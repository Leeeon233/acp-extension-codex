import {beforeEach, describe, expect, it, vi} from 'vitest';
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import type {TurnCompletedNotification} from "../../app-server/v2";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";

function createTurn(id: string, status: "inProgress" | "completed" | "interrupted") {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {promise, resolve, reject};
}

/**
 * Drives a prompt to the point where a turn is active (in progress) and paused
 * on turn completion, so a steer can be injected mid-turn.
 */
function startActiveTurn(sessionOverrides?: Partial<SessionState>) {
    const mockFixture = createCodexMockTestFixture();
    const sessionState = createTestSessionState(sessionOverrides);
    vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({
        turn: createTurn("turn-id", "inProgress"),
    });
    const turnCompleted = deferred<TurnCompletedNotification>();
    const turnActive = deferred<void>();
    vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockImplementation(() => {
            turnActive.resolve();
            return turnCompleted.promise;
        });
    vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    return {mockFixture, sessionState, turnCompleted, turnActive};
}

async function startPendingSteer(steerId: string) {
    const active = startActiveTurn();
    const steerResponse = deferred<{turnId: string}>();
    const steerRequested = deferred<void>();
    vi.spyOn(active.mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(() => {
        steerRequested.resolve();
        return steerResponse.promise;
    });
    const promptPromise = active.mockFixture.getCodexAcpAgent().prompt({
        sessionId: "session-id",
        prompt: [{type: "text", text: "long running prompt"}],
    });
    await active.turnActive.promise;
    const steerPromise = active.mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
        sessionId: "session-id",
        prompt: [{type: "text", text: "racing follow-up"}],
        steerId,
    });
    await steerRequested.promise;
    return {...active, promptPromise, steerPromise, steerResponse};
}

async function finishPrompt(
    turnCompleted: ReturnType<typeof deferred<TurnCompletedNotification>>,
    promptPromise: Promise<unknown>,
): Promise<void> {
    turnCompleted.resolve({
        threadId: "session-id",
        turn: createTurn("turn-id", "completed"),
    });
    await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
}

const noActiveTurnError = () => Object.assign(new Error("Internal error"), {
    data: {details: "no active turn to steer"},
});

describe('_lody/session/steer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports injected when the input joins the active turn', async () => {
        const {mockFixture, sessionState, turnCompleted, turnActive} = startActiveTurn();
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "turn-id"});

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnActive.promise;
        expect(sessionState.currentTurnId).toBe("turn-id");

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "also keep backward compatibility"}],
            steerId: "steer-active",
        })).resolves.toEqual({outcome: "injected"});

        expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            expectedTurnId: "turn-id",
            clientUserMessageId: "steer-active",
            input: [{type: "text", text: "also keep backward compatibility", text_elements: []}],
        });

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it('fails without starting a detached turn when no turn is active', async () => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        const turnStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "too late for the previous turn"}],
            steerId: "steer-idle",
        })).resolves.toEqual({outcome: "failed"});

        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it('reports failed when turn completion arrives before the explicit refusal', async () => {
        const run = await startPendingSteer("steer-completion-first");
        await finishPrompt(run.turnCompleted, run.promptPromise);
        expect(run.sessionState.currentTurnId).toBeNull();
        run.steerResponse.reject(noActiveTurnError());
        await expect(run.steerPromise).resolves.toEqual({outcome: "failed"});
    });

    it('reports failed when the explicit refusal arrives before turn completion', async () => {
        const run = await startPendingSteer("steer-refusal-first");
        run.steerResponse.reject(noActiveTurnError());
        await expect(run.steerPromise).resolves.toEqual({outcome: "failed"});
        await finishPrompt(run.turnCompleted, run.promptPromise);
    });

    it('lets matching application evidence win over a later request failure', async () => {
        const run = await startPendingSteer("steer-applied-before-error");
        run.mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: "session-id",
                turnId: "turn-id",
                completedAtMs: 1,
                item: {
                    type: "userMessage",
                    id: "item-steer-applied",
                    clientId: "steer-applied-before-error",
                    content: [{type: "text", text: "racing follow-up", text_elements: []}],
                },
            },
        });
        await run.mockFixture.getCodexAcpClient().waitForSessionNotifications("session-id");
        await finishPrompt(run.turnCompleted, run.promptPromise);
        run.steerResponse.reject(new Error("connection closed before steer response"));
        await expect(run.steerPromise).resolves.toEqual({outcome: "injected"});
    });

    it('throws a turn/steer internal failure without application evidence', async () => {
        const run = await startPendingSteer("steer-internal-error");
        run.steerResponse.reject(new Error("unexpected turn/steer failure"));
        await expect(run.steerPromise).rejects.toThrow("unexpected turn/steer failure");
        await finishPrompt(run.turnCompleted, run.promptPromise);
    });
    it('rejects concurrent late steering requests without creating a turn', async () => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "new-turn-id"});

        const firstRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "first late follow-up"}],
            steerId: "steer-late-1",
        });
        const secondRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "second late follow-up"}],
            steerId: "steer-late-2",
        });

        await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
            {outcome: "failed"},
            {outcome: "failed"},
        ]);
        expect(turnSteerSpy).not.toHaveBeenCalled();
    });

    it('throws when steering hits an unexpected error before non-application is proven', async () => {
        const mockFixture = createCodexMockTestFixture();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockImplementation(() => {
            throw new Error("unexpected boom");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "keep the agent alive"}],
            steerId: "steer-error",
        })).rejects.toThrow("unexpected boom");
    });

    it('rejects malformed steer params', async () => {
        const mockFixture = createCodexMockTestFixture();

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
        })).rejects.toThrow(RequestError);
    });

    it('rejects image input when the model does not support it', async () => {
        const {mockFixture} = startActiveTurn({supportedInputModalities: ["text"]});
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer");

        const image: acp.ContentBlock = {
            type: "image",
            mimeType: "image/png",
            data: "abc123",
        };

        const error = await mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [image],
            steerId: "steer-image",
        }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).data).toContain("does not support image input");
        expect(turnSteerSpy).not.toHaveBeenCalled();
    });
});
