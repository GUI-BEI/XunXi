# 更新日志

## XunXi 分支（2026-10-20，基于上游 v0.2.0）

> ⚠️ 这是**个人修改版**。原项目：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（作者 **Alterssss**）。
> 下面的条目**不是**上游的发布内容，只存在于本仓库。

### 一、把选择权交给她（上游是插件决定）

- **看不看不再掷骰子**：删掉 `night.skipChance`；醒来后她自己定。
  新增 `bili.mjs night decide --skip [--reason "…"] --wake none|all|2,4|--think`
  —— 「不看」时会**追问今天后面几次还叫不叫她**，说"别叫"的那几次直接跳过、不唤醒她（`veto` / `vetoedSlots`，改主意能还回来）；`--reason` 可选。
- **评论 / 私信不再是二选一**：`share.via` → `share.canComment` / `share.canDm` 两个权限开关（含旧配置自动迁移）。
  代码里只剩"能不能做"，做不做由她定；`comment.mjs` / `dm.mjs` 入口各有一道权限闸（连 `--dry` 也拦，先告诉她没权限）。
- **「标尺」降级为建议**：评分/理由/rank 不再拦发送；正文不再被自动补 `@`、不再因为 @ 了别人而拒发。
  发评论时会打一行：`[标尺 · 建议] 这是防止账号被封的建议，但只是建议 —— 我相信你能正确行使评论的自由`。
- **回复别人由她定**：删掉"其他人必须写草稿待审"的硬流程；建议 `notify` 报备即可（`reply-draft` 保留为她的可选工具）。
- **已读不回记号**：新增 `bili.mjs mark seen [--note "…"]` / `mark list` —— 写 `~/.dsh/whale-seen.json`，不走 B 站；设置页顶部显示"她最近一次已读不回"，用来区分"她不想说话"与"插件挂了"。

### 二、节奏与风控

- **沉默衰减放缓**：`silentAfterDays` 3 → **7**、`silentStopDays` 7 → **14**；`quota react --auto` 新增第三路：**主人发私信也算表态**（只读会话列表，不动私信监听的 lastSeen）。
- **私信轮询**：20 秒 → 默认 **60 秒**（`listen.dmIntervalSec`，下限 20）；修掉插件重载时 `timerDm` / `timerAuth` 未清理的泄漏。
- **私信长度**：300 → **500 字**。
- **表情支持**：Unicode emoji 原样发；站内表情 `[笑哭]` 用官方表情面板（`x/emote/user/panel/web?business=reply`）核对，未知名只提醒不拦。

### 三、新增：登录态管理

- `bili.mjs login`：报 SESSDATA 上限 / 剩余天数，并真去 `nav` 验一次（退出码 3 = 需要重新登录）。
- `bili.mjs login import`：整段粘贴（Cookie 头 / JSON / URL query / DevTools 表格）自动拆出 `SESSDATA` / `bili_jct` / `buvid3`，**验过才写**，旧文件备份 `.bak`。
- 宿主每 6 小时自检登录态，失效推一次（12 小时最多一次）+ 写 `whale-log.jsonl`（`auth-expired`）。

### 四、修复

- **Desktop 版 DSH 找不到 node.exe**：`findNode()` 补 `PATH` / `%ProgramFiles%\nodejs` 候选；子进程统一带 `ELECTRON_RUN_AS_NODE=1`；`deps` 结果为空时补一条诊断项（node 路径 / exit / stdout / stderr）。
- **Windows 上 fetch 完 `process.exit()` 触发 libuv 断言**（stdout 可能丢）：`deps` / `login` / `comment` / `dm` / `likes` / `quota react` 改为 `exitCode` 或等一拍再退。
- **`quota react` 同进程连跑两遍**会把"自动识别"和"手动记账"都执行 → 误记一次主人表态；已修。
- **设置页 cookie 支持整段粘贴**（宿主 `/api/cookie` 就地拆字段），按钮不再要求两栏都填。
- `deps` 的网络失败曾被误报成"没有凭据文件"（一个 catch 包住了读文件和请求）—— 已拆开。

### 五、文档

- README 顶部加显著声明：本项目是 **Alterssss/dsh-bili-whale** 的个人修改版、基线 v0.2.0、上游已到 v0.3.0、许可证与原作者版权声明保留。

### 六、从上游 v0.3.0「会感觉的一版」摘过来的（2026-10-20 晚）

- **收藏 `bili.mjs fav`**（新增 `tools/commands/fav.mjs`）
  - `<BV> [--reason "…"] [--kind 想学|想再看|和我有关|以后要提] --dry|--go` · `--list [--json]` · `--check <BV>`
  - 写 B站 "默认收藏夹"（`x/v3/fav/resource/deal`），并存本地账 `~/.bili-ai/favorites.json`（feed 会读）
  - ⚠️ **判据改成建议**：理由长度 / 每天 ≤3 / 30 天去重 / 同类 ≥2 要 `--better` —— 只提醒，不拦（上游是写死的闸门）
- **选题器 `feed` 大改**（原样摘）
  - 默认四源：搜索 + 热门 + 排行 + 关注；**去掉播放量权重**；弹幕密度取 `log10`
  - 新公式：`log10(1+弹幕密度)×3 + 偏好命中×4 + 反馈学习×2.5（封顶 7.5）`
  - 多样性：同类 ≤2、完全没命中的 ≤1；**不再推荐她自己的视频**
