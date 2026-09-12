// input: Public release download metadata
// output: Regression checks for release download targets and landing copy
// pos: Marketing app guard for release metadata and the public landing page

import { describe, expect, test } from "bun:test";
import {
  publicInstallerAssets,
  releaseAssetFiles,
  updateManifestFiles,
} from "@storyflow/release-assets";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../App";
import { DocsPage } from "../DocsPage";
import { docsChapters, findDocsChapter, resolveLegacyDocsTarget } from "../docs-content";
import { ChangelogPage } from "../ChangelogPage";
import { embedReleaseNotes, readReleaseNotes } from "../../release-notes";

import {
  defaultDownloadBaseUrl,
  downloadBaseUrl,
  downloadOptions,
  normalizeDownloadBaseUrl,
  updateManifestUrls,
} from "../downloads";

describe("downloadOptions", () => {
  test("points every installer at the public R2 release assets with Chinese labels", () => {
    expect(defaultDownloadBaseUrl).toBe(
      "https://story-storage.zjding.com/latest",
    );
    expect(downloadBaseUrl).toBe(defaultDownloadBaseUrl);

    expect(downloadOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mac-arm64",
          label: "下载 Apple Silicon 版",
          fileName: releaseAssetFiles.macArm64Dmg,
          href: `${downloadBaseUrl}/${releaseAssetFiles.macArm64Dmg}`,
        }),
        expect.objectContaining({
          id: "mac-x64",
          label: "下载 Intel Mac 版",
          fileName: releaseAssetFiles.macX64Dmg,
          href: `${downloadBaseUrl}/${releaseAssetFiles.macX64Dmg}`,
        }),
        expect.objectContaining({
          id: "windows-x64",
          label: "下载 Windows 版",
          fileName: releaseAssetFiles.windowsX64Exe,
          href: `${downloadBaseUrl}/${releaseAssetFiles.windowsX64Exe}`,
        }),
      ]),
    );
    expect(downloadOptions.map((option) => option.fileName)).toEqual(
      publicInstallerAssets.map((asset) => asset.fileName),
    );

    expect(
      downloadOptions.every((option) =>
        option.fileName.startsWith("Storyflow-"),
      ),
    ).toBe(true);
    expect(
      downloadOptions.every((option) => option.href.endsWith(option.fileName)),
    ).toBe(true);
    expect(
      downloadOptions.every(
        (option) => !option.href.match(/Storyflow-\d+\.\d+\.\d+/),
      ),
    ).toBe(true);
    expect(
      downloadOptions.every((option) => !option.href.includes("Craft-Agents")),
    ).toBe(true);
    expect(
      downloadOptions.every((option) => !option.href.includes("github.com")),
    ).toBe(true);
  });

  test("normalizes configured R2 download bases", () => {
    expect(
      normalizeDownloadBaseUrl(" https://cdn.example.com/releases/latest/// "),
    ).toBe("https://cdn.example.com/releases/latest");
    expect(normalizeDownloadBaseUrl("   ")).toBe(defaultDownloadBaseUrl);
  });

  test("exposes public update manifests next to installer assets", () => {
    expect(updateManifestUrls).toEqual({
      macOS: `${downloadBaseUrl}/${updateManifestFiles.macOS}`,
      Windows: `${downloadBaseUrl}/${updateManifestFiles.Windows}`,
    });
  });

  test("keeps landing previews unannotated and full-frame before interaction", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="写作实拍导览"');
    expect(html).not.toContain('class="tour-outline"');
    expect(html).not.toContain('class="tour-number"');
    expect(html).not.toContain('data-zoom="true"');
    expect(html).toContain("查看细节");
    expect(html).toContain("/reference-assets/current/workspace.png");
    expect(html).toContain("示例项目");
  });

  test("keeps the public product, download, and documentation entry points", () => {
    const html = renderToStaticMarkup(createElement(App));
    const documentShell = readFileSync(
      resolve(import.meta.dir, "../../index.html"),
      "utf8",
    );
    expect(html).toContain("Storyflow 是小说创作者的 AI 写作工作台。");
    expect(html).toContain("下载 macOS / Windows");
    expect(html).toContain("飞书：派大星");
    expect(html).toContain('href="mailto:zjdding@gmail.com"');
    expect(html).toContain('href="/docs/"');
    expect(html).toContain("本地项目是否等于离线模型");
    expect(html).toContain("支持 Apple Silicon、Intel Mac 和 Windows x64");
    expect(html).toContain("更新日志");
    expect(html).toContain('href="/changelog/"');
    expect(html).not.toContain('class="release-card"');
    expect(html).not.toContain("missing_api_key");
    expect(documentShell).toContain(
      "<title>Storyflow - 小说创作者的 AI 桌面工作台</title>",
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, target] of html.matchAll(/href="\/#([^"]+)"/g))
      expect(ids).toContain(target);
  });

  test("keeps every version's full release notes on site, excluding drafts", () => {
    const releases = readReleaseNotes();
    const html = renderToStaticMarkup(createElement(ChangelogPage, { releases }));
    expect(html).toContain('<h1 class="section-heading" id="changelog-title">更新日志</h1>');
    expect(releases.length).toBeGreaterThanOrEqual(24);
    expect(releases.map(({ version }) => version)).toContain("0.21.3");
    expect(releases[releases.length - 1]?.version).toBe("0.10.6");
    expect(html.match(/class="release-entry"/g)).toHaveLength(releases.length);
    for (const { version } of releases) {
      expect(html).toContain(`href="#v${version}"`);
      expect(html).toContain(`id="v${version}"`);
    }
    expect(html).toContain("刷新页面、切换项目或重新连接后");
    expect(html).toContain("<strong>待回答问题可恢复</strong>");
    expect(html).toContain("<h3>对话与工具</h3>");
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("最新动态");
    expect(html.match(/<h1 /g)).toHaveLength(1);
    const embedded = embedReleaseNotes("<!-- release-notes -->");
    expect(JSON.parse(embedded.replace(/^.*?application\/json">/, "").replace(/<\/script>$/, ""))).toEqual(releases);
    const literal = [{ version: "1.0.0", html: "保留 $& $` $' </script> 内容" }];
    const safeEmbedded = embedReleaseNotes("<!-- release-notes -->", literal);
    expect(safeEmbedded.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(safeEmbedded.replace(/^.*?application\/json">/, "").replace(/<\/script>$/, ""))).toEqual(literal);
  });

  test("automatically includes future version files, orders numerically and omits drafts", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "marketing-notes-"));
    try {
      for (const version of ["0.9.0", "0.22.0", "0.100.0", "next", "0.101.0-beta"]) {
        writeFileSync(resolve(directory, `${version}.md`), "# 最新动态\n\n完整内容 **保留**。\n\n<script>alert(1)</script>");
      }
      const releases = readReleaseNotes(directory);
      expect(releases.map(({ version }) => version)).toEqual(["0.100.0", "0.22.0", "0.9.0"]);
      expect(releases[0]?.html).toContain("<strong>保留</strong>");
      expect(releases[0]?.html).not.toContain("<script>");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("renders only the selected chapter and preserves all tutorial content and links", () => {
    let promptCount = 0;
    for (const chapter of docsChapters) {
      const html = renderToStaticMarkup(createElement(DocsPage, { pathname: chapter.path }));
      expect(html).toContain(`<h1>${chapter.title}</h1>`);
      expect(html).toContain('<details class="docs-more" open="">');
      expect(html).toContain('aria-label="本页目录"');
      expect(html).toContain(`href="${chapter.path}" data-storyflow-page-link="true" aria-current="page"`);
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of docsChapters) {
        for (const anchor of item.anchors) {
          if (item === chapter) expect(ids).toContain(anchor);
          else expect(ids).not.toContain(anchor);
        }
      }
      for (const [, href] of html.matchAll(/href="(\/docs\/[^"]*)"/g)) {
        const url = new URL(href, "https://example.com");
        const destination = findDocsChapter(url.pathname);
        expect(destination).toBeDefined();
        if (url.hash) expect(destination?.anchors).toContain(url.hash.slice(1));
      }
      promptCount += (html.match(/class="prompt-example"/g) ?? []).length;
      expect(html).not.toContain("立即使用");
      const index = docsChapters.indexOf(chapter);
      if (index > 0) expect(html).toContain(`rel="prev" href="${docsChapters[index - 1]!.path}"`);
      if (index < docsChapters.length - 1) expect(html).toContain(`rel="next" href="${docsChapters[index + 1]!.path}"`);
    }
    expect(promptCount).toBe(4);
    const install = renderToStaticMarkup(createElement(DocsPage, { pathname: "/docs/install/" }));
    for (const option of downloadOptions) expect(install).toContain(`href="${option.href}"`);
  });

  test("resolves old tutorial bookmarks and keeps nested routes in the tutorial", () => {
    const originalWindow = globalThis.window;
    try {
      for (const chapter of docsChapters) {
        for (const anchor of chapter.anchors) {
          expect(resolveLegacyDocsTarget({ pathname: "/docs/", hash: `#${anchor}` }))
            .toEqual({ pathname: chapter.path, hash: `#${anchor}` });
        }
        Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { location: { pathname: chapter.path, hash: "" } } });
        expect(renderToStaticMarkup(createElement(App))).toContain(`<h1>${chapter.title}</h1>`);
      }
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { location: { pathname: "/docs/missing/", hash: "" } } });
      expect(renderToStaticMarkup(createElement(App))).toContain("没有找到这个教程页面");
      for (const hash of ["#missing", "#%ZZ"]) {
        expect(resolveLegacyDocsTarget({ pathname: "/docs/", hash })).toEqual({ pathname: "/docs/", hash });
      }
      expect(resolveLegacyDocsTarget({ pathname: "/changelog/", hash: "#install" })).toEqual({ pathname: "/changelog/", hash: "#install" });
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: originalWindow });
    }
  });

  test("marks same-site page links for client-side navigation", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('href="/docs/"');
    expect(html).toContain('data-storyflow-page-link="true"');
    expect(html).toContain('href="/#workflow"');
    expect(html).toContain('href="/#downloads"');
  });

  test("keeps legacy root-domain release paths redirected to storage", () => {
    const redirects = readFileSync(
      resolve(import.meta.dir, "../../_redirects"),
      "utf8",
    );

    expect(redirects).toContain(
      "/latest/* https://story-storage.zjding.com/latest/:splat 301",
    );
    expect(redirects).toContain(
      "/releases/* https://story-storage.zjding.com/releases/:splat 301",
    );
    expect(redirects).toContain("/docs /docs/ 301");
    expect(redirects).toContain("/docs/ /index.html 200");
    expect(redirects).toContain("/docs/* /index.html 200");
    expect(redirects).toContain("/changelog /changelog/ 301");
    expect(redirects).toContain("/changelog/ /index.html 200");
  });
});
