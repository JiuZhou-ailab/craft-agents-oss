# Sidebar design QA

## Sources

- Existing implementation:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-bf07de50-d5a4-491b-9fa9-e7cb1e116cb4.png`
- Codex reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-b4d29db0-df2c-489f-a719-ff1efbed6165.png`
- Combined comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8e31-52d0-7363-95f5-3213b0c0891d/sidebar-qa/sidebar-final-comparison.png`

The Electron QA app used a 1195 × 768 viewport in the user's dark theme. The
references use a taller light-theme window, so color and visible item count are
theme/viewport differences rather than fidelity defects. The comparison is
focused on hierarchy, spacing, disclosure behavior, and fixed regions.

## Iteration 1

P1 findings:

- The active project was removed from the normal project loop and rendered in a
  separate block, so it jumped to the top and used different row geometry.
- A negative horizontal margin made the tree wider than its scroll container,
  causing the horizontal scrollbar and inconsistent left/right insets.
- Project Hub displayed Skills, Sources, Search, Settings, and What's New as
  disabled because navigation required an already-active runtime.

Root fixes:

- Render every project through one stable ordered loop and insert the active
  native directory at that project's existing position.
- Use one horizontal inset system and clip horizontal overflow at both the rail
  and native tree boundaries.
- Resolve global navigation against the active runtime or the most recently
  accessed project.

## Iteration 2

Electron evidence:

- `sidebar-final-project-hub.png`: one sidebar, top tools enabled, recent
  conversations limited, projects grouped, profile fixed at the bottom.
- `sidebar-final-directory.png`: the active project remains fifth in the list,
  uses the same folder-row geometry, and expands its native file tree in place.
- `sidebar-final-collapsed.png`: the Projects header collapses every project as
  one collection.
- `sidebar-final-profile-menu.png`: Account & Points, Settings, What's New, and
  Help & Feedback are enabled inside the single Profile item.
- `sidebar-final-skills-route.png`: one click from Project Hub activates the
  fallback project and opens the Skills route.

Fidelity checks:

- Typography and icons continue to use the existing product system.
- Top item order is Skills, Sources, Search.
- Recent conversations and Projects use matching section-header disclosure.
- Project rows share one left edge, one chevron column, one folder column, and
  one active-row treatment.
- The rail has one vertical scrolling region and no horizontal scrollbar.
- Standalone Writing Workspace and Check Updates items are absent.
- No new raster assets or decorative styling were introduced.
- No P0, P1, or P2 visual or interaction differences remain.

Final result: passed.

## Context menu design QA — 2026-07-23

### Sources

- Existing implementation:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-9d5990eb-9acf-4c17-9432-566f1c564934.png`
- Codex reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-5ad0ca43-409e-4558-81dc-e94fc493f393.png`
- Electron implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-qa/context-menu-implementation-open.jpg`
- Combined comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-qa/context-menu-comparison.png`

The Electron QA app used a 1108 × 768 light-theme viewport. The Codex
reference is a Retina crop, so the comparison normalizes the images for
hierarchy and density rather than treating raw pixel size as CSS size.

### Iteration 1

P1 findings:

- The project menu behaved like an eight-row creation palette instead of a
  project context menu.
- Create and import were repeated once per writing area, making related actions
  harder to scan.
- Sources and Skills duplicated global navigation that is already visible at
  the top of the activity rail.
- Tall rows, three separators, and generous padding made a local project action
  feel disproportionately prominent.

Root fixes:

- Group manuscript, global-information, and free-area creation under one
  `New file` submenu.
- Group the corresponding import actions under one `Import file` submenu.
- Remove duplicate Sources and Skills entries.
- Add the project-scoped Finder, new-window, and rename actions already used by
  the surrounding project-management flow.
- Match the Codex reference's compact rhythm with 28 px rows, 13 px labels,
  16 px library icons, a 6 px item radius, and a 12 px menu radius.

### Iteration 2

Electron evidence:

- The root context menu renders five scan-friendly entries with no separators.
- `New file` exposes manuscript, global-information, and free-area actions in a
  nested menu; the nested menu and its three entries are present in the live
  Electron accessibility tree.
- `Import file` uses the same grouped structure.
- Rename reuses the existing project rename dialog; Finder and new-window reuse
  the existing project-management callbacks.
- No delete action is offered for the active project.

Fidelity checks:

- Typography, colors, shadows, and icons continue to use the existing product
  system and Lucide library.
- The change borrows Codex's density and project semantics without copying its
  unrelated pin or archive actions.
- File and folder row context menus retain their existing behavior and spacing.
- No new raster assets or decorative styling were introduced.
- No P0, P1, or P2 visual or interaction differences remain.

final result: passed

## Model thinking label and slash active marker QA — 2026-09-04

### Evidence

- Before implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/model-label-slash-indicator-2026-09-04/before.jpeg`
- Final Electron implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/model-label-slash-indicator-2026-09-04/after.jpeg`
- Focused before/after comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/model-label-slash-indicator-2026-09-04/before-after-focus.png`

The captures are native 1x Electron screenshots at 768 px height. The before
window is 1097 px wide and the final window is 1047 px wide; the focused crops
use the same 650 × 480 px region without density normalization. State: light
theme, new free conversation, slash menu open, direct mode active.

### Findings

- The compact model control now reads `Gemini 3.5 Flash · 无思考`; the repeated
  category label in `思考: 无思考` is gone from both the visible control and its
  tooltip.
- The active direct-mode marker is now a 12 px blue circle with an 8 px white
  check. It remains recognizable without competing with the 14 px row icon or
  the command label.
- The slash menu geometry, row density, keyboard selection, and composer layout
  are unchanged.

### Required fidelity surfaces

- Fonts and typography: existing sizes and weights remain unchanged; only the
  redundant label was removed.
