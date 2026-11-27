#!/usr/bin/env node
// LinkPix 浏览器版 CLI。
//
//   linkpix login              扫码登录一次，之后复用本地 profile
//   linkpix whoami             看当前账号与积分
//   linkpix models             看可用模型与单价
//   linkpix upload <file>      上传素材拿 URL
//   linkpix video --image ...  图生视频（提交 + 可选等待 + 可选下载）
//   linkpix status <taskId>    查任务
//   linkpix download <taskId>  下载产物
//
// 所有请求都从浏览器页面上下文发出，等价于你在网页上亲自点。

import path from "node:path";
import { parseArgs } from "node:util";
import {
  BASE, BIZ, api, cacheToken, closeQuietly, downloadTo, fmtCredits, httpJson,
  launch, openSession, readCachedToken, readToken, resolveAsset, uploadFile, waitForLogin,
} from "./lib.mjs";

const LANG = {
  简体中文: "simplified-chinese", 繁体中文: "traditional-chinese", 英语: "english",
  西班牙语: "spanish", 法语: "french", 德语: "german", 日语: "japanese",
  韩语: "korean", 葡萄牙语: "portuguese", 意大利语: "italian",
  阿拉伯语: "arabic", 俄语: "russian", 泰语: "thai", 马来语: "malay",
  印尼语: "indonesian", 菲律宾语: "filipino", 越南语: "vietnamese",
};

const RATIO = {
  portrait: "portrait", 竖屏: "portrait", "9:16": "portrait",
  landscape: "landscape", 横屏: "landscape", "16:9": "landscape",
  square: "square", 方屏: "square", "1:1": "square",
};

function normLanguage(value) {
  const text = String(value || "简体中文").trim();
  if (LANG[text]) return LANG[text];
  const lower = text.toLowerCase();
  const byCode = Object.values(LANG).find((code) => code === lower);
  return byCode || "simplified-chinese";
}

function normRatio(value) {
  const text = String(value || "portrait").trim();
  return RATIO[text] || RATIO[text.toLowerCase()] || "portrait";
}

