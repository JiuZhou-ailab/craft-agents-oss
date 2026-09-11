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
assert.match(
  await page.evaluate(
    () => document.querySelector("#downloads button").textContent,
  ),
  /macOS \/ Windows/,
);
assert.equal(
  await page.evaluate(() =>
    document.querySelector(".footer-contact a").getAttribute("href"),
  ),
  "mailto:zjdding@gmail.com",
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".footer-contact").textContent,
  ),
  /飞书：派大星/,
);
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
// Exercise both clipboard outcomes without changing the user's clipboard.
assert.deepEqual(await page.evaluate(async () => {
  const own = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied = [];
  const blocks = [...document.querySelectorAll(".prompt-example")];
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value) => { copied.push(value); },
    }});
    for (const block of blocks) {
      block.querySelector("button").click();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const preserved = blocks.every((block, i) => copied[i] === block.querySelector("pre").textContent);
    const feedback = blocks.every(block => block.querySelector('[role="status"]').textContent.includes("已复制"));
    navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied for QA"); };
    blocks[0].querySelector("button").click();
    const deadline = performance.now() + 2000;
    while (!blocks[0].textContent.includes("手动复制") && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { count: blocks.length, preserved, feedback, fallback: blocks[0].textContent.includes("手动复制") };
  } finally {
    if (own) Object.defineProperty(navigator, "clipboard", own);
    else delete navigator.clipboard;
  }
}), { count: 4, preserved: true, feedback: true, fallback: true });

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
assert.equal(
  await page.evaluate(() => document.querySelector(".docs-toc details").open),
  true,
);
await page.waitForFunction(
  () =>
    document.querySelectorAll(".docs-page-toc a").length ===
    document.querySelectorAll(".docs-page h2[id], .docs-page h3[id]").length,
);
await page.click('.docs-page-toc a[href="#project-options"]');
await page.waitForURL("**/docs/#project-options");
await page.waitForFunction(
  () =>
    document
      .querySelector('.docs-page-toc a[aria-current="location"]')
      .getAttribute("href") === "#project-options",
);
assert.ok(
  await page.evaluate(
    () =>
      Math.abs(
        document.querySelector("#project-options").getBoundingClientRect().top -
          72,
      ) < 4,
  ),
);
await page.reload();
await page.waitForFunction(
  () =>
    document
      .querySelector('.docs-page-toc a[aria-current="location"]')
      ?.getAttribute("href") === "#project-options",
);
await page.click('header a:has-text("更新日志")');
await page.waitForURL("**/changelog/");
assert.equal(
  await page.evaluate(() => document.querySelector("h1").textContent),
  "更新日志",
);
assert.ok(
  await page.evaluate(() => document.querySelectorAll(".release-entry").length >= 24),
);
assert.ok(await page.evaluate(() => document.querySelector(".release-content").textContent.includes("待回答问题可恢复")));
assert.equal(await page.evaluate(() => document.querySelectorAll('.changelog a[href*="github.com"]').length), 0);
await page.click('.release-nav a[href="#v0.10.6"]');
await page.waitForURL("**/changelog/#v0.10.6");
await page.reload();
assert.ok(await page.evaluate(() => {
  const entry = document.getElementById("v0.10.6");
  return entry.getBoundingClientRect().top >= 0 && entry.getBoundingClientRect().top < 150;
}));
await page.evaluate(() => history.back());
await page.waitForURL("**/changelog/");
assert.equal(
  await page.evaluate(() => document.querySelectorAll(".product-tour").length),
  0,
);
await page.reload();
assert.equal(await page.evaluate(() => document.title), "Storyflow 更新日志");
await page.evaluate(() => history.back());
await page.waitForURL("**/docs/#project-options");
await page.goto(`${base}/docs/#first-task`);
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
  await page.goto(`${base}/changelog/`);
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
    `Changelog has no overflow at ${width}px`,
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
  "PASS: five-step tutorial and copy success/fallback, standalone changelog and history, expanded tutorial navigation and heading outline, all-platform downloads and contact, clean 16:10 previews, playback/zoom, four viewport widths, reduced motion, and failed-media fallback.",
);
console.log(observations);
await page.cdp("Network.setCacheDisabled", { cacheDisabled: false });
if (!config.space) await task.finish({ keep: [] });