- Spacing and layout rhythm: the smaller marker preserves row alignment and
  increases trailing whitespace.
- Colors and visual tokens: the active state uses the existing `blue-500`
  product indicator color.
- Image quality and asset fidelity: Lucide check rendering remains sharp at the
  native capture density; no bitmap assets changed.
- Copy and content: model and thinking values remain visible and accessible.

No actionable P0, P1, or P2 visual or interaction difference remains within
the requested scope.

final result: passed

## Opening tips and slash selection QA — 2026-09-04

### Evidence

- Source screenshot:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-525d3ba1-f61b-416b-afa6-d9624de23ce2.png`
- Full implementation before the timed change:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/opening-tips-2026-09-04/tips-before.jpeg`
- Full implementation after the timed change:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/opening-tips-2026-09-04/tips-after.jpeg`
- Slash-menu implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/opening-tips-2026-09-04/slash-menu.jpeg`
- Focused source/implementation alignment comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/opening-tips-2026-09-04/alignment-comparison.png`
- Focused before/after rotation comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/opening-tips-2026-09-04/tip-rotation-comparison.png`

The source is a 2270 × 2402 px user capture. The implementation is a 1097 ×
768 px live Electron capture in light theme, free-conversation empty state.
The source and implementation have different viewport sizes and capture
density, so the focused comparison normalizes the central content region
rather than asserting pixel-for-pixel scale parity.

### Comparison history and findings

- Before: a centered 520 px list container left-aligned short lines, moving the
  visible text mass left of the centered heading.
- After: the list keeps its 520 px ceiling but shrink-wraps its content; the
  heading, context, hint, and longest tip line now share the same visual center.
- A live accessibility-tree comparison captured one three-tip group, waited
  10.5 seconds, and captured a different three-tip group without user input.
- The active slash-mode marker is now 12 px instead of 16 px, with an 8 px
  check glyph. The existing filled-circle language and accessible item state
  remain unchanged.
- Hovering or focusing the tip list pauses rotation, and reduced-motion users
  keep a stable set. No new dependency, asset, or animation framework was added.

Focused tests: 26 passed, 0 failed. Electron TypeScript, targeted ESLint (no
errors), renderer production build, and `git diff --check` passed. The four
reported ESLint hook warnings predate this change and occur outside the edited
opening-state effect.

final result: passed

## Settings sidebar density alignment — 2026-09-03

### Sources

