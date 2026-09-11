# Homepage fidelity — Issue #39

## Reference baseline

Reference: <https://cursor.com/>, captured on 2026-09-11 after the Chinese light homepage finished rendering. The archived `design-reference/cursor.json` records the capture time, language, viewport, section order, and computed geometry at 1440, 768, 390, and 320 CSS px. `cursor-1440.png` and `cursor-390.png` are the full-page reference captures, for review only; the build does not publish this directory.

The fully rendered baseline includes changelog and editorial highlights. Earlier observations taken before those sections appeared are not the source of truth for this implementation.

| Desktop landmark | Reference | Implementation target |
| --- | --- | --- |
| Viewport | 1440 × 900 CSS px | Same |
| Header height | 52px | 52px |
| Content width | 1300px | 1300px |
| H1 top / font / line-height | 164px / 26px / 32.5px | Same; Storyflow text has a different length |
| Hero stage top / height | 318.17px / 720px | Same |
| Feature card padding | 17.5px | 17.5px |
| Feature copy / media | About 1:2 | About 1:2 |
| Feature media height | 680px | 680px |

These are calibration observations, not a new design token API. At narrow widths, captions reflow and enlarged screenshot details remain horizontally scrollable. Every scene also offers the original full image.

## Current revision — authentic product UI

User feedback requested closer agreement with the real Storyflow UI, fresh annotated captures, and the UI/UX rhythm of <https://cursor.com/cn/home>. That page was inspected again on 2026-09-11 with ego-browser. Its compact navigation, warm neutral surfaces, full-width product stage, alternating feature bands and local demo state transitions remain the reference. The header/H1/stage geometry above is unchanged.

The former hand-drawn writing, review, project and Skill components are removed. `ProductTour` shows original screenshots from the current built Electron renderer. Scene tabs, numbered outlines and captions are explicitly website annotations; they do not pretend to be desktop controls. Screenshot changes fade for 320ms and focusing a region transitions over 520ms. Optional six-second playback pauses offscreen, while the picture is hovered or another control is focused, and under reduced motion. No motion library or provider call was added.

## Capture provenance and refresh

`reference-assets/current/provenance.json` records the source commit, build version, capture time and dimensions. `capture-product.ts` reuses `e2e/perf/launch.ts` and the existing fixture generator. It creates an isolated sample project with real Markdown files, an authored conversation, a sample Edit trace, a local source and a Skill. Version creation uses the real workspace-version API. It runs the unmodified application and waits for layout geometry to settle before capture; it does not inject replacement UI or edit screenshot pixels. Original images are linked from every tour. A refresh first captures to a staging directory; only a complete generation replaces the previous images and provenance.

These are genuine UI captures with **illustrative content**, not recordings of model-generated work. No model is configured or invoked; the original offline state can therefore show “不可用”. They contain no real user conversation or credentials. The capture process only changes its temporary fixture and removes it afterward.

| Capture | Actual surface | Explanation |
| --- | --- | --- |
| workspace | Conversation, document and right-hand directory | Task goal, file links and editable result |
| context | Character document opened from a conversation link | Related files in the same project |
| review | Turn change-summary card and right-hand review | Actual `Accept` and `Reject` labels; inserted and removed text |
| skills | Current local Skill detail | Method, file editing and “立即使用” |
| add-menu | Actual input plus-menu and Skill submenu | Select a method for a task |
| sources | Current local source detail dialog | Connection path and guide, not a made-up query result |
| history | Actual version-management dialog | A saved local snapshot and restore action |

All former tutorial screenshot references now use these current captures. Instructions name the current left-side entry points, right-side directory and plus-menu behavior. Mobile detail views are horizontally scrollable and retain a full-image option; they do not fabricate a mobile desktop client.

## Scope and outstanding material

Only marketing code, documentation and capture artifacts change. The actual Electron UI is not redesigned in this task. Existing downloads, public anchors, tutorial navigation and release links remain. Old source assets are retained as archival material but no longer used by the homepage or tutorial.

Customer marks, attributable testimonials, team material and editorial articles remain unavailable. Issue #39 stays open and this revision does not claim full-homepage 1:1 sign-off. Completing those sections still needs authentic material or an explicit change to the spec.

## Verification

The fresh Electron capture completed for all seven surfaces. Marketing typecheck, build and the eight existing Bun tests passed. Browser verification covers the current image steps, focus transforms, original links, actual installer URLs, Enter/Tab/Escape, mobile download routing, tutorial history/deep links, four viewport widths, reduced motion and media failures. Screenshot fidelity is inspected separately from these programmatic checks.

Final checks: repository `bun run test` completed with 5,778 passing, 11 skipped and 0 failed tests. The later playback correction passed marketing typechecking and was rechecked by both review axes; the browser run verifies it without manually moving focus off the Play button.

### Standards review

The playback focus and incomplete-generation publication findings were corrected and rechecked. No remaining actionable Standards findings.

### Spec review

Current screenshots, separate annotations and updated tutorial behavior satisfy this refinement. The playback finding was corrected and rechecked. No remaining actionable findings for this refinement; the pre-existing external-material gaps remain.
