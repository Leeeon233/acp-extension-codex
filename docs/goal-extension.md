# Goal extension

This document defines a provider-neutral experimental ACP extension implemented by `codex-acp`. It is intentionally shaped like a possible future first-class ACP API: implementations publish `_meta.goal`, not provider-specific metadata such as `_meta.codex.goal`.

## Capability negotiation

An agent advertises support in its `initialize` response:

```json
{
  "_meta": {
    "lody": {
      "goal": {
        "version": 1,
        "actions": ["set", "pause", "resume", "clear"],
        "controlActions": ["pause", "clear"],
        "promptActions": ["set", "pause", "resume", "clear"]
      }
    }
  }
}
```

`actions` is the implementation-supported subset of `set`, `pause`, `resume`, and `clear`. Clients must not infer support for an action that is not advertised.

Actions travel on two transports, and `actions` alone does not say which:

- `controlActions` are accepted on the `_lody/session/goal` request, including while a prompt is in flight. They only move durable goal state and never start a turn. The request contains `sessionId` and `action`; `set` additionally requires a non-blank `objective`.
- `promptActions` are accepted as `session/prompt` metadata under `_meta.lody.goalControl` (`{"version": 1, "action": "resume"}`, or `"set"` with an `objective`). `set` and `resume` start work, so they must travel here: the client's prompt owns the turns they produce, and the prompt's content blocks are the fallback the adapter sends if the action started no native turn. `pause` and `clear` are accepted here too, which is how a client reaches a goal whose session has no prompt running.

`/goal set|pause|resume|clear` remains available for clients that cannot send metadata; it reaches the same code as the corresponding transport above.

## Session state

The current snapshot is published in `session_info_update._meta.lody.goal`. Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "createdAtEpochSeconds": 1710000000,
  "updatedAtEpochSeconds": 1710000012,
  "tokenBudget": null,
  "tokensUsed": 42,
  "timeUsedSeconds": 12
}
```

Common statuses are `active`, `paused`, `blocked`, `limited`, and `complete`. Optional fields allow implementations to report budgets, usage, iteration count, and the last continuation reason. Absolute timestamps are Unix epoch seconds.

## Lifecycle architecture

A goal belongs to the ACP session. Its durable state is separate from the ACP v1 prompt lifecycle:

- `status: active` means the persistent objective can drive more work; it does not mean an ACP prompt is currently executing.
- Once a prompt is executing an active goal, it remains open across native Codex turn completions and automatic continuations. Codex schedules those continuations; the adapter does not submit duplicate turns.
- The prompt returns only after the goal becomes complete, paused, blocked, limited, or cleared and the final native turn has drained. A failed or interrupted turn also ends the prompt. Goal completion before the last text chunk does not truncate that output.
- `/goal set` (an objective), `/goal resume`, and their `_meta.lody.goalControl` equivalents follow the same lifecycle. An explicit continuation prompt is needed only when the goal control operation started no native turn at all.
- `pause` and `clear` on the control request take effect immediately, including mid-prompt. The open prompt observes the status change and returns once its final native turn drains, so a paused goal can still be running out its last turn.
- Cancellation pauses the goal before returning, including when cancelled between native turns. Connection loss fails the pending prompt.
- While a prompt is open, clients use steering or prompt queueing when advertised. A stored active goal outside a prompt does not establish live presence.

This uses the standard ACP v1 request/response completion boundary: one prompt may contain multiple model exchanges. It requires no Core execution extension. A v2 implementation should use standard `state_update` notifications instead of treating prompt acceptance as completion.

## Codex mapping and compatibility

Codex `thread/goal/*` notifications map into the neutral snapshot. Provider statuses `usageLimited` and `budgetLimited` map to `limited`; Codex second-based timestamps are converted to Unix milliseconds. `/goal` remains the user-facing way to set, pause, resume, or clear a goal.

The control request is `_lody/session/goal` (`LODY_EXTENSION_METHODS.sessionGoal`). Older aliases are not advertised and no provider-specific goal metadata is emitted.
