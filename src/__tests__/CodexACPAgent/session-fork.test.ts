import {describe, expect, it, vi} from "vitest";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {forkSession} from "../../SessionFork";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("ACP session fork", () => {
    it("maps the Lody turn fork point to thread/fork", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const model = createTestModel();
        const mcpServer: McpServerStdio = {
            name: "fork-mcp",
            command: "node",
            args: ["server.js"],
            env: [{name: "TOKEN", value: "test-token"}],
        };

        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}} as never);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue({
            thread: {id: "child-session-id"},
            model: model.id,
            modelProvider: "openai",
            serviceTier: null,
            reasoningEffort: "medium",
        } as never);
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({} as never);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const result = await codexAcpClient.forkSession({
            sessionId: "source-session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
            mcpServers: [mcpServer],
            _meta: {
                lody: {
                    forkAtTurn: {
                        version: 1,
                        turnId: "completed-turn-id",
                    },
                },
            },
        });

        expect(result).toEqual({
            sessionId: "child-session-id",
            currentModelId: "model-id[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: ["/workspace/extra"],
        });
        expect(threadForkSpy).toHaveBeenCalledWith({
            threadId: "source-session-id",
            lastTurnId: "completed-turn-id",
            cwd: "/workspace",
            modelProvider: "openai",
            config: {
                projects: {
                    "/workspace": {trust_level: "trusted"},
                    "/workspace/extra": {trust_level: "trusted"},
                },
                sandbox_workspace_write: {
                    writable_roots: ["/workspace/extra"],
                },
                mcp_servers: {
                    "fork-mcp": {
                        command: "node",
                        args: ["server.js"],
                        env: {TOKEN: "test-token"},
                    },
                },
            },
        });
        expect(unsubscribeSpy).not.toHaveBeenCalled();
    });

    it("unsubscribes the child only when install fails after thread/fork", async () => {
        const threadUnsubscribe = vi.fn().mockResolvedValue({status: "unsubscribed"});
        const assignError = new Error("assign failed");
        await expect(
            forkSession(
                {sessionId: "source-session-id", cwd: "/workspace", mcpServers: []},
                [],
                {
                    codexClient: {
                        threadFork: vi.fn().mockResolvedValue({
                            thread: {id: "child-session-id"},
                            model: "gpt-5",
                            modelProvider: "openai",
                            reasoningEffort: "medium",
                            serviceTier: null,
                        }),
                        threadUnsubscribe,
                    } as never,
                    assignProject: vi.fn().mockRejectedValue(assignError),
                    refreshSkills: vi.fn().mockResolvedValue(undefined),
                    createSessionConfig: vi.fn().mockResolvedValue({}),
                    getResumeModelProvider: vi.fn().mockResolvedValue("openai"),
                    fetchAvailableModels: vi.fn(),
                    createCurrentModelId: vi.fn(),
                    getCollaborationMode: vi.fn(),
                },
            ),
        ).rejects.toBe(assignError);
        expect(threadUnsubscribe).toHaveBeenCalledTimes(1);
        expect(threadUnsubscribe).toHaveBeenCalledWith({threadId: "child-session-id"});
    });

    it("creates and installs a forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        const forkSpy = vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(response.sessionId).toBe("fork-id");
        expect(agent.getSessionState("fork-id").cwd).toBe("/workspace");
        expect(fixture.getAcpConnectionEvents([])).toEqual([
            {
                method: "notify",
                args: ["_auth/status_update", {authStatus: {kind: "none", label: "Not logged in"}}],
            },
        ]);
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });
    });
});
