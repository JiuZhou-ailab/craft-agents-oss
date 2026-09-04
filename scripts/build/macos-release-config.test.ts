// input: Release workflows, marketing deployment workflow, and Electron builder configuration
// output: Regression coverage for desktop releases and the public landing deployment boundary
// pos: Release safety guard for signed artifacts, updates, and independent landing delivery

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDir = join(import.meta.dir, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

function writeMacManifest(path: string, arch: 'arm64' | 'x64'): void {
  writeFileSync(
    path,
    [
      'version: 0.9.12',
      'files:',
      `  - url: Storyflow-${arch}.zip`,
      `    sha512: ${arch === 'arm64' ? 'arm64-sha512' : 'x64-sha512'}`,
      `    size: ${arch === 'arm64' ? '1234' : '5678'}`,
      `path: Storyflow-${arch}.zip`,
      `sha512: ${arch === 'arm64' ? 'arm64-sha512' : 'x64-sha512'}`,
      'releaseDate: 2026-05-21T00:00:00.000Z',
      '',
    ].join('\n'),
  );
}

describe('macOS release configuration', () => {
  test('requires Developer ID signing and notarization for official macOS release artifacts', () => {
    const builderConfig = readRepoFile('apps/electron/electron-builder.yml');

    expect(builderConfig).toContain('forceCodeSigning: true');
    expect(builderConfig).toContain('notarize: true');
    expect(builderConfig).toContain('sign: true');
    expect(builderConfig).toContain('CFBundleIconName: icon');
    expect(builderConfig).toMatch(/target:\n\s+- dmg\n\s+- zip/);
  });

  test('fails closed before draft creation when official release credentials are unavailable', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('preflight-release-secrets:');
    expect(workflow).toContain('Verify release secrets');
    expect(workflow).toContain('Missing CSC_LINK');
    expect(workflow).toContain('Missing Apple notarization credentials');
    expect(workflow).toContain(
      'for name in STORYFLOW_R2_BUCKET CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID',
    );
    expect(workflow).toContain('missing+=("Missing $name")');
    expect(workflow).toMatch(/create-release:\n\s+needs: preflight-release-secrets/);
    expect(workflow).toContain('gh release create "$RELEASE_TAG" --draft');
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    expect(workflow).toContain('CRAFT_REQUIRE_MAC_SIGNING: "1"');
    expect(workflow).toContain('timeout-minutes: 360');
    expect(workflow).toContain('CSC_LINK: ${{ secrets.CSC_LINK }}');
    expect(workflow).toContain('CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}');
    expect(workflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}');
    expect(workflow).toContain('APPLE_ID: ${{ secrets.APPLE_ID }}');
    expect(workflow).toContain('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}');
    expect(workflow).toContain('APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}');
    expect(workflow).toContain('if [ -n "$APPLE_API_KEY_BASE64" ] && [ -n "$APPLE_API_KEY_ID" ]; then');
    expect(workflow).toContain('APPLE_API_ISSUER is optional and should be omitted for Individual API keys');
    expect(workflow).toContain('CRAFT_MACOS_NOTARIZE_ATTEMPTS: "3"');
    expect(workflow).toContain('CRAFT_MACOS_NOTARIZE_RETRY_DELAY_SECONDS: "60"');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
    expect(workflow).not.toContain('STORYFLOW_R2_ACCESS_KEY_ID');
    expect(workflow).toContain('Publish release assets to Cloudflare R2');
    expect(workflow).toContain('bun run release:upload-r2');
    expect(workflow).toContain('Verify public release surfaces');
    expect(workflow.indexOf('Publish GitHub Release')).toBeGreaterThan(
      workflow.indexOf('Verify release assets'),
    );
    expect(workflow.indexOf('Publish GitHub Release')).toBeLessThan(
      workflow.indexOf('Publish release assets to Cloudflare R2'),
    );
    expect(workflow.indexOf('Verify public release surfaces')).toBeGreaterThan(
      workflow.indexOf('Publish release assets to Cloudflare R2'),
    );
    expect(workflow).toContain('Annotate macOS update manifest');
    expect(workflow).toContain('${{ matrix.arch }}=$manifest');
    expect(workflow).toContain('latest-mac-${{ matrix.arch }}.yml');
    expect(workflow).not.toContain('files+=(apps/electron/release/latest-mac.yml)');
    expect(workflow).toContain('Merge macOS update manifests');
    expect(workflow).toContain("gh release download \"$RELEASE_TAG\"");
    expect(workflow).toContain('scripts/merge-macos-update-manifests.py');
    expect(workflow).not.toContain('awk');
    expect(workflow).toContain("gh release upload \"$RELEASE_TAG\" latest-mac.yml --clobber");
    expect(workflow).toContain("grep -E '^Storyflow-arm64\\.dmg$'");
    expect(workflow).toContain("grep -E '^Storyflow-x64\\.dmg$'");
    expect(workflow).toContain("grep -E '^Storyflow-arm64\\.zip$'");
    expect(workflow).toContain("grep -E '^Storyflow-x64\\.zip$'");
    expect(existsSync(join(rootDir, 'scripts/merge-macos-update-manifests.py'))).toBe(true);
    expect(existsSync(join(rootDir, 'scripts/upload-r2-release-assets.ts'))).toBe(true);
  });

  test('deploys marketing independently from desktop releases', () => {
    const releaseWorkflow = readRepoFile('.github/workflows/release.yml');
    const marketingWorkflow = readRepoFile('.github/workflows/deploy-marketing.yml');

    expect(marketingWorkflow).toMatch(/push:\n\s+branches:\n\s+- main/);
    expect(marketingWorkflow).toContain('workflow_dispatch:');
    expect(marketingWorkflow).toContain('workflow_call:');
    expect(marketingWorkflow).toContain('- "apps/marketing/**"');
    expect(marketingWorkflow).toContain('- "scripts/build-marketing.ts"');
    expect(marketingWorkflow).toContain('group: deploy-marketing-production');
    expect(marketingWorkflow).toContain('cancel-in-progress: false');
    expect(marketingWorkflow).toMatch(/uses: actions\/checkout@v5\n\s+with:\n\s+ref: main/);
    expect(marketingWorkflow).toContain('bun test apps/marketing/src/__tests__/downloads.test.ts');
    expect(marketingWorkflow).toContain('bun run marketing:build');
    expect(marketingWorkflow).toContain('bunx wrangler pages deploy apps/marketing/dist');
    expect(marketingWorkflow).toContain(
      "STORYFLOW_PAGES_PROJECT_NAME: ${{ vars.STORYFLOW_PAGES_PROJECT_NAME || 'storyflow' }}",
    );
    expect(releaseWorkflow).not.toContain('deploy-marketing:');
    expect(releaseWorkflow).not.toContain('uses: ./.github/workflows/deploy-marketing.yml');
    expect(releaseWorkflow).not.toContain('bunx wrangler pages deploy apps/marketing/dist');
  });

  test('official release workflow validates versions and never builds Windows with dev runtime', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');
    const validateWorkflow = readRepoFile('.github/workflows/validate.yml');
    const windowsBuild = readRepoFile('scripts/build/win32.ts');
    const packageManifest = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(workflow).toContain('bun run check-version');
    expect(workflow).toContain("RELEASE_VERSION: ${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref_name }}");
    expect(packageManifest.scripts['validate:ci']).toMatch(/^bun run validate:dev && bun run test &&/);
    expect(workflow).toMatch(/full\|""\)\n\s+bun run validate:ci\n\s+;;/);
    expect(validateWorkflow).toContain('run: bun run validate:ci');
    expect(workflow).toContain('run: bun run electron:dist:win');
    expect(workflow).not.toContain('run: bun run electron:dist:dev:win');
    expect(windowsBuild).toMatch(/buildMainProcess\(config\);\n\s+stageSubprocessResources\(config\);/);
  });

  test('publishes the curated version note across release surfaces', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('--curated-notes="apps/electron/resources/release-notes/$version.md"');
    expect(workflow).toContain('--notes-file "$notes_file"');
    expect(workflow).not.toContain('--generate-notes');
    expect(workflow).not.toContain('STORYFLOW_WHATS_NEW_OPENAI_API_KEY');
  });

  test('runs packaged macOS E2E on a native runner for each architecture', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('runs-on: ${{ matrix.runner }}');
    expect(workflow).toMatch(/- arch: arm64\n\s+runner: macos-26/);
    expect(workflow).toMatch(/- arch: x64\n\s+runner: macos-15-intel/);
    expect(workflow).toContain('Run packaged core E2E');
  });

  test('manual release profiles can publish platform hotfixes and prune old R2 releases', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('release_profile:');
    expect(workflow).toContain('- windows-hotfix');
    expect(workflow).toContain('- macos-hotfix');
    expect(workflow).toContain("RELEASE_PROFILE: ${{ github.event_name == 'workflow_dispatch' && inputs.release_profile || 'full' }}");
    expect(workflow).toContain("inputs.release_profile == 'full' || inputs.release_profile == 'macos-hotfix'");
    expect(workflow).toContain("inputs.release_profile == 'full' || inputs.release_profile == 'windows-hotfix'");
    expect(workflow).toContain('UPLOAD_PROFILE="windows"');
    expect(workflow).toContain('UPLOAD_PROFILE="macos"');
    expect(workflow).toContain('--profile="$UPLOAD_PROFILE"');
    expect(workflow).toContain('--retain-releases="${STORYFLOW_R2_RETAIN_RELEASES:-5}"');
    expect(workflow).toContain('A platform hotfix requires an existing release');
  });

  test('desktop release builds skip duplicate dependency installs', () => {
    const commonBuild = readRepoFile('scripts/build/common.ts');
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(commonBuild).toContain('CRAFT_SKIP_INSTALL');
    expect(commonBuild).toContain('bun install --frozen-lockfile');
    expect(workflow.match(/CRAFT_SKIP_INSTALL: "1"/g)).toHaveLength(2);
    expect(workflow).toContain('bun install --frozen-lockfile --linker=hoisted');
  });

  test('local unsigned macOS builds disable app and DMG signing explicitly', () => {
    const darwinBuild = readRepoFile('scripts/build/darwin.ts');

    expect(darwinBuild).toContain('-c.mac.forceCodeSigning=false');
    expect(darwinBuild).toContain('-c.mac.notarize=false');
    expect(darwinBuild).toContain('-c.mac.identity=null');
    expect(darwinBuild).toContain('-c.dmg.sign=false');
  });

  test('normalizes PKCS#12 certificates into a macOS security-compatible format', () => {
    const darwinBuild = readRepoFile('scripts/build/darwin.ts');

    expect(darwinBuild).toContain("['pkcs12', '-export', '-legacy'");
  });

  test('publishes updater manifests from the public R2 endpoint', () => {
    const builderConfig = readRepoFile('apps/electron/electron-builder.yml');
    const autoUpdate = readRepoFile('apps/electron/src/main/auto-update.ts');
    const installScript = readRepoFile('scripts/install-app.sh');
    const windowsInstallScript = readRepoFile('scripts/install-app.ps1');

    expect(builderConfig).toContain('provider: generic');
    expect(builderConfig).toContain('url: https://story-storage.zjding.com/latest');
    expect(autoUpdate).toContain('public R2 download');
    expect(installScript).toContain(
      'RELEASE_DOWNLOAD_URL="${STORYFLOW_DOWNLOAD_BASE_URL:-https://story-storage.zjding.com/latest}"',
    );
    expect(windowsInstallScript).toContain('https://story-storage.zjding.com/latest');
    expect(builderConfig).not.toContain('craft-agents-oss/releases/latest/download');
    expect(installScript).not.toContain('craft-agents-oss/releases/latest/download');
  });

  test('fails the official macOS release build before upload if Gatekeeper verification fails', () => {
    const darwinBuild = readRepoFile('scripts/build/darwin.ts');
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(darwinBuild).toContain('validateMacReleaseCredentials');
    expect(darwinBuild).toContain('notarizeDmg');
    expect(darwinBuild).toContain('verifyMacReleaseArtifacts');
    expect(darwinBuild).toContain('runElectronBuilderWithRetries');
    expect(darwinBuild).toContain('retrying after');
    expect(darwinBuild).toContain('npx electron-builder');
    expect(darwinBuild).toContain('-c.mac.forceCodeSigning=true');
    expect(darwinBuild).toContain('-c.mac.notarize=true');
    expect(darwinBuild).toContain('selectNotarizationCredentials');
    expect(darwinBuild).toContain('APPLE_API_ISSUER');
    expect(darwinBuild).toContain('delete process.env.APPLE_ID');
    expect(darwinBuild).toContain('codesign --verify --deep --strict');
    expect(darwinBuild).toContain('spctl --assess');
    expect(darwinBuild).toContain('notarytool submit');
    expect(darwinBuild).toContain('xcrun stapler staple');
    expect(darwinBuild).toContain('spctl --assess --type open --context context:primary-signature');
    expect(darwinBuild).toContain('xcrun stapler validate');
    expect(darwinBuild).toContain('DMG artifact present');
    expect(darwinBuild).toContain('ZIP artifact present');
    expect(darwinBuild).toContain('Storyflow.app');
    expect(workflow).toContain('Verify macOS signing and notarization');
  });

  test('installer verifies macOS trust and uses zip artifacts for app replacement', () => {
    const installScript = readRepoFile('scripts/install-app.sh');

    expect(installScript).not.toContain('Open Anyway');
    expect(installScript).not.toContain('temporary workaround for unsigned or non-notarized builds');
    expect(installScript).toContain('verify_macos_app_trust');
    expect(installScript).toContain('staged_app="$install_temp_dir/$APP_NAME"');
    expect(installScript).toContain('backup_app="$backup_temp_dir/$APP_NAME"');
    expect(installScript).toContain('mv "$INSTALL_DIR/$APP_NAME" "$backup_app"');
    expect(installScript).toContain('mv "$staged_app" "$INSTALL_DIR/$APP_NAME"');
    expect(installScript).toContain('mv "$backup_app" "$INSTALL_DIR/$APP_NAME"');
    expect(installScript).toContain('endswith(\\".zip\\")');
    expect(installScript).toContain('Expected exactly one .zip artifact for architecture');
    expect(installScript.indexOf('verify_macos_app_trust "$app_source"')).toBeLessThan(
      installScript.indexOf('Removing previous installation'),
    );
    expect(installScript.indexOf('staged_app="$install_temp_dir/$APP_NAME"')).toBeLessThan(
      installScript.indexOf('Removing previous installation'),
    );
  });

  test('macOS build keeps explicit environment values ahead of local dotenv values', () => {
    const commonBuild = readRepoFile('scripts/build/common.ts');
    const envLoader = readRepoFile('scripts/env-loader.ts');

    expect(commonBuild).toContain("loadEnvFiles({ rootDir: config.rootDir, mode: 'build' })");
    expect(envLoader).toContain("['.env.local', '.env']");
    expect(envLoader).toContain("['.env.local', '.env.dev', '.env']");
    expect(envLoader).toContain('if (env[key] === undefined)');
    expect(envLoader).toContain('resolveEnvValue');
    expect(envLoader).toContain('cat\\s+');
  });

  test('macOS manifest helper annotates a single architecture manifest', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'storyflow-mac-manifest-'));
    const input = join(tempDir, 'latest-mac.yml');
    const output = join(tempDir, 'latest-mac-arm64.yml');
    writeMacManifest(input, 'arm64');

    const result = spawnSync(
      'python3',
      [join(rootDir, 'scripts/merge-macos-update-manifests.py'), output, `arm64=${input}`],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const manifest = readFileSync(output, 'utf8');
    expect(manifest).toContain('  - url: Storyflow-arm64.zip');
    expect(manifest).toContain('    arch: arm64');
    expect(manifest).toContain('    size: 1234');
  });

  test('macOS manifest helper merges arm64 and x64 manifests', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'storyflow-mac-manifest-'));
    const arm64 = join(tempDir, 'latest-mac-arm64.yml');
    const x64 = join(tempDir, 'latest-mac-x64.yml');
    const output = join(tempDir, 'latest-mac.yml');
    writeMacManifest(arm64, 'arm64');
    writeMacManifest(x64, 'x64');

    const result = spawnSync(
      'python3',
      [
        join(rootDir, 'scripts/merge-macos-update-manifests.py'),
        output,
        `arm64=${arm64}`,
        `x64=${x64}`,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const manifest = readFileSync(output, 'utf8');
    expect(manifest).toContain('  - url: Storyflow-arm64.zip');
    expect(manifest).toContain('    arch: arm64');
    expect(manifest).toContain('    size: 1234');
    expect(manifest).toContain('  - url: Storyflow-x64.zip');
    expect(manifest).toContain('    arch: x64');
    expect(manifest).toContain('    size: 5678');
    expect(manifest).toContain('path: Storyflow-arm64.zip');
  });
});
