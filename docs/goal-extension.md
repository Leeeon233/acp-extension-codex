# Goal extension

This document defines a provider-neutral experimental ACP extension implemented by `codex-acp`. It is intentionally shaped like a possible future first-class ACP API: implementations publish `_meta.goal`, not provider-specific metadata such as `_meta.codex.goal`.

## Capability negotiation

An agent advertises support in its `initialize` response:

```json
{
  "_meta": {
    "goal": {
      "version": 1,
      "controlMethod": "_session/goal",
      "actions": ["set", "pause", "resume", "clear"]
    }
  }
}
```

`actions` is the implementation-supported subset of `set`, `pause`, `resume`, and `clear`. Clients must not infer support for an action that is not advertised. The control request contains `sessionId` and `action`; `set` additionally requires a non-blank `objective`.

## Session state

The current snapshot is published in `session_info_update._meta.goal`. Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "createdAt": 1710000000000,
  "updatedAt": 1710000012000,
  "tokenBudget": null,
  "tokensUsed": 42,
  "timeUsedSeconds": 12,
  "controlMethod": "_session/goal"
}
```

Common statuses are `active`, `paused`, `blocked`, `limited`, and `complete`. Optional fields allow implementations to report budgets, usage, iteration count, and the last continuation reason. Timestamps are Unix milliseconds.

## Lifecycle architecture

A goal belongs to the ACP session. Its durable state is separate from the ACP v1 prompt lifecycle:

- `status: active` means the persistent objective can drive more work; it does not mean an ACP prompt is currently executing.
- Once a prompt is executing an active goal, it remains open across native Codex turn completions and automatic continuations. Codex schedules those continuations; the adapter does not submit duplicate turns.
- The prompt returns only after the goal becomes complete, paused, blocked, limited, or cleared and the final native turn has drained. A failed or interrupted turn also ends the prompt. Goal completion before the last text chunk does not truncate that output.
- `/goal set` (an objective) and `/goal resume` follow the same lifecycle. An explicit continuation prompt is needed only when the goal control operation started no native turn at all.
- Cancellation pauses the goal before returning, including when cancelled between native turns. Connection loss fails the pending prompt.
- While a prompt is open, clients use steering or prompt queueing when advertised. A stored active goal outside a prompt does not establish live presence.

This uses the standard ACP v1 request/response completion boundary: one prompt may contain multiple model exchanges. It requires no Core execution extension. A v2 implementation should use standard `state_update` notifications instead of treating prompt acceptance as completion.

## Codex mapping and compatibility

Codex `thread/goal/*` notifications map into the neutral snapshot. Provider statuses `usageLimited` and `budgetLimited` map to `limited`; Codex second-based timestamps are converted to Unix milliseconds. `/goal` remains the user-facing way to set, pause, resume, or clear a goal.

`_codex/session/goal_control` remains accepted as a legacy alias, but new clients discover and use `_session/goal`. The alias is not advertised and no provider-specific goal metadata is emitted.
