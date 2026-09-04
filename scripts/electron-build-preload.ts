/**
 * Cross-platform preload build script.
 *
 * Builds both preload entry points:
 * - apps/electron/src/preload/bootstrap.ts -> dist/bootstrap-preload.cjs
 * - apps/electron/src/preload/browser-toolbar.ts -> dist/browser-toolbar-preload.cjs
 */

import { spawn } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT_DIR, "apps/electron/dist");

const OUTPUTS = [
  {
    entry: "apps/electron/src/preload/bootstrap.ts",
    outfile: "apps/electron/dist/bootstrap-preload.cjs",
    label: "bootstrap-preload.cjs",
  },
  {
    entry: "apps/electron/src/preload/browser-toolbar.ts",
    outfile: "apps/electron/dist/browser-toolbar-preload.cjs",
    label: "browser-toolbar-preload.cjs",
  },
] as const;

async function buildEntry(entry: string, outfile: string): Promise<number> {
  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      entry,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${outfile}`,
      "--external:electron",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc.exited;
}

async function main(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  console.log("🔨 Building preload entries...");

  for (const output of OUTPUTS) {
    const exitCode = await buildEntry(output.entry, output.outfile);
    if (exitCode !== 0) {
      console.error(`❌ Failed to build ${output.label} (exit code ${exitCode})`);
      process.exit(exitCode);
    }
  }

  console.log("✅ Preload builds complete");
  process.exit(0);
}

main();