- Main-sidebar and previous settings state:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/token-activity-qa-v2/storyflow-token-activity-final.png`
- 208 px intermediate implementation:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-09-03 at 2.20.54 AM.jpeg`
- Final Electron implementation:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-09-03 at 2.21.58 AM.jpeg`

The final capture is 1098 × 736 px in the same light-theme account-settings
state. The earlier capture and final implementation were reviewed together.

### Findings and fixes

- P2: settings navigation used 44 px rows, 14 px labels, 12 px gaps, and a
  2 px focus ring; the main activity rail uses a visibly tighter 32 px / 13 px
  navigation rhythm. The settings rows now use that same contract.
- P2: the first compact pass left the settings rail at 208 px. The final rail is
  160 px while retaining the existing 56 px compact breakpoint. The longest
  label truncates instead of changing row geometry.
- Selection, hover, active, focus, radius, and sidebar background now reuse the
  activity rail's existing semantic token values.
- No P0, P1, or P2 visual differences remain within the requested sidebar
  density and style scope.

The 208 px and 160 px captures were compared at the same 1098 × 736 viewport,
theme, route, and selection state. Focused inspection was not needed because
the changed rail boundary and label truncation are legible in the full view.
Electron TypeScript, the production renderer build, focused Electron ESLint,
and `git diff --check` passed.

final result: passed

## Token activity and window shadow QA — 2026-09-03

### Sources

- Existing Storyflow window edge:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-d7861b06-65a8-4975-bf34-5b1251fc0498.png`
- Codex token activity reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-efdbe0a5-4549-4cab-8b12-f7f368e0ab9a.png`
- Final default state:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/token-activity-qa-v2/storyflow-token-activity-final.png`
- Final hover state:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/token-activity-qa-v2/storyflow-token-activity-hover.png`

The implementation is a 3208 × 2406 Retina capture of the 1604 × 1203 CSS-pixel
Electron window. State: light theme, App settings, free-conversation workspace;
daily history is empty while persisted all-time usage and tool calls exist.

### Root fixes and evidence

- The macOS native window shadow is disabled at BrowserWindow construction and
  again before first paint; a 1 px low-contrast inside edge retains separation
  without recreating the dark outside band.
- Token activity remains a one-year grid heatmap. The day/week/month segmented
  control deterministically changes the aggregate represented by each grid cell.
- The five-column summary, activity heatmap, activity insights, and top-tool counts
  follow the supplied Codex reference. Tool counts
  are derived from persisted tool messages in the active workspace. The final
  UI total of 893 matches the 893 durable tool records on disk; reads are
  serialized and deduplicated so transcript release cannot race the aggregate.
- Pointer hover highlights a cell and its tooltip shows the period start
  and exact Token total.
- A width correction removed the transient horizontal scrollbar and invalid
  non-image icon data is no longer rendered as a broken asset.
- Historical totals collected before daily tracking remain explicitly
  separated instead of being assigned to fabricated dates.
- Daily, weekly, and monthly views are all interactive. Weekly cells share the
  Sunday-start heatmap-column aggregate and monthly cells share the calendar-month aggregate;
  no synthetic activity is assigned to untracked history.

### Required fidelity surfaces

- Typography: existing Storyflow type system, weight hierarchy aligned to the
  reference summary and two-column statistics layout.
- Spacing and layout: five equal summary cells, one-year grid, month labels,
  insights, and top tools fit the settings content without clipping or scroll.
- Colors and shadows: empty activity is neutral gray; non-zero levels use four
  blue intensities; native outer window shadow is absent.
- Assets: no new decorative assets; tool icons render only from valid embedded
  image data.
- Copy: visible labels and hover content are localized.

No actionable P0, P1, or P2 visual or interaction difference remains within
the implemented Token-activity scope.

Focused tests, Electron TypeScript, Electron lint, renderer production build,
and `git diff --check` passed. Existing repository lint warnings are unchanged.

final result: passed

## Settings usage, slash palette, and opening tips QA — 2026-09-04

### Sources and implementation evidence

- Annotated settings source:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/settings-reference.png`
- Codex slash-palette reference:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/slash-reference.png`
- Final slash implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/slash-implementation.jpeg`
- Weekly hover implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/usage-week-hover.jpeg`
- Monthly hover implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/usage-month-hover.jpeg`
- Focused settings comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/settings-comparison.png`
- Focused slash comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/slash-comparison.png`
- Focused weekly/monthly hover comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/09/03/01a0684e-3907-7bf1-b494-b7737148226a/storyflow-ui-qa/period-hover-comparison.png`

The live Electron checks used a 1097 × 768 light-theme viewport in the free
conversation workspace. Full-window captures were inspected first, then the
settings header, slash palette, and heatmap states were cropped and normalized
for focused comparison.

### Iteration history

- P2: the account identity and usage content were stacked under one App page,
  creating redundant separators and hierarchy. They now live on dedicated
  Profile and Usage pages; each standalone card keeps its complete boundary.
- P2: weekly and monthly values were aggregated but hover still behaved like a
  single-day cell. Hover now keys every cell by its selected period, dims the
  rest, and outlines the full Sunday-start week column or calendar-month group.
- P1: the slash interaction used a narrow caret-following menu with section
  headings, separators, and a footer. The final panel anchors to the composer,
  matches its width, uses one scrollable flat list, keeps label and description
  on one line, and preserves pointer plus arrow/Enter/Tab/Escape behavior.
- P2: general-chat onboarding selected one tip. The final state samples three
  unique items on mount from eight relevant localized guidance strings, rotates
  them every ten seconds, and resets the sample for each conversation.
- The first live weekly check made empty grouped cells too subtle. A second pass
  increased surrounding dimming and added a restrained outline to every cell in
  the hovered period; the weekly and monthly focused capture confirms the group.

### Required fidelity surfaces

- Typography and icons reuse Storyflow's existing type scale, semantic colors,
  Lucide icons, and installed UI primitives.
- The slash panel is visually distinct from the composer through its own border,
  background, radius, and shadow, while retaining the reference's shared width.
- Selected slash rows have a clear neutral highlight; descriptions remain muted
  without section chrome competing for attention.
- Heatmap layout remains the requested one-year grid and does not collapse into
  a line or bar chart.
- Account and usage are separate settings destinations, so the annotated stacked
  separators no longer exist.
- Three opening tips were visible in the live accessibility tree; after ten
  seconds the group changed without turning the tips into action buttons.

No actionable P0, P1, or P2 visual or interaction differences remain within
the four requested corrections.

final result: passed

## Sources Hub refactor standard — 2026-09-04

This is the implementation contract for aligning Sources with the Skills Hub
information architecture. It is not implementation evidence.

### Information architecture

- The Sources navigation entry opens one full-width `SourcesHubPage` with
  `Discover` and `Added` tabs, matching the Skills Hub page shell and density.
- `Discover` reuses the existing MCP Registry search, review, endpoint display,
  admission decision, and add flow. API and local-directory sources remain
  explicit create actions because they are not remotely discoverable packages.
- `Added` renders every API, MCP, and local source from `sourcesAtom`. Selecting
  an item opens the existing `SourceInfoPage`; back navigation restores the tab,
  query, filter, and scroll position.

### Domain and state boundaries

- Shared page structure does not imply a shared package protocol. Sources must
  not inherit Skill bundle, checksum receipt, version-upgrade, or install-scope
  behavior.
- MCP Registry entries are read-only discovery metadata that create a local
  Source. Enabled state, connection state, permission state, and credential
  references remain local and workspace-scoped.
- `sourcesAtom` and `sources:changed` remain the single live state path. Add,
  edit, and delete must not maintain a second copied catalog or require refresh.

### Safety and acceptance

- Discovery never probes an endpoint, requests credentials, or starts runtime
  traffic before the user confirms adding the Source. Endpoint and transport
  remain visible before confirmation.
- `Discover` and `Added` have explicit loading, empty, error, retry, keyboard,
  focus, and light/dark states using the existing Storyflow design tokens.
- Adding or deleting updates counts and lists immediately. Workspace changes do
  not leak Sources, credentials, permissions, or connection state across scope.
- API, MCP, and local Sources are searchable and filterable in `Added`; detail,
  delete, deep-link, and back-navigation behavior remain intact.

## Activity rail help menu QA — 2026-08-06

### Sources

- Codex reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-e23387f9-0bc2-47b3-9914-03ae653c8ab7.png`
- Electron main-window capture:
  `/Users/dingzhijian/.codex/visualizations/2026/08/06/019fd738-055e-7851-986c-268ab66b0039/help-menu-qa/help-menu-implementation-open-v2.jpg`
