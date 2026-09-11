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
| Hero stage top / height | 318.17px / 720px | Top retained; height follows native 16:10 image plus controls/padding |
| Feature card padding | 17.5px | 17.5px |
| Feature copy / media | About 1:2 | About 1:2 |
| Feature media height | 680px | Intrinsic image ratio plus controls/padding |

These are calibration observations, not a new design token API. At narrow widths, captions reflow and enlarged screenshot details remain horizontally scrollable. Every scene also offers the original full image.

## Current revision — authentic product UI

User feedback requested closer agreement with the real Storyflow UI, fresh annotated captures, and the UI/UX rhythm of <https://cursor.com/cn/home>. That page was inspected again on 2026-09-11 with ego-browser. Its compact navigation, warm neutral surfaces, full-width product stage, alternating feature bands and local demo state transitions remain the reference. Header and H1 geometry are retained; screenshot frames now follow the actual product aspect ratio instead of copying the reference’s fixed heights.

The former hand-drawn writing, review, project and Skill components are removed. `ProductTour` shows original screenshots from the current built Electron renderer. The latest user correction separates presentation from instruction: the landing page starts with full 16:10 images, no numbered markers, outlines or explanation paragraphs; the tutorial keeps those annotations. Both retain screenshot selection, focus, original links and optional six-second playback. Image changes fade for 320ms and focusing a region transitions over 520ms. Playback pauses offscreen, while the picture is hovered or another control is focused, and under reduced motion. No motion library or provider call was added.

The header has five destinations: product, review, Skills, tutorial and changelog, with a separate download action. A mobile menu exposes the same links, closes on selection and supports Escape with focus restoration. Feature frames and secondary cards no longer force tall fixed boxes or arbitrary pixel-offset crops. High-density screenshots provide real source pixels rather than upscaling the previous PNGs.

## Capture provenance and refresh

`reference-assets/current/provenance.json` records the source commit, build version, capture time and dimensions. `capture-product.ts` reuses `e2e/perf/launch.ts` and the existing fixture generator. It creates an isolated sample project with real Markdown files, an authored conversation, a sample Edit trace, a local source and a Skill. Version creation uses the real workspace-version API. It captures 4320 × 2700 pixels from a 1440 × 900 CSS viewport at device scale 3, using the native keyboard path to open the Skill submenu. It runs the unmodified application and waits for layout geometry to settle before capture; it does not inject replacement UI or edit screenshot pixels. Original images are linked from every tour. A refresh first captures to a staging directory; only a complete generation replaces the previous images and provenance.

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

The regression checks distinguish the two surfaces: no markers or explanation paragraphs on the landing page; tutorial markers remain present. Browser QA verifies 16:10 scene bounds at 1440/768/390/320 px, five desktop links and the mobile menu’s selection/Escape behavior, alongside existing playback, zoom, download, history, reduced-motion and media-failure checks. Pixel dimensions are checked against capture provenance; clarity and framing are inspected in the rendered page.

Final validation passed: marketing typecheck/build, 8 marketing tests (84 assertions), browser QA at all four widths, and the repository test command (5,778 passed, 11 skipped, 0 failed). All seven PNG dimensions are 4320 × 2700; the browser decoded the same native resolution. Desktop overview/detail and mobile captures were visually inspected.

### Standards review

No actionable code findings. The obsolete annotated-landing description was corrected in this README projection and the marketing README.

### Spec review

Clean landing presentation, tutorial-only annotations, five meaningful header destinations, native image proportions and 3× capture satisfy the current correction. Historical external-material gaps remain outside this refinement.
