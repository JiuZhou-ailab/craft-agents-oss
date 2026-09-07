// input: Build-time env vars and Electron main-process source
// output: Bundled main process and subprocess assets under apps/electron/dist
// pos: Shared Electron main build entrypoint used by dev and release packaging

/**
 * Cross-platform main process build script
 * Loads layered local env files and passes OAuth defines to esbuild
 */

import { spawn } from "bun";
import { existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { validateDesktopAuthBuildEnv } from "./build/desktop-auth-build-config";
import { buildPiAgentServerBinary } from "./build/pi-agent-server";
import { waitForFileStable } from "./build/common";
import { loadEnvFiles } from "./env-loader";

const ROOT_DIR = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT_DIR, "apps/electron/dist");
const OUTPUT_FILE = join(DIST_DIR, "main.cjs");
const SESSION_TOOLS_CORE_DIR = join(ROOT_DIR, "packages/session-tools-core");
const PI_AGENT_SERVER_DIR = join(ROOT_DIR, "packages/pi-agent-server");

// ESM packages (e.g. @earendil-works/pi-coding-agent) call fileURLToPath(import.meta.url)
// at module init. esbuild CJS leaves import.meta as {}, which crashes Electron load.
// Inject a runtime file URL for the bundle and rewrite import.meta.url to it.
const IMPORT_META_URL_BANNER =
  'var __import_meta_url=require("url").pathToFileURL(__filename).href;';
const IMPORT_META_URL_DEFINE = "--define:import.meta.url=__import_meta_url";

function validateDesktopAuthBuildConfig(): void {
  const validation = validateDesktopAuthBuildEnv(process.env);
  if (validation.ok) return;

  console.error("❌", validation.message);
  process.exit(1);
}

// Get public build-time defines for esbuild.
// NOTE: Google OAuth credentials are NOT baked into the build - users provide their own
// via source config. See README_FOR_OSS.md for setup instructions.
function getBuildDefines(): string[] {
  const definedVars = [
    "SLACK_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_SECRET",
    "MICROSOFT_OAUTH_CLIENT_ID",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
    "CRAFT_DEV_RUNTIME",
    // Public desktop auth bootstrap values. Server credentials stay on Workers.
    "CRAFT_CLIENT_AUTH_REQUIRED",
    "CRAFT_CLIENT_AUTH_BROKER_URL",
    "CRAFT_CLIENT_FEISHU_AUTH_BROKER_URL",
    "CRAFT_CLIENT_FEISHU_APP_ID",
    "CRAFT_CLIENT_FEISHU_SCOPE",
    "CRAFT_CLIENT_FEISHU_AUTH_BASE_URL",
    "CRAFT_CLIENT_FEISHU_CALLBACK_PORT",
    "CRAFT_CLIENT_FEISHU_LOGIN_TIMEOUT_MS",
    "CRAFT_CLIENT_NEON_AUTH_BASE_URL",
    "CRAFT_CLIENT_NEON_AUTH_JWKS_URL",
    "CRAFT_CLIENT_NEON_AUTH_ISSUER",
    "CRAFT_CLIENT_NEON_AUTH_AUDIENCE",
    "CRAFT_CLIENT_NEON_AUTH_USERNAME_EMAIL_DOMAIN",
    "CRAFT_CLIENT_NEON_AUTH_SIGN_UP_ENABLED",
    "CRAFT_CLIENT_NEON_AUTH_ORIGIN",
    "STORYFLOW_FEEDBACK_ENDPOINT",
  ];

  return definedVars.map((varName) => {
    const value = process.env[varName] || "";
    return `--define:process.env.${varName}="${value}"`;
  });
}

