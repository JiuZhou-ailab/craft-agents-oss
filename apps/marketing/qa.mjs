// input: A running production marketing preview and the ego-browser Page API
// output: Browser-level regression assertions and optional screenshots
// pos: Marketing public-page QA; run with ego-browser nodejs < apps/marketing/qa.mjs
const config = globalThis.marketingQA || {};
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  config.space ? Number(config.space) : "Marketing QA",
);
const page = task.page(config.page || "p1");
const base = config.url || "http://127.0.0.1:4176";
await page.cdp("Network.enable");
await page.cdp("Network.setCacheDisabled", { cacheDisabled: true });
await page.cdp("Network.setBlockedURLs", { urls: [] });
await page.goto(base);
await page.reload();
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.waitForSelector('section[aria-label="写作演示"]');
await page.click('section[aria-label="写作演示"] button:has-text("改动审阅")');
await page.click('section[aria-label="写作演示"] button:has-text("接受改动")');
assert.match(
  await page.evaluate(
    () => document.querySelector('section[aria-label="写作演示"]').textContent,
  ),
  /演示：已保留这处改动/,
);
await page.click('section[aria-label="写作演示"] button:has-text("重新审阅")');
await page.click('section[aria-label="写作演示"] button:has-text("拒绝改动")');
assert.match(
  await page.evaluate(
    () => document.querySelector('section[aria-label="写作演示"]').textContent,
  ),
  /演示：已恢复原文/,
);
await page.click('section[aria-label="写作演示"] button:has-text("创作目标")');
assert.match(
  await page.evaluate(
    () => document.querySelector('section[aria-label="写作演示"]').textContent,
  ),
  /第一章的创作目标/,
);
await page.click('section[aria-label="写作演示"] button:has-text("正文成果")');
assert.match(
  await page.evaluate(
    () => document.querySelector('section[aria-label="写作演示"]').textContent,
  ),
  /第 01 章 主播你刚才说什么，黑洞？/,
);
await page.click(
  'section[aria-label="项目文件演示"] .project-files button:has-text("人物.md")',
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('section[aria-label="项目文件演示"]').textContent,
  ),
  /苏白/,
);
await page.click(
  'section[aria-label="项目文件演示"] .project-files button:has-text("创作要求.md")',
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('section[aria-label="项目文件演示"]').textContent,
  ),
  /语气要求/,
);
await page.click(
  'section[aria-label="Skills 方法演示"] button:has-text("使用示例")',
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('section[aria-label="Skills 方法演示"]')
        .textContent,
  ),
  /先给出依据/,
);
await page.click(
  'section[aria-label="Skills 方法演示"] button:has-text("方法说明")',
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('section[aria-label="Skills 方法演示"]')
        .textContent,
  ),
  /Reading/,
);
await page.click(
  'aside[aria-label="续写任务的引用依据"] button:has-text("人物.md")',
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".project-demo .demo-paper h3").textContent,
  ),
  /苏白/,
);
await page.evaluate(() => document.querySelector("#downloads button").focus());
await page.press("#downloads button", "Enter");
const expectedInstallers = [
  "Storyflow-arm64.dmg",
  "Storyflow-x64.dmg",
  "Storyflow-x64.exe",
].map(
  (name) =>
    `${config.downloadBase || "https://story-storage.zjding.com/latest"}/${name}`,
);
assert.deepEqual(
  await page.evaluate(() =>
    [...document.querySelectorAll("#installer-options a[download]")].map(
      (a) => a.href,
    ),
  ),
  expectedInstallers,
);
await page.press("#downloads button", "Tab");
assert.equal(
  await page.evaluate(
    () =>
      document.activeElement === document.querySelector("#installer-options a"),
  ),
  true,
);
await page.keyboard.press("Escape");
assert.equal(
  await page.evaluate(
    () =>
      document.activeElement === document.querySelector("#downloads button") &&
      !document.querySelector("#installer-options"),
  ),
  true,
);
await page.goto(`${base}/docs/#first-task`);
await page.waitForFunction(
  () =>
    Math.abs(
      document.querySelector("#first-task").getBoundingClientRect().top - 72,
    ) < 4,
);
await page.reload();
await page.waitForFunction(
  () =>
    Math.abs(
      document.querySelector("#first-task").getBoundingClientRect().top - 72,
    ) < 4,
);
await page.click('header a:has-text("理解产品")');
await page.waitForURL("**/#workflow");
await page.evaluate(() => history.back());
await page.waitForURL("**/docs/#first-task");
await page.evaluate(() => history.forward());
await page.waitForURL("**/#workflow");
const observations = [];
for (const width of [1440, 768, 390, 320]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto(base);
  await page.waitForSelector("h1");
  const sections = await page.evaluate(
    () => document.querySelectorAll("main > section").length,
  );
  for (let index = 0; index < sections; index++) {
    await page.evaluate(
      (index) =>
        document.querySelectorAll("main > section")[index].scrollIntoView(),
      index,
    );
    await page.waitForFunction(() =>
      [...document.images]
        .filter((img) => {
          const r = img.getBoundingClientRect();
          return r.top < innerHeight && r.bottom > 0;
        })
        .every((img) => img.complete && img.naturalWidth > 0),
    );
  }
  const images = await page.evaluate(() => document.images.length);
  for (let index = 0; index < images; index++) {
    await page.evaluate(
      (index) => document.images[index].scrollIntoView({ block: "center" }),
      index,
    );
    await page.waitForFunction(
      (index) =>
        document.images[index].complete &&
        document.images[index].naturalWidth > 0,
      index,
    );
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await page.evaluate(() => ({
    width: innerWidth,
    noOverflow:
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
    heading: document.querySelector("h1").getBoundingClientRect().toJSON(),
    stage: document
      .querySelector(".hero-stage")
      .getBoundingClientRect()
      .toJSON(),
    allImagesLoaded: [...document.images].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  }));
  console.log(result);
  assert.equal(result.noOverflow, true, `No page overflow at ${width}px`);
  assert.equal(
    result.allImagesLoaded,
    true,
    `Product captures load at ${width}px`,
  );
  observations.push(result);
  if (config.output && [1440, 390].includes(width))
    await page.screenshot({
      path: `${config.output}/storyflow-${width}.png`,
      fullPage: true,
    });
  if (width < 768) {
    await page.click("header a.header-download-mobile");
    await page.waitForURL("**/docs/#install");
    await page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector("#install").getBoundingClientRect().top - 72,
        ) < 4,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll("#install a[download]")].map(
          (a) => a.href,
        ),
      ),
      expectedInstallers,
    );
  }
  await page.goto(`${base}/docs/`);
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
    `Tutorial has no overflow at ${width}px`,
  );
}
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await page.goto(base);
await page.click('section[aria-label="写作演示"] button:has-text("创作目标")');
assert.match(
  await page.evaluate(
    () => document.querySelector('section[aria-label="写作演示"]').textContent,
  ),
  /第一章的创作目标/,
);
await page.cdp("Emulation.setEmulatedMedia", { features: [] });
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", {
  urls: ["*storyflow-skills-detail.webp*"],
});
await page.reload();
await page.evaluate(() => document.querySelector("#skills").scrollIntoView());
await page.waitForFunction(() =>
  document.body.textContent.includes("截图暂未加载"),
);
assert.equal(
  await page.evaluate(() =>
    [...document.querySelectorAll("a")].some(
      (a) => a.getAttribute("href") === "/docs/",
    ),
  ),
  true,
);
await page.cdp("Network.setBlockedURLs", { urls: [] });
await page.reload();
if (config.output) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(config.output, { recursive: true });
  await fs.writeFile(
    `${config.output}/qa-results.json`,
    JSON.stringify(
      { capturedAt: new Date().toISOString(), observations },
      null,
      2,
    ),
  );
}
console.log(
  "PASS: demo states, review decisions, project files, downloads, deep links/history, four viewport widths, reduced motion, and failed-media fallback.",
);
console.log(observations);
await page.cdp("Network.setCacheDisabled", { cacheDisabled: false });
if (!config.space) await task.finish({ keep: [] });