function parseJsonField(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function durationConfigOf(item) {
  const cfg = parseJsonField(item.durationConfig);
  // 线上目录里 mode 是大写（RANGE / OPTIONS / FIXED），统一折成小写再用。
  if (cfg && cfg.mode) return { ...cfg, mode: String(cfg.mode).toLowerCase() };
  const value = Number(item.duration);
  return Number.isFinite(value) ? { mode: "fixed", value } : null;
}

function durationRange(cfg) {
  if (!cfg) return null;
  if (cfg.mode === "range") return { min: Number(cfg.min), max: Number(cfg.max) };
  if (cfg.mode === "options") {
    const values = (cfg.values || []).map(Number).filter(Number.isFinite);
    return { values };
  }
  if (cfg.mode === "fixed") return { values: [Number(cfg.value)] };
  return null;
}

function supportsDuration(cfg, duration) {
  const range = durationRange(cfg);
  if (!range) return false;
  if (range.values) return range.values.includes(duration);
  return duration >= range.min && duration <= range.max;
}

function costOf(sku, duration, count) {
  if (sku.isFree) return 0;
  const perSecond = Number(sku.secondCost);
  if (Number.isFinite(perSecond) && perSecond > 0) return perSecond * duration * count;
  const flat = Number(sku.tokenCost);
  return Number.isFinite(flat) ? flat * count : null;
}

/** 列模型：把线上目录压成「一个模型一行」，只留提交需要的字段。 */
function shapeModels(list, businessType) {
  const rows = [];
  for (const item of list) {
    if (!item || item.frontHide === 1 || item.frontHide === true) continue;
    const cfg = durationConfigOf(item);
    const range = durationRange(cfg);
    rows.push({
      label: String(item.label || "").trim(),
      skuId: item.id,
      businessType,
      duration: range && range.values ? range.values : range ? [range.min, range.max] : [],
      defaultDuration: cfg && cfg.defaultValue != null ? Number(cfg.defaultValue) : undefined,
      requiresImage: item.inputImageRequired === true,
      free: item.isFree === true,
      maintenance: item.maintenance === true,
      creditsPerSecond: item.secondCost != null ? Number(item.secondCost) : undefined,
      creditsFlat: item.tokenCost != null ? Number(item.tokenCost) : undefined,
      description: String(item.description || "").trim(),
    });
  }
  return rows;
}

async function fetchModels(page, token, businessType) {
  const suffix = businessType === "video" ? "&durationSelectable=true" : "";
  const res = await api(page, {
    path: `/api/qinghu-ai-agent/ai/model/list?businessType=${encodeURIComponent(businessType)}${suffix}`,
    token,
  });
  const list = (res.body && (res.body.data || res.body.payload)) || [];
  return Array.isArray(list) ? list : [];
}

/**
 * 没指定模型时挑一个。
 *
 * 默认**跳过**免费模型（isFree），按每秒单价从低到高。
 *
 * 原因很实际：免费通道（Viduq2-turbo）是有额度的，额度用完之后提交并不会报错，
 * 而是拿到一个永远 `pending` 的任务——用户会以为工具坏了。实测同一天第二条起
 * 就这样卡住。所以免费模型必须显式用 `--model Viduq2-turbo` 或 `--prefer-free`
 * 点名，才去用它。
 */
function pickModel(rawList, { duration, hasImage, preferFree = false }) {
  const usable = rawList
    .filter((item) => item.frontHide !== 1 && item.frontHide !== true)
    .filter((item) => item.maintenance !== true)
    .filter((item) => supportsDuration(durationConfigOf(item), duration))
    .filter((item) => (hasImage ? true : item.inputImageRequired !== true));

  const ranked = usable
    .map((item) => ({ item, cost: costOf(item, duration, 1) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => {
      const freeA = a.item.isFree ? 0 : 1;
      const freeB = b.item.isFree ? 0 : 1;
      if (freeA !== freeB) return freeA - freeB;
      return a.cost - b.cost;
    });

  if (preferFree) return ranked.length ? ranked[0].item : null;
  const paid = ranked.filter((entry) => entry.item.isFree !== true);
  return paid.length ? paid[0].item : ranked.length ? ranked[0].item : null;
}

function buildVideoPayload({ prompt, images, model, duration, orientation, count, language }) {
  const imagesWithStyle = images.map((url) => ({ url, text: "" }));
  const parameterPayload = {
    videoUrls: [],
    videoReferenceRules: null,
    audioUrls: [],
    orientation,
    duration,
    modelSkuId: model.id,
    count,
    language,
    modelSkuName: model.label || null,
    imagesWithStyle,
  };
  return {
    prompt,
    images,
    videoUrls: [],
    audioUrls: [],
    orientation,
    duration,
    count,
    language,
    parameterRequest: JSON.stringify(parameterPayload),
    prompt1688DetailGlobal: "",
    goodsDetailGlobal: { offerId: "", imageUrl: "" },
    modelSkuId: model.id,
    imagesWithStyle,
  };
}

function collectVideoUrls(data) {
  const urls = [];
  const push = (value) => {
    if (!value) return;
    if (typeof value === "string") { urls.push(value); return; }
    if (Array.isArray(value)) { value.forEach(push); return; }
    if (typeof value === "object") {
      if (typeof value.url === "string") urls.push(value.url);
      else if (typeof value.videoUrl === "string") urls.push(value.videoUrl);
    }
  };
  if (!data || typeof data !== "object") return urls;
  push(data.outputs);
  push(data.videos);
  push(data.videoUrl);
  return Array.from(new Set(urls));
}

async function getTask(token, taskId) {
  const body = await httpJson(
    `${BASE}/api/qinghu-ai-agent/ai/video/task/${encodeURIComponent(taskId)}`,
    { token },
  );
  const data = body && body.data ? body.data : {};
  const urls = collectVideoUrls(data);
  return {
    taskId: data.videoTaskId || taskId,
    status: String(data.status || "pending").toLowerCase(),
    done: urls.length > 0,
    videos: urls,
    error: data.error || data.errorMessage || null,
    frameRate: data.frameRate || null,
    freeChannel: data.freeChannel === true,
  };
}

/**
 * 轮询直到出片或超时。视频任务慢，默认给 20 分钟。
 *
 * 走 Node 直连而不是浏览器：轮询要发几十次 GET，没必要每次都经过页面，
 * 更重要的是这样不会把浏览器 profile 锁住二十分钟。
 */
async function waitTask(token, taskId, { timeoutMs = 20 * 60_000, intervalMs = 8000, onProgress } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await getTask(token, taskId);
    if (onProgress) onProgress(last, Math.round((Date.now() - started) / 1000));
    if (last.done) return { ...last, ok: true };
    if (last.status === "failed" || last.status === "error") {
      throw new Error(`任务失败：${last.error || last.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ...(last || { taskId, status: "timeout" }), ok: false, timeout: true };
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

const HELP = `LinkPix 浏览器版 CLI

用法：
  linkpix login [--timeout 300]              打开浏览器扫码登录
  linkpix whoami                             当前账号与积分
  linkpix models [--type video|image]        可用模型与单价
  linkpix upload <文件> [--type image|video] 上传素材拿 URL
  linkpix video --image <文件|URL> --prompt "..." [选项]
  linkpix status <taskId>
  linkpix download <taskId> [--out ./out]

video 选项：
  --model <名称>        指定模型，省略则自动选最便宜的可用模型
  --duration <秒>       时长，默认取该模型默认值
  --ratio <竖屏|横屏|方屏|9:16|16:9|1:1>
  --count <数量>        默认 1
  --language <语言>     默认 简体中文
  --wait                提交后等到出片
  --out <目录>          --wait 出片后直接下载
  --prefer-free         自动选型时优先用免费模型（额度通常只有一条，用完后任务会一直排队）
  --dry-run             只打印将要提交的内容和预估积分，不提交

通用选项：
  --headless            无头运行（首次登录不要用）
  --token <token>       手动指定 token，跳过读 profile
`;

async function withPage(options, fn) {
  const context = await launch({ headless: options.headless !== false });
  try {
    const page = await openSession(context);
    // 优先级：显式 --token > profile 里的 localStorage > 上次缓存
    // 兜底那层很关键：profile 里 token 偶尔会因为 SPA 没写回而读不到，
    // 但缓存还在，不该为此让整条命令失败。
    const token = options.token || (await readToken(page)) || (await readCachedToken());
    if (!token) {
      throw new Error("没有登录态。先跑 `linkpix login` 扫码，或用 --token 指定。");
    }
    // 顺手缓存，后续 status / download 就不用再起浏览器了
    await cacheToken(token);
    return await fn({ context, page, token });
  } finally {
    await closeQuietly(context);
  }
}

/** 拿 token：先用缓存的，没有才起浏览器。 */
async function resolveToken(options) {
  if (options.token) return options.token;
  const cached = await readCachedToken();
  if (cached) return cached;
  return null;
}

async function main() {
  const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: "string", multiple: true },
      prompt: { type: "string" },
      model: { type: "string" },
      duration: { type: "string" },
      ratio: { type: "string" },
      count: { type: "string" },
      language: { type: "string" },
      out: { type: "string" },
      type: { type: "string" },
      token: { type: "string" },
      timeout: { type: "string" },
      wait: { type: "boolean", default: false },
      "prefer-free": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      headless: { type: "boolean", default: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (options.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "login") {
    const context = await launch({ headless: false });
    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(`${BASE}/workbench/login?type=1`, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      const existing = await readToken(page);
      if (existing) {
        out({ ok: true, already: true, message: "这个 profile 已经登录过了，无需重复扫码。" });
        return;
      }
      process.stderr.write("浏览器已打开，请扫码或输账号登录。登录成功会自动继续（最多等 5 分钟）…\n");
      const token = await waitForLogin(page, {
        timeoutMs: Number(options.timeout || 300) * 1000,
        onTick: (sec) => { if (sec % 15 === 0) process.stderr.write(`  等待中 ${sec}s\n`); },
      });
      if (!token) throw new Error("等待登录超时。重新跑 `linkpix login` 再试。");
      await cacheToken(token);
      out({ ok: true, login: true, profile: "~/.linkpix-browser" });
    } finally {
      await closeQuietly(context);
    }
    return;
  }

  if (command === "whoami") {
    await withPage(options, async ({ page, token }) => {
      // userInfo 是网页端登录后写进 localStorage 的快照；用缓存 token 驱动的场景可能没有。
      const info = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem("userInfo") || "null"); } catch { return null; }
      });
      // 空对象也算没有快照：某些页面会先写一个 {} 占位
      const hasSnapshot = Boolean(info && (info.nickname || info.phone || info.userId));
      if (!hasSnapshot) {
        out({
          ok: true,
          loggedIn: Boolean(token),
          nickname: null,
          message: "token 有效，但 profile 里没有账号快照。想看昵称和积分余额，跑一次 `linkpix login`（已登录时不会要求重新扫码）。",
        });
        return;
      }
      out({
        ok: true,
        loggedIn: true,
        nickname: info.nickname,
        phone: info.phone,
        userId: info.userId,
        balance: info.balance,
        packages: ((info.vipInfo && info.vipInfo.packagePropertyList) || []).map((p) => ({
          name: p.name, remain: `${p.totalNumber - p.usageNumber}`, unit: p.unit, expire: p.expireTime,
        })),
      });
    });
    return;
  }

  if (command === "models") {
    await withPage(options, async ({ page, token }) => {
      const type = options.type || "video";
      const raw = await fetchModels(page, token, type);
      out({ ok: true, type, count: raw.length, models: shapeModels(raw, type) });
    });
    return;
  }

  if (command === "upload") {
    const file = rest[0];
    if (!file) throw new Error("用法：linkpix upload <文件>");
    await withPage(options, async ({ context, page, token }) => {
      const biz = BIZ[options.type || "image"] || BIZ.image;
      const res = await uploadFile(context, page, file, biz, token);
      out({ ok: true, ...res });
    });
    return;
  }

  if (command === "status") {
    const taskId = rest[0];
    if (!taskId) throw new Error("用法：linkpix status <taskId>");
    // 查一条任务不值得为它拉起 Chromium，有缓存 token 就直连
    const token = (await resolveToken(options)) || (await withPage(options, async ({ token: t }) => t));
    out({ ok: true, ...(await getTask(token, taskId)) });
    return;
  }

  if (command === "download") {
    const taskId = rest[0];
    if (!taskId) throw new Error("用法：linkpix download <taskId> --out ./out");
    const token = (await resolveToken(options)) || (await withPage(options, async ({ token: t }) => t));
    {
      const task = await getTask(token, taskId);
      if (!task.done) {
        out({ ok: false, status: task.status, message: "还没出片，过一会儿再试，或先跑 --wait。" });
        process.exitCode = 1;
        return;
      }
      const dir = path.resolve(options.out || "./linkpix-out");
      const saved = [];
      for (let i = 0; i < task.videos.length; i += 1) {
        const name = task.videos.length > 1 ? `${task.taskId}-${i + 1}` : task.taskId;
        saved.push(await downloadTo(task.videos[i], dir, name));
      }
      out({ ok: true, taskId: task.taskId, files: saved });
    }
    return;
  }

  if (command === "video") {
    const images = options.image || [];
    if (!images.length) throw new Error("图生视频至少要一张参考图：--image <文件|URL>");
    if (!options.prompt) throw new Error("缺少 --prompt。描述镜头、场景、动作，越具体越好。");

    await withPage(options, async ({ context, page, token }) => {
      // 1) 素材先落地成公网 URL
      const assets = [];
      for (const item of images) {
        assets.push(await resolveAsset(context, page, item, BIZ.image, token));
      }
      const imageUrls = assets.map((a) => a.url);

      // 2) 选模型：显式指定优先，否则按「免费 → 便宜 → 时长匹配」挑
      const raw = await fetchModels(page, token, "video");
      const durationAsked = options.duration ? Number(options.duration) : null;
      let model = null;
      let duration = durationAsked;

      if (options.model) {
        model = raw.find((item) => String(item.label || "").trim() === options.model.trim());
        if (!model) {
          const available = raw.filter((i) => i.frontHide !== 1).map((i) => i.label);
          throw new Error(`没有叫「${options.model}」的模型。可用：${available.join("、")}`);
        }
        if (model.maintenance === true) throw new Error(`模型「${options.model}」当前维护中，换一个。`);
        const cfg = durationConfigOf(model);
        if (duration == null) duration = Number(cfg && cfg.defaultValue) || 5;
        if (!supportsDuration(cfg, duration)) {
          const range = durationRange(cfg);
          const hint = range && range.values ? range.values.join("/") : `${range.min}-${range.max}`;
          throw new Error(`模型「${model.label}」不支持 ${duration} 秒，可选：${hint}`);
        }
      } else {
        if (duration == null) duration = 5;
        model = pickModel(raw, { duration, hasImage: true, preferFree: options["prefer-free"] === true });
        if (!model) throw new Error(`${duration} 秒没有可用模型，试试别的时长。`);
      }

      const orientation = normRatio(options.ratio);
      const count = Math.max(1, Number(options.count || 1));
      const language = normLanguage(options.language);
      const payload = buildVideoPayload({
        prompt: options.prompt, images: imageUrls, model,
        duration, orientation, count, language,
      });
      const estimate = costOf(model, duration, count);

      if (options["dry-run"]) {
        out({
          ok: true, dryRun: true,
          model: model.label, skuId: model.id, duration, orientation, count, language,
          images: imageUrls, assets,
          estimatedCredits: model.isFree ? "免费" : fmtCredits(estimate),
          payload,
        });
        return;
      }

      // 3) 提交
      process.stderr.write(`提交中：${model.label} / ${duration}秒 / ${orientation} / ${count}条…\n`);
      const submit = await api(page, {
        method: "POST", path: "/api/qinghu-ai-agent/ai/video/task", body: payload, token,
      });
      const data = (submit.body && submit.body.data) || {};
      const taskId = data.videoTaskId || data.qingHuTaskId;
      if (!taskId) throw new Error(`提交后没拿到任务 ID：${JSON.stringify(submit.body).slice(0, 400)}`);

      const base = {
        ok: true, stage: "submitted", taskId, status: data.status || "processing",
        model: model.label, duration, orientation, count,
        estimatedCredits: model.isFree ? "免费" : fmtCredits(estimate),
      };
      // 立刻把 taskId 打到 stderr：--wait 可能要等几十分钟，中途另开终端查进度、
      // 或者直接中断这条命令都用得上。
      process.stderr.write(`已提交 taskId=${taskId}\n`);

      // 4) 可选等待 + 下载
      if (!options.wait) {
        out({ ...base, hint: "用 `linkpix status <taskId>` 查进度，或加 --wait 直接等出片。" });
        return;
      }
      // 轮询不需要浏览器，先把 profile 让出来，别把后面的命令挡在锁外面
      await closeQuietly(context, 1000);
      let lastReported = 0;
      const task = await waitTask(token, taskId, {
        onProgress: (t, sec) => {
          // 轮询间隔不是整秒，按 30 秒「跨过」判断，别用取余
          if (sec - lastReported >= 30) {
            lastReported = sec;
            process.stderr.write(`  ${sec}s：${t.status}\n`);
          }
        },
      });
      if (!task.ok) {
        out({ ...base, stage: "timeout", status: task.status });
        process.exitCode = 1;
        return;
      }
      const result = { ...base, stage: "done", status: task.status, videos: task.videos };
      if (options.out) {
        const dir = path.resolve(options.out);
        const saved = [];
        for (let i = 0; i < task.videos.length; i += 1) {
          const name = task.videos.length > 1 ? `${taskId}-${i + 1}` : taskId;
          saved.push(await downloadTo(task.videos[i], dir, name));
        }
        result.files = saved;
      }
      out(result);
      return;
    });
    return;
  }

  throw new Error(`未知命令：${command}\n\n${HELP}`);
}

main().then(() => {
  // Chromium 子进程偶尔会拖住事件循环，显式退出，保证脚本能被 agent 直接复用。
  process.exit(process.exitCode || 0);
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2)}\n`);
  process.exit(1);
});