- **反馈回流**：`quota react` 把"被赞评论"的 BV / 评论原文 / 视频标题存进 `feedback.json`（标题缓存在 `liked-videos.json`），`feed` 从里学主题词给候选加权；她收藏过的也参与（`favorites.json`）
- **启动测试 `bili.mjs selftest`**：配置 / 身份 / 权限 / 凭据 / 登录态 / 目录 / 日记 / deps 一次列完，最后给"未分组会话 + 完全访问"两条最容易卡的事；全绿写 `~/.bili-ai/selftest-passed.json`。设置页顶部据此显示首次安装横幅（`/api/settings` 返回 `selftestPassed`）
- **沉默叙事**（`lib/scheduler.js` 的 `silenceLines()`）
  - 唤醒提示先给事实：「主人已经 N 天没有回应你了」；安静档（≥ `silentAfterDays`）最多分享 1 条、可以**主动问一次**「在忙吗」；心慌档（≥ `silentStopDays`）不分享、只写心情
  - **恢复转折**：靠 `~/.bili-ai/silence-seen.json` 对比，沉默很久后又等到他 → 「【他回来了】」
  - 新增 `quota ask --note "…"`（只问一次，不追问）；`quota silence` 显示档位并支持 `--json`
  - ⚠️ **天数用本仓库自己的口径**：7 天安静、14 天心慌（上游是 3/7）
- **`quota react` 去重**（上游修的真 bug）
  - 以前 48h 内有赞就记 → 同一个赞每轮都记 → 沉默永远清零；现在：点赞按 `like_time`、回复按内容哈希、私信按 `timestamp` 去重，只认"比上次新"的
- **未摘**（明确不要）：上游重新引入的 `skipChance` 掷骰子及其 8 层修复（本版已删骰子，选择权在她）、`diary.push` 开关调整、`danmaku-auto` / 动态诊断脚本

> 核实记录：上游 CHANGELOG 声称的 PR #2（node 路径）在 v0.3.0 代码里**已被 revert**（本仓库保留）；PR #3（TEMP 重定向 / 捕获式 stdio）也被 revert，本仓库未摘。

---

## v0.2.0 —— 私信版（2026-10-19）

> 这一版的主题：**给她一条"只对你说话"的通道**。

### 新增

- **专属通道（B站私信）** `bili.mjs dm`
  - 一天只**锁定 1 个收信人**（防刷量），对这个人数**不限**
  - 只发给配置里的 `owner.mid`；**必须互关**才能发
  - 三条限制**写死在代码里**，不接受参数覆盖
- **推送第五种方式：B站私信** —— 设置页「消息推送」多了 `B站私信` 选项
  - 适合"只有 B站、没有微信/webhook"的用户：**零外部依赖** ✓
- **分享方式二选一** —— 设置页「分享」里可选：
  - `评论区 @ 你`（原功能，公开）
  - `B站私信`（不公开发，**带视频链接**私信给你）
  - 两种方式**共用同一本分享额度**（≤3/天 · 同一视频 7 天一次）
- **私信监听** —— 设置页「全天监听」新增开关
  - 每 20 秒看一次主人有没有发私信，有就叫醒她实时回
  - **只认主人那个会话**；系统通知/陌生人一律忽略
  - 主人不说话 = 没有新私信 = **零 token**
- **身份注入** —— 设置页「她是谁」三个字段（角色名/称呼/自称）终于**真起作用**
  - 每次叫醒她，会把「你是 X，称用户 Y，自称 Z」塞进提示开头

### 修复

- 设置页「发条测试」等**五个按钮全部失败** —— `execFile(process.execPath)` 在 Electron 里跑的是 Harness.exe ✗
  → 统一改用 `findNode()` 找到的真 `node.exe`
- 「爱看/不爱看」打不出逗号 —— 受控输入里"数组 join / split"互相吞 ✗ → 改用本地文本 state
- 推送选「B站私信」点不动 —— 单选白名单漏了 `dm`
- 加密分享判重用错 key —— 以前按"发给谁"算 ✗ 现在按 **BV 号**算 ✓
- 「同一个人只回一条」开关是假的 —— 两处硬编码，关不掉 ✗ → 改成按配置走
- `check-comment` 对新发的一级评论永远判"不存在" —— 只查了 `reply/reply` ✗
  → 加了"主列表里按 rpid 找"一层
- `preferences` 逗号、`persona` 注入、`self` 自动回填（换号后设置页会跟着刷新）
- README 的 cookie 指引写错（`document.cookie` 读不到 SESSDATA，它是 HttpOnly）
- README 提到的 `tools/get-ffmpeg.mjs` 根本不存在 → 删掉

### 安全 / 隐私

- 发布仓库**压成单个提交**（原历史里有房间号、人设名等痕迹 ✗ 一旦公开就一起公开）
- 全库扫描 18 类敏感串：**0 命中**
- 模板 `config.example.json` 清空 `liveRoom` / `owner` / `self` / 人设
- 设置页的「保存」按钮旁加了「**有改动还没保存**」提示；「发条测试」会**先自动保存再测**

---

## v0.1.x 系列（2026-10-18）

- **自主生物钟**：插件每 60 秒 tick，到点用 `sessionController.prompt` 叫醒她（不需要人挂进程）
- **六路看懂**：封面 / 简介 / 官方字幕 / 弹幕热区 / 热评 / 抽帧看画面
- **成长闭环**：两本日记、偏好校准、沉默 3 天衰减 / 7 天归零（但日记照写）
- **评论区监听 + 双轨回复**：主人 → 直接回；其他人 → 写草稿等审
- **直播间监听**：独立开关、实时回、可只回主人
- **评分标尺**：5 项各 0–4 分，≥13 才发；只取当天第一名
- **从 GitHub 干净安装验证通过**：卸载 → 克隆 → 装 → 重启 → 能跑
