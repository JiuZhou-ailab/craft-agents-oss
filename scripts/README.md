# scripts

Build, validation, packaging, install, and local development entry scripts for the monorepo.

## Files

- `browser-tool.ts` - browser tool helper runner.
- `build.ts` - root Electron package build dispatcher.
- `build-server.ts` - standalone server distribution builder.
- `build-wa-worker.ts` - WhatsApp worker bundle builder.
- `build/` - shared and platform-specific Electron packaging helpers.
- `check-i18n-coverage.ts` - i18n literal coverage check.
- `check-i18n-parity.ts` - i18n locale parity check.
- `check-raw-sends.sh` - raw IPC send guard.
- `check-version.ts` - workspace and release-target version consistency check.
- `docker-smoke-test.sh` - Docker distribution smoke test.
- `electron-build-main.ts` - Electron main-process and subprocess bundle builder.
- `electron-build-preload.ts` - Electron preload bundle builder.
- `electron-build-renderer.ts` - Electron renderer build runner.
- `electron-clean.ts` - Electron build artifact cleaner.
- `electron-dev.ts` - local Electron development runner.
- `electron-perf-summary.ts` - summarize Electron debug performance logs into operation latency evidence.
- `generate-dev-cert.sh` - local certificate generator.
- `install-app.ps1` - Windows app installer.
- `install-app.sh` - Unix app installer.
- `install-server.sh` - server installer.
- `merge-macos-update-manifests.py` - merge per-architecture macOS update manifests for release assets.
- `release.ts` - release gate that runs version checks, CI validation, and packaging.
- `sort-locales.ts` - locale key sorter.
- `test-workflow-local.sh` - local workflow test helper.
- `upload-r2-release-assets.ts` - publish GitHub release assets to Cloudflare R2 with Wrangler.
- `verify-mcp-market.ts` - verify the live MCP subregistry catalog parses with the shipped desktop parser; endpoints are never contacted.
- `verify-skills-market.ts` - verify every live Market entry parses with the shipped desktop parser, imports, and is discovered by Pi.
- `verify-skills-market-auth.ts` - verify the Auth Broker capability is accepted by the independent Skills Registry.

## Release R2 publishing

The release workflow publishes public download assets with `bunx wrangler r2 object put`,
not S3 access keys. It creates new GitHub releases as drafts, runs validation and signed
platform builds in parallel, then publishes the draft only after every gate passes.
Marketing deploys independently because its download links already target stable R2
`latest/` URLs. Required GitHub settings:

- Secret `STORYFLOW_R2_BUCKET`: `storyflow-downloads`.
- Secret `CLOUDFLARE_API_TOKEN`: Cloudflare API token with `Account > Workers R2 Storage > Edit`.
- Variable `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
- Variable `STORYFLOW_R2_PUBLIC_BASE_URL`: public R2 custom domain, for example `https://story-storage.zjding.com`.
- Variable `STORYFLOW_R2_LATEST_PREFIX`: `latest`.
- Variable `STORYFLOW_R2_RELEASE_PREFIX`: `releases`.
- Variable `STORYFLOW_R2_RETAIN_RELEASES`: number of immutable `releases/<tag>/` prefixes to keep, default `5`.
- Variable `STORYFLOW_PAGES_PROJECT_NAME`: Cloudflare Pages project name, default `storyflow`.

Immutable and stable assets upload with bounded concurrency. Canonical updater manifests
are uploaded last so clients cannot observe a new version before its artifacts exist.
Installer artifacts are uploaded under stable names in `latest/`, such as
`Storyflow-arm64.dmg`, so stale web pages cannot keep downloading an old latest alias.
The immutable `releases/<tag>/` prefix also receives versioned browser-download aliases,
such as `Storyflow-<version>-arm64.dmg`, for direct archival links.
Manual releases can choose `release_profile=windows-hotfix` or `release_profile=macos-hotfix`
to build and publish only the affected platform. R2 publishing maps those profiles to
`--profile=windows` or `--profile=macos`, while full tag releases continue to publish every
required public asset. After a successful upload, the publisher prunes old immutable release
prefixes so only the newest configured release tags remain in R2; `latest/` is always
overwritten and is never pruned by tag retention.
