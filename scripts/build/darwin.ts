/**
 * input: Electron build config, staged runtime assets, and macOS target architecture
 * output: A verified architecture-specific Storyflow DMG path
 * pos: macOS packaging gate for the desktop release pipeline
 *
 * macOS-specific build logic
 */

import { $ } from 'bun';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BuildConfig } from './common';

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function hasAppleApiCredentials(): boolean {
  return Boolean((process.env.APPLE_API_KEY_BASE64 || process.env.APPLE_API_KEY) && process.env.APPLE_API_KEY_ID);
}

function hasApplePasswordCredentials(): boolean {
  return Boolean(process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD);
}

function shouldEnableMacReleaseSigning(): boolean {
  return process.env.CRAFT_REQUIRE_MAC_SIGNING === '1' || hasAppleApiCredentials() || hasApplePasswordCredentials();
}

function validateMacReleaseCredentials(): void {
  if (process.env.CRAFT_REQUIRE_MAC_SIGNING !== '1') return;

  requireEnv('CSC_LINK');
  if (!hasAppleApiCredentials() && !hasApplePasswordCredentials()) {
    throw new Error(
      'Official macOS release builds require Apple notarization credentials: ' +
      'APPLE_API_KEY_BASE64/APPLE_API_KEY + APPLE_API_KEY_ID, or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD.',
    );
  }
}

function prepareAppleApiKey(tempDir: string): void {
  if (!process.env.APPLE_API_KEY_BASE64) return;

  requireEnv('APPLE_API_KEY_ID');
  const apiKeyPath = join(tempDir, `AuthKey_${process.env.APPLE_API_KEY_ID}.p8`);
  writeFileSync(apiKeyPath, Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'));
  process.env.APPLE_API_KEY = apiKeyPath;
}

function selectNotarizationCredentials(): void {
  if (process.env.APPLE_API_KEY_BASE64 || process.env.APPLE_API_KEY) {
    requireEnv('APPLE_API_KEY');
    requireEnv('APPLE_API_KEY_ID');
    delete process.env.APPLE_ID;
    delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
    delete process.env.APPLE_TEAM_ID;
    console.log(process.env.APPLE_API_ISSUER
      ? 'Using App Store Connect Team API key notarization'
      : 'Using App Store Connect Individual API key notarization');
    return;
  }

  if (hasApplePasswordCredentials()) {
    console.log('Using Apple ID app-specific password notarization');
    return;
  }

  throw new Error('Missing Apple notarization credentials for macOS release signing.');
}

function runOpenSsl(args: string[]): boolean {
  const result = spawnSync('openssl', args, { stdio: 'ignore' });
  return result.status === 0;
}

function normalizeCscLinkForMacosSecurity(tempDir: string): void {
  const cscLink = process.env.CSC_LINK;
  if (!cscLink || !existsSync(cscLink) || !/\.(p12|pfx)$/i.test(cscLink)) return;

  const passFile = join(tempDir, 'storyflow-csc-password');
  const pemFile = join(tempDir, 'storyflow-csc-extracted.pem');
  const normalizedP12 = join(tempDir, 'storyflow-csc-normalized.p12');
  writeFileSync(passFile, process.env.CSC_KEY_PASSWORD || '', { mode: 0o600 });

  const readOk = runOpenSsl(['pkcs12', '-in', cscLink, '-passin', `file:${passFile}`, '-nodes', '-out', pemFile])
    || runOpenSsl(['pkcs12', '-legacy', '-in', cscLink, '-passin', `file:${passFile}`, '-nodes', '-out', pemFile]);
  if (!readOk) {
    console.log('OpenSSL could not read CSC_LINK; using CSC_LINK as provided.');
    return;
  }

  const exportOk = runOpenSsl(['pkcs12', '-export', '-legacy', '-in', pemFile, '-out', normalizedP12, '-passout', `file:${passFile}`]);
  if (!exportOk) {
    console.log('OpenSSL could not normalize CSC_LINK; using CSC_LINK as provided.');
    return;
  }

  process.env.CSC_LINK = normalizedP12;
  console.log('Normalized CSC_LINK for macOS keychain import.');
}

async function runElectronBuilderWithRetries(electronDir: string, builderArgs: string[]): Promise<void> {
  const maxAttempts = Number(process.env.CRAFT_MACOS_NOTARIZE_ATTEMPTS || '3');
  const retryDelaySeconds = Number(process.env.CRAFT_MACOS_NOTARIZE_RETRY_DELAY_SECONDS || '60');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`electron-builder attempt ${attempt} of ${maxAttempts}...`);
    try {
      await $`cd ${electronDir} && npx electron-builder ${builderArgs}`;
      return;
    } catch (error) {
      if (!shouldEnableMacReleaseSigning() || attempt >= maxAttempts) {
        throw error;
      }
      console.log(`electron-builder failed during signed macOS packaging; retrying after ${retryDelaySeconds}s.`);
      await Bun.sleep(retryDelaySeconds * 1000);
    }
  }
}

