// input: Public release download metadata
// output: Regression checks for release download targets and landing copy
// pos: Marketing app guard for release metadata and the public landing page

import { describe, expect, test } from "bun:test";
import {
  publicInstallerAssets,
  releaseAssetFiles,
  updateManifestFiles,
} from "@storyflow/release-assets";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../App";

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
    expect(html).toContain("下载 macOS 版本");
    expect(html).toContain('href="/docs/"');
    expect(html).toContain("本地项目是否等于离线模型");
    expect(html).toContain("支持 Apple Silicon、Intel Mac 和 Windows x64");
    expect(html).toContain("更新日志");
    expect(html).toContain(
      'href="https://github.com/JiuZhou-ailab/storyflow/releases/tag/v0.21.3"',
    );
    expect(html).not.toContain("missing_api_key");
    expect(documentShell).toContain(
      "<title>Storyflow - 小说创作者的 AI 桌面工作台</title>",
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, target] of html.matchAll(/href="\/#([^"]+)"/g))
      expect(ids).toContain(target);
  });

  test("renders the documentation as an in-site page", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { location: { pathname: "/docs" } },
    });

    try {
      const html = renderToStaticMarkup(createElement(App));

      expect(html).toContain("从一个项目，写出第一份稿件");
      expect(html).toContain("这次先完成一件小事");
      expect(html).toContain("常用工具在哪里");
      expect(html).toContain("认识工作台");
      expect(html).toContain("2. 创建你的作品项目");
      expect(html).toContain("系统只建立空项目");
      expect(html).toContain("判断是否用对了");
      expect(html).toContain("初始给出的信息越明确越好");
      expect(html).toContain("点击输入区的加号");
      expect(html).toContain('class="tour-outline"');
      expect(html).toContain('class="tour-number"');
      expect(html).toContain("current/workspace.png");
      expect(html).toContain("current/add-menu.png");
      expect(html).not.toContain("https://ehyg6a9wjd.feishu.cn/wiki");
      expect(html).toContain('aria-current="page"');
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
        expect(ids).toContain(target);
      }
      for (const option of downloadOptions) {
        expect(html).toContain(`href="${option.href}"`);
      }
      const steps = [
        "install",
        "create-project",
        "first-task",
        "review-changes",
        "header-tools",
      ];
      for (const step of steps) expect(ids).toContain(step);
      expect(steps.map((id) => ids.indexOf(id))).toEqual(
        steps.map((id) => ids.indexOf(id)).sort((a, b) => a - b),
      );
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          writable: true,
          value: originalWindow,
        });
      }
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
  });
});
