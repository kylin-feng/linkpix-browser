# 接口速查

全部来自 2026-11 在 `www.iqinghu.com` 上抓的真实请求，与官方 `qhkit` CLI 调用的是同一套后端。
站点改版时优先核对这里。

## 认证

网页工作台登录后把 token 放在 **`localStorage.Authorization`**（裸 token，不带 `Bearer` 前缀）。
另有 cookie `qh_token`、`QH_AUTH_TOKEN_CN` 存同样的值。

| 场景 | 认证方式 |
|---|---|
| 读类接口（model/list 等） | cookie 就够，带不带 Authorization 都行 |
| 上传、提交任务 | **必须** `Authorization: Bearer <token>` |
| 裸 token 不带 Bearer | 部分接口 401，别省这个前缀 |

本技能统一补成 `Bearer <token>`。

## 基址

```
https://www.iqinghu.com/api/qinghu-ai-agent/ai      AI 能力主服务
https://www.iqinghu.com/api/desktop/qh              desktop 服务（上传、素材、工作流）
```

## 1. 上传素材

```
POST /api/desktop/qh/common/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>

file          二进制
uploadBizType COMMON_IMAGE | COMMON_VIDEO | USER_MATERIAL
```

返回：

```json
{ "code": 200, "success": true, "message": "success",
  "payload": "https://static-001.iqinghu.com/common_image/20261127/6383388-....png" }
```

注意：素材 URL 在 **`payload`** 字段（不是 `data`）。图片硬上限 10MB。

## 2. 模型目录

```
GET /api/qinghu-ai-agent/ai/model/list?businessType=video&durationSelectable=true
GET /api/qinghu-ai-agent/ai/model/list?businessType=image
```

返回 `{ code: 0, msg: "操作成功", data: [...] }`，每条 SKU 的关键字段：

| 字段 | 含义 |
|---|---|
| `id` | 提交时用的 `modelSkuId` |
| `label` | 模型名（提交时 `modelSkuName` 用这个） |
| `durationConfig` | **JSON 字符串**，如 `{"mode":"RANGE","min":5,"max":30,"defaultValue":30}`，`mode` 是大写 |
| `secondCost` | 每秒积分单价 |
| `tokenCost` | 老口径的固定积分 |
| `isFree` | 免费模型 |
| `inputImageRequired` | 必须给参考图 |
| `maintenance` | 维护中，别选 |
| `frontHide` | 1 表示前端隐藏 |
| `supportedAspectRatios` | JSON 字符串，含 `code/label/aspectRatio` |

`durationConfig.mode` 三种：`RANGE`（min/max）、`OPTIONS`（values 数组）、`FIXED`（value）。

## 3. 提交视频任务

```
POST /api/qinghu-ai-agent/ai/video/task
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "prompt": "镜头描述",
  "images": ["https://.../a.png"],
  "videoUrls": [],
  "audioUrls": [],
  "orientation": "portrait",
  "duration": 5,
  "count": 1,
  "language": "simplified-chinese",
  "parameterRequest": "<下面那个对象序列化成字符串>",
  "prompt1688DetailGlobal": "",
  "goodsDetailGlobal": { "offerId": "", "imageUrl": "" },
  "modelSkuId": 100,
  "imagesWithStyle": [{ "url": "https://.../a.png", "text": "" }]
}
```

`parameterRequest` 里再放一份结构化参数（字符串，不是对象）：

```json
{
  "videoUrls": [], "videoReferenceRules": null, "audioUrls": [],
  "orientation": "portrait", "duration": 5, "modelSkuId": 100,
  "count": 1, "language": "simplified-chinese", "modelSkuName": "Viduq2-turbo",
  "imagesWithStyle": [{ "url": "https://...", "text": "" }]
}
```

`orientation` 取值：`portrait` / `landscape` / `square`。
`language` 取值：`simplified-chinese`、`english`、`japanese` 等（见 `scripts/linkpix.mjs` 的 `LANG`）。

返回：

```json
{ "code": 0, "msg": "操作成功",
  "data": { "videoTaskId": "baf2a4886e5641ab8aa7f94cdf4e3cbf", "status": "processing" } }
```

## 4. 查任务

```
GET /api/qinghu-ai-agent/ai/video/task/{videoTaskId}
```

```json
{ "code": 0, "data": {
  "videoTaskId": "...", "status": "pending|processing|completed|failed",
  "outputs": [...], "videos": [...], "videoUrl": "...",
  "frameRate": "540p", "freeChannel": true, "error": null } }
```

