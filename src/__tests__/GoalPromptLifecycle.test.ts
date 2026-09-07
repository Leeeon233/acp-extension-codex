import {describe, expect, it} from "vitest";
import {GoalPromptLifecycle} from "../GoalPromptLifecycle";
import type {ThreadGoalStatus, TurnCompletedNotification} from "../app-server/v2";

function completion(id: string, status: "completed" | "interrupted" | "failed" = "completed"): TurnCompletedNotification {
    return {threadId: "session", turn: {
        id, status, items: [], itemsView: "notLoaded", error: null,
        startedAt: null, completedAt: null, durationMs: null,
    }};
}

function updateGoal(lifecycle: GoalPromptLifecycle, status: ThreadGoalStatus): void {
    lifecycle.observe({method: "thread/goal/updated", params: {
        threadId: "session", turnId: null, goal: {
            threadId: "session", objective: "Synthetic goal", status,
            tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
        },
    }});
}

describe("ACP v1 goal prompt lifecycle", () => {
    it("returns an ordinary turn without waiting for a goal", async () => {
        const lifecycle = new GoalPromptLifecycle("session", false);
        lifecycle.startTurn("a");
        await expect(lifecycle.waitForCompletion(completion("a"))).resolves.toEqual(completion("a"));
    });

    it("keeps one prompt open across native continuations and drains the final turn", async () => {
        const lifecycle = new GoalPromptLifecycle("session", false);
        lifecycle.startTurn("a");
        updateGoal(lifecycle, "active");
        let settled = false;
        const result = lifecycle.waitForCompletion(completion("a")).finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        lifecycle.observe({method: "turn/started", params: {threadId: "session", turn: {...completion("b").turn, status: "inProgress"}}});
        updateGoal(lifecycle, "complete");
        await Promise.resolve();
        expect(settled).toBe(false);
        lifecycle.observe({method: "turn/completed", params: completion("b")});
        await expect(result).resolves.toEqual(completion("b"));
    });

    it("retains a continuation that starts before the original completion promise resumes", async () => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        lifecycle.startTurn("a");
        lifecycle.observe({method: "turn/completed", params: completion("a")});
        lifecycle.startTurn("b");
        expect(lifecycle.startSubmittedTurn("a")).toBe(false);
        const result = lifecycle.waitForCompletion(completion("a"));
        updateGoal(lifecycle, "paused");
        lifecycle.observe({method: "turn/completed", params: completion("b")});
        await expect(result).resolves.toEqual(completion("b"));
    });

    it.each(["paused", "blocked", "budgetLimited", "usageLimited", "complete"] as const)("releases a between-turn wait when the goal becomes %s", async status => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        const result = lifecycle.waitForCompletion(completion("a"));
        updateGoal(lifecycle, status);
        await expect(result).resolves.toEqual(completion("a"));
    });

    it("releases a cleared goal between turns", async () => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        const result = lifecycle.waitForCompletion(completion("a"));
        lifecycle.observe({method: "thread/goal/cleared", params: {threadId: "session"}});
        await expect(result).resolves.toEqual(completion("a"));
    });

    it.each(["interrupted", "failed"] as const)("does not wait for a goal update after a %s turn", async status => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        lifecycle.startTurn("a");
        await expect(lifecycle.waitForCompletion(completion("a", status))).resolves.toEqual(completion("a", status));
    });

    it("cancels between native turns", async () => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        const result = lifecycle.waitForCompletion(completion("a"));
        lifecycle.cancel();
        await expect(result).resolves.toBeNull();
    });

    it("fails a between-turn wait when the connection closes", async () => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        const result = lifecycle.waitForCompletion(completion("a"));
        lifecycle.fail(new Error("connection closed"));
        await expect(result).rejects.toThrow("connection closed");
    });

    it("does not bind a review on another thread to the session goal", async () => {
        const lifecycle = new GoalPromptLifecycle("session", true);
        const review = {...completion("review"), threadId: "review-thread"};
        await expect(lifecycle.waitForCompletion(review)).resolves.toEqual(review);
    });
});
