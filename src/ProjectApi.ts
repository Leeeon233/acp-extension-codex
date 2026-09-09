/** Project fields from Codex 0.153.4's experimental schema, omitted by stable generate-ts. */
export type CodexProject = {
    id: string;
    roots: Array<{path: string}>;
};

export type ProjectListParams = {cursor?: string; limit?: number};
export type ProjectListResponse = {data: CodexProject[]; nextCursor: string | null};
export type ProjectCreateParams = {
    idempotencyKey: string;
    name: string;
    roots: Array<{path: string}>;
};
export type ProjectCreateResponse = {project: CodexProject};
export type ThreadProjectUpdateParams = {threadId: string; projectId: string};

export type CodexProjectRequest =
    | {method: "project/list"; params: ProjectListParams}
    | {method: "project/create"; params: ProjectCreateParams}
    | {method: "thread/metadata/update"; params: ThreadProjectUpdateParams};
