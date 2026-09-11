import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {ThreadGoal, Turn} from "../../app-server/v2";

const sessionId = "goal-session";
const goal: ThreadGoal = {
    threadId: sessionId, objective: "Synthetic multi-turn goal", status: "active",
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
};
const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
    id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null,
});

async function startPrompt(prompt = "Pursue the test goal", meta?: Record<string, unknown>) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const native = fixture.getCodexAppServerClient();
    const session = createTestSessionState({sessionId});
    vi.spyOn(agent, "getSessionState").mockReturnValue(session);
    // @ts-expect-error - install the fixture session for standard session/cancel
    agent.sessions.set(sessionId, session);
    vi.spyOn(native, "turnStart").mockResolvedValue({turn: turn("a", "inProgress")});
    let ready: () => void = () => {};
    const started = new Promise<void>(resolve => { ready = resolve; });
    const awaitCompleted = native.awaitTurnCompleted.bind(native);
    vi.spyOn(native, "awaitTurnCompleted").mockImplementation((threadId, turnId) => {
        const completion = awaitCompleted(threadId, turnId);
        ready();
        return completion;
    });
    vi.spyOn(native, "runGoalSet").mockImplementation(async (_params, onStarted) => {
        onStarted?.("a");
        return native.awaitTurnCompleted(sessionId, "a");
    });
    vi.spyOn(client, "setGoalStatus").mockResolvedValue({...goal, status: "paused"});
    let close: () => void = () => {};
    vi.spyOn(client, "onConnectionClosed").mockImplementation(callback => {
        close = callback;
        return () => {};
    });
    let settled = false;
    const response = agent.prompt({sessionId, prompt: [{type: "text", text: prompt}], ...(meta ? {_meta: meta} : {})})
        .finally(() => { settled = true; });
    await started;
    const sendGoal = (status: ThreadGoal["status"]) => fixture.sendServerNotification({
        method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal: {...goal, status}},
    });
    const complete = (id: string, status: Turn["status"] = "completed") => fixture.sendServerNotification({
        method: "turn/completed", params: {threadId: sessionId, turn: turn(id, status)},
    });
    const start = (id: string) => fixture.sendServerNotification({
        method: "turn/started", params: {threadId: sessionId, turn: turn(id, "inProgress")},
    });
    const text = (id: string, delta: string) => fixture.sendServerNotification({
        method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: id, itemId: `message-${id}`, delta},
    });
    const drain = () => client.waitForSessionNotifications(sessionId);
    sendGoal("active");
    text("a", "First turn.");
    complete("a");
    await drain();
    return {fixture, agent, client, native, response, sendGoal, complete, start, text, drain, close: () => close(), settled: () => settled};
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Goal continuation through ACP v1 prompt", () => {
    it.each(["Pursue the test goal", "/goal Synthetic multi-turn goal", "/goal resume"])("keeps %s open across native turns without duplicate submission", async prompt => {
        const run = await startPrompt(prompt);
        expect(run.settled()).toBe(false);
        run.start("b");
        run.sendGoal("complete");
        run.text("b", "Last turn.");
        await run.drain();
        expect(run.settled()).toBe(false);
        run.complete("b");
        await expect(run.response).resolves.toMatchObject({stopReason: "end_turn"});
        const output = run.fixture.getAcpConnectionEvents([]).flatMap(event => {
            const update = event.args[0]?.update;
            return update?.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [];
        });
        expect(output).toEqual(["First turn.", "Last turn."]);
        expect(run.native.turnStart).toHaveBeenCalledTimes(prompt.startsWith("/goal") ? 0 : 1);
    });

    it("resumes from prompt metadata without command text or a duplicate turn", async () => {
        const run = await startPrompt("Continue working toward the active goal.", {
            lody: {goalControl: {version: 1, action: "resume"}},
        });
        expect(run.settled()).toBe(false);
        expect(run.native.runGoalSet).toHaveBeenCalledWith(
            expect.objectContaining({threadId: sessionId, status: "active"}),
            expect.any(Function),
        );
        // The metadata action replaces the prompt, so nothing extra is submitted.
        expect(run.native.turnStart).not.toHaveBeenCalled();
        run.sendGoal("paused");
        await expect(run.response).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("cancels in the gap and pauses the native goal scheduler", async () => {
        const run = await startPrompt();
        await run.agent.cancel({sessionId});
        await expect(run.response).resolves.toMatchObject({stopReason: "cancelled"});
        expect(run.fixture.getAcpConnectionEvents([])).toContainEqual(expect.objectContaining({
            args: [expect.objectContaining({update: expect.objectContaining({
                _meta: {lody: {goal: expect.objectContaining({status: "paused"})}},
            })})],
        }));
    });

    it("interrupts the continuation turn rather than the already-completed first turn", async () => {
        const run = await startPrompt();
        run.start("b");
        await run.drain();
        const interrupted: string[] = [];
        vi.spyOn(run.client, "turnInterrupt").mockImplementation(async params => {
            interrupted.push(params.turnId);
            run.complete(params.turnId, "interrupted");
        });
        await run.agent.cancel({sessionId});
        await expect(run.response).resolves.toMatchObject({stopReason: "cancelled"});
        expect(interrupted).toEqual(["b"]);
    });

    it("releases the prompt when a goal is cleared between turns", async () => {
        const run = await startPrompt();
        run.fixture.sendServerNotification({method: "thread/goal/cleared", params: {threadId: sessionId}});
        await expect(run.response).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("rejects when the native connection closes between turns", async () => {
        const run = await startPrompt();
        run.close();
        await expect(run.response).rejects.toThrow("Codex connection closed");
    });
});
