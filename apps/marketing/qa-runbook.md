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

## Browser checks

1. Initial hero contains a readable goal and chapter before any playback. Switch goal/draft/review; accept, reset and reject the sample change. Selecting the main window brings it in front so the secondary window cannot intercept its controls.
2. Switch project files, follow the continuation task’s file references, and switch Skill method/example states. The labelled demonstration changes only local example content. Open the real supporting capture to compare it with the demonstration.
3. Use Enter to open the installer menu, verify all three actual link destinations, Tab into the options, then Escape to close and restore button focus. At 390 and 320 px, click the visible header download link and verify the installation section and all three destinations.
4. Open and refresh `/docs/#first-task`; use product navigation, browser back and forward. The correct route and anchor remain visible below the fixed header. Keep tutorial copy and its existing screenshots unchanged.
5. At 1440, 768, 390 and 320 CSS px, check page overflow, readable content, loading of all product captures, and tutorial layout. Scroll to each lazy image before declaring it loaded. Verify reduced-motion mode and block one image request to exercise the readable fallback.

The automated script covers these state transitions and layout checks (supporting captures and a complete keyboard-only pass through demo controls and footer help still need visual/manual inspection) and captures full-page screenshots at 1440 and 390 when an output directory is provided. It starts with cache disabled and reloads the current build to avoid accepting a restored older preview; it restores normal caching on success. A browser failure is evidence to inspect, not a passed run.

## Visual acceptance

Compare with `design-reference/cursor-1440.png`, `cursor-390.png`, and the recorded computed geometry. Inspect hero, each feature, cards, releases, final CTA and footer at matching viewport widths. Scrollable demonstration text must remain readable and keyboard reachable. Check screenshot framing rather than only HTTP status.

The browser smoke test does not award a visual-fidelity score. Document differences in `implementation-notes.md`. Customer proof, testimonials, team and editorial material remain missing; no full-homepage 1:1 sign-off is claimed. Later sections cannot have matching absolute positions until those material gaps are resolved.

## Boundaries

No installer download, installation, login, paid provider request or real Project write is needed for these checks. Marketing-page typechecking/build and the existing Bun regression suite are separate from the repository-wide test command, whose result is reported separately in the implementation handoff.
