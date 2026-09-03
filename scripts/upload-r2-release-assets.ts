// input: Release artifacts downloaded from GitHub Actions, release profile, and Cloudflare R2 authentication
// output: Profile-scoped release assets, stable latest public assets, and optional old-release pruning in R2
// pos: Public release publisher for landing-page downloads and electron-updater manifests

import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  publicInstallerAssets,
  releaseAssetFiles,
  requiredPublicReleaseAssets,
  versionedInstallerFileName,
} from "@craft-agent/shared/release-assets";

type CliOptions = {
  assetsDir: string;
  tag: string;
  dryRun: boolean;
  profile: ReleaseAssetProfile;
  retainReleases?: number;
};

type UploadTarget = {
  key: string;
  cacheControl: string;
};

type UploadTask = {
  filePath: string;
  target: UploadTarget;
};

export type ReleaseAssetProfile = "full" | "windows" | "macos" | "metadata";

export type R2ReleaseRetentionPlan = {
  keptTags: string[];
  deletedTags: string[];
  deleteKeys: string[];
};

export type R2ReleaseRetentionInput = {
  objectKeys: string[];
  releasePrefix: string;
  retainReleases: number;
};

function usage(): string {
  return [
    "Usage: bun run scripts/upload-r2-release-assets.ts --tag=v0.9.12 --assets-dir=/path/to/assets [--dry-run]",
    "",
    "Required environment:",
    "  STORYFLOW_R2_BUCKET",
    "  Wrangler authentication via local `wrangler login` or CI CLOUDFLARE_API_TOKEN",
    "",
    "Optional environment:",
    "  STORYFLOW_R2_LATEST_PREFIX=latest",
    "  STORYFLOW_R2_RELEASE_PREFIX=releases",
    "  STORYFLOW_R2_PUBLIC_BASE_URL=https://story-storage.zjding.com",
    "",
    "Options:",
    "  --profile=full|windows|macos|metadata",
    "  --retain-releases=5",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const { values } = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "assets-dir": { type: "string" },
      tag: { type: "string" },
      "dry-run": { type: "boolean" },
      profile: { type: "string" },
      "retain-releases": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }

  const retainReleases = values["retain-releases"] === undefined
    ? undefined
    : Number.parseInt(values["retain-releases"], 10);
  if (retainReleases !== undefined && (!Number.isInteger(retainReleases) || retainReleases < 1)) {
    throw new Error(`Invalid --retain-releases value: ${values["retain-releases"]}`);
  }

  const options: CliOptions = {
    assetsDir: values["assets-dir"] ?? "",
    tag: values.tag ?? "",
    dryRun: values["dry-run"] ?? false,
    profile: parseReleaseAssetProfile(values.profile ?? "full"),
    retainReleases,
  };
  if (!options.assetsDir) {
    throw new Error("Missing --assets-dir");
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.tag)) {
    throw new Error(`Invalid --tag value: ${options.tag || "(missing)"}`);
  }

  return options;
}

