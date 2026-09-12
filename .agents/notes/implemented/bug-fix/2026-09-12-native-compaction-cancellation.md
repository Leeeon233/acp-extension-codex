# Native terminal evidence for compaction cancellation

Status: implemented
Translation: pending

## Abstract

Stop before a submitted compaction's native turn starts must retain prompt ownership
through native termination. A local interrupted completion previously released that
ownership after the interrupt acknowledgement. Compaction now bypasses that local
fallback, and its waiter resolves only from a native `turn/completed` notification.
Other turn interruption behavior is unchanged.

## Decision and evidence

`CodexAcpServer.interruptLateStartedTurn` marks a cancelled compaction turn stale and
requests interruption without calling `resolveTurnInterrupted`. `CodexAppServerClient`
settles compact waiters at the native notification boundary, before stale-event
filtering; its shared local completion helper cannot settle them. Connection closure
continues to reject pending waiters.

The regression explicitly holds and releases the interrupt acknowledgement, drains
promise continuations with fake timers, and checks that the prompt remains occupied
until native termination. Both pre-start Stop and request-abort failed on the earlier
implementation. A separate boundary test also reproduced synthetic completion
incorrectly settling compaction.

Validation passed: adapter typecheck, 617 tests (27 existing gated skips), and a
real Codex 0.153.4 run with Stop sent before native start. That run observed native
`interrupted` before the ACP prompt returned `cancelled`.

Contract: [Codex app-server](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn).
Implementation and validation: [adapter PR #41](https://github.com/LodyAI/acp-extension-codex/pull/41).
