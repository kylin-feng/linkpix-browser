---
name: linkpix-browser
description: 用浏览器登录态操作青虎 AI（LinkPix / iqinghu.com）的电商素材生成能力：商品图转带货视频、上传素材、查模型价格与积分。不需要 API key、不需要装 qhkit，只要在浏览器里登录过一次青虎账号。当用户提到 LinkPix、青虎 AI、iqinghu、图生视频、商品图做视频、带货短视频、电商素材批量生成、或者想在没有 API key 的情况下调用这套工具时，使用本技能。
---

# LinkPix 浏览器版

青虎 AI 的 LinkPix 有一套官方 CLI（`qhkit`，见 `autoagc/linkpix-skills`），但它要求你去后台申请 API key。本技能走另一条路：**用你自己在网页上登录的那个会话**，所以只要有青虎账号就能用。

## 先搞懂它在做什么

青虎的网页工作台（`www.iqinghu.com/workbench`）登录后会把一个 token 放在 **`localStorage.Authorization`** 里，同时种下 `qh_token` cookie。之后网页上每一次生成请求，本质都是带着这个 token 去调 `/api/qinghu-ai-agent/ai/...`。

本技能就是把这一步自动化：

1. Playwright 起一个**持久化 profile**，你手动扫码登录一次，token 就留在这个 profile 里；
2. 之后每条命令都用这个 profile 打开一个**同源静态页**（`/workbench/user-agreement.html`，比工作台 SPA 快两个数量级）；
3. 在页面上下文里 `fetch` 站点的接口 —— 请求头、cookie、来源、UA 和你在网页上手点完全一致。

这样做的好处是稳：不依赖任何 CSS 选择器，站点改版不会让脚本失效。坏处是它依赖站点的内部接口，青虎若改动接口路径需要同步更新。

## 环境

```bash
npm install                      # 装 playwright
npx playwright install chromium  # 下载浏览器内核（约 124MB，只需一次）
```

Node >= 18。Windows / macOS / Linux 都行。

## 第一步永远是登录

```bash
node scripts/linkpix.mjs login
```

会弹出一个真实浏览器窗口，停在工作台登录页。**扫码或输账号密码登录**，登录成功后命令自己退出，token 落到 `~/.linkpix-browser/`。

这个 profile 是你的账号本体，别提交到 git，也别拷给别人。要换账号就删掉这个目录重新 login。

用 `--headless` 跑其他命令是默认行为；登录时不要加，因为你需要看见二维码。

## 日常命令

```bash
# 看当前身份和积分余额
node scripts/linkpix.mjs whoami

# 有哪些模型、多少钱
node scripts/linkpix.mjs models --type video
node scripts/linkpix.mjs models --type image

# 上传素材，拿到可提交的 URL
node scripts/linkpix.mjs upload ./商品图.jpg

# 图生视频
node scripts/linkpix.mjs video \
  --image ./商品图.jpg \
  --prompt "产品置于浅色桌面，镜头缓慢推近，柔和自然光，背景虚化" \
  --duration 5 \
  --wait --out ./out

# 查任务 / 下载
node scripts/linkpix.mjs status <taskId>
node scripts/linkpix.mjs download <taskId> --out ./out
```

`--image` 可以给多个，也可以直接给公网 URL（站内素材域会跳过上传）。

### 先算钱再提交

**养成先 `--dry-run` 的习惯。** 它会打印将要提交的完整 payload 和预估积分，不提交、不扣费：

```bash
node scripts/linkpix.mjs video --image ./a.jpg --prompt "..." --duration 10 --dry-run
```

没指定 `--model` 时，脚本按「免费模型 → 每秒单价最低 → 时长匹配」自动挑一个。**免费模型优先**，所以默认几乎不会花钱。

## 模型与计费（2026-11 线上实测）

按秒计费，实扣 = 每秒单价 × 时长 × 数量。

| 模型 | 时长 | 积分/秒 | 要参考图 | 备注 |
|---|---|---|---|---|
| `Viduq2-turbo` | 仅 5 秒 | 0（**免费**） | 是 | 白嫖首选，只能出 1 条 |
| `Viduq3-turbo` | 5–16 秒 | 0.7 | 是 | 电影级，提示词要写细 |
| `全能电商3.0` | 5–30 秒 | 1 | 否 | 768p，有 21:9 |
| `MiniMax H3` | 5–30 秒 | 1 | 否 | 性价比 |
| `阿里wanx3.0` | 5–30 秒 | 1.8 | 否 | 提示词要精准 |
| `全能电商2.0` | 5–15 秒 | 2 | 否 | 效果好、提示词门槛低 |
| `Happy Horse 1.1` | 5–15 秒 | 2 | 否 | 音画一体 |
| `Seedance2.5 Flash` | 4–30 秒 | 3 | 是 | 省钱版 Seedance |
| `Seedance2.0` | 5–15 秒 | 3.3 | 否 | 带货效果最好 |
| `Seedance2.5` | 5–30 秒 | 3.6 | 是 | 营销广告长片 |
| `可灵3.0 Omni` | 5–15 秒 | 4 | 是 | 角色统一、原生音画 |
| `电商热卖引擎` | 10/15 秒 | 2 | 是 | 经常维护中 |

价格随时会变，**以 `linkpix models` 的实时输出为准**，上表只用来判断量级。

## 提示词怎么写

这套模型吃的是**镜头语言**，不是形容词堆砌。一个够用的模板：

> 主体 + 动作 + 镜头运动 + 光线 + 背景

`"绿色玻璃瓶置于浅色木桌，瓶身缓慢旋转，镜头由中景推至特写，柔和侧逆光，背景虚化"`

只写「高档大气上档次」会出废片。要中英日等语种的配音/字幕，用 `--language` 切，模型会按目标语言生成口播。

## 失败模式

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `401 未登录` | profile 里的 token 过期了 | 重跑 `login` |
| `模型维护中` | 该模型当天下线 | 换一个，或让脚本自动挑 |
| `积分不足` | 余额不够 | 换免费模型，或去工作台充值 |
| `内容审核未通过` | 提示词或素材违规 | 改词/换图，别原样重试 |
| 任务一直 `pending` | 队列拥堵，免费通道更慢 | 免费模型可能排很久，`status` 隔 30–60 秒查一次 |
| 上传 401 | 图片超过 10MB，或格式不在 jpeg/png/webp | 压缩后再传 |
| 出了方图 / 比例不对 | 输出比例会跟随参考图，`--ratio` 不是硬保证 | 想要竖屏就喂竖屏比例的参考图 |

**不要对着同一个失败反复重试**——视频任务提交后通常已扣费，重复提交会重复扣。

## 边界

- 只覆盖 **图生视频**（`video/task`）与素材上传。主图、详情图、爆款复刻、视频翻译走的是另外几个接口，本版本未实现——别假装能调，直接说没做。
- 视频任务慢，免费通道可能排队几十分钟，`--wait` 默认给 20 分钟上限。
- 不发头图、不自动发布到电商平台。产物是本地文件或直链 URL，发布要人来做。

## 参考

- `references/api.md` —— 已探明的接口清单、参数结构、返回字段
- `examples/` —— 可直接抄的命令组合
