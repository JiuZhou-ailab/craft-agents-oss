// input: apps/marketing React source, HTML shell, versioned release notes, and static marketing assets
// output: Static production assets in apps/marketing/dist
// pos: Build script for the public marketing landing page

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { embedReleaseNotes } from "../apps/marketing/release-notes";

const rootDir = join(import.meta.dir, "..");
const appDir = join(rootDir, "apps", "marketing");
const distDir = join(appDir, "dist");
const assetsDir = join(distDir, "assets");
const entrypoint = join(appDir, "src", "main.tsx");
const htmlPath = join(appDir, "index.html");
const faviconIcoPath = join(appDir, "favicon.ico");
const appleTouchIconPath = join(appDir, "apple-touch-icon.png");
const redirectsPath = join(appDir, "_redirects");
const referenceAssetsDir = join(appDir, "reference-assets");
const downloadBaseUrl = process.env.VITE_STORYFLOW_DOWNLOAD_BASE_URL ?? "";

if (!existsSync(entrypoint)) {
  throw new Error(`Missing marketing entrypoint: ${relative(rootDir, entrypoint)}`);
}

rmSync(distDir, { force: true, recursive: true });
mkdirSync(assetsDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir: assetsDir,
  target: "browser",
  format: "esm",
  define: {
    "import.meta.env": JSON.stringify({
      VITE_STORYFLOW_DOWNLOAD_BASE_URL: downloadBaseUrl,
    }),
  },
  minify: true,
  sourcemap: "external",
  splitting: true,
  naming: {
    asset: "[name]-[hash].[ext]",
    chunk: "[name]-[hash].[ext]",
    entry: "[name]-[hash].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const jsOutput = result.outputs.find((output) => output.path.endsWith(".js"));
const cssOutput = result.outputs.find((output) => output.path.endsWith(".css"));

if (!jsOutput) {
  throw new Error("Marketing build did not emit a JavaScript entry file.");
}

const jsAsset = `/assets/${basename(jsOutput.path)}`;
const cssAsset = cssOutput ? `/assets/${basename(cssOutput.path)}` : undefined;
let html = embedReleaseNotes(readFileSync(htmlPath, "utf8"));

html = html.replace(
  '<script type="module" src="/src/main.tsx"></script>',
  `${cssAsset ? `<link rel="stylesheet" href="${cssAsset}" />\n    ` : ""}<script type="module" src="${jsAsset}"></script>`,
);

writeFileSync(join(distDir, "index.html"), html);
if (existsSync(faviconIcoPath)) {
  copyFileSync(faviconIcoPath, join(distDir, "favicon.ico"));
}
if (existsSync(appleTouchIconPath)) {
  copyFileSync(appleTouchIconPath, join(distDir, "apple-touch-icon.png"));
}
if (existsSync(redirectsPath)) {
  copyFileSync(redirectsPath, join(distDir, "_redirects"));
}
if (existsSync(referenceAssetsDir)) {
  cpSync(referenceAssetsDir, join(distDir, "reference-assets"), { recursive: true });
}

console.log(`Built marketing site to ${relative(rootDir, distDir)}`);
