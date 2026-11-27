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