async function notarizeDmg(dmgPath: string): Promise<void> {
  if (!existsSync(dmgPath)) {
    throw new Error(`DMG artifact not found at ${dmgPath}`);
  }

  console.log('Submitting DMG for Apple notarization...');
  if (process.env.APPLE_API_KEY || process.env.APPLE_API_KEY_BASE64) {
    requireEnv('APPLE_API_KEY');
    requireEnv('APPLE_API_KEY_ID');
    const args = ['notarytool', 'submit', dmgPath, '--wait', '--output-format', 'json', '--key', process.env.APPLE_API_KEY!, '--key-id', process.env.APPLE_API_KEY_ID!];
    if (process.env.APPLE_API_ISSUER) args.push('--issuer', process.env.APPLE_API_ISSUER);
    await $`xcrun ${args}`;
  } else {
    requireEnv('APPLE_ID');
    requireEnv('APPLE_TEAM_ID');
    requireEnv('APPLE_APP_SPECIFIC_PASSWORD');
    await $`xcrun notarytool submit ${dmgPath} --wait --output-format json --apple-id ${process.env.APPLE_ID!} --team-id ${process.env.APPLE_TEAM_ID!} --password ${process.env.APPLE_APP_SPECIFIC_PASSWORD!}`;
  }

  console.log('Stapling DMG notarization ticket...');
  await $`xcrun stapler staple ${dmgPath}`;
}

async function verifyMacReleaseArtifacts(appPath: string, dmgPath: string, zipPath: string): Promise<void> {
  if (!existsSync(dmgPath)) throw new Error(`Expected DMG artifact not found at ${dmgPath}`);
  if (!existsSync(zipPath)) throw new Error(`Expected ZIP artifact not found at ${zipPath}`);

  console.log(`DMG artifact present: ${dmgPath}`);
  console.log(`ZIP artifact present: ${zipPath}`);
  console.log('Verifying Developer ID signature...');
  await $`codesign --verify --deep --strict --verbose=2 ${appPath}`;
  console.log('Verifying Gatekeeper assessment for app bundle...');
  await $`spctl --assess --type execute --verbose=4 ${appPath}`;
  console.log('Validating notarization staple for app bundle...');
  await $`xcrun stapler validate ${appPath}`;
  console.log('Verifying Gatekeeper assessment for DMG...');
  await $`spctl --assess --type open --context context:primary-signature --verbose=4 ${dmgPath}`;
  console.log('Validating notarization staple for DMG...');
  await $`xcrun stapler validate ${dmgPath}`;
}

/**
 * Package the macOS app with electron-builder
 */
export async function packageDarwin(config: BuildConfig): Promise<string> {
  const { arch, electronDir } = config;
  const tempDir = mkdtempSync(join(tmpdir(), 'storyflow-macos-build-'));

  try {
    prepareAppleApiKey(tempDir);
    validateMacReleaseCredentials();
    normalizeCscLinkForMacosSecurity(tempDir);

    console.log('Packaging app with electron-builder...');

    // Set up environment for electron-builder
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';

    // Build electron-builder arguments
    const builderArgs = ['--mac', `--${arch}`];
    if (shouldEnableMacReleaseSigning()) {
      builderArgs.push('-c.mac.forceCodeSigning=true', '-c.mac.notarize=true');
      selectNotarizationCredentials();
      console.log('Notarization enabled');
    } else {
      builderArgs.push('-c.mac.forceCodeSigning=false', '-c.mac.notarize=false', '-c.mac.identity=null', '-c.dmg.sign=false');
      console.log('Notarization credentials not present; building a local unsigned macOS package.');
    }

    // Add code signing if identity is available
    if (process.env.APPLE_SIGNING_IDENTITY) {
      // Strip "Developer ID Application: " prefix if present (electron-builder adds it automatically)
      const cscName = process.env.APPLE_SIGNING_IDENTITY.replace('Developer ID Application: ', '');
      console.log(`  Using signing identity: ${cscName}`);
      process.env.CSC_NAME = cscName;
    }

    await runElectronBuilderWithRetries(electronDir, builderArgs);

    const macDir = arch === 'arm64' ? 'mac-arm64' : 'mac';
    const appPath = join(electronDir, 'release', macDir, 'Storyflow.app');

    // Verify the DMG was built.
    const dmgName = `Storyflow-${arch}.dmg`;
    const dmgPath = join(electronDir, 'release', dmgName);
    const zipPath = join(electronDir, 'release', `Storyflow-${arch}.zip`);

    if (!existsSync(dmgPath)) {
      console.error('Contents of release directory:');
      await $`ls -la ${join(electronDir, 'release')}`;
      throw new Error(`Expected DMG not found at ${dmgPath}`);
    }

    if (shouldEnableMacReleaseSigning()) {
      await notarizeDmg(dmgPath);
    }

    if (process.env.CRAFT_REQUIRE_MAC_SIGNING === '1') {
      await verifyMacReleaseArtifacts(appPath, dmgPath, zipPath);
    }

    // Get file sizes
    const dmgFile = Bun.file(dmgPath);
    const dmgSizeMB = ((await dmgFile.size) / 1024 / 1024).toFixed(2);

    console.log(`\n=== Build Complete ===`);
    console.log(`DMG: ${dmgPath} (${dmgSizeMB} MB)`);

    return dmgPath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