产物的 URL 可能出现在 **`outputs` / `videos` / `videoUrl`** 任一处，三个都要看。
`status` 用完之后可能变成新的 `videoTaskId`（预任务 → 正式任务），以最新返回的为准。

## 5. 报价（可选）

```
POST /api/qinghu-ai-agent/ai/video/getTaskScore
```

本技能没有用它——`secondCost × duration × count` 已经够准，且省一次调用。

## 已知坑

1. **`durationConfig` 是字符串**，直接当对象用会拿到 `undefined`。
2. **`mode` 是大写**（`RANGE`），小写比较会全部失配。
3. **上传返回的 URL 在 `payload`**，提交接口的成功标志却是 `code: 0`。两套返回约定并存。
4. **任务提交耗时长**（服务端 30–60 秒才回），别用 5 秒超时的 HTTP 客户端。
5. **重复提交会重复扣费**，失败时先 `status` 查有没有已经建好的任务。
6. 工作台 SPA 很重，别拿它当接口调用的落地页；用静态页更快也更稳。
7. **`orientation` 不一定生效。** 实测传 `portrait`、参考图是方图时，`Viduq2-turbo` 出的是 720×720。
   输出比例可能跟随参考图，别把 `--ratio` 当硬保证——想要竖屏就喂竖屏比例的参考图。
8. **`status` 返回的 `videoTaskId` 可能和你提交时拿到的不是同一个**（预任务 ID → 正式任务 ID）。
   以最新返回的为准，别拿旧 ID 硬轮询。
9. **免费模型的额度只有一条，用完不报错。** 额度耗尽后再提交，返回的仍是 `code: 0` 和
   `status: processing`，但任务会永久停在 `pending`——没有任何错误码提示你额度没了。
   所以自动选型默认跳过 `isFree` 的 SKU。状态里 `freeChannel: true` 说明走的是免费通道。

## 附：UI 自动化踩坑记录

本仓库有两种驱动方式：`--engine api`（默认，页面内请求）和 `--engine ui`（真点真填）。
下面是把 UI 模式跑通之前踩的坑，按发现顺序记。

### 1. 提交键不是 `<button>`，也没有 `alt`

输入区右下角那个发送箭头，DOM 里是一张 `<img>`，**没有 `alt` 属性**：

```
img[alt="arrow-up"]          → 0 个
getByRole("img", { name: "arrow-up" }) → 1 个   ✅
```

可访问名称是从上层（aria-label / title / 组件注入）来的，所以只能按 role + name 找。
按 class 找会命中同页多张 class 几乎相同、且 `opacity: 0` 的装饰图（如 `hi-lite-img`）。

### 2. 坐标点击会漂移，而且每次漂到不同控件

同一套坐标逻辑，三次实测分别命中了：

| 打到的东西 | 后果 |
|---|---|
| 顶部通知条的关闭键 | 什么也没发生 |
| 工具栏「提示词」按钮 | 弹出面板盖住 composer |
| 商品分析 | 打出 `POST /ai/product/analyze` |

composer 的高度会随提示词长度、上传缩略图数量变化，硬编码或按容器推算坐标都不可靠。

### 3. 回车不是提交，是「AI 生成提示词」

在 `.ProseMirror` 里按 Enter 会打 `POST /ai/chat/generatePrompt`（SSE 流式），
把用户写好的提示词整段替换掉。**不要用回车兜底提交**——它会静默改写需求。

### 4. 提示词是 ProseMirror，不是 textarea

`fill()` 不管用，要 `click()` + `keyboard.insertText()`。

### 5. 上传后站点会自动生成一大段提示词

不清空直接提交，提交的是它生成的词。

### 6. 时长是 ant-input-number，没有档位按钮

只能往 `.video-duration-range input` 填值，并按它自己的 `aria-valuemin/aria-valuemax`
夹紧，否则会被静默改回去。换模型会把时长重置成该模型默认值，所以顺序必须是「先选模型，再设时长」。

### 7. 提交会打出一串 POST

预检、计分、建任务依次发出，只等第一个会抓错。要全收下来，再找带 `videoTaskId` 的那条。

### 结论

UI 模式可以做，前提是**只用可访问名称和 DOM 关系定位，完全不用坐标**。
它比 api 模式脆（站点改版会失效），但能肉眼看见每一步，适合演示和排错。
