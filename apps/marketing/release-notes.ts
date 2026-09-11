// input: Versioned desktop release-note Markdown; next.md is an unpublished draft
// output: Complete, newest-first release history embedded in the website HTML
// pos: Shared build-time content loader for Bun production builds and Vite development

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

const notesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../electron/resources/release-notes");

export function readReleaseNotes(directory = notesDir) {
  return readdirSync(directory)
    .filter((file) => /^\d+\.\d+\.\d+\.md$/.test(file))
    .map((file) => ({ version: file.slice(0, -3), content: readFileSync(resolve(directory, file), "utf8") }))
    .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))
    .map(({ version, content }) => ({
      version,
      html: renderToStaticMarkup(createElement(Markdown, {
        // The page owns h1 and each version owns h2; note sections start at h3.
        components: { h1: "h3", h2: "h3", h3: "h4" },
        children: content.trim().replace(/^# 最新动态[ \t]*(?:\r?\n|$)/, "").trimStart(),
      })),
    }));
}

export function embedReleaseNotes(html: string, releases = readReleaseNotes()) {
  const data = JSON.stringify(releases).replace(/</g, "\\u003c");
  return html.replace("<!-- release-notes -->", () => `<script id="release-notes" type="application/json">${data}</script>`);
}
