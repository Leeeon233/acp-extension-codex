import type {
    AvailableCommand,
    ClientContext,
    ContentBlock,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {
    GOAL_CONTROL_METHOD,
    LEGACY_GOAL_CONTROL_METHOD,
    type GoalControlRequest,
} from "./GoalExtension";

export {
    GOAL_CONTROL_ACTIONS,
    GOAL_CONTROL_METHOD,
    GOAL_EXTENSION_VERSION,
    LEGACY_GOAL_CONTROL_METHOD,
    type GoalCapability,
    type GoalControlAction,
    type GoalControlRequest,
    type GoalSnapshot,
    type GoalStatus,
} from "./GoalExtension";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const ACP_EXT_SESSION_USAGE_UPDATE_METHOD = "_acp_ext:session_usage_update";
export const ACP_EXT_SESSION_RATE_LIMITS_METHOD = "_acp_ext:session_rate_limits";
export const ACP_EXT_CODEX_PROPOSED_PLAN_METHOD = "_acp_ext:codex_proposed_plan";
export const CODEX_STEER_APPLIED_METHOD = "_codex/steerApplied";
export const SESSION_STEERING_METHOD = "_session/steering";
export const LODY_READ_SESSION_HISTORY_METHOD = "_lody/session/history/read";
export function getLodyForkTurnId(meta: unknown): string | null {
    if (typeof meta !== "object" || meta === null) return null;
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return null;
    const forkAtTurn = (lody as Record<string, unknown>)["forkAtTurn"];
    if (typeof forkAtTurn !== "object" || forkAtTurn === null) return null;
    const version = (forkAtTurn as Record<string, unknown>)["version"];
    const turnId = (forkAtTurn as Record<string, unknown>)["turnId"];
    return version === 1 && typeof turnId === "string" && turnId.length > 0
        ? turnId
        : null;
}

export type CodexSteerCapability = {
    version: 1;
    method: typeof SESSION_STEERING_METHOD;
    appliedNotification: typeof CODEX_STEER_APPLIED_METHOD;
    upstreamTurn: "same";
    configPolicy: "active";
}

export const CODEX_STEER_CAPABILITY: CodexSteerCapability = {
    version: 1,
    method: SESSION_STEERING_METHOD,
    appliedNotification: CODEX_STEER_APPLIED_METHOD,
    upstreamTurn: "same",
    configPolicy: "active",
};

export type LodyReadSessionHistoryCapability = {
    version: 1;
    method: typeof LODY_READ_SESSION_HISTORY_METHOD;
}

export const LODY_READ_SESSION_HISTORY_CAPABILITY: LodyReadSessionHistoryCapability = {
    version: 1,
    method: LODY_READ_SESSION_HISTORY_METHOD,
};

export type LodyReadSessionHistoryRequest = {
    sessionId: SessionId;
}

export type LodyReadSessionHistoryResponse = {}

export type LegacySessionModel = {
    modelId: string;
    name: string;
    description?: string | null;
}

export type LegacySessionModelState = {
    availableModels: Array<LegacySessionModel>;
    currentModelId: string;
}

export type SessionUsageExtNotification = {
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        reasoningOutputTokens: number;
        contextWindow: number | null;
    }
}

export type SessionRateLimitWindow = {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
}

export type SessionRateLimitsExtNotification = {
    schemaVersion: 2;
    planName: string | null;
    limitName: string | null;
    limitId: string | null;
    windows: Array<SessionRateLimitWindow>;
    fiveHour: number | null;
    sevenDay: number | null;
    fiveHourResetAt: number | null;
    sevenDayResetAt: number | null;
}

export type CodexProposedPlanExtNotification = {
    schemaVersion: 1;
    sessionId: string;
    turnId: string;
    markdown: string;
    status: "delta" | "completed";
    isLatest: boolean;
}

export type LegacySetSessionModelRequest = {
    sessionId: SessionId;
    modelId: string;
}

export type LegacySetSessionModelResponse = {}

export type LegacyNewSessionResponse = NewSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type LegacyLoadSessionResponse = LoadSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type LegacyResumeSessionResponse = ResumeSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type ExtMethodRequest =
    AuthenticationStatusRequest
    | AuthenticationLogoutRequest
    | LegacySetSessionModelExtRequest
    | SessionSteeringExtRequest
    | GoalControlExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD
        || request.method === LEGACY_GOAL_CONTROL_METHOD
        || request.method === SESSION_STEERING_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD | typeof LEGACY_GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}

export type SessionSteerRequest = {
    sessionId: SessionId;
    prompt: ContentBlock[];
    /**
     * Lody application correlation. When present, the adapter only injects
     * into the active turn and confirms application through the advertised
     * committed-user-message notification; it never starts a fallback turn.
     */
    steerId?: string;
}

export type SessionSteeringResponse = {
    outcome: "injected" | "startedNewTurn" | "failed";
}

export type SessionSteeringExtRequest = {
    method: typeof SESSION_STEERING_METHOD;
    params: SessionSteerRequest;
}

export async function steerSessionWithFallback(
    connection: Pick<ClientContext, "request">,
    params: SessionSteerRequest,
): Promise<SessionSteeringResponse> {
    return await connection.request<SessionSteeringResponse, SessionSteerRequest>(SESSION_STEERING_METHOD, params);
}
