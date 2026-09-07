# Core Electron E2E
`run.ts` drives the built desktop app through its public preload API against a deterministic local model stub.
It covers migration from the incompatible v0.17.0 server lock, local no-login startup, managed-model login routing, the real Allow All button and subsequent Pi tools, safe Session cleanup, isolated workspace versions, restore, and restart recovery including the Host's renewed-consent policy for Projects.
Run `bun run e2e:core`; set `CRAFT_E2E_ELECTRON_BIN` to a packaged app executable to test the release artifact.

`startup-recovery.ts` generates an isolated offline fixture and verifies conversation loading with the file pane closed, last-session selection, project/free-conversation cold restart, and automatic blank composers without duplicate sessions. After building Electron, run `bun e2e/core/startup-recovery.ts`; use `VITE_DEV_SERVER_URL=http://localhost:5173` to check the development renderer. It sends no messages or model requests and cleans up its fixture.

`scheduled-task-creation.ts` verifies project-independent creation, the same standalone task list from project and free-conversation windows, and restart with zero registered projects. Run `VITE_DEV_SERVER_URL=http://localhost:5173 bun e2e/core/scheduled-task-creation.ts` after building the Electron main process, or omit the environment variable to test the built renderer. The isolated fixture uses a disabled task; typed drafts are dismissed without submission.

`scheduled-task-submit.ts` presses Enter in the actual creation composer from both a Project and free conversations, then asserts the same window displays the bound session, its user message and model reply, and a persisted disabled schedule. Returning through the sidebar must show one task list; clicking a task opens a centered, viewport-bounded modal while preserving the background list width. Escape and the close button dismiss details; another task can then be opened. Generated session titles use user intent without edit metadata, pinned sessions occupy a peer sidebar section, and quick pin/unpin/archive buttons persist their changes without navigating away. Hover must preserve both conversation row height and sidebar scroll height. It includes an input longer than external URL parameter limits. Run `VITE_DEV_SERVER_URL=http://localhost:5173 bun e2e/core/scheduled-task-submit.ts`; a local OpenAI-compatible stub drives real Pi tool execution without external model calls. Main-process changes require restarting Electron: the dev watcher rebuilds the bundle but does not reload the running main process.

`sources-hub.ts` verifies both free and project runtimes retain the Add Source entry, draggable headers, and a full-width overview that does not auto-select a source. Clicking a source opens a modal without resizing the list; Escape returns to the overview. Run `VITE_DEV_SERVER_URL=http://localhost:5173 bun e2e/core/sources-hub.ts`; the fixture uses only local directory sources.

`automation-panel-scope.ts` verifies a standalone task list retains its runtime data when a second chat panel receives focus. Run `VITE_DEV_SERVER_URL=http://localhost:5173 bun e2e/core/automation-panel-scope.ts`; the isolated fixture uses a disabled task and makes no model calls. Run Electron UI checks sequentially so windows do not compete for keyboard focus.

### Sidebar session ownership and drag

Run `VITE_DEV_SERVER_URL=http://localhost:5173 bun e2e/core/session-sidebar.ts` after building main/preload.
The isolated offline fixture creates named project conversations, checks pinned drag order,
drags a pinned conversation back into its project, verifies the saved unpin through the owner-scoped API,
and checks pin-button projection. Cross-server routing and connection cleanup are covered in
`apps/electron/src/transport/__tests__/routed-client.test.ts`; this Electron check does not connect to remote servers.
