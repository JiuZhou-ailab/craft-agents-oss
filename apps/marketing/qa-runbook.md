# Marketing QA — Issue #39

## Run

From the repository root:

```sh
bun test --cwd apps/marketing
bun run --cwd apps/marketing typecheck
bun run --cwd apps/marketing build
bun run --cwd apps/marketing preview --host 127.0.0.1
```

In another terminal, run the browser check against the production preview:

```sh
ego-browser nodejs < apps/marketing/qa.mjs
```

The script uses the existing ego-browser API, without another test framework. By default it opens its own TaskSpace and closes it after success. When running inside an existing browser task, prepend `globalThis.marketingQA = { space: <existing numeric id>, page: "p2", output: "/absolute/evidence/directory" };` to the script input and reuse that space. `url` optionally changes the preview origin. Shell environment variables are not forwarded by ego-browser's remote Node runtime.

## Refresh product captures

After building the current desktop application:

```sh
bun run electron:build
bun apps/marketing/capture-product.ts
```

This uses an isolated offline fixture and the real renderer; it never sends a model request. Inspect every original PNG and the provenance record before rebuilding marketing. The script waits for visible content and stable layout to avoid recording a partial panel animation. The 1440 × 900 CSS viewport is captured at 3×: verify every original PNG is 4320 × 2700 pixels, not a resized older image.

## Browser checks

1. Landing previews start in full view with no numbered markers, outlines or explanation paragraphs. Tutorial previews retain them. Switch steps and focus regions; the original-image link must follow the selected state. Images and authored example content are labelled.
2. Play and pause a tour. It advances only when visible and the picture is not hovered and another control is not focused. Reduced-motion users get instant focus changes and no playback button. Keyboard users can select steps and scroll narrow detail views.
3. Verify the download button explicitly names macOS / Windows and footer contact is 飞书：派大星 / `mailto:zjdding@gmail.com`. Use Enter to open the installer menu, verify all three destinations, Tab into it, then Escape to close and recover focus. At 390/320 px, the visible download link reaches the installation section.
4. Refresh `/docs/#first-task` and a right-outline h3 link; verify the left reference group starts expanded, outline links match all h2/h3 headings, and the selected heading is highlighted. Navigate to `/changelog/`, refresh, and use back/forward. Keep anchor content below the header.
5. At 1440/768/390/320 px, verify landing scene bounds are 16:10, no overflow, image loads, tutorial layout and failed-image fallback. Check all five desktop navigation links and mobile menu selection/Escape. Inspect SVG screenshot resources as well as ordinary HTML images.

`qa.mjs` exercises state/zoom, downloads, routes, four widths, reduced motion and media failure; screenshot framing is checked separately in the live browser; playback timing and pause behavior are exercised by the script. With an output directory it saves full-page images. It reloads with cache disabled to avoid accepting an older restored preview, and restores caching after success.

## Visual acceptance

Compare with `design-reference/cursor-1440.png`, `cursor-390.png`, and the recorded computed geometry. Inspect hero, each feature, cards, releases, final CTA and footer at matching viewport widths. Scrollable demonstration text must remain readable and keyboard reachable. Check screenshot framing rather than only HTTP status.

The browser smoke test does not award a visual-fidelity score. Document differences in `implementation-notes.md`. Customer proof, testimonials, team and editorial material remain missing; no full-homepage 1:1 sign-off is claimed. Later sections cannot have matching absolute positions until those material gaps are resolved.

## Boundaries

No installer download, installation, login, paid provider request or real Project write is needed for these checks. Marketing-page typechecking/build and the existing Bun regression suite are separate from the repository-wide test command, whose result is reported separately in the implementation handoff.

## On-site release archive

Open `/changelog/`: all 24 existing versions render their full notes, newest first, without GitHub links. Select v0.10.6 in the version directory, refresh its anchor URL, and confirm the oldest entry remains visible; browser Back returns to the previous page position. Check the version directory and article text at 1440px and 390px widths. Adding a numeric version file under `apps/electron/resources/release-notes/` must include it in the next build; `next.md` stays excluded.


## Beginner walkthrough

Follow `/docs/` from installation to reopening a saved file. Verify the current desktop entry labels against ActivityRail, AccountSettingsSection, permission controls and version management. The example consistently uses the 黑洞直播 project, 创作要求.md and 第01章.md. All five main steps must state what to do and how to recognize completion; recovery links and both tables of contents must land on visible content.

Click all four copy buttons and compare the complete multiline text with their displayed prompts. Simulate clipboard denial and confirm a manual-copy message appears without losing the prompt. `qa.mjs` performs these assertions with a temporary clipboard stub and restores it afterward. Check keyboard focus, mobile wrapping and tutorial screenshot controls. This website QA does not send requests to a model or prove the quality of generated prose.


## Chapter navigation

The tutorial index must not contain the installation, writing or troubleshooting article bodies. Directly load and refresh every route in `docsChapters`; only the current chapter's content and heading outline should appear. The left navigation identifies the current chapter and the reference group starts expanded. Walk forward and backward using both chapter pagination and browser history. Cross-page help links must open the target chapter at the correct heading. Old `/docs/#first-task` and `/docs/#project-options` bookmarks must replace their URL with the appropriate chapter route, retain their anchor, and remain correct after refresh. An unknown `/docs/` subpath must show a recovery link rather than the landing page. Copy tests run on the writing, review and troubleshooting chapters; check the writing page at all four viewport widths.
