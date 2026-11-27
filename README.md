# linkpix-browser

> 不申请 API key，用浏览器登录态调青虎 AI LinkPix 的 Agent Skill。

一张商品图 → 一条带货视频。这个仓库做的事很简单：**把你网页上手动点的那套操作，变成一条命令。**

```bash
node scripts/linkpix.mjs video --image ./商品图.jpg \
  --prompt "产品置于浅色桌面，镜头缓慢推近，柔和自然光" \
  --wait --out ./out
```

```
提交中（ui）：Viduq3-turbo / 5秒 / portrait / 1条…
已提交 taskId=fe43e66063114db6995c593f833f1a20
  67s：pending
 134s：processing
{"ok": true, "stage": "done", "engine": "ui", "status": "completed",
 "videos": ["https://static-001.iqinghu.com/ai_video/....mp4"],
 "files": [{"file": "out/fe43e660....mp4", "bytes": 1318084}]}
```

## 它长什么样

### 效果：一条命令跑出来的东西

![输入是扁平色块，输出是实拍质感的瓶子](assets/before-after.jpg)

左边是输入——我随手画的一个色块；右边是同一条命令产出的成片截帧。

![成片动图](assets/result.gif)

5 秒、528×960、带音轨。这条是 `--engine ui` 真点按钮跑出来的，实扣 3.5 积分。

### 工作台：一个输入框就是全部

![青虎 AI LinkPix 工作台](assets/studio.jpg)

这个 skill 操作的就是这个界面。左边是功能面（图像生成 / 视频生成 / 详情图 / 广告素材 /
POD / 视频翻译 / 工具），中间那条输入框是全部操作入口。

### 输入框特写

![上传参考图 + 提示词 + 参数 + 预估积分](assets/composer.jpg)

上传参考图 → 写提示词 → 选「模型 / 时长 / 比例 / 语言 / 数量」→ 右下角点提交。
`--dry-run` 会把这里的参数和预估积分原样打印出来，不提交、不扣费。

### 图像线也能看到（本 skill 暂未实现）

![图像生成](assets/feature-image.jpg)

同一个工作台切到「图像生成」就是主图套图：套图模式、平台与尺寸、数量、场景，
一次出 9 张 22.5 积分。这条线走的是另一组接口（`/task/image/submit`，见
[`references/api.md`](references/api.md)），**本 skill 目前只接了视频线**。

### 十二个模型，价格和免费额度都在界面上

![模型列表](assets/models.jpg)

`linkpix models` 读的就是这份目录：每秒单价、是否维护、是否需要参考图、哪个免费。
自动选型默认避开免费模型——它的额度只有一条，用完再提交不会报错，只会永远排队。

### 案例墙

![做同款案例](assets/cases.jpg)

平台自带的「做同款」案例，每张都标了是哪个模型出的（阿里 Wanx3.0 / Seedance2.5 /
全能电商2.0）。`--model` 收的就是这些名字，可以直接照抄。

> 截图来自实测环境，账号昵称与头像已隐去。

## 先说清楚「用浏览器」是什么意思

它在真浏览器里登录（扫码一次），之后有两种干法：

**默认（`--engine api`）** —— 由浏览器在页面上下文里发出每一次请求。cookie、UA、Origin、
`localStorage` 里的 token 全是你手点时的同一份。身份是「你本人开着网页在操作」，
而不是「拿 API key 从服务端调」。快，稳，看不见。

**`--engine ui`** —— 真的点按钮、真的往输入框里打字，**有头可见**，就是上面截图里那套动作：

```bash
node scripts/linkpix.mjs video --engine ui --image ./a.jpg --prompt "..." --duration 5
```

UI 引擎的定位只用可访问名称和 DOM 关系，不用坐标。这不是洁癖——这个页面上坐标点击会稳定地
打到隔壁控件（实测三次分别命中通知条关闭键、工具栏按钮、商品分析接口）。完整踩坑记录在
[`references/api.md`](references/api.md) 附录，想改 UI 引擎的话先读那个。

## 为什么要这个

