import { createPlanModeConfigOption } from "acp-extension-core";
import type * as acp from "@agentclientprotocol/sdk";
import type {ReasoningEffort} from "./app-server";
import type {ModeKind} from "./app-server/ModeKind";
import {ModelId} from "./ModelId";

export { LODY_PLAN_MODE_CONFIG_ID } from "acp-extension-core";
export const DEFAULT_COLLABORATION_MODE: ModeKind = "default";
export const PLAN_COLLABORATION_MODE: ModeKind = "plan";

export function createCollaborationModeConfigOption(currentValue: ModeKind): acp.SessionConfigOption {
    return createPlanModeConfigOption(currentValue === PLAN_COLLABORATION_MODE);
}

export function parseCollaborationMode(value: unknown): ModeKind | null {
    if (value === DEFAULT_COLLABORATION_MODE) return DEFAULT_COLLABORATION_MODE;
    if (value === PLAN_COLLABORATION_MODE) return PLAN_COLLABORATION_MODE;
    return null;
}

export function createCodexCollaborationMode(mode: ModeKind, currentModelId: string) {
    const modelId = ModelId.fromString(currentModelId);
    return {
        mode,
        settings: {
            model: modelId.model,
            reasoning_effort: modelId.effort as ReasoningEffort | null,
            developer_instructions: null,
        },
    };
}
