import {mkdir, mkdtemp, realpath, rm, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {readWorktreeProject, WorktreeProjects} from "../../WorktreeProject";

describe("local project identity across worktrees", () => {
    let root: string;
    let fixture: ReturnType<typeof createCodexMockTestFixture>;
    beforeEach(async () => {
        root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acp-project-")));
        fixture = createCodexMockTestFixture();
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(native, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(native, "configRead").mockResolvedValue({config: {}} as never);
        vi.spyOn(native, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
        vi.spyOn(native, "threadUnsubscribe").mockResolvedValue({} as never);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, {recursive: true, force: true});
    });

    function metadata(originProjectPath = root) {
        return {lody: {worktreeProject: {version: 1, originProjectPath}}};
    }
    function resumed(projectId: string | null = null) {
        return {
            thread: {id: "thread-1", projectId},
            model: "model-id", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
        };
    }
    function existingProject() {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockResolvedValue({
            data: [{id: "original-project", roots: [{path: root}]}], nextCursor: null,
        });
        // Reusing a project must not create a second project.
        vi.spyOn(native, "projectCreate").mockRejectedValue(new Error("unexpected project creation"));
    }

    it("starts in the worktree while assigning its existing original project", async () => {
        existingProject();
        const native = fixture.getCodexAppServerClient();
        const start = vi.spyOn(native, "threadStart").mockResolvedValue(resumed("original-project") as never);
        const cwd = path.join(root, "worktree");
        const result = await fixture.getCodexAcpClient().newSession({cwd, mcpServers: [], _meta: metadata()});
        expect(result.sessionId).toBe("thread-1");
        expect(start).toHaveBeenCalledWith({
            cwd, projectId: "original-project", modelProvider: null,
            config: {projects: {[cwd]: {trust_level: "trusted"}}},
        });
    });

    it("creates one canonical project identity across symlinks and independent adapters", async () => {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockResolvedValue({data: [], nextCursor: null});
        const requests: unknown[] = [];
        vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            requests.push(params);
            return {project: {id: params.idempotencyKey, roots: params.roots}};
        });
        const alias = path.join(root, "alias");
        await symlink(root, alias, "dir");
        const first = new WorktreeProjects(native);
        const second = new WorktreeProjects(native);
        const ids = await Promise.all([
            first.resolve({version: 1, originProjectPath: root}),
            first.resolve({version: 1, originProjectPath: alias}),
            second.resolve({version: 1, originProjectPath: root}),
        ]);
        expect(new Set(ids).size).toBe(1);
        expect(requests).toEqual(expect.arrayContaining([{
            idempotencyKey: ids[0], name: path.basename(root), roots: [{path: root}],
        }]));
        expect(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0]))).toBe(true);
    });

    it("keeps distinct directory names that differ by trailing whitespace separate", async () => {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockResolvedValue({data: [], nextCursor: null});
        vi.spyOn(native, "projectCreate").mockImplementation(async params => ({
            project: {id: params.idempotencyKey, roots: params.roots},
        }));
        const roots = [path.join(root, "source"), path.join(root, "source ")];
        await Promise.all(roots.map(originProjectPath => mkdir(originProjectPath)));
        const resolver = new WorktreeProjects(native);
        const ids = await Promise.all(roots.map(originProjectPath => resolver.resolve({version: 1, originProjectPath})));
        expect(ids[0]).not.toEqual(ids[1]);
    });

    it("finds a registered project on a later page using its symlink root", async () => {
        const alias = path.join(root, "alias");
        await symlink(root, alias, "dir");
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockImplementation(async params => params.cursor === "next"
            ? {data: [{id: "existing", roots: [{path: alias}]}], nextCursor: null}
            : {data: [{id: "other", roots: [{path: path.join(root, "deleted")}]}], nextCursor: "next"});
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root})).resolves.toBe("existing");
    });

    it.each(["resumeSession", "loadSession"] as const)("backfills an unassigned persisted thread on %s", async method => {
        existingProject();
        const native = fixture.getCodexAppServerClient();
        const response = resumed();
        const resume = vi.spyOn(native, "threadResume").mockResolvedValue(response as never);
        vi.spyOn(native, "threadRead").mockImplementation(async () => ({thread: response.thread}) as never);
        const assign = vi.spyOn(native, "threadProjectUpdate").mockImplementation(async ({projectId}) => {
            response.thread.projectId = projectId;
        });
        const cwd = path.join(root, "worktree");
        await fixture.getCodexAcpClient()[method]({sessionId: "thread-1", cwd, mcpServers: [], _meta: metadata()});
        expect(response.thread.projectId).toBe("original-project");
        expect(assign).toHaveBeenCalledWith({threadId: "thread-1", projectId: "original-project"});
        expect(resume).toHaveBeenCalledWith(expect.objectContaining({cwd}));
    });

    it("preserves an existing user project assignment during resume", async () => {
        const native = fixture.getCodexAppServerClient();
        const response = resumed("user-selected-project");
        vi.spyOn(native, "threadResume").mockResolvedValue(response as never);
        vi.spyOn(native, "projectList").mockRejectedValue(new Error("must preserve existing assignment"));
        vi.spyOn(native, "threadProjectUpdate").mockRejectedValue(new Error("must preserve existing assignment"));
        const result = await fixture.getCodexAcpClient().resumeSession({sessionId: "thread-1", cwd: root, _meta: metadata()});
        expect(result.sessionId).toBe("thread-1");
        expect(response.thread.projectId).toBe("user-selected-project");
    });

    it("assigns the fork target without changing the source thread", async () => {
        existingProject();
        const native = fixture.getCodexAppServerClient();
        const response = resumed("source-project");
        response.thread.id = "fork-child";
        vi.spyOn(native, "threadFork").mockResolvedValue(response as never);
        const updates: unknown[] = [];
        vi.spyOn(native, "threadProjectUpdate").mockImplementation(async params => {updates.push(params);});
        const result = await fixture.getCodexAcpClient().forkSession({
            sessionId: "source-thread", cwd: path.join(root, "worktree"), mcpServers: [], _meta: metadata(),
        });
        expect(result.sessionId).toBe("fork-child");
        expect(updates).toEqual([{threadId: "fork-child", projectId: "original-project"}]);
    });

    it("leaves clients without project metadata unchanged", async () => {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockRejectedValue(new Error("unexpected project lookup"));
        const start = vi.spyOn(native, "threadStart").mockResolvedValue(resumed() as never);
        await fixture.getCodexAcpClient().newSession({cwd: root, mcpServers: []});
        expect(start).toHaveBeenCalledWith({cwd: root, modelProvider: null, config: {projects: {[root]: {trust_level: "trusted"}}}});
    });

    it("rejects ambiguous roots instead of assigning an arbitrary project", async () => {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectList").mockResolvedValue({data: [
            {id: "one", roots: [{path: root}]}, {id: "two", roots: [{path: root}]},
        ], nextCursor: null});
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root})).rejects.toThrow("Multiple Codex projects");
    });

    it.each([null, {version: 2, originProjectPath: "/project"}, {version: 1, originProjectPath: "relative"}])("rejects invalid project metadata %j", value => {
        expect(() => readWorktreeProject({lody: {worktreeProject: value}})).toThrow("absolute originProjectPath");
    });
});
