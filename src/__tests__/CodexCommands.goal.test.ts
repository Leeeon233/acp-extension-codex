import {describe, expect, it} from "vitest";
import {GOAL_CONTINUATION_PROMPT, resolveGoalCommandHandleResult} from "../CodexCommands";
import {parseGoalPromptControl} from "../GoalExtension";
import type {TurnCompletedNotification} from "../app-server/v2";

const completedTurn = (status: TurnCompletedNotification["turn"]["status"]): TurnCompletedNotification => ({
    threadId: "thread-1",
    turn: {
        id: "turn-1",
        status,
        items: [],
        itemsView: "summary",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    },
});

describe("resolveGoalCommandHandleResult", () => {
    it("follows native continuation when Codex completes a setup turn", () => {
        const turnCompleted = completedTurn("completed");
        expect(resolveGoalCommandHandleResult(turnCompleted)).toEqual({
            handled: true,
            turnCompleted,
        });
    });

    it("chains into goal continuation when no setup turn starts", () => {
        expect(resolveGoalCommandHandleResult(null)).toEqual({
            handled: false,
            prompt: GOAL_CONTINUATION_PROMPT,
        });
    });

    it("preserves interrupted setup turns without starting continuation", () => {
        const turnCompleted = completedTurn("interrupted");
        expect(resolveGoalCommandHandleResult(turnCompleted)).toEqual({
            handled: true,
            turnCompleted,
        });
    });
});

describe("parseGoalPromptControl", () => {
    it("reads a set action with its objective", () => {
        expect(parseGoalPromptControl({lody: {goalControl: {version: 1, action: "set", objective: "Ship it"}}}))
            .toEqual({version: 1, action: "set", objective: "Ship it"});
    });

    it("reads status-only actions for sessions with no running prompt", () => {
        expect(parseGoalPromptControl({lody: {goalControl: {version: 1, action: "pause"}}}))
            .toEqual({version: 1, action: "pause"});
        expect(parseGoalPromptControl({lody: {goalControl: {version: 1, action: "clear"}}}))
            .toEqual({version: 1, action: "clear"});
    });

    it("rejects metadata that cannot name a goal action", () => {
        // A blank objective would silently become a goal with no instruction.
        expect(parseGoalPromptControl({lody: {goalControl: {version: 1, action: "set", objective: "  "}}})).toBeNull();
        expect(parseGoalPromptControl({lody: {goalControl: {version: 1, action: "stop"}}})).toBeNull();
        expect(parseGoalPromptControl({lody: {goalControl: {version: 2, action: "resume"}}})).toBeNull();
        expect(parseGoalPromptControl({lody: {}})).toBeNull();
        expect(parseGoalPromptControl(undefined)).toBeNull();
    });
});
