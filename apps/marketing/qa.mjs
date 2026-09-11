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
await page.waitForSelector('section[aria-label="写作实拍导览"]');
await page.click(
  'section[aria-label="写作实拍导览"] button:has-text("播放导览")',
);
await page.waitForFunction(
  () =>
    document
      .querySelector(
        'section[aria-label="写作实拍导览"] .tour-tabs button[aria-pressed="true"]',
      )
      .textContent.includes("引用项目文件"),
  undefined,
  { timeout: 10000 },
);
await page.click(
  'section[aria-label="写作实拍导览"] button:has-text("暂停导览")',
);
const pausedCapture = await page.evaluate(() =>
  document
    .querySelector('section[aria-label="写作实拍导览"] image')
    .getAttribute("href"),
);
await new Promise((resolve) => setTimeout(resolve, 6200));
assert.equal(
  await page.evaluate(() =>
    document
      .querySelector('section[aria-label="写作实拍导览"] image')
      .getAttribute("href"),
  ),
  pausedCapture,
);
for (const title of ["引用项目文件", "审阅具体改动", "目标与正文"]) {
  await page.click(
    `section[aria-label="写作实拍导览"] .tour-tabs button:has-text("${title}")`,
  );
  assert.equal(
    await page.evaluate(
      (title) =>
        [
          ...document.querySelectorAll(
            'section[aria-label="写作实拍导览"] .tour-tabs button',
          ),
        ]
          .find((b) => b.textContent.includes(title))
          .getAttribute("aria-pressed"),
      title,
    ),
    "true",
  );
}
assert.equal(
  await page.evaluate(
    () =>
      document.querySelectorAll(".tour-outline, .tour-marker, .tour-number")
        .length,
  ),
  0,
);
assert.equal(
  await page.evaluate(() => document.querySelectorAll(".header-nav a").length),
  5,
);
await page.click(
  'section[aria-label="写作实拍导览"] button:has-text("查看细节")',
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('section[aria-label="写作实拍导览"] .tour-camera')
        .style.transform,
  ),
  /scale\([2-9]|scale\(1\./,
);
await page.click(
  'section[aria-label="写作实拍导览"] button:has-text("查看全貌")',
);
await page.click(
  'section[aria-label="Skills 实拍"] .tour-tabs button:has-text("把方法带入任务")',
);
assert.match(
  await page.evaluate(() =>
    document
      .querySelector('section[aria-label="Skills 实拍"] image')
      .getAttribute("href"),
  ),
  /add-menu.png/,
);
await page.click(
  'section[aria-label="Skills 实拍"] .tour-tabs button:has-text("查看写作方法")',
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
assert.ok(
  await page.evaluate(
    () =>
      !!document.querySelector(".tour-outline") &&
      !!document.querySelector(".tour-number"),
  ),
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
    frameRatios: [
      ...document.querySelectorAll(".product-tour .tour-scene"),
    ].map((scene) => {
      const r = scene.getBoundingClientRect();
      return r.width / r.height;
    }),
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
  for (const ratio of result.frameRatios)
    assert.ok(Math.abs(ratio - 1.6) < 0.01, `Native 16:10 frame at ${width}px`);
  observations.push(result);
  if (config.output && [1440, 390].includes(width))
    await page.screenshot({
      path: `${config.output}/storyflow-${width}.png`,
      fullPage: true,
    });
  if (width < 1024) {
    await page.click(".header-menu-button");
    await page.click('header a:has-text("Skills")');
    await page.waitForURL("**/#skills");
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector(".header-menu-button")
          .getAttribute("aria-expanded"),
      ),
      "false",
    );
    await page.click(".header-menu-button");
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () =>
          document.activeElement ===
            document.querySelector(".header-menu-button") &&
          !document.querySelector(".header-nav.is-open"),
      ),
      true,
    );
  }
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
  const screenshotUrls = await page.evaluate(() =>
    [...document.querySelectorAll(".product-tour image")].map((image) =>
      image.getAttribute("href"),
    ),
  );
  for (const url of new Set(screenshotUrls)) {
    const response = await page.fetch(url);
    assert.equal(response.ok, true, `Native capture loads: ${url}`);
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
assert.equal(
  await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".tour-camera"))
        .transitionDuration,
  ),
  "0s",
);
assert.equal(
  await page.evaluate(
    () => getComputedStyle(document.querySelector(".tour-play")).display,
  ),
  "none",
);
await page.cdp("Emulation.setEmulatedMedia", { features: [] });
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", {
  urls: ["*/current/skills.png"],
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
  "PASS: clean 16:10 landing previews, tutorial-only annotations, desktop/mobile navigation, zoom, downloads, deep links/history, four viewport widths, reduced motion, and failed-media fallback.",
);
console.log(observations);
await page.cdp("Network.setCacheDisabled", { cacheDisabled: false });
if (!config.space) await task.finish({ keep: [] });
