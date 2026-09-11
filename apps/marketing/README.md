# Marketing

Storyflow landing page and release-download metadata.

The landing page uses the archived Cursor homepage geometry with Storyflow's
own brand, clean current Electron previews, and published
release links. The screenshot tour is local to the page and never calls an Agent. Original 4320 × 2700 screenshots come from the unmodified current Electron renderer at a 1440 × 900 viewport and 3× pixel density, with authored sample files and transcripts. Landing previews keep the native 16:10 ratio; annotations and explanatory captions belong only to the tutorial.
Customer proof, testimonials, team materials and editorial highlights remain
explicit acceptance gaps; see `implementation-notes.md` before calling the page
a completed 1:1 replica.
`/changelog/` contains the curated release history and links to full published notes. Header and footer link to the page; the old `/#changelog` anchor remains at the footer entry.
`/docs/` follows installation, project creation, the first writing task, and review,
then keeps the existing screenshots as an interface reference. Tutorial copy must
match current desktop labels and file behavior; screenshots illustrate an existing
project rather than a default folder template. Its topic navigation starts expanded; on wide screens, a separate right sidebar derives the page outline from the actual h2/h3 headings and tracks the current reading position.

## Downloads

Download controls name both macOS and Windows; the menu lists Apple Silicon, Intel Mac and Windows x64 independently of the visitor’s OS. Download buttons point at `https://story-storage.zjding.com/latest` by default and use
stable installer names such as `Storyflow-arm64.dmg`. Override the base URL at build
time with `VITE_STORYFLOW_DOWNLOAD_BASE_URL` when testing another R2 custom domain or
prefix. The marketing page intentionally does not know the current release version.

## Deployment

Changes to this app on `main` deploy through `.github/workflows/deploy-marketing.yml`.
The release workflow calls the same deployment after publishing release downloads.

## Files

- `index.html` - Vite HTML shell.
- `implementation-notes.md` - Running implementation notes for current landing-page changes.
- `promo-video/` - HyperFrames product promo composition and rendered assets.
- `reference-assets/` - Local landing screenshots and visual reference assets.
- `src/App.tsx` - Landing page and same-site navigation.
- `src/DocsPage.tsx` - First-project tutorial, topic navigation and derived page-heading outline.
- `src/ChangelogPage.tsx` - Standalone curated release history and published-note links.
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
