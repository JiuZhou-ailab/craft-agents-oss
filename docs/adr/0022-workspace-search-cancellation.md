# Workspace Search cancellation

Status: Accepted — Spec #29, 2026-09-08.

Workspace Search owns two ripgrep scans. Discarding a renderer response does not stop those scans.

Add `search:cancelWorkspace(requestId)`. The server keys active searches by trusted transport client ID, resolved runtime workspace ID, and request ID. Cancellation is idempotent; it cannot target another client or workspace. Existing query arguments and successful results remain unchanged. Cancelled queries return the additive `cancelled` status; failures and timeouts retain `unavailable` semantics.

The renderer uses UUID request IDs and cancels on effect cleanup. Only `CHANNEL_NOT_FOUND` permits old-host fallback to response discard and the existing timeout. Other cancellation failures remain observable in diagnostics.

Transport supplies an optional workspace-lifetime AbortSignal, aborted on disconnect or workspace change and renewed on reconnect. This is lifecycle notification, not a general request cancellation protocol. Search combines that signal with its request controller and aborts both child processes. Completion removes listeners and its exact registry entry; stale cleanup cannot remove a newer search. Termination waits for child exit, with a bounded kill fallback.

No indexes, persistence changes, global query cache, or runtime eviction are introduced.