- Focused source/implementation comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/08/06/019fd738-055e-7851-986c-268ab66b0039/help-menu-qa/help-menu-comparison.png`

The reference is a 742 × 406 Retina crop. The Electron window is 1106 × 768
in the light theme. The focused comparison normalizes the persistent footer
geometry; the CUA raster file excludes the transient Radix popup, so its open
state was inspected in the live CUA capture and accessibility tree instead.

### Root fix and evidence

- Account actions remain in the profile menu; product help now has one separate
  square question-mark trigger at the bottom-right of the activity rail.
- The popup opens above and to the right of that trigger, uses the existing
  196 px dropdown width and native menu density, and keeps the reference's
  separator after `新功能`.
- The live Electron accessibility tree exposed one `帮助菜单` containing, in
  order, `新功能`, `新手教程`, and `帮助与反馈`.
- Existing release-note, Feishu tutorial, and feedback-dialog handlers are
  reused. The unread release-note indicator moved with the release-note entry.
- The profile row remains independently operable and no duplicate help actions
  remain in its menu.

No actionable P0, P1, or P2 visual or interaction differences remain within
the requested help-menu scope.

Focused help-menu test, update-entrypoint tests, ActivityRail render tests,
Electron TypeScript, targeted ESLint, and `git diff --check` passed.

final result: passed

## Workspace-aware new-task composer QA — 2026-07-30

### Sources

- User reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-4d621559-187f-434d-9d96-fd2a90cc8e7a.png`
- Earlier Storyflow rail:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/activity-rail-after-1119.png`
- Final Electron full view:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/task-workspace-context-full.png`
- Final focused composer:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/task-workspace-context-composer.png`
- Combined focused comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/task-workspace-context-comparison.png`

### Normalization and state

- Source crop: 1402 × 302 pixels at 1× density.
- Electron capture: 1400 × 1000 CSS pixels and pixels at `deviceScaleFactor=1`.
- Focused implementation crop: 384 × 231 CSS pixels and pixels at 1×.
- Combined comparison: 1400 × 320 pixels. The source is a wide Codex
  composer crop while Storyflow's composer lives in a narrower writing pane,
  so each side was scaled and centered without claiming pixel-identical width.
- State: light theme, focused project `400章长篇小说`, newly created empty
  task, workspace context visible, then context cleared to a fresh free
  conversation.

### Comparison history

Iteration 1 findings:

- P2: rail text hierarchy was too heavy at the primary action and too small at
  project/conversation rows.
- P2: the rail used the 2% foreground surface, making the full-height split
  more visible than necessary against the main background.
- P1: the primary action always created a free conversation and exposed no
  visible project scope above the composer.

Fixes:

- Use 13px/500 for the primary task action, 13px/400 for project and
  conversation rows, and retain 12px/500 only for section labels.
- Move the rail to the existing `foreground-1.5` token.
- Rename the primary action to `新建任务`, align it to the same 225 × 30
  rendered box as the navigation rows, and create inside the focused project
  when one is available.
- Show the project name with the existing Lucide folder and close icons above
  the composer only while the new task is empty. Closing it opens a fresh free
  conversation instead of mutating the project session's workspace identity.

Iteration 2 evidence:

- The final full-view capture shows a quieter rail/main boundary while
  preserving enough surface separation to identify navigation.
- Computed styles report the task action at 13px/500 and project rows at
  13px/400.
- The new-task and first navigation rows both render at 225 × 30 pixels.
- The focused comparison shows the project name and close affordance in the
  same above-composer location as the reference. `本地` and branch controls are
  intentionally omitted per the requested Storyflow scope.

### Required fidelity surfaces

- Fonts and typography: native product font stack is preserved; primary and
  body weights now follow a restrained 500/400 hierarchy with no 600-weight
  sidebar action.
- Spacing and layout rhythm: new-task and navigation rows have identical
  width/height; the workspace row uses the composer's existing max-width and
  horizontal padding.
- Colors and visual tokens: only existing semantic tokens are used. The rail
  is a 1.5% foreground mix over the main background; hover and active states
  remain distinguishable.
- Image quality and assets: no raster assets are required. Existing Lucide
  `SquarePen`, `Folder`, and `X` icons remain sharp at the captured density.
- Copy and content: `新建任务`, the actual focused workspace name, and
  `切换为自由对话` accurately describe the behavior.

### Interaction and build evidence

- Clicking `新建任务` from the focused project created an empty project task
  and rendered `400章长篇小说` above the composer.
- Clicking the close control removed the project context and the active
  runtime returned only sessions under `__storyflow_free__`.
- No renderer exceptions were captured.
- 34 focused tests, Electron TypeScript, targeted ESLint, renderer production
  build, and `git diff --check` passed.

No actionable P0, P1, or P2 differences remain.

final result: passed

## Activity rail visual hierarchy QA — 2026-07-30

### Sources

- Source visual truth:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-b7edabce-02b4-4560-ba8c-42693fb337f3.png`
- Rendered Electron implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/activity-rail-after-1119.png`
- Normalized source crop:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/activity-rail-reference.png`
- Combined comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/30/019fb200-ef23-7fd3-a03a-655a98f32153/activity-rail-comparison.png`

The source is 3344 × 2238 physical pixels. Its 440 × 2238 WorkBuddy sidebar
crop was normalized to 220 × 1119, matching the reference's 2× density. The
Electron implementation was captured at a 1400 × 1119 CSS viewport with
deviceScaleFactor 1; its focused rail is 240 × 1119 pixels. Both use the light
theme and an idle sidebar state. The synthetic Electron fixture contains 0 free
conversations and 20 projects, so copy and item counts differ from the source
while hierarchy, density, spacing, typography, and state treatment remain
directly comparable.

### Iteration 1

P2 finding:

- The first implementation established the primary conversation action and
  clearer typography, but still rendered all 20 projects by default. The long
  continuous list preserved the original density problem.

Root fix:

- Keep the existing last-accessed project ordering, show eight projects by
  default, and expose the complete count through `显示全部 20 个项目` /
  `收起项目`.

### Iteration 2

The combined comparison shows the intended hierarchy in both products:
product identity, a persistent primary creation action, compact tool
navigation, subdued counted section headers, bounded content lists, and a
fixed profile footer. Storyflow keeps its own product tokens, Chinese copy,
project semantics, and existing Lucide dependency.

