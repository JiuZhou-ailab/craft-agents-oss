// input: Release build target flags and platform packaging scripts
// output: A packaged Electron artifact for the requested platform and architecture
// pos: Root build dispatcher that keeps package.json from bypassing runtime staging

import { existsSync } from "fs";
import { join } from "path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  buildElectronApp,
  cleanBuildArtifacts,
  copyRipgrep,
  createManifest,
  downloadBun,
  downloadUv,
  installDependencies,
  loadEnvFile,
  uploadToS3,
  verifyPiAgentServerExists,
  type BuildConfig,
} from "./build/common.ts";
import { packageDarwin } from "./build/darwin.ts";
import { packageLinux } from "./build/linux.ts";
import { buildElectronAppWindows, packageWindows } from "./build/win32.ts";

type BuildPlatform = "darwin" | "linux" | "win32";
type BuildArch = "arm64" | "x64";

interface BuildOptions {
  platform: BuildPlatform;
  arch?: BuildArch;
  upload: boolean;
  latest: boolean;
  script: boolean;
}

const rootDir = join(import.meta.dir, "..");
const electronDir = join(rootDir, "apps", "electron");

function usage(): string {
  return [
    "Usage: bun run scripts/build.ts [--platform=darwin|linux|win32] [--arch=arm64|x64] [--upload] [--latest] [--script]",
    "",
    "Defaults:",
    "  --platform uses the current host platform.",
    "  --arch uses arm64 on darwin, x64 on linux/win32.",
    "",
    "The dispatcher stages runtime assets before electron-builder runs.",
  ].join("\n");
}

function parsePlatform(value: string): BuildPlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`Unsupported platform: ${value}`);
}

function parseArch(value: string): BuildArch {
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported arch: ${value}`);
}

function parseOptions(args: string[]): BuildOptions {
  const { values } = parseNodeArgs({
    args,
    allowPositionals: false,
    options: {
      platform: { type: "string" },
      arch: { type: "string" },
      upload: { type: "boolean" },
      latest: { type: "boolean" },
      script: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }

  const options: BuildOptions = {
    platform: parsePlatform(values.platform ?? process.platform),
    arch: values.arch === undefined ? undefined : parseArch(values.arch),
    upload: values.upload ?? false,
    latest: values.latest ?? false,
    script: values.script ?? false,
  };

  if (!options.arch) {
    options.arch = options.platform === "darwin" ? "arm64" : "x64";
  }

  if (options.platform === "win32" && options.arch !== "x64") {
    throw new Error("Windows packaging currently supports x64 only.");
  }

  if ((options.latest || options.script) && !options.upload) {
    throw new Error("--latest and --script require --upload.");
  }

  if (options.platform === "win32" && options.upload) {
    throw new Error("Windows upload is not wired. Build locally without --upload.");
  }

  if (options.upload && !existsSync(join(rootDir, "scripts", "upload.ts"))) {
    throw new Error("Upload requested, but scripts/upload.ts is missing. Build locally without --upload.");
  }

  return options;
}

function createBuildConfig(options: BuildOptions): BuildConfig {
  return {
    platform: options.platform,
    arch: options.arch!,
    upload: options.upload,
    uploadLatest: options.latest,
    uploadScript: options.script,
    rootDir,
    electronDir,
  };
}

async function prepareRuntime(config: BuildConfig): Promise<void> {
  await loadEnvFile(config);
  cleanBuildArtifacts(config);
  await installDependencies(config);
  await downloadBun(config);
  await downloadUv(config);
  copyRipgrep(config);
}

async function buildPackage(config: BuildConfig): Promise<void> {
  process.env.CRAFT_BUILD_PLATFORM = config.platform;
  process.env.CRAFT_BUILD_ARCH = config.arch;

  if (config.platform === "win32") {
    await buildElectronAppWindows(config);
    await packageWindows(config);
  } else {
    await buildElectronApp(config);
    verifyPiAgentServerExists(config);
    if (config.platform === "darwin") {
      await packageDarwin(config);
    } else {
      await packageLinux(config);
    }
  }

  await createManifest(config);
  await uploadToS3(config);
}

const options = parseOptions(Bun.argv.slice(2));
const config = createBuildConfig(options);

await prepareRuntime(config);
await buildPackage(config);
