# Marketing

Storyflow landing page and release-download metadata.

The landing page uses the archived Cursor homepage geometry with Storyflow's
own brand, clean current Electron previews, and published
release history. The screenshot tour is local to the page and never calls an Agent. Original 4320 × 2700 screenshots come from the unmodified current Electron renderer at a 1440 × 900 viewport and 3× pixel density, with authored sample files and transcripts. Landing previews keep the native 16:10 ratio; annotations and explanatory captions belong only to the tutorial.
Customer proof, testimonials, team materials and editorial highlights remain
explicit acceptance gaps; see `implementation-notes.md` before calling the page
a completed 1:1 replica.
`/changelog/` contains the full version history with permanent `#vX.Y.Z` anchors. Both the Bun build and Vite development load every numeric versioned Markdown file from `apps/electron/resources/release-notes/`; `next.md` and prerelease drafts are excluded. Markdown renders safely at build time and is embedded in the site HTML, so reading history never depends on GitHub or a live API. Existing version files remain the archive; add new versions without replacing older files. Header and footer link to the page; the old `/#changelog` anchor remains at the footer entry.
`/docs/` teaches one five-step practice: install/sign in and confirm a reply, add a local project folder, write requirements and a short opening, review one targeted edit, then save a version and reopen the file. Each step includes a completion signal. Four copyable prompts preserve multiline text and offer a manual-copy fallback. Symptom-based help links lead to recovery instructions and contact details; advanced references follow the practice. Repeated screenshots are consolidated at their relevant steps. Tutorial copy must
match current desktop labels and file behavior; screenshots illustrate an existing
project rather than a default folder template. Its topic navigation starts expanded; on wide screens, a separate right sidebar derives the page outline from the actual h2/h3 headings and tracks the current reading position.

## Downloads

Download controls name both macOS and Windows; the menu lists Apple Silicon, Intel Mac and Windows x64 independently of the visitor’s OS. Download buttons point at `https://story-storage.zjding.com/latest` by default and use
stable installer names such as `Storyflow-arm64.dmg`. Override the base URL at build
time with `VITE_STORYFLOW_DOWNLOAD_BASE_URL` when testing another R2 custom domain or
prefix. The marketing page intentionally does not know the current release version.

## Deployment

Changes to this app on `main` deploy through `.github/workflows/deploy-marketing.yml`.
Changes to versioned release-note Markdown on `main` also trigger this deployment. The desktop release workflow remains independent.

## Files

- `index.html` - Vite HTML shell.
- `implementation-notes.md` - Running implementation notes for current landing-page changes.
- `promo-video/` - HyperFrames product promo composition and rendered assets.
- `reference-assets/` - Local landing screenshots and visual reference assets.
- `src/App.tsx` - Landing page and same-site navigation.
- `src/DocsPage.tsx` - Five-step writing practice, copyable prompts, recovery paths and derived page-heading outline.
- `release-notes.ts` - Build-time loader and Markdown renderer shared by Bun and Vite.
- `src/ChangelogPage.tsx` - Full on-site release archive and version navigation.
- `src/styles.css` / `src/docs.css` - Shared landing styles and tutorial layout.
- `src/ProductTour.tsx` / `src/product-tour.css` - Clean landing previews and annotated tutorial tours with focus regions and playback.
- `capture-product.ts` - Reproducible isolated Electron capture using the existing desktop harness.
- `reference-assets/current/` - Original current product captures and provenance.
- `src/downloads.ts` - Shared installer metadata for both pages.
- `src/__tests__/` - Download, tutorial navigation, and rendering checks.
- `qa-runbook.md` / `qa.mjs` - Public-page browser acceptance and download/tutorial regression checks.
- `design-reference/` - Fixed Cursor reference, Storyflow verification captures and measured geometry; excluded from published assets.
- `tsconfig.json` - TypeScript checks for the marketing app.
- `vite.config.ts` - Vite build and preview configuration.
