# linkpix-browser

> 不申请 API key，用浏览器登录态调青虎 AI LinkPix 的 Agent Skill。

## 先说清楚「用浏览器」是什么意思

它在真浏览器里登录（扫码一次），之后**由浏览器在页面上下文里发出每一次请求**——
cookie、UA、Origin、`localStorage` 里的 token 全是你手点时的同一份。所以它的身份是
「你本人开着网页在操作」，而不是「拿 API key 从服务端调用」。

但它**不模拟鼠标点击**。原因写在 [`references/api.md`](references/api.md) 的附录里，
一句话概括：这个工作台的提交键是一张 `<img>`，同页还有多张 class 相近、`opacity: 0` 的
装饰图，实测三次坐标点击分别打到了通知条关闭键、工具栏按钮和商品分析接口；
回车也不是提交，而是触发「AI 生成提示词」并把你的词覆盖掉。

如果你要的是「肉眼看着它一个个点」，这个仓库不是——它选择确定性，放弃表演性。


一张商品图 → 一条带货视频。这个仓库做的事很简单：**把你网页上手动点的那套操作，变成一条命令。**

```bash
node scripts/linkpix.mjs video --image ./商品图.jpg \
  --prompt "产品置于浅色桌面，镜头缓慢推近，柔和自然光" \
  --wait --out ./out
```

```
提交中：Viduq2-turbo / 5秒 / portrait / 1条…
{"ok":true,"stage":"done","taskId":"...","videos":["https://...mp4"],
 "files":[{"file":"out/....mp4","bytes":1843200}]}
```

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

`video` 的常用参数：`--model` `--duration` `--ratio` `--count` `--language` `--wait` `--out` `--dry-run`。

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
