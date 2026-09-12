import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { CodexAppServerClient } from "../CodexAppServerClient";
import type { TurnStartParams } from "../app-server/v2";
import type { ServerNotification } from "../app-server";

describe("CodexAppServerClient turn lifecycle", () => {
    function compactHarness(sendRequest: () => Promise<unknown> = async () => ({})) {
        let notify: (event: ServerNotification) => void = () => {};
        let close: () => void = () => {};
        const client = new CodexAppServerClient({
            onClose: (listener: () => void) => { close = listener; return {dispose() {}}; },
            onDispose: () => ({dispose() {}}),
            onUnhandledNotification: (listener: typeof notify) => { notify = listener; return {dispose() {}}; },
            onRequest: vi.fn(),
            sendRequest,
        } as unknown as MessageConnection);
        const turn = (id: string, status: "inProgress" | "completed" | "interrupted" | "failed") => ({
            id, status, items: [], itemsView: "notLoaded" as const,
            error: null, startedAt: null, completedAt: null, durationMs: null,
        });
        return {
            client,
            close: () => close(),
            start: (threadId = "thread-1", turnId = "compact-1") => notify({
                method: "turn/started", params: {threadId, turn: turn(turnId, "inProgress")},
            }),
            finish: (status: "completed" | "interrupted" | "failed", threadId = "thread-1", turnId = "compact-1") => notify({
                method: "turn/completed", params: {threadId, turn: turn(turnId, status)},
            }),
        };
    }

    it.each(["completed", "interrupted", "failed"] as const)("settles compact from its native %s turn, even before the start ACK", async (status) => {
        let acknowledge: () => void = () => {};
        const ack = new Promise<void>(resolve => { acknowledge = resolve; });
        const h = compactHarness(() => ack);
        let ownedTurn: string | undefined;
        let settled = false;
        const compact = h.client.runCompact({threadId: "thread-1"}, id => { ownedTurn = id; })
            .then(result => { settled = true; return result; });
        h.start("another-thread", "other-turn");
        expect(ownedTurn).toBeUndefined();
        h.start();
        expect(ownedTurn).toBe("compact-1");
        h.finish("completed", "thread-1", "previous-turn");
        await Promise.resolve();
        expect(settled).toBe(false);
        h.finish(status);
        acknowledge();
        await expect(compact).resolves.toMatchObject({threadId: "thread-1", turn: {id: "compact-1", status}});
    });

    it.each([
        {started: false, acknowledged: false},
        {started: false, acknowledged: true},
        {started: true, acknowledged: false},
        {started: true, acknowledged: true},
    ])("rejects compact on process exit (started: $started, acknowledged: $acknowledged)", async ({started, acknowledged}) => {
        const h = compactHarness(() => acknowledged ? Promise.resolve({}) : new Promise(() => {}));
        const compact = h.client.runCompact({threadId: "thread-1"});
        if (started) h.start();
        h.close();
        await expect(compact).rejects.toThrow("Codex process exited before completing the turn");
    });

    it("releases a rejected compact start so a later request can run", async () => {
        let rejectStart = true;
        const h = compactHarness(async () => {
            if (rejectStart) throw new Error("compact start rejected");
            return {};
        });
        await expect(h.client.runCompact({threadId: "thread-1"})).rejects.toThrow("compact start rejected");
        rejectStart = false;
        const next = h.client.runCompact({threadId: "thread-1"});
        h.start();
        h.finish("completed");
        await expect(next).resolves.toMatchObject({turn: {status: "completed"}});
    });

    it("rejects when the process closes after turn/start but before completion registration", async () => {
        let closeConnection: (() => void) | undefined;
        const connection = {
            onClose: (listener: () => void) => {
                closeConnection = listener;
                return { dispose: () => {} };
            },
            onDispose: () => ({ dispose: () => {} }),
            onUnhandledNotification: () => ({ dispose: () => {} }),
            onRequest: vi.fn(),
            sendRequest: vi.fn(async (method: string) => {
                if (method === "turn/start") {
                    return { turn: { id: "turn-1" } };
                }
                return undefined;
            }),
        } as unknown as MessageConnection;
        const client = new CodexAppServerClient(connection);

        const turn = client.runTurn(
            { threadId: "thread-1", input: [] } as unknown as TurnStartParams,
            () => closeConnection?.(),
        );

        await expect(turn).rejects.toThrow("Codex process exited before completing the turn");
    });
});