青虎 AI 官方已经有一套 Agent Skills（[autoagc/linkpix-skills](https://github.com/autoagc/linkpix-skills)，324 个技能），能力比这个仓库全得多。但它有两个门槛：

1. 要装 `qhkit` CLI（`npm i -g @iqinghu/qhkit`）
2. 要去后台单独申请 API key

而这个仓库只要求一件事：**你本来就在网页上登录着青虎账号。**

适合的场景：

- 你已经买了青虎的套餐，但不想为 API 单独开权限
- 你在给客户/同事演示，装 CLI 太麻烦
- 你想用免费的 `Viduq2-turbo` 批量试，但 API 套餐里没这个通道

## 快速开始

```bash
git clone <this-repo> && cd linkpix-browser
npm install
npx playwright install chromium   # 约 124MB，只需一次

node scripts/linkpix.mjs login    # 弹浏览器，扫码登录
node scripts/linkpix.mjs whoami   # 看看有没有登录上、还剩多少积分
```

然后：

```bash
# 先看有哪些模型、多少钱
node scripts/linkpix.mjs models

# 不花钱试一把，打印将要提交的内容
node scripts/linkpix.mjs video --image ./a.jpg --prompt "..." --duration 5 --dry-run

# 真跑
node scripts/linkpix.mjs video --image ./a.jpg --prompt "..." --duration 5 --wait --out ./out
```

## 当成 Agent Skill 装

这个仓库根目录就是一份标准 Skill（`SKILL.md` + `scripts/` + `references/`）。

```bash
# Claude Code / ZCode：把整个目录放进 skills 目录即可
cp -r linkpix-browser ~/.claude/skills/linkpix-browser

# 或者只在当前项目里用
mkdir -p .claude/skills && cp -r linkpix-browser .claude/skills/
```

装好之后，跟 agent 说「用 LinkPix 把这张商品图做成带货视频」，它会读 `SKILL.md`
自己拼命令；`references/api.md` 在需要查参数或排错时才会被读进上下文。

## 命令

| 命令 | 作用 |
|---|---|
| `login` | 扫码登录一次，token 存进 `~/.linkpix-browser/` |
| `whoami` | 账号、积分包余额 |
| `models [--type video\|image]` | 实时模型目录、每秒单价、是否免费/维护中 |
| `upload <file>` | 上传素材，返回可提交的 URL |
| `video --image ... --prompt ...` | 图生视频，`--dry-run` 只预览不提交 |
| `status <taskId>` | 查任务状态 |
| `download <taskId> --out dir` | 下载产物 |

`video` 的常用参数：`--engine` `--model` `--duration` `--ratio` `--count` `--language` `--wait` `--out` `--dry-run`。

不指定 `--model` 时按**每秒单价从低到高**自动挑，**默认跳过免费模型**（原因见下）。
`--ratio` 收 `竖屏/横屏/方屏/9:16/16:9/1:1`，`--language` 收 `简体中文/英语/日语…`。

## 它是怎么工作的

```
Playwright 持久化 profile
        │
        ├─ login 一次 → localStorage.Authorization 留在 profile 里
        │
        ├─ 每条命令打开同源静态页 /workbench/user-agreement.html   ← 0.1 秒
        │
        └─ page.evaluate 里 fetch 站点自己的接口
             ├─ POST /api/desktop/qh/common/upload          上传素材
             ├─ GET  /api/qinghu-ai-agent/ai/model/list     模型与价格
             ├─ POST /api/qinghu-ai-agent/ai/video/task     提交
             └─ GET  /api/qinghu-ai-agent/ai/video/task/:id 轮询
```

**不写 CSS 选择器。** 请求从页面上下文发出，header / cookie / UA / 来源和你手点完全一致，所以站点改版不会让脚本炸掉——它只会在接口路径变更时失效，而那种变更官方 CLI 也要跟着改。

三个实测算出来的工程细节，都写在代码里了：

- **落地页用静态页，不用工作台。** 工作台是个重型 SPA，加载它会把一条命令从 5 秒拖到 90 秒。`localStorage` 按 origin 共享，静态页读到的 token 一模一样。
- **`context.close()` 会卡 30 秒。** Chromium 关 persistent context 时会等站点长连接自然超时。`closeQuietly()` 给 3 秒上限，之后靠进程退出回收。
- **`durationConfig` 是字符串，`mode` 还是大写的。** 直接当对象用、或按小写比较，都会静默失配——这是接这套接口最容易踩的坑。

## 计费

按秒计费：`每秒单价 × 时长 × 数量`。

有一个免费模型 `Viduq2-turbo`（5 秒、必须给参考图）。

**但免费额度通常只有一条**，而且额度用完之后再提交**不会报错**——你会拿到一个永远
`pending` 的任务，看起来像卡住了。这就是为什么自动选型默认跳过它：

```bash
# 想白嫖一次，显式点名
node scripts/linkpix.mjs video --image ./a.jpg --prompt "..." --duration 5 --model Viduq2-turbo
```

其余模型从 `Viduq3-turbo` 的 0.7 积分/秒到 `可灵3.0 Omni` 的 4 积分/秒不等。
价格会变，**以 `models` 的实时输出为准。**

## 已知限制

- **只做图生视频。** 主图、详情图、爆款复刻、视频翻译走的是另外几个接口，本版本没实现。别指望它能替代官方那 324 个技能。
- **依赖站点内部接口。** 不做版本协商，青虎改接口就需要更新本仓库。
- **`~/.linkpix-browser/` 是你的账号本体。** 别提交、别外传。
- 视频任务慢。免费通道可能排队很久，`--wait` 默认 20 分钟上限。

## 合规

用于操作你自己有权限的账号。抓取/自动化可能违反平台用户协议，用之前自己掂量。仓库作者不对账号封禁、积分损失负责。

## License

MIT
