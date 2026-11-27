// 纯 UI 点击引擎（`--engine ui`）。
//
// 真的打开工作台、真的往上传框塞图、真的在 ProseMirror 里敲提示词、
// 真的点模型/时长/提交。适合想肉眼看着它跑的场合。
//
// 定位原则：能用可访问名称就不用 class，能用 DOM 关系就不用坐标。
// 这个页面里坐标点击会稳定地打到隔壁控件（详见 references/api.md 附录）。

import { BASE, STUDIO_PATH } from "./lib.mjs";

const RATIO_LABEL = { portrait: "9:16", landscape: "16:9", square: "1:1" };

async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelector(".contact-me-card__close")?.click();
  }).catch(() => {});
}

/** 读工具栏：当前模型、时长/比例、预估积分。 */
async function readToolbar(page) {
  return page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll("button"))
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean);
    const model = texts.find((t) => /^(Seedance|Viduq|全能电商|阿里|MiniMax|可灵|Happy|电商热卖)/.test(t)) || null;
    const time = texts.find((t) => /\d+秒\s*·/.test(t)) || null;
    const m = (document.body.innerText || "").match(/预估消耗\s*(\d+(?:\.\d+)?)\s*积分/);
    return { model, time, credits: m ? Number(m[1]) : null };
  });
}

/** 选模型：点开模型按钮，在 popover 里按名字点。 */
async function selectModel(page, modelLabel) {
  const before = await readToolbar(page);
  if (before.model === modelLabel) return before;

  const opener = page.locator("button", {
    hasText: /^(Seedance|Viduq|全能电商|阿里|MiniMax|可灵|Happy|电商热卖)/,
  }).first();
  await opener.click({ timeout: 15_000 });
  await page.waitForSelector(".ant-popover", { timeout: 10_000 });

  const option = page.locator(".ant-popover").getByText(modelLabel, { exact: true }).first();
  if (!(await option.count())) throw new Error(`模型下拉里没有「${modelLabel}」。`);
  await option.click({ timeout: 15_000 });
  await page.waitForTimeout(800);
  return readToolbar(page);
}

/**
 * 设置比例和时长：两者在同一个 popover 里。
 * 比例是 `.video-ratio-option` 按钮；时长是 ant-input-number，只能往输入框填值。
 */
async function setTimePanel(page, { duration, orientation }) {
  if (!duration && !orientation) return;
  const opener = page.locator("button").filter({ hasText: /\d+秒\s*·/ }).first();
  if (!(await opener.count())) return;
  await opener.click({ timeout: 10_000 }).catch(() => {});
  if (!(await page.waitForSelector(".ant-popover", { timeout: 8000 }).catch(() => null))) return;

  if (orientation && RATIO_LABEL[orientation]) {
    const r = page.locator(".video-ratio-option").filter({ hasText: RATIO_LABEL[orientation] }).first();
    if (await r.count()) await r.click({ timeout: 8000 }).catch(() => {});
  }

  if (duration) {
    const input = page.locator(".video-duration-range input").first();
    if (await input.count()) {
      const bounds = await input.evaluate((el) => ({
        min: Number(el.getAttribute("aria-valuemin") || 0),
        max: Number(el.getAttribute("aria-valuemax") || 0),
      })).catch(() => null);
      let value = Number(duration);
      if (bounds && bounds.min) value = Math.max(bounds.min, value);
      if (bounds && bounds.max) value = Math.min(bounds.max, value);
      await input.fill(String(value)).catch(() => {});
      await input.press("Tab").catch(() => {});
    }
  }
  await page.waitForTimeout(700);
}

/**
 * 点提交。
 *
 * 提交键是一张带可访问名称 "arrow-up" 的图（DOM 里没有 alt，名字来自上层），
 * 所以用 getByRole 找，而不是 img[alt=...]。
 * 它外面通常包着一层可点击容器，图本身被盖住时点父级更稳。
 */
async function clickSubmit(page) {
  const arrow = page.getByRole("img", { name: "arrow-up" });
  if (!(await arrow.count())) throw new Error("找不到提交键（可访问名称 arrow-up）。");
  try {
    await arrow.click({ timeout: 8000 });
  } catch {
    // 图被输入层盖住时，点它的可点击祖先
    await arrow.evaluate((el) => {
      const target = el.closest("button, [role=button], [class*=cursor]") || el.parentElement || el;
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }
}

/**
 * 走一遍 UI 提交，返回 { taskId, toolbar, uiCredits }。
 * taskId 从提交响应里抓，后续 --wait / --out 复用 api 引擎的轮询。
 */
export async function submitViaUI({
  page, imagePaths, prompt, modelLabel, duration, orientation, maxCredits = null,
}) {
  await page.goto(BASE + STUDIO_PATH, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await dismissOverlays(page);
  await page.waitForSelector(".ProseMirror", { timeout: 60_000 });

  // 1) 参考图
  await page.setInputFiles('input[type=file]', imagePaths);
  await page.waitForTimeout(3000);

  // 2) 提示词。上传后站点会自动生成一大段，必须清掉再写，否则提交的是它的词。
  const editor = page.locator(".ProseMirror");
  await editor.click({ timeout: 15_000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);
  if (!(await editor.innerText()).includes(prompt.slice(0, 10))) {
    throw new Error("提示词没写进输入框，UI 模式中止。");
  }

  // 3) 模型 → 时长/比例（换模型会重置这两个，所以顺序不能反）
  if (modelLabel) {
    const tb = await selectModel(page, modelLabel);
    if (tb.model !== modelLabel) {
      throw new Error(`模型没切过去，当前是「${tb.model}」。中止，避免按默认模型扣费。`);
    }
  }
  await setTimePanel(page, { duration, orientation });

  // 4) 提交前核对积分。界面上的数字是站点自己算的，比我们的估算可信。
  const before = await readToolbar(page);
  if (maxCredits != null && before.credits != null && before.credits > maxCredits) {
    throw new Error(`界面预估 ${before.credits} 积分，超过上限 ${maxCredits}。中止，没有提交。`);
  }

  // 5) 提交，并把这一串 POST 全收下来——只等第一个会抓到预检请求。
  const captured = [];
  const onResponse = async (r) => {
    if (r.request().method() !== "POST" || !r.url().includes("/api/")) return;
    try { captured.push(await r.text()); } catch { /* 读不到就跳过 */ }
  };
  page.on("response", onResponse);
  try {
    await clickSubmit(page);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      for (const body of captured) {
        if (!body.includes("TaskId")) continue;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { continue; }
        const data = (parsed && parsed.data) || {};
        if (data && typeof data === "object" && (data.videoTaskId || data.qingHuTaskId)) {
          return {
            taskId: data.videoTaskId || data.qingHuTaskId,
            toolbar: before, uiCredits: before.credits,
          };
        }
      }
      await page.waitForTimeout(500);
    }
    throw new Error("UI 点了提交，但没等到带任务 ID 的响应。任务可能已建好并扣费，先去工作台「资产」确认。");
  } finally {
    page.off("response", onResponse);
  }
}
