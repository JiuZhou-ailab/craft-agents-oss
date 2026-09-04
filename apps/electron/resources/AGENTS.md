# Bundled Resources

This folder contains assets that are bundled with the Electron app and synced to the user's `~/.craft-agent/` directory on every launch.

## How It Works

1. **Build time**: `scripts/copy-assets.ts` copies this folder to `dist/resources/`
2. **Package time**: electron-builder includes `dist/resources/` in the app bundle
3. **Runtime**: `getBundledAssetsDir()` resolves paths to these bundled assets
4. **Launch**: Each asset type syncs to the user's home directory

## Asset Types

| Folder/File | Synced To | Sync Behavior |
|-------------|-----------|---------------|
| `docs/` | `~/.craft-agent/docs/` | Always overwrite on launch |
| `themes/` | `~/.craft-agent/themes/` | Always overwrite on launch |
| `permissions/` | `~/.craft-agent/permissions/` | Always overwrite on launch |
| `tool-icons/` | `~/.craft-agent/tool-icons/` | Always overwrite on launch |
| `release-notes/` | `~/.craft-agent/release-notes/` | Always overwrite on launch |
| `config-defaults.json` | `~/.craft-agent/config-defaults.json` | Always overwrite on launch |

## Why Sync on Every Launch?

- Ensures users always have the latest defaults/docs when the app updates
- Consistent behavior between debug and release builds
- No stale configuration causing confusion

## Other Files (Not Synced)

These files are used by electron-builder or the app directly, not synced to user home:

| File | Purpose |
|------|---------|
| `icon.*` | App icons (icns, ico, png, svg) |
| `Assets.car` | macOS compiled asset catalog |
| `dmg-background.*` | DMG installer background |
| `source.png` | Default source icon |
| `generate-icons.sh` | Icon generation script |
| `pi-agent-server/` | Bundled Pi AgentSession runtime |

## Single Source of Truth

The files in this folder are the **source of truth** for bundled defaults:
- Edit `config-defaults.json` here to change default settings
- Edit files in `docs/` to update documentation
- Edit files in `themes/` to update bundled themes

There is no TypeScript fallback - if the bundled JSON file is missing, the app will fail with a clear error.

## Release Notes Authoring

**Never create `{version}.md` files in feature commits.** Versioned files in `release-notes/` are owned by the release skill — it consolidates pending entries into `{version}.md` at release-prep time and resets the scratch file.

For PRs that add user-visible behavior, append a bullet to the relevant product area in [`release-notes/next.md`](release-notes/next.md). `next.md` is the single source for the in-app announcement, update history, and GitHub Release body.

Write for people using Storyflow:

- Open with one plain sentence about what feels better after updating.
- Group bullets by user-visible area, not by implementation layer or commit type.
- Use a short bold outcome followed by one sentence describing what changed for the user.
- Keep protocol names, internal architecture, CI, signing, and release gates out unless the user must act on them.
- Do not include issue numbers or commit hashes. The GitHub compare view already owns that history.
- Prefer calm, direct Chinese. Say “现在可以做什么” before explaining why it works.

At release prep, copy the finished note to `{version}.md`, then reset `next.md` for the following version in the same release commit. The release workflow requires that versioned file and publishes the exact same copy everywhere; it never falls back to GitHub-generated commit notes.

**Why this exists:** during v0.9.0 prep, two feature commits had pre-emptively written `0.8.14.md` and `0.8.15.md` (guessing patch releases), but the changes ended up rolled into a minor. Both files had to be deleted and folded back in — without that cleanup, they would have surfaced as ghost versions in the in-app release-notes panel.
