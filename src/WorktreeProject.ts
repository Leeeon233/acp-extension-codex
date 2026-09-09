import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import path from "node:path";
import {RequestError} from "@agentclientprotocol/sdk";
import type {LodyWorktreeProject} from "acp-extension-core";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread} from "./app-server/v2";

export function readWorktreeProject(meta: unknown): LodyWorktreeProject | undefined {
    if (typeof meta !== "object" || meta === null) return undefined;
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return undefined;
    const value = (lody as Record<string, unknown>)["worktreeProject"];
    if (value === undefined) return undefined;
    if (typeof value === "object" && value !== null) {
        const project = value as Record<string, unknown>;
        if (project["version"] === 1 && typeof project["originProjectPath"] === "string"
            && path.isAbsolute(project["originProjectPath"]) && !project["originProjectPath"].includes("\0")) {
            return {version: 1, originProjectPath: project["originProjectPath"]};
        }
    }
    throw RequestError.invalidParams(undefined, "worktreeProject requires version 1 and an absolute originProjectPath");
}

/** Uses project APIs only: logical roots must never become execution or sandbox roots. */
export class WorktreeProjects {
    constructor(private readonly client: CodexAppServerClient) {}

    async resolve(project: LodyWorktreeProject | undefined): Promise<string | undefined> {
        if (!project) return undefined;
        const originProjectPath = await realpath(project.originProjectPath);
        const key = projectRootKey(originProjectPath);
        return this.findOrCreate(originProjectPath, key);
    }

    async assign(thread: Thread, project: LodyWorktreeProject | undefined, preserveExisting: boolean): Promise<void> {
        if (!project || (preserveExisting && thread.projectId)) return;
        const projectId = await this.resolve(project);
        if (projectId && projectId !== thread.projectId) {
            await this.client.threadProjectUpdate({threadId: thread.id, projectId});
        }
    }

    private async findOrCreate(originProjectPath: string, key: string): Promise<string> {
        let cursor: string | undefined;
        const matches = new Set<string>();
        do {
            const page = await this.client.projectList({limit: 100, ...(cursor ? {cursor} : {})});
            for (const project of page.data) {
                for (const root of project.roots) {
                    if (projectRootKey(root.path) === key || await this.matchesRoot(root.path, key)) {
                        matches.add(project.id);
                        break;
                    }
                }
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (matches.size > 1) {
            throw RequestError.invalidParams(undefined, "Multiple Codex projects use this root; consolidate the project assignments first");
        }
        const match = matches.values().next().value;
        if (match) return match;
        // Shared by independent adapter processes. Do not use a per-session/worktree id.
        const idempotencyKey = `acp-project-v1:${createHash("sha256").update(key).digest("hex")}`;
        const response = await this.client.projectCreate({
            idempotencyKey,
            name: path.basename(originProjectPath) || originProjectPath,
            roots: [{path: originProjectPath}],
        });
        return response.project.id;
    }

    private async matchesRoot(storedPath: string, key: string): Promise<boolean> {
        try {
            return projectRootKey(await realpath(storedPath)) === key;
        } catch {
            // An unrelated registered root can be deleted or inaccessible on this host.
            return false;
        }
    }
}

function projectRootKey(originProjectPath: string): string {
    const normalized = path.resolve(originProjectPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
