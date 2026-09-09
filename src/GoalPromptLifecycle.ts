import type {ServerNotification} from "./app-server";
import type {TurnCompletedNotification} from "./app-server/v2";

/**
 * One ACP v1 prompt can own several native Codex turns. Observe the native
 * continuation rather than starting another turn (Codex owns goal scheduling).
 * This observer exists only while a prompt is open; a stored goal alone never
 * starts a prompt or establishes live presence.
 */
export class GoalPromptLifecycle {
    private goalActive: boolean;
    private currentTurnId: string | null = null;
    private completed: TurnCompletedNotification | null = null;
    private failure: Error | null = null;
    private waiter: (() => void) | null = null;
    private cancelled = false;

    constructor(private readonly sessionId: string, goalActive: boolean) {
        this.goalActive = goalActive;
    }

    startTurn(turnId: string): void {
        if (this.currentTurnId === turnId) return;
        this.currentTurnId = turnId;
        this.completed = null;
    }

    prepareTurn(): void {
        this.currentTurnId = null;
        this.completed = null;
    }

    /** A delayed turn/start response must not overwrite already-observed native work. */
    startSubmittedTurn(turnId: string): boolean {
        if (this.currentTurnId !== null || this.completed !== null) return false;
        this.startTurn(turnId);
        return true;
    }

    observe(event: ServerNotification): void {
        if (event.method === "thread/goal/updated" && event.params.threadId === this.sessionId) {
            this.goalActive = event.params.goal.status === "active";
        } else if (event.method === "thread/goal/cleared" && event.params.threadId === this.sessionId) {
            this.goalActive = false;
        } else if (event.method === "turn/started" && event.params.threadId === this.sessionId) {
            this.startTurn(event.params.turn.id);
        } else if (event.method === "turn/completed" && event.params.threadId === this.sessionId) {
            this.recordCompletion(event.params);
        } else {
            return;
        }
        this.waiter?.();
    }

    private recordCompletion(event: TurnCompletedNotification): void {
        this.completed = event;
        if (this.currentTurnId === event.turn.id) this.currentTurnId = null;
    }

    cancel(): void {
        this.cancelled = true;
        this.waiter?.();
    }

    fail(error: Error): void {
        this.failure = error;
        this.waiter?.();
    }

    async waitForCompletion(first: TurnCompletedNotification): Promise<TurnCompletedNotification | null> {
        // /review may execute on another thread, outside this session's goal.
        if (first.threadId !== this.sessionId) return first;
        // The serialized event handler may already have observed later turns by
        // the time runTurn's promise resumes. Never replace their state with A.
        if (this.completed === null) this.recordCompletion(first);
        const result = await new Promise<TurnCompletedNotification | null>((resolve, reject) => {
            this.waiter = () => {
                if (this.failure) reject(this.failure);
                else if (this.cancelled && this.currentTurnId === null) resolve(null);
                else if (this.completed && this.currentTurnId === null &&
                    (!this.goalActive || this.completed.turn.status !== "completed")) {
                    resolve(this.completed);
                }
            };
            this.waiter();
        }).finally(() => { this.waiter = null; });
        return result;
    }
}
