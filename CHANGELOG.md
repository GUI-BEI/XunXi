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

### 七、同一窗口的多次叫醒会均分（2026-10-20 晚）

- 反馈：「一个时间段内多次叫醒的时间间隔似乎有点短」—— 以前每趟都在**整个窗口**里随机 → 两次可以只隔几分钟 ✗
- 现在：一个窗口设 N 次 → 把窗口**均分成 N 格**，每趟只在自己那格（中间 60%）里随机；
  窗口剩下的几趟**一起预排**并存进 `state.slotTimes`（不存的话每趟按"现在"重算，最后一趟会被挤到最后 ✗）
- 中途才启动（窗口已经过去一部分）→ 从 `max(现在, 上次叫醒+最小间隔)` 起按**还剩几趟**重新均分 ✓
- 新增配置 `night.minGapMinutes`（默认 30 分钟）兜底两次的最小间隔；短窗口里它会自动收到格长的 90%，不会把最后一趟压到整点末端 ✓
- 实测（22:32，窗口 18:00–24:00）：×3 → `22:50 → 23:19 → 23:45`；×2 → `22:47 → 23:31`；窗口还在未来时同样均分 ✓

### 八、她能改自己的人格卡，但会留痕（2026-10-22，主人选的「乙档」）

- 事实核查：她自己的会话工作区就是家目录（`session.cwd = C:\Users\Lenovo`），默认文件策略 `workspace-write` → `~/AGENTS.md` 与 `~/.dsh/bili-whale.config.json` **都在她可写范围内**，写它不需要审批，改完下一条消息即生效
- 选择：**不阻断**（她该能自己长），改用 git 兜住
  - `tools/commands/persona.mjs`（新增，`bili.mjs persona`）：`backup`（备份到 `~/.dsh/persona-backups/`，保留最近 50 份）/ `commit`（提交家目录仓库）/ `log`（备份 + 最近提交）/ `diff`（人格卡改动）
  - `lib/scheduler.js`：新增 `archiveTick()` —— 每 6 小时看一眼、**20 小时节流**，自动 `git add -A` + commit 一次（`~/.dsh/whale-autocommit.json` 记时间；没仓库/没装 git 就静默跳过）
  - 家目录仓库的 `.gitignore` 用白名单：只跟踪 `AGENTS.md`、`.dsh/bili-whale.config.json`、两本日记、`persona-backups/`，其余（`AppData`、`sessions`、`profiles`…）全部忽略；`.gitattributes` 固定 LF
  - 人格卡末尾补了三条给她自己看：改前 `persona backup` → 改完 `persona commit` → 跟阿墨说一声（不是求批准）
- 没做的（按主人要求）：没有加"权限开关只能由主人改"那条约束

### 九、长期记忆分三层（2026-10-23，主人口头需求「记住更久，但不能撑爆上下文」）

- 实测病根：两本日记 20.5k 字符（≈15k tokens）且**每轮全文读**，日增 ~4.1k 字符（≈3k tokens）→ 几周后触发压缩，而压缩会把日记原文一起摘要（自伤）
- 分三层（不再全文读）：
  - **最近 N 天全文**：`bili.mjs diary recent --days 2`（新增子命令；`## YYYY-MM-DD` 分段取近几天，两本都给）
  - **全史一屏**：`bili.mjs memory index` → `~/.dsh/memory/INDEX.md`（自动生成：每月每段 = 日期 + 标题 + 第一句 + 来源；`--print` 通读）
  - **按需检索**：`bili.mjs recall "关键词" [--days 60] [--limit 8] [--json]` → 段落级搜索（多词 = 同段都要有），来源含两本日记、`memory/*.md` 记忆卷、`whale-log.jsonl`、`favorites.json`；`--recent 7d` 只列段标题
- 唤醒提示第 2 步改成这三条；人格卡「两本日记」一节补了"记忆不用靠背，翻到就算想起来"
- 家目录仓库 `.gitignore` 忽略自动生成的 `INDEX.md`（避免每天 churn）
- 实测：`memory index` → 26 段（10-19 ~ 10-23）；`recall "猫咪"` → 命中 6 段、按新→旧给出片段；`diary recent --days 2` → 只回最近两天的两本内容 ✓

### 十、只读模式（2026-10-23，她的号被 B 站风控要求实名/人脸）

- 现象：`x/web-interface/nav` 返回 `-101 账号未登录` —— 网页/App 都登不上，平台要求实名 + 人脸；读（feed/搜索/排行/深读）仍可用，写（评论/私信/点赞/收件箱）全断
- 代码改动（`lib/scheduler.js`）：
  - 模块级 `authOk`：启动时读 `whale-auth.json`，之后由 `authTick()` 更新
  - `dmTick()` / `listenTick()` 在 `!authOk` 时直接 return（不再每 30–60 秒撞一次 `-101`，也不再刷事件流）
  - `wakePrompt()`：只读时替换第 5 步（分享/评论/私信）与第 7/7.5/8 步（收件箱/反馈/B站私信报备），改为「看、读日记、写日记、用 `notify_qq` 找阿墨；评论/私信/点赞/重试一律别做」
- 配置（预防下一次）：`quota.shareDaily` 5 → **2**、`listen.dmIntervalSec` 60 → **120**
- 踩坑记录：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 **BOM** → `JSON.parse` 失败 → 插件悄悄用了默认值（表现为"改了没生效"）。改配置一律用 `[IO.File]::WriteAllText(path, text, UTF8Encoding(false))`

### 十一、她的家搬到 D:\XunXi 工作区（2026-10-23）

- 起因：`/list` 里看不到她 —— 她的会话在 `C:\Users\Lenovo`（**未登记成工作区**），QQ 插件只列"工作区"这一层
- 迁移：会话（`bili-whale`，1917 条记录 / 1191 个 zstd 帧）+ 人格卡（`AGENTS.md`）+ 唤醒目录，一起搬到 `D:\XunXi`
  - 会话文件按帧切分 → 只重压第 0 帧（把 `cwd` 改成 `D:\XunXi`）→ 其余 1190 帧字节不动 → 回读逐帧校验通过
  - 旧目录移出 `sessions/` 树（备份在 `~/.dsh/_migrate-backup/`），避免同一个 sessionId 在两个工作区里打架
- 代码：`workspace` 配置 + `herWorkspace()`（index.js）、`persona.mjs` 改用工作区、`archiveTick()` 同时快照两个仓库
- 新家 `D:\XunXi` 自己也是一个 git 仓库（只跟踪 `AGENTS.md`），家目录仓库只留日记与配置
- 结果：QQ `/list` 的 `XunXi` 夹里出现「寻汐」（会话标题），能直接聊
- 她的"工具"用**目录联接（junction）**挂进新家，保持结构又不复制文件：
  - `D:\XunXi\.dsh` → `C:\Users\Lenovo\.dsh`（两本日记 / 状态 / 记忆索引）
  - `D:\XunXi\.bili-ai` → `C:\Users\Lenovo\.bili-ai`（凭据 / 额度 / 收藏）
  - `D:\XunXi\bili-whale` → 插件目录（`tools\bili.mjs` 那一整套）
  - ⚠️ 新家的 `.gitignore` 必须把这三个联接目录排除，否则 `git add -A` 会试图把整个 `.dsh` 收进仓库 ✗
  - 实测：`cd D:\XunXi\bili-whale\tools && node bili.mjs diary recent --days 1`、`memory index` 均正常 ✓

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
