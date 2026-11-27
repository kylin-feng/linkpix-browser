// LinkPix 浏览器驱动公共层。
//
// 设计要点：所有请求都从**页面上下文**发出（page.evaluate 里的 fetch），
// 这样 cookie、language、UA、来源都与用户手点完全一致，服务端不会区别对待。
// 登录态复用 localStorage.Authorization —— 也就是网页端自己用的那个 token。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

export const BASE = process.env.LINKPIX_BASE || "https://www.iqinghu.com";
export const STUDIO_PATH = "/workbench/linkpix/video";
export const DASHBOARD_PATH = "/workbench/dashboard";
// 只发接口请求时用的落地页：同源、纯静态、几乎瞬时加载。
// localStorage 和 cookie 都按 origin 共享，所以这里读到的 token 与工作台完全一致。
export const SESSION_PATH = "/workbench/user-agreement.html";

// 素材业务类型。上传接口靠它决定落到哪个存储目录、走什么审核。
export const BIZ = {
  image: "COMMON_IMAGE",
  video: "COMMON_VIDEO",
  audio: "USER_MATERIAL",
};

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

export function profileDir() {
  return process.env.LINKPIX_PROFILE || path.join(os.homedir(), ".linkpix-browser");
}

export function isUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/**
 * 从 localStorage 里取 token 并补齐 Bearer。
 * 网页端存的是裸 token；上传接口只认带 Bearer 的形式，会话接口两种都收，
 * 所以统一补成 Bearer 最省事。
 */
