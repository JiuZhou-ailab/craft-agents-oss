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