Focused region comparison was not split further because both normalized rails
are already full-height focused crops and every relevant label, icon, row,
spacing interval, and selected state is legible at 1×.

Required fidelity surfaces:

- Fonts and typography: Storyflow keeps Inter/system fallbacks. Primary and
  tool actions use 13 px labels, section headers use muted 12 px medium labels,
  content rows remain 12 px, and timestamps move from low-contrast 10 px to
  readable 11 px.
- Spacing and layout rhythm: rail width is 240 px; primary and tool rows are
  32 px; free conversations are limited to five and projects to eight; the
  existing title-bar, scroll owner, footer, row radii, and project disclosure
  geometry remain intact.
- Colors and visual tokens: the implementation reuses existing foreground,
  muted, hover, selected, focus, runtime, and background tokens. No palette,
  gradients, shadows, or unrelated decoration were introduced.
- Image quality and assets: neither design needs raster imagery. The primary
  action reuses the installed Lucide message-plus icon; no custom SVG, CSS art,
  or placeholder asset was added.
- Copy and content: `Storyflow`, `新建对话`, counted section labels, and bounded
  list controls express current product semantics. Project and conversation
  names remain source data.

Interaction and runtime evidence:

- The project list rendered eight rows, expanded to all 20 through the visible
  control, and retained the existing project disclosure behavior.
- Activating `新建对话` reached the fresh conversation composer.
- The Electron interaction run captured no renderer exceptions.
- 33 focused tests pass with 271 assertions.
- Electron TypeScript check, targeted ESLint, renderer production build, and
  `git diff --check` pass.

No actionable P0, P1, or P2 differences remain. The remaining 20 px width
difference from WorkBuddy is intentional: Storyflow retains timestamps,
project names, and project hover actions that need the additional space.

final result: passed

## Activity rail project hierarchy QA — 2026-07-29

### Sources

- Storyflow before:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-2c259c6f-091a-4449-a597-f660508f7cd1.png`
- Codex hierarchy reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-85de8320-46fa-4414-bfda-13f24b35a982.png`
- Codex spacing, hover, and loading reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-d4e8ad52-5bfc-46fa-803a-76cc15ccd4c5.png`
- Storyflow five-session preview:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/storyflow-project-preview-final.jpeg`
- Storyflow expanded sessions:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/storyflow-project-expanded-final.jpeg`
- Reference versus preview:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/reference-vs-preview-final.png`
- Preview versus expanded:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/preview-vs-expanded-final.png`
- Storyflow project-row hover:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/storyflow-spacing-hover.png`
- Codex reference versus Storyflow hover:
  `/Users/dingzhijian/.codex/visualizations/2026/07/29/019faccb-90d4-72c0-823a-bf02b376d449/activity-rail-hierarchy-qa/reference-vs-hover-final.png`

The live Electron capture is 1164 × 768 pixels in the current light-theme
writing workspace. Computer Use does not expose the CSS viewport or device
pixel ratio, so the focused project crops were normalized to 442 × 940 pixels
before comparison; raw font pixels were not treated as fidelity evidence.

### Iteration 1

P2 findings:

- Project conversations repeated the free-conversation leading icons, pushing
  their titles past the project-name column instead of forming Codex's clear
  second level.
- Expanding a project rendered every conversation immediately, so one large
  project could consume the complete sidebar.
- Removing the project chevron also removed the remaining visible open/closed
  cue.

Root fixes:

- Keep project conversations inside the existing project subtree, remove their
  repeated leading icons, and align their title edge with the project title.
- Show five recent project conversations by default, then toggle the complete
  list with `展开显示` and `收起显示`.
- Reuse the installed Lucide closed/open folder icons for project disclosure.
- Keep runtime and unread indicators at the right edge of nested rows.

### Iteration 2

Full-view evidence shows the existing Free Conversations and Projects sections
remain in the same order and one sidebar scroll owner still contains both.
The focused reference comparison shows that project names and their nested
conversation names now share one title column. The preview/expanded comparison
shows five rows plus `展开显示`, then all eight rows plus `收起显示`.

The first focused pass found one remaining P2: the selected nested
conversation's background inherited the subtree margin and became narrower
than the project rows. The fix moved indentation from the subtree container to
the nested button's content padding.

### Iteration 3

The final focused comparison shows a full-width selected row while its title
still aligns with the project-name column. No surrounding project geometry or
free-conversation layout changed.

### Iteration 4

The newer Codex reference exposed one remaining P2: the section wrapper added a
4 px inset before its own 8 px button padding, so the `项目` parent appeared
farther right than the project-folder column. The shared section header now has
no extra wrapper inset, puts its chevron after the title, and starts the title
on the same column as project folder icons. Project names and nested
conversation titles keep their shared second column, one icon-and-gap step to
the right.

The live hover capture shows the existing full-width soft background and only
the hovered project's `+` and overflow controls. Keyboard focus keeps the same
controls visible. Loading and running states now reuse the installed Lucide
spinner at the right edge: list loading is announced with screen-reader-only
copy, running conversations show the ring in their row, and collapsed projects
with active sessions receive the same ring from the existing server active
session summary. This adds one aggregate request, not one request per project.

The Codex section-level overflow icon was not copied because Storyflow has no
equivalent section action; adding a decorative dead control would reduce
fidelity of behavior.

### Iteration 5

The project creation trigger previously remained a separate, permanently
visible control beside the section title. The shared section header now owns
one rounded hover/focus surface. Its disclosure icon and the project creation
trigger reserve their layout space but remain transparent until the row is
hovered or keyboard focus enters it; the creation trigger also remains visible
while its menu is open. The disclosure and creation actions stay as separate
semantic buttons, so the unified visual item does not introduce nested buttons.