export function withBearer(raw) {
  const token = String(raw || "").trim();
  if (!token) return "";
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

export async function launch({ headless = true, viewport } = {}) {
  const dir = profileDir();
  await fsp.mkdir(dir, { recursive: true });
  const channel = process.env.LINKPIX_CHANNEL || undefined;
  const context = await chromium.launchPersistentContext(dir, {
    headless,
    channel,
    viewport: viewport || { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return context;
}

/**
 * 打开一个同源页面，作为后续所有 fetch 的执行环境。
 *
 * 默认落到静态页而不是工作台 SPA：接口调用只需要 origin + localStorage，
 * 加载整站反而会把每条命令拖到几十秒。
 */
export async function openSession(context) {
  const page = context.pages()[0] || (await context.newPage());
  const target = BASE + SESSION_PATH;
  if (!page.url().startsWith(BASE)) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return page;
}

/** 需要真实界面时（截图、UI 操作）再落到工作台。 */
export async function openStudio(context) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(BASE + STUDIO_PATH, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return page;
}

export async function readToken(page) {
  return page.evaluate(() => {
    try {
      return localStorage.getItem("Authorization");
    } catch {
      return null;
    }
  });
}

/**
 * 等扫码登录。会一直轮询 localStorage，直到 token 出现或超时。
 * 建议只在 login 命令里用，其他命令拿到空 token 就报错，不要静默等待。
 */
export async function waitForLogin(page, { timeoutMs = 300_000, onTick } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const token = await readToken(page);
    if (token) return token;
    if (onTick) onTick(Math.round((Date.now() - started) / 1000));
    await page.waitForTimeout(2000);
  }
  return null;
}

/**
 * 在页面上下文里发同源请求。
 * 返回 { status, body }；body 已尝试 JSON 解析，失败则保留原始文本。
 */
export async function api(page, { method = "GET", path: apiPath, body, token } = {}) {
  const result = await page.evaluate(
    async ({ method, apiPath, body, token }) => {
      const auth = (token || "").trim();
      const headers = { Authorization: /^Bearer\s+/i.test(auth) ? auth : `Bearer ${auth}` };
      if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
      const res = await fetch(apiPath, {
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, text, json: parsed };
    },
    { method, apiPath, body, token },
  );
  const out = { status: result.status, body: result.json, raw: result.text };
  if (result.status === 401) {
    throw new Error("未登录或登录已过期：这条请求返回 401。先跑 `linkpix login` 重新扫码。");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`请求失败 HTTP ${result.status}：${String(result.text).slice(0, 300)}`);
  }
  if (result.json && typeof result.json === "object" && result.json.code !== undefined && result.json.code !== 0 && result.json.code !== 200) {
    throw new Error(`接口返回错误 code=${result.json.code}：${result.json.msg || result.json.message || ""}`);
  }
  return out;
}

/**
 * 上传本地文件，返回可直接提交的素材 URL。
 *
 * 走 context.request 的 multipart（大文件不必 base64 塞进页面）；失败时回退到
 * 页面内 base64 重建 Blob —— 后者慢但能绕过个别代理对 multipart 的处理差异。
 */
export async function uploadFile(context, page, filePath, bizType, tokenIn) {
  const abs = path.resolve(filePath.replace(/^~(?=$|[\\/])/, os.homedir()));
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`文件不存在：${abs}`);
  const name = path.basename(abs);
  const mime = mimeOf(abs);
  // token 由调用方传入：新建的 profile 里 localStorage 是空的，
  // 用 --token 显式指定的场景下必须走参数，不能回头读页面。
  const token = withBearer(tokenIn || (await readToken(page)));
  if (!token) throw new Error("上传需要登录态，但没有拿到 token。");

  const res = await context.request.post(`${BASE}/api/desktop/qh/common/upload`, {
    headers: { Authorization: token },
    multipart: {
      file: { name, mimeType: mime, buffer: await fsp.readFile(abs) },
      uploadBizType: bizType,
    },
    timeout: 120_000,
  }).catch(() => null);

  if (res && res.ok()) {
    const data = await res.json().catch(() => null);
    const url = data && (data.payload || data.data);
    if (url) return { url: String(url), name, size: stat.size, via: "request" };
  }

  const base64 = await fsp.readFile(abs, { encoding: "base64" });
  const fallback = await page.evaluate(
    async ({ base64, name, mime, bizType, token }) => {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: mime }), name);
      fd.append("uploadBizType", bizType);
      const r = await fetch("/api/desktop/qh/common/upload", {
        method: "POST",
        headers: { Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}` },
        body: fd,
        credentials: "include",
      });
      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch { j = null; }
      return { status: r.status, url: j && (j.payload || j.data), raw: t.slice(0, 300) };
    },
    { base64, name, mime, bizType, token },
  );
  if (!fallback.url) throw new Error(`上传失败 HTTP ${fallback.status}：${fallback.raw}`);
  return { url: String(fallback.url), name, size: stat.size, via: "page" };
}

/** 本地路径则上传，http(s) 直接透传。 */
export async function resolveAsset(context, page, value, bizType, token) {
  if (isUrl(value)) return { url: value.trim(), name: path.basename(new URL(value.trim()).pathname) || "remote", size: 0, via: "url" };
  return uploadFile(context, page, value, bizType, token);
}

export function fmtCredits(n) {
  if (n == null || Number.isNaN(Number(n))) return "未知";
  return `${Math.round(Number(n) * 100) / 100} 积分`;
}

// ---- token 缓存 ------------------------------------------------------------
// 轮询和下载只需要一个 token，不需要再起浏览器。把登录后的 token 落在 profile
// 目录里，`status` / `download` 就能在别的命令跑着的时候独立工作。

function tokenFile() {
  return path.join(profileDir(), "token");
}

export async function cacheToken(token) {
  if (!token) return;
  const file = tokenFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(token), { encoding: "utf8", mode: 0o600 }).catch(() => {});
}

export async function readCachedToken() {
  try {
    const raw = await fsp.readFile(tokenFile(), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 不经浏览器，直接用 token 发 JSON 请求。
 * 用于轮询这类高频、短小的调用——不必为了一次 GET 拉起 Chromium。
 */
export async function httpJson(url, { method = "GET", body, token } = {}) {
  const headers = { Authorization: withBearer(token) };
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status === 401) throw new Error("未登录或登录已过期（401）。先跑 `linkpix login`。");
  if (res.status < 200 || res.status >= 300) throw new Error(`请求失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  if (json && typeof json === "object" && json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(`接口返回错误 code=${json.code}：${json.msg || json.message || ""}`);
  }
  return json;
}

export async function downloadTo(url, outDir, fallbackName) {
  await fsp.mkdir(outDir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(url).pathname) || ".bin";
  const file = path.join(outDir, `${fallbackName}${ext}`);
  await fsp.writeFile(file, buf);
  return { file, bytes: buf.length };
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 关浏览器，但不为它等太久。
 *
 * Chromium 在 persistent context 关闭时可能先等站点的长连接自然超时（实测 30 秒），
 * 一条命令干完这点收尾工作不值当。给个上限，剩下的交给进程退出时回收。
 */
export async function closeQuietly(context, ms = 3000) {
  if (!context) return;
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}
