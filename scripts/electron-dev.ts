/**
 * input: Development environment, source tree, and optional CRAFT_CLEAN_VITE_CACHE=1 recovery flag
 * output: Cross-platform Electron development processes with reusable Vite dependency cache
 * pos: Local desktop development orchestrator
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, cpSync, statSync, mkdirSync } from "fs";
import { join, basename } from "path";
import * as esbuild from "esbuild";
import { downloadUv, waitForFileStable, type Platform, type Arch } from "./build/common";
import { buildPiAgentServerBinary } from "./build/pi-agent-server";
import { stageSubprocessResources } from "./build/resource-staging";
import { loadEnvFiles } from "./env-loader";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");
const DIST_DIR = join(ELECTRON_DIR, "dist");

// Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3) with
// native Node globals. esbuild otherwise renames the polyfill's `class
// AbortSignal` to `_AbortSignal` to dodge collision with the global, which
// breaks node-fetch@2's `constructor.name === 'AbortSignal'` check and fails
// every Telegram API call with a TypeError. Kept in sync with
// `apps/electron/package.json` build:main and `scripts/electron-build-main.ts`.
const MAIN_PROCESS_ALIAS: Record<string, string> = {
  "node-fetch": join(ROOT_DIR, "apps/electron/src/main/shims/node-fetch.cjs"),
  "abort-controller": join(ROOT_DIR, "apps/electron/src/main/shims/abort-controller.cjs"),
};

const MAIN_PROCESS_EXTERNAL = [
  "electron",
  // unzipper exposes an unused S3 helper that lazily requires AWS SDK v3.
  // Keep it external so electron-updater zip support can bundle in dev
  // without requiring the unused AWS client.
  "@aws-sdk/client-s3",
];

// ESM packages (e.g. @earendil-works/pi-coding-agent) call fileURLToPath(import.meta.url)
// at module init. esbuild CJS leaves import.meta as {}, which crashes Electron load.
const IMPORT_META_URL_BANNER =
  'var __import_meta_url=require("url").pathToFileURL(__filename).href;';
const IMPORT_META_URL_DEFINE = {
  "import.meta.url": "__import_meta_url",
};

// Pi agent server path (subprocess for Pi SDK sessions)
const PI_AGENT_SERVER_DIR = join(ROOT_DIR, "packages/pi-agent-server");

// Platform-specific binary paths (bun creates .exe on Windows, no extension on Unix)
const IS_WINDOWS = process.platform === "win32";
const BIN_EXT = IS_WINDOWS ? ".exe" : "";
const VITE_BIN = join(ROOT_DIR, `node_modules/.bin/vite${BIN_EXT}`);
const ELECTRON_BIN = join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`);

function resolveBuildPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform for uv bootstrap: ${process.platform}`);
}

function resolveBuildArch(): Arch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported architecture for uv bootstrap: ${process.arch}`);
}

async function ensureBundledUvForCurrentPlatform(): Promise<void> {
  const platform = resolveBuildPlatform();
  const arch = resolveBuildArch();
  const platformKey = `${platform}-${arch}`;
  const uvBinary = platform === "win32" ? "uv.exe" : "uv";
  const uvPath = join(ELECTRON_DIR, "resources", "bin", platformKey, uvBinary);

  if (existsSync(uvPath)) {
    console.log(`✅ Bundled uv present: ${uvPath}`);
    return;
  }

  console.log(`⬇️  Bundled uv missing, bootstrapping ${platformKey}...`);
  await downloadUv({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  });
}

// Multi-instance detection (matches detect-instance.sh logic)
// Detects instance number from folder name suffix (e.g., storyflow-1 → instance 1)
function detectInstance(): void {
  // Don't override if already set (e.g., by sourcing detect-instance.sh first)
  if (process.env.CRAFT_VITE_PORT) return;

  const folderName = basename(ROOT_DIR);
  const match = folderName.match(/-(\d+)$/);

  if (match) {
    const instanceNum = match[1];
    process.env.CRAFT_INSTANCE_NUMBER = instanceNum;
    process.env.CRAFT_VITE_PORT = `${instanceNum}173`;
    process.env.CRAFT_APP_NAME = `Storyflow [${instanceNum}]`;
    process.env.CRAFT_CONFIG_DIR = join(process.env.HOME || "", `.craft-agent-${instanceNum}`);
    process.env.CRAFT_DEEPLINK_SCHEME = `craftagents${instanceNum}`;
    console.log(`🔢 Instance ${instanceNum} detected: port=${process.env.CRAFT_VITE_PORT}, config=${process.env.CRAFT_CONFIG_DIR}`);
  }
}

// Kill any process using the specified port
async function killProcessOnPort(port: string): Promise<void> {
  const isWindows = process.platform === "win32";

  try {
    if (isWindows) {
      // Windows: use netstat to find PID, then taskkill
      const netstat = spawn({
        cmd: ["cmd", "/c", `netstat -ano | findstr :${port}`],
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      // Parse PIDs from netstat output (last column)
      const pids = new Set<string>();
      for (const line of output.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== "0") {
            pids.add(pid);
          }
        }
      }

      // Kill each PID
      for (const pid of pids) {
        const kill = spawn({
          cmd: ["taskkill", "/PID", pid, "/F"],
          stdout: "pipe",
          stderr: "pipe",
        });
        await kill.exited;
      }

      if (pids.size > 0) {
        console.log(`🔪 Killed ${pids.size} process(es) on port ${port}`);
      }
    } else {
      // Mac/Linux: use lsof and kill
      const lsof = spawn({
        cmd: ["sh", "-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`],
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(lsof.stdout).text();
      await lsof.exited;

      if (output.trim()) {
        console.log(`🔪 Killed process(es) on port ${port}`);
      }
    }
  } catch {
    // Ignore errors - port may not be in use
  }
}

function resolveLocalBrokerHealthUrl(): string | null {
  const rawBrokerUrl = process.env.CRAFT_CLIENT_AUTH_BROKER_URL
    || process.env.CRAFT_CLIENT_FEISHU_AUTH_BROKER_URL;
  if (!rawBrokerUrl) return null;

  try {
    const url = new URL(rawBrokerUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    return new URL("/health", url).toString();
  } catch {
    return null;
  }
}

async function isBrokerHealthy(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForBrokerHealthy(healthUrl: string, timeoutMs = 15000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isBrokerHealthy(healthUrl)) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function maybeStartLocalAuthBroker(processes: Subprocess[]): Promise<void> {
  const healthUrl = resolveLocalBrokerHealthUrl();
  if (!healthUrl) return;

  if (await isBrokerHealthy(healthUrl)) {
    console.log(`🔐 Local auth broker already healthy: ${healthUrl}`);
    return;
  }

  const hasFeishuBrokerConfig = Boolean(
    (process.env.CRAFT_WEBUI_FEISHU_APP_ID || process.env.CRAFT_CLIENT_FEISHU_APP_ID)
      && process.env.CRAFT_WEBUI_FEISHU_APP_SECRET,
  );
  const hasNeonBrokerConfig = Boolean(
    process.env.CRAFT_WEBUI_NEON_AUTH_BASE_URL || process.env.CRAFT_CLIENT_NEON_AUTH_BASE_URL,
  );

  if (!hasFeishuBrokerConfig && !hasNeonBrokerConfig) {
    console.warn("⚠️  Local auth broker not started: configure CRAFT_WEBUI_NEON_AUTH_BASE_URL for email login or CRAFT_WEBUI_FEISHU_APP_ID/CRAFT_WEBUI_FEISHU_APP_SECRET for Feishu login.");
    return;
  }

  console.log("🔐 Starting local auth broker...");
  const brokerProc = spawn({
    cmd: ["bun", "run", "scripts/auth-broker-dev.ts"],
    cwd: ROOT_DIR,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });
  processes.push(brokerProc);

  if (!await waitForBrokerHealthy(healthUrl)) {
    console.warn(`⚠️  Local auth broker did not become healthy at ${healthUrl}`);
  }
}

// Vite fingerprints dependency and config changes itself. Unconditional deletion
// makes the first project open re-optimize large editor/chat dependencies and
// reload the renderer; retain an explicit recovery switch for corrupted caches.
function cleanViteCacheOnRequest(): void {
  if (process.env.CRAFT_CLEAN_VITE_CACHE !== "1") return;

  const viteCacheDir = join(ELECTRON_DIR, "node_modules/.vite");
  if (existsSync(viteCacheDir)) {
    rmSync(viteCacheDir, { recursive: true, force: true });
    console.log("🧹 Cleaned Vite cache");
  }
}

// Copy resources to dist
function copyResources(): void {
  const srcDir = join(ELECTRON_DIR, "resources");
  const destDir = join(ELECTRON_DIR, "dist/resources");
  if (existsSync(srcDir)) {
    cpSync(srcDir, destDir, { recursive: true, force: true });
    console.log("📦 Copied resources to dist");
  }
}

// Build the WhatsApp worker bundle (dist/worker.cjs). Runs the canonical
// `scripts/build-wa-worker.ts` as a subprocess so the dev path stays in
// sync with the packaged/CI build. Cheap (~70ms) so we always rebuild.
async function buildWaWorker(): Promise<void> {
  console.log("📨 Building WhatsApp worker...");
  const proc = spawn({
    cmd: ["bun", "run", "scripts/build-wa-worker.ts"],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("❌ WhatsApp worker build failed");
    process.exit(1);
  }
}

// Build the Pi agent server once; it is not part of the watch graph.
async function buildAgentRuntime(): Promise<void> {
  console.log("🥧 Building Pi agent server...");

  const piDistDir = join(PI_AGENT_SERVER_DIR, "dist");
  if (!existsSync(piDistDir)) mkdirSync(piDistDir, { recursive: true });

  // Build Pi agent server with bun (not esbuild) because its Pi SDK deps are ESM-only.
  // esbuild with packages:external leaves them as require() calls which fail at runtime.
  // Optional: skip if package directory is missing (e.g., not synced to OSS).
  if (existsSync(join(PI_AGENT_SERVER_DIR, "src"))) {
    const piResult = await buildPiAgentServer();
    if (!piResult.success) {
      console.error("❌ Pi agent server build failed:", piResult.error);
      process.exit(1);
    }
    console.log("✅ Pi agent server built");
  } else {
    console.log("⏭️  Pi agent server skipped (package not found)");
  }
}

// Get OAuth defines for esbuild API
function getOAuthDefines(): Record<string, string> {
  const oauthVars = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SLACK_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_SECRET",
    "MICROSOFT_OAUTH_CLIENT_ID",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
  ];

  const defines: Record<string, string> = {};
  for (const varName of oauthVars) {
    const value = process.env[varName] || "";
    defines[`process.env.${varName}`] = JSON.stringify(value);
  }
  return defines;
}

// Get environment variables for electron process
function getElectronEnv(): Record<string, string> {
  const vitePort = process.env.CRAFT_VITE_PORT || "5173";

  // Codex binary path is resolved at runtime by the binary-resolver module.
  // It checks: CODEX_PATH env var > bundled binary > local dev fork > system PATH.
  // You can override with CODEX_PATH env var if needed for debugging.

  return {
    ...process.env as Record<string, string>,
    VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
    CRAFT_CONFIG_DIR: process.env.CRAFT_CONFIG_DIR || "",
    CRAFT_APP_NAME: process.env.CRAFT_APP_NAME || "Storyflow",
    CRAFT_DEEPLINK_SCHEME: process.env.CRAFT_DEEPLINK_SCHEME || "craftagents",
    CRAFT_INSTANCE_NUMBER: process.env.CRAFT_INSTANCE_NUMBER || "",
  };
}

// Run a one-shot esbuild using the JavaScript API
async function runEsbuild(
  entryPoint: string,
  outfile: string,
  defines: Record<string, string> = {},
  options: { packagesExternal?: boolean; alias?: Record<string, string> } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    await esbuild.build({
      entryPoints: [join(ROOT_DIR, entryPoint)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: join(ROOT_DIR, outfile),
      external: MAIN_PROCESS_EXTERNAL,
      ...(options.packagesExternal ? { packages: "external" as const } : {}),
      ...(options.alias ? { alias: options.alias } : {}),
      banner: { js: IMPORT_META_URL_BANNER },
      define: {
        ...IMPORT_META_URL_DEFINE,
        ...defines,
      },
      logLevel: "warning",
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function buildPiAgentServer(): Promise<{ success: boolean; error?: string }> {
  try {
    await buildPiAgentServerBinary({
      rootDir: ROOT_DIR,
      platform: resolveBuildPlatform(),
      arch: resolveBuildArch(),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Verify a built JavaScript bundle is parseable. `node --check` performs
// syntax-only validation — it does NOT execute module-level code or resolve
// `require()`, so Electron-specific top-level requires are safe. This catches
// truncated writes, FS corruption, and edge cases that
// esbuild's build-success signal doesn't cover.
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  try {
    const proc = spawn({
      cmd: ["node", "--check", filePath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { valid: false, error: stderr.trim() || `node --check exited ${exitCode}` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  console.log("🚀 Starting Electron dev environment...\n");

  // Setup
  detectInstance();
  loadEnvFiles({
    rootDir: ROOT_DIR,
    mode: "dev",
    log: (message) => console.log(`📄 ${message}`),
  });
  cleanViteCacheOnRequest();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  await ensureBundledUvForCurrentPlatform();

  await buildAgentRuntime();
  stageSubprocessResources({
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
    platform: resolveBuildPlatform(),
    arch: resolveBuildArch(),
  });
  copyResources();

  // Build WhatsApp worker bundle so the adapter can spawn it on demand
  await buildWaWorker();

  const vitePort = process.env.CRAFT_VITE_PORT || "5173";
  const oauthDefines = getOAuthDefines();

  // Kill any existing process on the Vite port
  await killProcessOnPort(vitePort);

  // =========================================================
  // PHASE 1: Initial build (one-shot, wait for completion)
  // =========================================================
  console.log("🔨 Building main process...");

  const mainCjsPath = join(DIST_DIR, "main.cjs");
  const preloadCjsPath = join(DIST_DIR, "bootstrap-preload.cjs");
  const toolbarPreloadCjsPath = join(DIST_DIR, "browser-toolbar-preload.cjs");

  // Remove old build files to ensure fresh build
  if (existsSync(mainCjsPath)) rmSync(mainCjsPath);
  if (existsSync(preloadCjsPath)) rmSync(preloadCjsPath);
  if (existsSync(toolbarPreloadCjsPath)) rmSync(toolbarPreloadCjsPath);

  // Build main and preload entries in parallel
  const [mainResult, preloadResult, toolbarPreloadResult] = await Promise.all([
    runEsbuild(
      "apps/electron/src/main/index.ts",
      "apps/electron/dist/main.cjs",
      oauthDefines,
      { alias: MAIN_PROCESS_ALIAS }
    ),
    runEsbuild(
      "apps/electron/src/preload/bootstrap.ts",
      "apps/electron/dist/bootstrap-preload.cjs"
    ),
    runEsbuild(
      "apps/electron/src/preload/browser-toolbar.ts",
      "apps/electron/dist/browser-toolbar-preload.cjs"
    ),
  ]);

  if (!mainResult.success) {
    console.error("❌ Main process build failed:", mainResult.error);
    process.exit(1);
  }

  if (!preloadResult.success) {
    console.error("❌ Preload build failed:", preloadResult.error);
    process.exit(1);
  }

  if (!toolbarPreloadResult.success) {
    console.error("❌ Browser toolbar preload build failed:", toolbarPreloadResult.error);
    process.exit(1);
  }

  // Wait for files to stabilize (filesystem flush)
  console.log("⏳ Waiting for build files to stabilize...");
  const [mainStable, preloadStable, toolbarPreloadStable] = await Promise.all([
    waitForFileStable(mainCjsPath),
    waitForFileStable(preloadCjsPath),
    waitForFileStable(toolbarPreloadCjsPath),
  ]);

  if (!mainStable || !preloadStable || !toolbarPreloadStable) {
    console.error("❌ Build files did not stabilize");
    process.exit(1);
  }

  // Verify the built files are valid JavaScript
  console.log("🔍 Verifying build output...");
  const [mainValid, preloadValid, toolbarPreloadValid] = await Promise.all([
    verifyJsFile(mainCjsPath),
    verifyJsFile(preloadCjsPath),
    verifyJsFile(toolbarPreloadCjsPath),
  ]);

  if (!mainValid.valid) {
    console.error("❌ main.cjs is invalid:", mainValid.error);
    process.exit(1);
  }

  if (!preloadValid.valid) {
    console.error("❌ bootstrap-preload.cjs is invalid:", preloadValid.error);
    process.exit(1);
  }

  if (!toolbarPreloadValid.valid) {
    console.error("❌ browser-toolbar-preload.cjs is invalid:", toolbarPreloadValid.error);
    process.exit(1);
  }

  console.log("✅ Initial build complete and verified\n");

  // =========================================================
  // PHASE 2: Start dev servers with watch mode
  // =========================================================
  console.log("📡 Starting dev servers...\n");

  const processes: Subprocess[] = [];
  const esbuildContexts: esbuild.BuildContext[] = [];

  await maybeStartLocalAuthBroker(processes);

  // 1. Vite dev server (strictPort ensures we don't silently switch ports)
  const viteProc = spawn({
    cmd: [VITE_BIN, "dev", "--config", "apps/electron/vite.config.ts", "--port", vitePort, "--strictPort"],
    cwd: ROOT_DIR,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });
  processes.push(viteProc);

  // 2. Main process watcher (using esbuild watch API)
  const mainContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/main/index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/main.cjs"),
    external: MAIN_PROCESS_EXTERNAL,
    alias: MAIN_PROCESS_ALIAS,
    banner: { js: IMPORT_META_URL_BANNER },
    define: {
      ...IMPORT_META_URL_DEFINE,
      ...oauthDefines,
    },
    logLevel: "info",
  });
  await mainContext.watch();
  await mainContext.rebuild();
  esbuildContexts.push(mainContext);
  console.log("👀 Watching main process...");

  // 3. Preload watcher (using esbuild watch API)
  const preloadContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/bootstrap.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/bootstrap-preload.cjs"),
    external: ["electron"],
    logLevel: "info",
  });
  await preloadContext.watch();
  await preloadContext.rebuild();
  esbuildContexts.push(preloadContext);
  console.log("👀 Watching preload...");

  // 4. Browser toolbar preload watcher (dedicated browser window bridge)
  const toolbarPreloadContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/browser-toolbar.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/browser-toolbar-preload.cjs"),
    external: ["electron"],
    logLevel: "info",
  });
  await toolbarPreloadContext.watch();
  await toolbarPreloadContext.rebuild();
  esbuildContexts.push(toolbarPreloadContext);
  console.log("👀 Watching browser toolbar preload...");

  // 5. Start Electron (build already verified)
  console.log("🚀 Starting Electron...\n");

  const electronProc = spawn({
    cmd: [ELECTRON_BIN, "apps/electron"],
    cwd: ROOT_DIR,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: getElectronEnv(),
  });
  processes.push(electronProc);

  // Handle cleanup on exit
  const cleanup = async () => {
    console.log("\n🛑 Shutting down...");
    // Dispose esbuild contexts
    for (const ctx of esbuildContexts) {
      try {
        await ctx.dispose();
      } catch {
        // Context may already be disposed
      }
    }
    // Terminate subprocesses and wait for them: Electron runs its quit
    // cleanup on SIGTERM and must finish releasing the server lease and the
    // single-instance lock before the next `electron:dev` can start.
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {
        // Process may already be dead
      }
    }
    await Promise.all(processes.map(async (proc) => {
      const timeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 8000);
      await proc.exited;
      clearTimeout(timeout);
    }));
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup());
  process.on("SIGTERM", () => cleanup());

  // Windows doesn't have SIGINT/SIGTERM in the same way
  if (process.platform === "win32") {
    process.on("SIGHUP", () => cleanup());
  }

  // Wait for electron to exit (main process)
  await electronProc.exited;
  await cleanup();
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