function parseReleaseAssetProfile(value: string): ReleaseAssetProfile {
  if (value === "full" || value === "windows" || value === "macos" || value === "metadata") {
    return value;
  }
  throw new Error(`Invalid --profile value: ${value}`);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function shouldUploadFile(fileName: string): boolean {
  return (
    /^Storyflow-.+\.(dmg|zip|exe)$/.test(fileName) ||
    /^Storyflow-.+\.(dmg|zip|exe)\.blockmap$/.test(fileName) ||
    /^latest(?:-mac(?:-(?:arm64|x64))?)?\.yml$/.test(fileName) ||
    /^install-app\.(?:sh|ps1)$/.test(fileName) ||
    fileName === "whats-new.json"
  );
}

function shouldUploadFileForProfile(fileName: string, profile: ReleaseAssetProfile): boolean {
  if (!shouldUploadFile(fileName)) return false;
  if (profile === "full") return true;

  if (profile === "windows") {
    return (
      /^Storyflow-.+\.exe$/.test(fileName) ||
      /^Storyflow-.+\.exe\.blockmap$/.test(fileName) ||
      fileName === releaseAssetFiles.windowsManifest ||
      fileName === releaseAssetFiles.installPs1
    );
  }

  if (profile === "macos") {
    return (
      /^Storyflow-.+\.(dmg|zip)$/.test(fileName) ||
      /^Storyflow-.+\.(dmg|zip)\.blockmap$/.test(fileName) ||
      /^latest-mac(?:-(?:arm64|x64))?\.yml$/.test(fileName) ||
      fileName === releaseAssetFiles.installSh
    );
  }

  return (
    fileName === releaseAssetFiles.installSh ||
    fileName === releaseAssetFiles.installPs1 ||
    fileName === "whats-new.json"
  );
}

function requiredAssetsForProfile(profile: ReleaseAssetProfile): readonly string[] {
  if (profile === "windows") {
    return [
      releaseAssetFiles.windowsX64Exe,
      releaseAssetFiles.windowsManifest,
    ];
  }

  if (profile === "macos") {
    return [
      releaseAssetFiles.macArm64Dmg,
      releaseAssetFiles.macX64Dmg,
      releaseAssetFiles.macArm64Zip,
      releaseAssetFiles.macX64Zip,
      releaseAssetFiles.macManifest,
    ];
  }

  if (profile === "metadata") {
    return [
      releaseAssetFiles.installSh,
      releaseAssetFiles.installPs1,
    ];
  }

  return requiredPublicReleaseAssets;
}

function contentTypeFor(fileName: string): string {
  if (fileName.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (fileName.endsWith(".zip")) return "application/zip";
  if (fileName.endsWith(".exe")) return "application/octet-stream";
  if (fileName.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  if (fileName.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (fileName.endsWith(".ps1")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function versionedAliasFor(fileName: string, tag: string): string | undefined {
  const installerAsset = publicInstallerAssets.find(
    (asset) => asset.fileName === fileName,
  );
  if (!installerAsset) {
    return undefined;
  }
  return versionedInstallerFileName(installerAsset.fileName, tag);
}

function wranglerCommand(): string[] {
  return (process.env.STORYFLOW_R2_WRANGLER_COMMAND ?? "bunx wrangler@4.114.0")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function putObjectWithWrangler(params: {
  bucket: string;
  filePath: string;
  target: UploadTarget;
}): Promise<void> {
  const [command, ...baseArgs] = wranglerCommand();
  if (!command) {
    throw new Error("Missing Wrangler command");
  }

  const fileName = basename(params.filePath);
  const child = Bun.spawn(
    [
      command,
      ...baseArgs,
      "r2",
      "object",
      "put",
      `${params.bucket}/${params.target.key}`,
      "--file",
      params.filePath,
      "--content-type",
      contentTypeFor(fileName),
      "--cache-control",
      params.target.cacheControl,
      "--remote",
      "--force",
    ],
    {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    },
  );

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Wrangler upload failed for ${params.target.key} with exit code ${exitCode}`);
  }
}

async function uploadTasks(params: {
  tasks: UploadTask[];
  bucket: string;
  publicBaseUrl: string;
  dryRun: boolean;
}): Promise<void> {
  // ponytail: two uploads saturate the hosted runner without making R2 retries noisy.
  for (let index = 0; index < params.tasks.length; index += 2) {
    await Promise.all(params.tasks.slice(index, index + 2).map(async ({ filePath, target }) => {
      const publicUrl = `${params.publicBaseUrl}/${target.key}`;
      console.log(`${params.dryRun ? "Would upload" : "Uploading"} ${relative(process.cwd(), filePath)} -> ${publicUrl}`);
      if (!params.dryRun) {
        await putObjectWithWrangler({ bucket: params.bucket, filePath, target });
      }
    }));
  }
}

function parseReleaseTag(tag: string): [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag);
  if (!match) return [0, 0, 0];
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function compareReleaseTagsDesc(left: string, right: string): number {
  const leftParts = parseReleaseTag(left);
  const rightParts = parseReleaseTag(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = rightParts[index] - leftParts[index];
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}

export function planR2ReleaseRetention(input: R2ReleaseRetentionInput): R2ReleaseRetentionPlan {
  const releasePrefix = normalizePrefix(input.releasePrefix);
  const releasePathPrefix = `${releasePrefix}/`;
  const tags = new Set<string>();

  for (const key of input.objectKeys) {
    if (!key.startsWith(releasePathPrefix)) continue;
    const rest = key.slice(releasePathPrefix.length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0) continue;

    const tag = rest.slice(0, slashIndex);
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
      tags.add(tag);
    }
  }

  const sortedTags = Array.from(tags).sort(compareReleaseTagsDesc);
  const keptTags = sortedTags.slice(0, input.retainReleases);
  const deletedTags = sortedTags.slice(input.retainReleases);
  const deletedTagSet = new Set(deletedTags);
  const deleteKeys = input.objectKeys
    .filter((key) => {
      if (!key.startsWith(releasePathPrefix)) return false;
      const rest = key.slice(releasePathPrefix.length);
      const tag = rest.split("/", 1)[0];
      return deletedTagSet.has(tag);
    })
    .sort((a, b) => a.localeCompare(b));

  return { keptTags, deletedTags, deleteKeys };
}

function encodeR2ObjectKeyPath(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function cloudflareFetchJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T & { success?: boolean; errors?: unknown[] };

  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare R2 API request failed: ${JSON.stringify(body.errors ?? body)}`);
  }

  return body;
}

async function listR2ObjectKeys(params: {
  accountId: string;
  bucket: string;
  apiToken: string;
  prefix: string;
}): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const search = new URLSearchParams({ prefix: params.prefix });
    if (cursor) search.set("cursor", cursor);

    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.accountId)}/r2/buckets/${encodeURIComponent(params.bucket)}/objects?${search.toString()}`;
    const response = await cloudflareFetchJson<{
      result?: { objects?: Array<{ key?: string }>; cursor?: string; truncated?: boolean } | Array<{ key?: string }>;
      result_info?: { cursor?: string; is_truncated?: boolean };
    }>(url, params.apiToken);

    const result = response.result;
    const objects = Array.isArray(result) ? result : result?.objects ?? [];
    for (const object of objects) {
      if (object.key) keys.push(object.key);
    }

    const isTruncated = response.result_info?.is_truncated ?? (!Array.isArray(result) && result?.truncated) ?? false;
    cursor = isTruncated
      ? response.result_info?.cursor ?? (!Array.isArray(result) ? result?.cursor : undefined)
      : undefined;
  } while (cursor);

  return keys;
}

async function deleteR2ObjectKey(params: {
  accountId: string;
  bucket: string;
  apiToken: string;
  key: string;
}): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.accountId)}/r2/buckets/${encodeURIComponent(params.bucket)}/objects/${encodeR2ObjectKeyPath(params.key)}`;
  await cloudflareFetchJson(url, params.apiToken, { method: "DELETE" });
}

async function pruneR2ReleaseObjects(params: {
  bucket: string;
  releasePrefix: string;
  retainReleases: number;
  dryRun: boolean;
}): Promise<void> {
  if (params.dryRun) {
    console.log(`Would prune R2 releases to retain ${params.retainReleases} tag(s) under ${params.releasePrefix}/`);
    return;
  }

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const objectKeys = await listR2ObjectKeys({
    accountId,
    bucket: params.bucket,
    apiToken,
    prefix: `${normalizePrefix(params.releasePrefix)}/`,
  });
  const plan = planR2ReleaseRetention({
    objectKeys,
    releasePrefix: params.releasePrefix,
    retainReleases: params.retainReleases,
  });

  console.log(`Keeping R2 release tags: ${plan.keptTags.join(", ") || "(none)"}`);
  if (plan.deleteKeys.length === 0) {
    console.log("No old R2 release objects to delete.");
    return;
  }

  console.log(`Deleting ${plan.deleteKeys.length} old R2 release object(s): ${plan.deletedTags.join(", ")}`);
  for (const key of plan.deleteKeys) {
    await deleteR2ObjectKey({ accountId, bucket: params.bucket, apiToken, key });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const bucket = requireEnv("STORYFLOW_R2_BUCKET");
  const latestPrefix = normalizePrefix(process.env.STORYFLOW_R2_LATEST_PREFIX ?? "latest");
  const releasePrefix = normalizePrefix(process.env.STORYFLOW_R2_RELEASE_PREFIX ?? "releases");
  const publicBaseUrl = normalizeBaseUrl(
    process.env.STORYFLOW_R2_PUBLIC_BASE_URL ?? "https://story-storage.zjding.com",
  );

  const allFiles = readdirSync(options.assetsDir)
    .filter((fileName) => shouldUploadFileForProfile(fileName, options.profile))
    .sort((a, b) => a.localeCompare(b));

  const missingFiles = requiredAssetsForProfile(options.profile).filter((fileName) => !allFiles.includes(fileName));
  if (missingFiles.length > 0) {
    throw new Error(`Missing required release asset(s): ${missingFiles.join(", ")}`);
  }

  const releaseTasks: UploadTask[] = [];
  const latestAssetTasks: UploadTask[] = [];
  const latestManifestTasks: UploadTask[] = [];

  for (const fileName of allFiles) {
    const filePath = join(options.assetsDir, fileName);
    releaseTasks.push({
      filePath,
      target: {
        key: `${releasePrefix}/${options.tag}/${fileName}`,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    const versionedAlias = versionedAliasFor(fileName, options.tag);
    if (versionedAlias) {
      releaseTasks.push({
        filePath,
        target: {
          key: `${releasePrefix}/${options.tag}/${versionedAlias}`,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
    }

    const latestTask = {
      filePath,
      target: {
        key: `${latestPrefix}/${fileName}`,
        cacheControl: "public, max-age=300, must-revalidate",
      },
    };
    if (fileName === releaseAssetFiles.macManifest || fileName === releaseAssetFiles.windowsManifest) {
      latestManifestTasks.push(latestTask);
    } else {
      latestAssetTasks.push(latestTask);
    }
  }

  await uploadTasks({ tasks: releaseTasks, bucket, publicBaseUrl, dryRun: options.dryRun });
  await uploadTasks({ tasks: latestAssetTasks, bucket, publicBaseUrl, dryRun: options.dryRun });
  // Publish updater manifests only after every referenced latest artifact exists.
  await uploadTasks({ tasks: latestManifestTasks, bucket, publicBaseUrl, dryRun: options.dryRun });

  console.log(`Published ${allFiles.length} asset(s) to ${publicBaseUrl}/${latestPrefix}`);

  if (options.retainReleases !== undefined) {
    await pruneR2ReleaseObjects({
      bucket,
      releasePrefix,
      retainReleases: options.retainReleases,
      dryRun: options.dryRun,
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error("");
    console.error(usage());
    process.exit(1);
  });
}