// Verify a JavaScript file is syntactically valid
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  const proc = spawn({
    cmd: ["node", "--check", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return { valid: false, error: stderr || "Syntax error" };
  }

  return { valid: true };
}

// Verify Session Tools Core package exists (raw TypeScript, bundled by consumers)
// No build step needed - it exports TypeScript directly like other packages
function verifySessionToolsCore(): void {
  console.log("🔍 Verifying Session Tools Core...");

  // Verify source exists
  const sourceFile = join(SESSION_TOOLS_CORE_DIR, "src/index.ts");
  if (!existsSync(sourceFile)) {
    console.error("❌ Session tools core source not found at", sourceFile);
    process.exit(1);
  }

  console.log("✅ Session tools core verified");
}

// Build the Pi Agent Server (subprocess for Pi SDK sessions)
// Optional: skips if package directory is missing (e.g., not synced to OSS).
async function buildPiAgentServer(): Promise<void> {
  if (!existsSync(join(PI_AGENT_SERVER_DIR, "src"))) {
    console.log("⏭️  Pi agent server skipped (package not found)");
    return;
  }

  console.log("🥧 Building Pi Agent Server...");

  const outputPath = await buildPiAgentServerBinary({ rootDir: ROOT_DIR });
  if (!existsSync(outputPath)) {
    console.error("❌ Pi agent server output not found at", outputPath);
    process.exit(1);
  }

  console.log("✅ Pi agent server built successfully");
}

// Build the WhatsApp worker (Baileys-backed subprocess spawned by WhatsAppAdapter)
async function buildWhatsAppWorker(): Promise<void> {
  const proc = spawn({
    cmd: ["bun", "run", "build:wa-worker"],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("❌ WhatsApp worker build failed with exit code", exitCode);
    process.exit(exitCode);
  }
}

async function main(): Promise<void> {
  loadEnvFiles({ rootDir: ROOT_DIR, mode: "build" });
  validateDesktopAuthBuildConfig();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  // Verify session tools core exists (shared utilities for session-scoped tools)
  verifySessionToolsCore();

  // Build session server (provides session-scoped tools like SubmitPlan)
  // Depends on session-tools-core being built first
  // Build Pi agent server (subprocess for Pi SDK sessions)
  await buildPiAgentServer();

  // Build WhatsApp worker (Baileys subprocess — optional package)
  await buildWhatsAppWorker();

  const buildDefines = getBuildDefines();

  console.log("🔨 Building main process...");

  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "apps/electron/src/main/index.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--outfile=apps/electron/dist/main.cjs",
      "--external:electron",
      // unzipper exposes an unused S3 helper that lazily requires AWS SDK v3.
      // Keep it external so local filesystem zip support can bundle without
      // shipping the AWS client.
      "--external:@aws-sdk/client-s3",
      // Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3)
      // with native Node globals. esbuild otherwise renames the polyfill's
      // `class AbortSignal` to `_AbortSignal` to dodge collision with the
      // global, which then breaks node-fetch@2's `constructor.name` check and
      // fails every Telegram API call with a TypeError.
      "--alias:node-fetch=./apps/electron/src/main/shims/node-fetch.cjs",
      "--alias:abort-controller=./apps/electron/src/main/shims/abort-controller.cjs",
      `--banner:js=${IMPORT_META_URL_BANNER}`,
      IMPORT_META_URL_DEFINE,
      ...buildDefines,
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ esbuild failed with exit code", exitCode);
    process.exit(exitCode);
  }

  // Wait for file to stabilize
  console.log("⏳ Waiting for file to stabilize...");
  const stable = await waitForFileStable(OUTPUT_FILE);

  if (!stable) {
    console.error("❌ Output file did not stabilize");
    process.exit(1);
  }

  // Verify the output
  console.log("🔍 Verifying build output...");
  const verification = await verifyJsFile(OUTPUT_FILE);

  if (!verification.valid) {
    console.error("❌ Build verification failed:", verification.error);
    process.exit(1);
  }

  // Guard the pi-coding-agent CJS regression: empty import.meta.url → fileURLToPath(undefined).
  const bundled = await Bun.file(OUTPUT_FILE).text();
  if (
    !bundled.includes("__import_meta_url") ||
    /fileURLToPath\)\(\s*import_meta\w*\.url\s*\)/.test(bundled)
  ) {
    console.error(
      "❌ Build verification failed: import.meta.url was not rewritten for CJS (pi-coding-agent would crash on load)",
    );
    process.exit(1);
  }

  console.log("✅ Build complete and verified");
  process.exit(0);
}

main();
