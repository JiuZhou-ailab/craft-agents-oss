# Sessions

`SessionManager.ts` is the Product Host session Facade: it implements `ISessionManager` (handlers/session-manager-interface.ts) as one-line delegates, and keeps only the cross-cutting orchestration that changes for reasons of its own — sendMessage/processEvent projection, rewind, Project transition/operation draining, configWatcher/automations glue, session create/delete, permission/question responders.

Modules by reason-of-change (all flat in this directory):

| Module | Owns |
| --- | --- |
| `session-broadcaster.ts` | Event sink fan-out: sendEvent, broadcast*, delta batching |
| `share-service.ts` | shareToViewer / updateShare / revokeShare |
| `message-edits.ts` | Message annotation add/update/remove + updateMessageContent |
| `plan-tracking.ts` | Pending plan execution state (five plain functions over ManagedSession) |
| `session-crud-metadata.ts` | Flag/archive/status/connection/rename/model/labels/thinking/read-state/viewing-session metadata |
| `auth-flow.ts` | reinitializeAuth, completeAuthRequest, credential input handling |
| `export-import.ts` | Session export/import incl. remote transfer payloads |
| `persistence.ts` | Boot/init gate, disk load, debounced persist queue, lazy message load, idle release |
| `agent-runtime-lease.ts` | Per-session send-admission gates, runtime mutex, and shared-subprocess lease counting |
| `isolated-test-runner.ts` | Shared Bun subprocess + marked JSON parsing for lifecycle tests |
| `agent-runtime.ts` | Pi subprocess lifecycle: getOrCreateAgentLocked, runtime refresh, three eligible idle runtimes, credential rotation, confirmed disposal; AGENT_FLAGS |
| `wire-agent-callbacks.ts` | Post-construction product callback wiring onto a live agent |
| `browser-pane-bridge.ts` | browser_* tool delegation to BrowserPaneManager |
| `source-bridge.ts` | buildServersFromSources shared by source reload paths (bridge updates call `agent.applyBridgeUpdates(...)` directly) |

Pre-existing support modules: `managed-session.ts` (ManagedSession state assembly), `runtime-config.ts` (runtime/restart signatures), `pi-turn-anchors.ts` (provider fork anchors), `tool-display.ts` (UI tool projection), `turn-watchdog.ts` (absolute turn safety limit), `managed-gateway-auth-error.ts`, `write-original-content.ts`, `session-runtime.ts` (host singletons + pure helpers incl. getLastFinalOutputMessageId).

Module wiring rule: stateful modules receive a narrow deps object of arrow functions resolving through the Facade (`this`) at call time, so per-instance test stubs on SessionManager keep working; stateless helpers are plain functions taking `ManagedSession` directly. Adjacent `*.test.ts` files verify these boundaries and durable session behavior.

Automatic Session cleanup uses the `deleteIfEmpty` Session command. The Host checks loaded messages and active operations atomically with the deletion tombstone under the Project lock; cold or busy Sessions are retained. Explicit user deletion remains separate. Clients never fall back to unconditional deletion when an older server rejects the new command. Send acknowledgement loss is an unknown outcome, not permission to delete or replay the request.

Permission responses must match a pending request owned by the live Session and still awaited by Pi. The explicit `permissionMode: 'allow-all'` response option uses the same metadata mutation as the mode selector before resuming Pi's native `tool_call` hook; this updates the runtime, broadcasts the mode, and persists its metadata. Project execute consent remains process-scoped: writable Session metadata does not restore authorization after restart. Single-tool and administrator approvals do not implicitly change Session mode.

Standalone scheduled tasks live in the free-conversation runtime and start at Host boot even when no Project is registered. Matcher `sessionId` binds runs to a persisted conversation; dispatch retains its model and permissions, uses the normal send queue, and rejects unavailable targets without creating replacements. Legacy matchers without a binding continue creating per-run sessions.

Every send serializes its short admission phase per Session: loading, queue selection, persistence, and claiming the processing generation. The gate releases before model execution, so concurrent sends durably queue rather than overwrite the active turn. Bound automation validation hands off synchronously to the send's own operation lease; validation never retains a lease while cold runtime acquisition waits for active operations to drain.

Session titles derive from the user-visible request: context badges and edit instructions do not enter first-title inference. The full original message remains unchanged in the transcript; explicit title refresh also strips edit metadata.

Idle runtime residency is independent of the transcript cache. Operation drain and native Pi settlement trigger an opportunistic sweep, keeping the three most recently used eligible runtimes. Active leases/admission, native prompts or pending requests, queued sends, permission/auth interactions, background work, and closing Sessions are exempt. The existing per-Session mutex protects the final eligibility check, durable flush, and disposal; sweeps never wait behind user operations or trigger themselves on failure. Cleanup failures retain their original runtime/MCP owners and block replacement until the same cleanup succeeds. Native history is restored through the existing Pi creation path, without replaying the user request.
