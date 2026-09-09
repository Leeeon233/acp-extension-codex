import type {SessionId} from "@agentclientprotocol/sdk";
import {
    LODY_EXTENSION_METHODS,
    type LodyGoalPromptControl,
    type LodyGoalSnapshot,
} from "acp-extension-core";

export const GOAL_EXTENSION_VERSION = 1;
export const GOAL_CONTROL_METHOD = LODY_EXTENSION_METHODS.sessionGoal;

export const GOAL_CONTROL_ACTIONS = ["set", "pause", "resume", "clear"] as const;
export type GoalControlAction = typeof GOAL_CONTROL_ACTIONS[number];

export type GoalCapability = {
    version: typeof GOAL_EXTENSION_VERSION;
    actions: GoalControlAction[];
    /** Actions accepted on the control request while a prompt is in flight. */
    controlActions?: readonly GoalControlAction[];
    /** Actions accepted through `prompt._meta.lody.goalControl`. */
    promptActions?: readonly GoalControlAction[];
}

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";

export type GoalSnapshot = LodyGoalSnapshot;

export type GoalControlRequest =
    | { sessionId: SessionId; action: "set"; objective: string }
    | { sessionId: SessionId; action: Exclude<GoalControlAction, "set"> }

export type GoalPromptControl = LodyGoalPromptControl;

/**
 * A prompt may carry a goal action instead of `/goal …` text. Actions that start
 * work must travel this way — the client's prompt is what owns the turns they
 * produce — and status-only actions may, for clients reaching a session that is
 * not currently running a prompt.
 */
export function parseGoalPromptControl(meta: unknown): GoalPromptControl | null {
    if (typeof meta !== "object" || meta === null) return null;
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return null;
    const control = (lody as Record<string, unknown>)["goalControl"];
    if (typeof control !== "object" || control === null) return null;
    const {version, action, objective} = control as Record<string, unknown>;
    if (version !== GOAL_EXTENSION_VERSION) return null;
    if (action === "pause" || action === "resume" || action === "clear") {
        return {version: GOAL_EXTENSION_VERSION, action};
    }
    if (action !== "set") return null;
    // A blank objective would become a goal with no instruction to pursue.
    return typeof objective === "string" && objective.trim().length > 0
        ? {version: GOAL_EXTENSION_VERSION, action: "set", objective}
        : null;
}