The free-conversation creation trigger now uses the same contextual visibility
contract. Its rendered class list contains `opacity-0`, `group-hover:opacity-100`,
and `group-focus-within:opacity-100`; the live stylesheet contains both group
selectors. A DevTools query after force reload returned zero
`.lucide-message-square-text` elements, confirming that free-conversation rows
retain only their status marker, title, and timestamp.

The desktop capture surface remained blank while docked DevTools could inspect
the live renderer DOM, so it was not used as visual evidence. Further UI
automation stopped when the user resumed interacting with the Electron window.

Interaction evidence:

- Clicking `短篇/中篇小说` loaded its workspace-scoped conversations.
- The first state exposed exactly five sessions and `展开显示`.
- Activating `展开显示` exposed all eight sessions and changed the control to
  `收起显示`.
- Activating `收起显示` restored the five-session preview.
- The project-level disclosure and per-project show-more state remain separate.

Required fidelity surfaces:

- Fonts and typography: existing Storyflow family, 12 px row text, truncation,
  and optical weights remain unchanged; Codex typography was not copied.
- Spacing and layout rhythm: the section title matches the folder-icon column,
  nested titles match the project-title column, the obsolete tree border is
  gone, and compact 28–30 px rows remain.
- Colors and visual tokens: existing foreground, muted, active, hover, focus,
  unread, and runtime-status tokens remain unchanged.
- Image quality and assets: no raster assets were added; closed/open folder
  states use the existing Lucide dependency.
- Copy and content: the only new visible copy is `展开显示` / `收起显示`;
  project and conversation names remain source data.

Runtime evidence:

- 32 focused tests pass with 1,439 assertions.
- Electron TypeScript check passes.
- Targeted ESLint reports no errors.
- `git diff --check` passes.
- ActivityRail orchestration is 756 lines; its row primitives are isolated in a
  324-line sibling component.
- The live Electron window rendered both interaction states without an HMR
  error overlay.

The remaining density difference from Codex is intentional: this task adopts
its hierarchy and disclosure behavior while retaining Storyflow's product
tokens and compact sidebar.

No actionable P0, P1, or P2 differences remain.

final result: passed

## Writing workspace shared tabs and directory QA — 2026-07-27

### Sources

- Open-directory reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-1ecd352a-01de-4a1b-8e62-421ae3fb4ab3.png`
- Closed-directory reference:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-518d47b9-769a-4918-9e12-d8ac631f77b9.png`
- Storyflow open-directory result:
  `/Users/dingzhijian/.codex/visualizations/2026/07/27/019fa244-8fc4-7941-91fe-ee2b0f244a8f/storyflow-writing-tabs-open.jpeg`
