import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { CodexAppServerClient } from "../CodexAppServerClient";
import type { ThreadCompactStartParams, TurnStartParams } from "../app-server/v2";

type MockConnection = {
    close: () => void;
    notify: (notification: unknown) => void;
    sendRequest: ReturnType<typeof vi.fn>;
    connection: MessageConnection;
};

const createMockConnection = (): MockConnection => {
    let closeListener: (() => void) | undefined;
    let disposeListener: (() => void) | undefined;
    let notificationListener: ((data: unknown) => void) | undefined;
    const sendRequest = vi.fn(async (_method: string, _params?: unknown) => undefined);
    const close = () => {
        closeListener?.();
        disposeListener?.();
    };
    const connection = {
        onClose: (listener: () => void) => {
            closeListener = listener;
            return { dispose: () => {} };
        },
        onDispose: (listener: () => void) => {
            disposeListener = listener;
            return { dispose: () => {} };
        },
        onUnhandledNotification: (listener: (data: unknown) => void) => {
            notificationListener = listener;
            return { dispose: () => {} };
        },
        onRequest: vi.fn(),
        sendRequest,
    } as unknown as MessageConnection;
    return {
        close,
        notify: (notification: unknown) => notificationListener?.(notification),
        sendRequest,
        connection,
    };
};

const compacted = (threadId: string) => ({
    method: "thread/compacted" as const,
    params: { threadId, turnId: "compact-turn-1" },
});

describe("CodexAppServerClient turn lifecycle", () => {
    it("rejects when the process closes after turn/start but before completion registration", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "turn/start") {
                return { turn: { id: "turn-1" } };
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        const turn = client.runTurn(
            { threadId: "thread-1", input: [] } as unknown as TurnStartParams,
            () => mock.close(),
        );

        await expect(turn).rejects.toThrow("Codex process exited before completing the turn");
    });
});

describe("CodexAppServerClient compact lifecycle", () => {
    const params = { threadId: "thread-1" } as ThreadCompactStartParams;

    it("completes when thread/compacted arrives after start", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                return {};
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        const compact = client.runCompact(params);
        await vi.waitFor(() => {
            expect(mock.sendRequest).toHaveBeenCalledWith("thread/compact/start", params);
        });
        mock.notify(compacted("thread-1"));

        await expect(compact).resolves.toEqual(compacted("thread-1"));
    });

    it("completes when thread/compacted arrives before start returns", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                mock.notify(compacted("thread-1"));
                return {};
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        await expect(client.runCompact(params)).resolves.toEqual(compacted("thread-1"));
    });

    it("rejects when the process closes after compact start is acknowledged", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                return {};
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        const compact = client.runCompact(params);
        await vi.waitFor(() => {
            expect(mock.sendRequest).toHaveBeenCalledWith("thread/compact/start", params);
        });
        mock.close();

        await expect(compact).rejects.toThrow("Codex process exited before completing the turn");
    });

    it("rejects when close fires while compact start is still in flight", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                // vscode-jsonrpc closeHandler fires onClose and does not reject
                // in-flight responsePromises; only dispose does. Keep start pending.
                return await new Promise(() => {});
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        const compact = client.runCompact(params);
        await vi.waitFor(() => {
            expect(mock.sendRequest).toHaveBeenCalledWith("thread/compact/start", params);
        });
        mock.close();

        await expect(compact).rejects.toThrow("Codex process exited before completing the turn");
    });

    it("does not leave a waiter when compact start fails with a normal error", async () => {
        const mock = createMockConnection();
        let compactStarts = 0;
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                compactStarts += 1;
                if (compactStarts === 1) {
                    throw new Error("thread not found");
                }
                return {};
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);

        await expect(client.runCompact(params)).rejects.toThrow("thread not found");

        const second = client.runCompact(params);
        await vi.waitFor(() => {
            expect(compactStarts).toBe(2);
        });
        mock.notify(compacted("thread-1"));
        await expect(second).resolves.toEqual(compacted("thread-1"));
    });

    it("rejects a compact started after the connection already died", async () => {
        const mock = createMockConnection();
        mock.sendRequest.mockImplementation(async (method: string) => {
            if (method === "thread/compact/start") {
                return {};
            }
            return undefined;
        });
        const client = new CodexAppServerClient(mock.connection);
        mock.close();

        await expect(client.runCompact(params)).rejects.toThrow("Codex process exited before completing the turn");
    });
});
