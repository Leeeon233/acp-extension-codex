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
        const {mockFixture, sessionState, turnCompleted, turnActive} = startActiveTurn();
        const steerResponse = deferred<{turnId: string}>();
        const steerRequested = deferred<void>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(() => {
            steerRequested.resolve();
            return steerResponse.promise;
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnActive.promise;

        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "racing follow-up"}],
            steerId: "steer-race",
        });
        await steerRequested.promise;
        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(sessionState.currentTurnId).toBeNull();
        steerResponse.reject(Object.assign(new Error("Internal error"), {
            data: {details: "no active turn to steer"},
        }));
        await expect(steerPromise).resolves.toEqual({outcome: "failed"});
    });

    it('reports failed when the explicit refusal arrives before turn completion', async () => {
        const {mockFixture, turnCompleted, turnActive} = startActiveTurn();
        const steerResponse = deferred<{turnId: string}>();
        const steerRequested = deferred<void>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(() => {
            steerRequested.resolve();
            return steerResponse.promise;
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnActive.promise;
        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "racing follow-up"}],
            steerId: "steer-race-refusal-first",
        });
        await steerRequested.promise;
        steerResponse.reject(Object.assign(new Error("Internal error"), {
            data: {details: "no active turn to steer"},
        }));
        await expect(steerPromise).resolves.toEqual({outcome: "failed"});

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it('lets matching application evidence win over a later request failure', async () => {
        const {mockFixture, turnCompleted, turnActive} = startActiveTurn();
        const steerResponse = deferred<{turnId: string}>();
        const steerRequested = deferred<void>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(() => {
            steerRequested.resolve();
            return steerResponse.promise;
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnActive.promise;
        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "applied despite response failure"}],
            steerId: "steer-applied-before-error",
        });
        await steerRequested.promise;
        mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: "session-id",
                turnId: "turn-id",
                completedAtMs: 1,
                item: {
                    type: "userMessage",
                    id: "item-steer-applied",
                    clientId: "steer-applied-before-error",
                    content: [{
                        type: "text",
                        text: "applied despite response failure",
                        text_elements: [],
                    }],
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications("session-id");

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        steerResponse.reject(new Error("connection closed before steer response"));
        await expect(steerPromise).resolves.toEqual({outcome: "injected"});
    });

    it('throws a turn/steer internal failure without application evidence', async () => {
        const {mockFixture, turnCompleted, turnActive} = startActiveTurn();
        const steerRequested = deferred<void>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(() => {
            steerRequested.resolve();
            return Promise.reject(new Error("unexpected turn/steer failure"));
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnActive.promise;
        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "ambiguous steer"}],
            steerId: "steer-internal-error",
        });
        await steerRequested.promise;
        await expect(steerPromise).rejects.toThrow("unexpected turn/steer failure");

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
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