- Reference/result comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/27/019fa244-8fc4-7941-91fe-ee2b0f244a8f/writing-tabs-reference-vs-storyflow.jpg`

Visible behavior:

- A single 42 px file-tab header owns open files, new-file action, directory
  visibility, and the complete writing-workspace toggle.
- The directory is nested below that shared header. Its 42 px alignment row
  matches the TipTap toolbar, so the file tree begins at the editor-content row.
- Folding the directory preserves the outer writing-workspace width and header
  position; the manuscript consumes the released body width.
- Opening files appends unique closable tabs while one TipTap instance remains
  mounted. Switching or closing the active tab saves first.
- Moving or renaming a file or folder remaps every affected tab; deleting one
  removes only affected tabs and selects an already-open neighbour.

Runtime evidence:

- 129 focused writing/layout tests pass with 785 assertions.
- Electron TypeScript check passes.
- Renderer production build passes.
- Electron lint reports zero errors; remaining warnings predate this change.
- The live Electron dev window rendered three tabs, the shared right-side
  controls, aligned formatting/directory rows, and one manuscript editor without
  an HMR error overlay.

final result: passed

## Directory independent collapse and panel motion QA — 2026-07-26

### Sources

- Interaction truth: the directory folds independently from the complete
  writing workspace, with a persistent toggle and horizontal slide motion.
- Expanded implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/07-directory-expanded.png`
- Collapsed implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/06-directory-collapsed.png`
- Full-view comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/08-directory-expanded-collapsed.png`
- Focused header comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/09-directory-toggle-focus.png`

Both application captures are 1339 × 768 CSS pixels at 1× density in the
same light-theme project, file, window, and DevTools-docked state.

### Iteration 1

P1 findings:

- The title-bar control owned one boolean for both manuscript and directory,
  so the directory could not be folded without also removing the manuscript.
- Right-side columns unmounted immediately, producing a hard layout jump
  instead of spatially explaining where the panels went.

Root fixes:

- Keep the title-bar control for the complete writing workspace and give the
  directory its own persisted visibility state.
- Keep the directory toggle at the right edge: inside the directory header
  while expanded, then inside the manuscript header while collapsed.
- Route manuscript, directory, and existing shell visibility changes through
  one critically damped panel spring with horizontal travel and animated width.
- Disable motion during direct sash dragging and respect reduced-motion
  preferences.

### Iteration 2

Interaction evidence:

- `收起目录` removes only the directory; the manuscript remains mounted and
  receives the released width.
- `展开目录` remains available at the manuscript's upper-right edge and
  restores the directory.
- The title-bar `收起右侧栏` / `展开右侧栏` still hides and restores both
  right-side columns.
- The directory sash was dragged 40 px and restored; width tracking remained
  attached to the pointer rather than springing behind it.

Required fidelity surfaces:

- Fonts and typography: unchanged.
- Spacing and layout rhythm: the existing 6 px gaps, 42 px headers, and outer
  right radius remain aligned in both states.
- Colors and visual tokens: the toggle reuses `HeaderIconButton` and the
  existing foreground, hover, focus, shadow, and panel tokens.
- Image quality and assets: no raster assets were added; the control reuses the
  installed Lucide panel icons.
- Copy and content: only accessible labels/tooltips `收起目录` and `展开目录`
  were added; project and manuscript content are unchanged.

Runtime evidence:

- Electron TypeScript check passes.
- Five relevant suites pass with 108 tests and 818 assertions.
- Targeted ESLint reports no errors; warnings are pre-existing hook and shared
  local-storage warnings.
- `git diff --check` passes.

No actionable P0, P1, or P2 visual or interaction differences remain.

### Iteration 3

User feedback:

- The directory toggle must not jump back into the directory header after
  expansion.
- The directory tree must not start at the window's top edge; the 42 px header
  lane remains the highest-priority structural row.

Root fix:

- Keep the directory toggle on the manuscript surface in both visibility
  states.
- Let the outer `ResizableColumn` own an empty 42 px directory header, then
  place the scrolling project tree beneath it. `WorkspaceProjectSidebar`
  contains neither a duplicate header nor a duplicate toggle.

Verification:

- Three focused suites pass with 92 tests and 690 assertions.
- Electron TypeScript checking and the renderer production build pass.
- Targeted ESLint reports no errors; its nine Hook dependency warnings are
  pre-existing in `AppShell`.
- `git diff --check` passes.

final result: passed

## Writing panel chrome QA — 2026-07-26

### Sources

- Source visual truth:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/01-writing-layout.png`
- Rendered implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/02-writing-layout-fixed.png`
- Full-view comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/03-before-after-full.png`
- Focused header and seam comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/26/019f9df5-e400-7012-9e00-46208f788e99/ui-boundary-audit/04-before-after-boundaries.png`

The source capture is 1276 × 768 pixels and the implementation capture is
1277 × 768 pixels. The comparison crops one pixel from the implementation
without resampling, producing two 1276 × 768 panels. The Electron capture uses
the native desktop viewport at the same apparent CSS size and light theme.
The selected file changed from `简报.md` to `创作要求.md` between captures, so
copy and document body content are excluded from the comparison; the panel
headers, seams, outer frame, and directory state remain comparable.

### Iteration 1

P1/P2 findings:

- The outer writing row had no flex gap while each zero-width resize sash used
  negative half-gap margins, causing the manuscript and directory surfaces to
  overlap.
- A permanent 2 px sash line stacked with both panels' one-pixel shadow
  outlines, making the seam look like a doubled border.
- The manuscript header was 40 px while the shared shell header was 42 px.
- The conversation panel was incorrectly marked as the right window edge while
  the actual outer directory always used the inner radius.

Root fixes:

- Make the shared writing row own `PANEL_GAP` and remove per-column bottom
  compensation.
- Reuse the shared sash hit geometry and existing hover/drag gradient.
- Align manuscript and empty-workspace headers to the 42 px shell contract.
- Derive visible right-column state once and assign `RADIUS_EDGE` only to the
  actual outermost column.

### Iteration 2

Full-view evidence shows equal panel tops and bottoms, consistent open space
between conversation, manuscript, and directory, and no dark permanent resize
lines. The focused comparison confirms that the three title regions now share
one vertical baseline and the manuscript-directory seam no longer stacks
multiple outlines.

Required fidelity surfaces:

- Fonts and typography: font family, size, weight, wrapping, and antialiasing
  are unchanged; only the manuscript header box height moved from 40 to 42 px.
- Spacing and layout rhythm: adjacent panels now use the shared 6 px gap;
  top/bottom alignment and inner/outer radii are consistent.
- Colors and visual tokens: existing background, border, shadow, and muted
  foreground tokens are preserved.
- Image quality and assets: this shell contains no new raster or decorative
  image assets.
- Copy and content: no product copy changed; differing selected-file content is
  intentionally outside the visual comparison.

Runtime evidence:

- Electron TypeScript check passes.
- The four relevant suites pass with 104 tests and 791 assertions.
- Targeted ESLint reports no errors; the nine warnings are pre-existing
  `AppShell` hook dependency warnings outside this change.
- The implementation rendered through the existing Electron dev process
  without an HMR error overlay.
- Direct collapse/expand automation was not used as pass evidence because the
  active project/window changed during QA; the toggle implementation itself was
  not modified.

No actionable P0, P1, or P2 visual differences remain.

final result: passed

## Generic file-tree creation QA — 2026-07-24

### Sources

- Reported semantic submenu:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-da6da7e2-de5d-4a5e-a909-b0b0f614a914.png`
- Electron root menu:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-generic-qa/root-menu-flat.png`
- New-folder dialog:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-generic-qa/new-folder-dialog.png`
- Nested creation result:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-generic-qa/nested-file-created.png`
- Combined comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/07/23/019f8fb0-ac86-7f52-a0c8-930256c717bb/context-menu-generic-qa/semantic-vs-generic-comparison.png`

The Electron QA viewport was 1400 × 900 CSS pixels at 2× screenshot density
in the product's dark theme. The reported screenshot is a light-theme crop, so
the combined comparison focuses on hierarchy, labels, and submenu behavior.

### Iteration 1

P1 findings:

- `New file` still encoded manuscript, global-information, and free-area
  destinations in a submenu, so the UI remained coupled to one writing method.
- Import used the same semantic routing instead of the directory that received
  the context-menu action.
- Creating an empty folder updated the expansion state but did not open the
  mounted React Arborist instance, so a successful creation could remain hidden.

Root fixes:

- Replace semantic creation branches with flat `New file` and `New folder`
  actions.
- Resolve create and import targets from the root or directory that was
  right-clicked.
- Keep the editable file contract explicit: `.md` and `.txt`, with `.md` as the
  default when the user omits an extension.
- Open the mounted tree node after creation or import so an empty folder is
  immediately visible.

### Iteration 2

Electron evidence:

- The project-root menu contains six flat actions with no submenu chevrons:
  `New file`, `New folder`, `Import file`, Finder, new window, and rename.
