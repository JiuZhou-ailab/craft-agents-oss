# Marketing

Storyflow landing page and release-download metadata.

The landing page uses the archived Cursor homepage geometry with Storyflow's
own brand, annotated current Electron captures, and published
release links. The screenshot tour is local to the page and never calls an Agent. Original screenshots come from the unmodified current Electron renderer with authored sample files and transcripts.
Customer proof, testimonials, team materials and editorial highlights remain
explicit acceptance gaps; see `implementation-notes.md` before calling the page
a completed 1:1 replica.
`/docs/` follows installation, project creation, the first writing task, and review,
then keeps the existing screenshots as an interface reference. Tutorial copy must
match current desktop labels and file behavior; screenshots illustrate an existing
project rather than a default folder template.

## Downloads

Download buttons point at `https://story-storage.zjding.com/latest` by default and use
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
- `src/DocsPage.tsx` - First-project tutorial and interface reference.
- `src/styles.css` / `src/docs.css` - Shared landing styles and tutorial layout.
- `src/ProductTour.tsx` / `src/product-tour.css` - Shared native screenshot tour, captions, focus regions and playback.
- `capture-product.ts` - Reproducible isolated Electron capture using the existing desktop harness.
- `reference-assets/current/` - Original current product captures and provenance.
- `src/downloads.ts` - Shared installer metadata for both pages.
- `src/__tests__/` - Download, tutorial navigation, and rendering checks.
- `qa-runbook.md` / `qa.mjs` - Public-page browser acceptance and download/tutorial regression checks.
- `design-reference/` - Fixed Cursor reference, Storyflow verification captures and measured geometry; excluded from published assets.
- `tsconfig.json` - TypeScript checks for the marketing app.
- `vite.config.ts` - Vite build and preview configuration.