- The directory menu exposes the same three location-aware file operations
  before the existing Finder, rename, and delete operations.
- `New folder` opens a generic folder-name dialog; `New file` opens a generic
  file-name dialog.
- A root file created as `QA-新文件` appeared as `QA-新文件.md`.
- A folder created as `QA-新文件夹` accepted `目录内文件`, produced
  `QA-新文件夹/目录内文件.md`, and stayed expanded in the visible tree.
- The isolated QA project, config, and Electron profiles were moved to
  `~/.Trash/storyflow-menu-qa-20260724-35010` after verification.

Fidelity checks:

- Existing product typography, colors, shadows, menu density, and Lucide icons
  remain unchanged.
- The menu no longer exposes manuscript/global/free-area classifications.
- Creation behavior follows the native file-tree location instead of Method Pack
  semantics.
- No P0, P1, or P2 visual or interaction differences remain.

final result: passed

## Prompt TOC design QA — 2026-08-01

### Sources

- Source visual truth:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-dff288e3-e238-4f1b-933e-c91e5ef6f81c.png`
- Current Electron capture:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-01 at 8.12.44 PM.jpeg`

The source is a 666 × 1402 Retina crop (approximately 333 × 701 CSS pixels at
2× density) showing the expanded prompt list. The Electron capture is a
1269 × 768 screenshot at 1× density in the collapsed conversation state.
Because the interaction states and crops do not match, no fidelity judgment is
made from these images.

### Required fidelity surfaces

- Fonts and typography: pending an expanded-state capture.
- Spacing and layout rhythm: pending a visible collapsed rail and expanded list.
- Colors and visual tokens: implementation uses existing Storyflow semantic
  tokens; visible comparison is pending.
- Image quality and asset fidelity: no image assets are part of this component.
- Copy and content: query labels are sourced from the session's user turns;
  runtime confirmation is pending.

### Runtime blocker

The latest renderer build completed and the Electron app was refreshed. The Mac
locked before hover expansion, click navigation, active-query tracking, and
console inspection could be completed. Computer Use could not unlock it
automatically. A same-state full-view/focused comparison and interaction run
therefore remain unavailable.

final result: blocked

## Activity rail system-control alignment — 2026-08-04

### Evidence

- Source visual truth:
  `/var/folders/jk/7_pcx4cd3y94_lwnf7hbxcv80000gn/T/codex-clipboard-538cf43b-ce1f-4aa4-9094-58cbe736334c.png`
- Before implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/08/04/019fccb9-e731-7491-91b5-3ec5cffb9d1f/sidebar-alignment/before.png`
- Implementation screenshot:
  `/Users/dingzhijian/.codex/visualizations/2026/08/04/019fccb9-e731-7491-91b5-3ec5cffb9d1f/sidebar-alignment/final-title-aligned.png`
- Focused source/implementation comparison:
  `/Users/dingzhijian/.codex/visualizations/2026/08/04/019fccb9-e731-7491-91b5-3ec5cffb9d1f/sidebar-alignment/reference-final-comparison.png`

The source is 3310 × 2064 px. The implementation is a 3188 × 2420 px native
window capture of a 1526 × 1142 CSS-pixel macOS window at 2× density; the
capture includes the OS window shadow. State: light theme, expanded activity
rail, active free conversation.

### Comparison history

- Iteration 1 moved the native controls right from x=18 to x=19 CSS px by
  following the icon layout box; the user rejected that direction.
- Iteration 2 uses the rendered glyph column as visual truth and moves the
  traffic-light origin left to x=17 CSS px, one pixel left of the original
  baseline and two pixels left of iteration 1.
- After: the close-button center is x=115.5 physical px and the rendered menu
  icon column centers at approximately x=114 physical px in the focused crop.
  No actionable P0/P1/P2 alignment difference remains.
- Final title pass: moved the `Storyflow` label right by 6 CSS px so its left
  edge shares the rendered icon-left axis; menu labels and navigation behavior
  remain unchanged.

### Required fidelity surfaces

- Fonts and typography: unchanged; existing Storyflow type hierarchy remains.
- Spacing and layout rhythm: the system close button and menu icon column now
  share one vertical axis; all other spacing is unchanged.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no product assets were added or replaced.
- Copy and content: unchanged.

The production build opened the saved conversation and activity rail without
new runtime errors. Existing Skills catalog warnings are unrelated. Focused
layout test: 24 passed, 0 failed.

final result: passed

## Chat titlebar alignment QA — 2026-08-06

### Sources

- Codex reference:
  `/Users/dingzhijian/.codex/visualizations/2026/08/06/019fd738-055e-7851-986c-268ab66b0039/ui-audit/01-codex-reference.png`
- Earlier Storyflow implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/08/06/019fd738-055e-7851-986c-268ab66b0039/ui-audit/02-storyflow-current.jpeg`
- Final Electron implementation:
  `/Users/dingzhijian/.codex/visualizations/2026/08/06/019fd738-055e-7851-986c-268ab66b0039/ui-audit/03-storyflow-header-final.jpeg`

### Root fixes and evidence

- Chat titles opt into the shared header's leading layout; settings and other
  panels retain the centered default.
- The title is plain heading content and the session menu is a separate native
  button with a Lucide overflow icon; the invalid nested trigger structure is
  gone.
- The two-column leading layout leaves the transcript and composer centered and
  preserves the existing right-side action region.
- The live Electron accessibility tree exposes the title as a heading and the
  overflow control as a popup button. Keyboard activation opened the existing
  session menu with mark, archive, unread, rename, new-window, copy, and delete
  actions.
- The Codex reference and final Electron capture were reviewed together. No
  actionable P0, P1, or P2 visual or interaction difference remains within the
  requested titlebar scope.

Focused regression tests, Electron TypeScript, and `git diff --check` passed.

final result: passed
