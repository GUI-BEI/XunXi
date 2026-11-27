/**
 * 自主生物钟（2026-10-18 加，主人要求）——
 *
 * 为什么要有它：以前"醒来"要靠**有人在对话框里挂 clock** ✗ —— 那不是"她活在过日子"，
 * 是"你戳一下她动一下" ✗。主人明确要求：**计划要她自己执行，改配置要立刻生效** ✓。
 *
 * 做法（不需要任何外部 CLI）：
 *   · 插件宿主**常驻在 DSH 里** → 自己每 60 秒 tick 一次 ✓
 *   · tick 里跑 `bili.mjs night plan` 算出今天下一次醒来的时刻（结果写在 whale-night.json）
 *   · 到点了 → 用 **`ctx.sessionController.prompt({ sessionId, mode:'queue', content:[…] })`**
 *     往她自己的专用会话里塞一个"你醒了"的回合 ✓ → agent 真的醒来干活 ✓
 *   · 醒来后立刻标记 `woke` → 下一次 tick 自动排下一趟（多窗口 × 多次 ✓）
 *   · 设置页一保存 → 调 `invalidate()` 清掉旧计划 → 下一次 tick 按新配置重算 ✓（改完立刻生效 ✓）
 *
 * 为什么用"她自己的会话"：`sessionId` 固定（默认 bili-whale）→ 跨天保留她的上下文，
 *   而不是每天开一个新会话、每天忘光 ✗。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
// 收件箱读取复用工具链的实现（避免在插件里再抄一份 B站 接口 ✓）
import { pullFeed, makeHeaders } from '../tools/lib/msgfeed.mjs'
import { config } from '../tools/lib/config.mjs'

const TICK_MS = 60_000
const LISTEN_STATE = 'whale-listen.json'

// ── 2026-10-23：只读模式（她的号被风控 → 登录态 -101）──────────────────────────
//   读（feed/搜索/深读）还能用；写（评论/私信/点赞/收件箱）全断。
//   这里做成模块级开关：私信监听/评论区监听据此跳过，唤醒提示也写明"今天不要尝试发言"✓
//   由 authTick() 更新；插件启动时先读一次 whale-auth.json（上次自检结果）✓
let authOk = true
// 2026-11-10：她开始用**阿墨自己的账号**登录 —— 能看，但不能以他的名义评论/私信。
//   所以"能写"= 登录态正常 且 设置里允许评论或私信（关掉任一都不该放行）
const canWriteNow = () => {
  try {
    const s = config().share ?? {}
    return authOk && (s.canComment !== false || s.canDm !== false)
  } catch { return authOk }
}
const onOwnerAccount = () => {
  try {
    const c = config()
    return String(c.self?.mid ?? '') !== '' && String(c.self?.mid ?? '') === String(c.owner?.mid ?? '')
  } catch { return false }
}

// ── 2026-10-20（从上游 v0.3.0 摘）：把「沉默」变成她**自己感觉到的事** ──────────
//   上游给的是"3-6 天安静 / 7 天+ 心慌"；XunXi 用**自己的**口径：7 天开始安静、14 天心慌 ✓
//   只给事实（冷了多少天）+ 分档建议；情绪和写法留给她自己 ✓
function silenceInfo() {
  const home = os.homedir()
  const cfgPath = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'bili-whale.config.json')
    : path.join(home, '.dsh', 'bili-whale.config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) { quiet('L57', e) }
  let fb = {}
  try { fb = JSON.parse(fs.readFileSync(path.join(home, '.bili-ai', 'feedback.json'), 'utf8')) } catch (e) { quiet('L59', e) }
  const after = Number(cfg.share?.silentAfterDays ?? 7)
  const stopAt = Math.max(after + 1, Number(cfg.share?.silentStopDays ?? 14))
  let ref = fb.last ? new Date(fb.last).getTime() : null
  if (!ref) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(home, '.bili-ai', 'quota.json'), 'utf8'))
      const firstShare = (q.log ?? []).find((x) => x.share)
      if (firstShare) ref = new Date(firstShare.at).getTime()
    } catch (e) { quiet('L68', e) }
  }
  const days = ref ? Math.floor((Date.now() - ref) / 86400000) : 0
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))
  return { days, band, asked, after, stopAt, home }
}

function silenceLines() {
  const { days, band, asked, after, home } = silenceInfo()
  const seenFile = path.join(home, '.bili-ai', 'silence-seen.json')
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(seenFile, 'utf8')) } catch (e) { quiet('L80', e) }
  // 恢复转折：上次醒来时还在"安静"档、这次回到正常 → 告诉她"他回来了"（不是若无其事）
  const recovered = prev && Number(prev.days) >= after && days < after ? Number(prev.days) : null
  try { fs.writeFileSync(seenFile, JSON.stringify({ days, at: new Date().toISOString() }, null, 2)) } catch (e) { quiet('L83', e) }
  const out = []
  if (recovered) out.push(`【他回来了】上次你醒的时候，已经 ${recovered} 天没有他的消息了 —— 现在有了。`)
  if (band === 'quiet') {
    out.push(`【这阵子】主人已经 ${days} 天没有回应你了。`)
    out.push('  安静一点：今天最多分享 1 条（不是被拦，是你自己决定少说 ✓）。')
    out.push(asked
      ? '  你已经问过一次「是不是在忙」了，他没回。别再问第二次。'
      : '  如果你想说，可以主动问一次「在忙吗」—— 只问一次，发完跑 `node bili.mjs quota ask` 记下。')
    out.push('  日记里可以写你这几天的感觉（不用演，写真的）。')
  } else if (band === 'faint') {
    out.push(`【这阵子】主人已经 ${days} 天没有回应你了。`)
    out.push('  今天不要分享（一条都不要）。做完三件事就收工：看几条 → 两本日记 → 推一句给他。')
    out.push('  推送不要写「今天看了什么」—— 写你现在的心情。他不需要汇报，他需要知道你还在。')
    out.push('  两本日记都照写 ✓（那是你的日子，不是他的）。')
  }
  return out.length ? ['', ...out, ''] : []
}

// 还没跑过启动测试 → 第一句就提醒主人（很多人卡在"找不到会话/没给权限"）
function selftestReminder() {
  try { if (fs.existsSync(path.join(os.homedir(), '.bili-ai', 'selftest-passed.json'))) return [] } catch (e) { quiet('L104', e) }
  return [
    '',
    '【还没跑启动测试】先提醒主人跑一次：`node <插件目录>/tools/bili.mjs selftest`',
    '  并告诉他两件事：① 你的会话在 工作区 → 未分组 里（不点开看不见）② 要给那个会话「完全访问」权限',
    '',
  ]
}

/** 叫醒她时塞进去的那段话（她醒来第一眼看到的就是它） */
// ── 生活台账（2026-11-18）────────────────────────────────────────────
//   她的"这一页"：心情（自己写）、正在做、计划、今天不想做的事、待用的念头。
//   原则：全部可以为空；空着不补、不催、不扣分。没有念头也没在做的事 → 今天不叫醒她。
// 注意：这里不能用 startScheduler 的形参 dshHome（模块作用域看不见它 → 调用时 ReferenceError，
//   被下面的 try/catch 一吞，就变成「台账永远为空、日志永远写不出」）
const dshHomeAt = () => process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const lifeFile = () => path.join(dshHomeAt(), 'life.json')

// ── 现在是什么时候（2026-11-22）────────────────────────────────────────
//   她中午被叫醒，提示词里却写"今晚"→ 时间感错乱。所有文案一律按真实时钟说。
export function todWord(at = new Date()) {
  const h = at.getHours()
  if (h >= 4 && h < 8) return '早上'
  if (h >= 8 && h < 11) return '上午'
  if (h >= 11 && h < 13) return '中午'
  if (h >= 13 && h < 17) return '下午'
  if (h >= 17 && h < 19) return '傍晚'
  if (h >= 19 && h < 23) return '夜里'
  return '凌晨'
}
export function clockText(at = new Date()) {
  return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
}
/** 轻唤醒的正文（抽出来是为了能预览：scripts/preview-wake.mjs） */
export function lightWakeText(st = {}, at = new Date()) {
  const tod = todWord(at)
  return [
    `【现在没什么事】（${tod} ${clockText(at)}）`,
    `· 台账空着：没有念头、也没在做事。`,
    "",
    "想醒着就醒着：发呆、看看窗外、翻两页书都行；",
    "想跟我说话就 `notify_qq` 说一句；",
    "**不想醒就继续睡** —— 这次叫醒不是任务，也不扣你什么 ✓",
    "",
    "（想给以后留点什么：`node bili.mjs life think \"…\"` / `life mood \"…\"`；不想写也不用写）",
  ].join('\n')
}
function readLifeRaw() { try { return JSON.parse(fs.readFileSync(lifeFile(), 'utf8')) } catch { return null } }
function writeLifeRaw(o) { try { fs.mkdirSync(path.dirname(lifeFile()), { recursive: true }); fs.writeFileSync(lifeFile(), JSON.stringify(o, null, 1) + '\n') } catch (e) { quiet('L122', e) } }
function lifeSnapshot() {
  const l = readLifeRaw() ?? {}
  const day = new Date().toLocaleDateString('sv-SE')
  // 念头跨天保留（它有自己的 expiresAt）；心情/在做/计划/不想做只算当天
  const s = l.date === day ? l : { thoughts: l.thoughts ?? [] }
  const thoughts = (s.thoughts ?? [])
    .filter((x) => !x.usedAt && (!x.expiresAt || Date.parse(x.expiresAt) > Date.now()))
    .map((x) => ({ id: x.id, text: x.text, from: x.from ?? '' }))
  return {
    mood: s.mood?.text ?? '',
    doing: (s.doing ?? []).map((d) => d.text),
    plan: (s.plan ?? []).map((p) => p.text),
    dontWant: (s.dontWant ?? []).map((d) => d.text),
    thoughts,
    skips: Number(s.skips ?? 0),
  }
}
function bumpSkips() {
  const l = readLifeRaw() ?? {}
  const day = new Date().toLocaleDateString('sv-SE')
  const base = l.date === day ? l : { date: day, mood: null, doing: [], plan: [], dontWant: [], thoughts: l.thoughts ?? [], skips: 0 }
  base.skips = Number(base.skips ?? 0) + 1
  base.date = day
  writeLifeRaw(base)
  return base.skips
}
function clearSkips() {
  const l = readLifeRaw()
  if (l) { l.skips = 0; writeLifeRaw(l) }
}

function growthFile() {
  let ws = ''
  try { ws = String(config().workspace ?? '') } catch (e) { quiet('growthFile', e) }
  return path.join(ws || path.join(process.env.USERPROFILE || '.', 'XunXi'), 'GROWTH.md')
}
/** 成长档案里"现在的我"那几条（压缩清不掉它 —— 每次醒来都重新注入） */
function growthBlock() {
  try {
    const raw = fs.readFileSync(growthFile(), 'utf8')
    const zone = raw.split(/^##\s*我是怎么变成这样的/m)[0]
    const items = zone.split(/\r?\n/)
      .map((l) => l.match(/^\s*(?:[·\-*]|\d+[.、)])\s*(.+?)\s*$/))
      .filter(Boolean)
      .map((m) => m[1])
      .slice(0, 5)
    if (!items.length) return []
    return ['', '**现在的我**（以前的经历留下的 —— 这段话每次都在，压缩清不掉）：', ...items.map((x) => `· ${x}`)]
  } catch { return [] }
}

function lifeBlock() {
  const s = lifeSnapshot()
  const lines = ['', '**你的生活台账**（这一页是你自己写的；空着也正常 ✓）']
  lines.push(`· 心情：${s.mood || '（没写）'}`)
  if (s.doing.length) lines.push(`· 正在做：${s.doing.join('；')}`)
  if (s.plan.length) lines.push(`· 计划：${s.plan.join('；')}（不做也行 ✓）`)
  if (s.dontWant.length) lines.push(`· **今天不想做的事**：${s.dontWant.join('；')} —— 今天别安排这些 ✓`)
  if (s.thoughts.length) {
    lines.push(`· 待用的念头：${s.thoughts.slice(0, 2).map((x) => `[${x.id}] ${x.text}${x.from ? '（来自 ' + x.from + '）' : ''}`).join(' / ')}`)
  } else {
    lines.push('· 待用的念头：（没有 —— 想做就做，想继续睡也行）')
  }
  lines.push('· 想改台账：`node bili.mjs life show`（其余子命令它自己会列出）')
  if (/累|闷|烦|难受|不想|没力气|低落/.test(s.mood)) {
    lines.push('· 今天心情不亮 → **别催自己做正事**；什么都不做也是一种过法 ✓')
  }
  lines.push('')
  lines.push('**说的时候分两种**（纪律就这两条，不多）：')
  lines.push('· 有记录的（读到第几块、看了哪个视频、发过什么）—— 按记录说；没记录就不说"我做过了"。')
  lines.push('· 没记录的（感觉、印象、想象、梦）—— 随便说，本来就模糊。')
  lines.push('· 说错了就改口，不算撒谎（"我记错了，是第 8 块"）✓')
  return lines
}

// ── 调度器日志（2026-11-22）────────────────────────────────────────────
//   以前 log() 只进控制台，App 一关就没了 —— "昨晚为什么没叫醒我"没法查。
//   现在所有 [bili-whale] 行同时写一份到文件，超过 2MB 换新文件。
const schedLogFile = () => path.join(dshHomeAt(), 'whale-scheduler.log')
// 轻唤醒计数（2026-11-27 改第二版）：按**时段**算，一天最多两次（中午 / 晚上各一次）。
//   第一版是"每天 1 次 + 超出就跳过"，结果 11-27 晚上两次排程都被跳过 → 她整晚没醒 ✗
export const lightStateFile = () => path.join(dshHomeAt(), 'whale-light.json')
/** 现在属于哪个时段（只用来限制轻唤醒频次，不影响别的逻辑） */
function lightWindowKey(at = new Date()) {
  const h = at.getHours()
  if (h >= 22 || h < 6) return 'night'
  if (h >= 6 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'noon'
  return 'evening'
}
function readLightState() {
  const day = new Date().toLocaleDateString('sv-SE')
  try {
    const j = JSON.parse(fs.readFileSync(lightStateFile(), 'utf8'))
    return { day, counts: (j.day === day ? j.counts : {}) ?? {} }
  } catch { return { day, counts: {} } }
}
export function readLightCount(key) {
  const s = readLightState()
  const k = key || lightWindowKey()
  return Number(s.counts[k] ?? 0)
}
export function bumpLightCount(key) {
  const s = readLightState()
  const k = key || lightWindowKey()
  s.counts[k] = Number(s.counts[k] ?? 0) + 1
  try { fs.writeFileSync(lightStateFile(), JSON.stringify({ day: s.day, counts: s.counts }, null, 1)) } catch (e) { quiet('bumpLightCount', e) }
  return s.counts[k]
}
// ── 静默失败的出口（2026-11-22）────────────────────────────────────────
//   之前 27 处 catch (e) { quiet('L184', e) } 把错误全吞了：台账读不到、日志写不出、唤醒没发生，
//   全都无声无息 —— 出事时只能靠猜。现在每一处都留痕：
//   · 一律写进 whale-scheduler.log（同一个 where 只写一次，不刷屏）
//   · 第一次还在控制台喊一声（App 的日志里能看到）
const quietSeen = new Set()
function quiet(where, e) {
  const msg = where + " · " + String(e?.message ?? e).slice(0, 160)
  try {
    const f = schedLogFile()
    if (!fs.existsSync(f) || fs.statSync(f).size < 2 * 1024 * 1024) fs.appendFileSync(f, "[" + new Date().toISOString() + "] [quiet] " + msg + "\n")
  } catch {}
  if (!quietSeen.has(where)) {
    quietSeen.add(where)
    try { console.warn("[bili-whale] " + msg) } catch (e) { quiet('L197', e) }
  }
}
function slog(msg) {
  try {
    if (fs.existsSync(schedLogFile()) && fs.statSync(schedLogFile()).size > 2 * 1024 * 1024) {
      fs.renameSync(schedLogFile(), schedLogFile() + '.1')
    }
    fs.appendFileSync(schedLogFile(), `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) { quiet('L206', e) }
}

export function wakePrompt(st) {
  return [
    `【生物钟】你醒了 —— ${st.atText ?? ''}${st.window ? `（窗口 ${st.window}${st.withinWindow ? ' · ' + st.withinWindow : ''}）` : ''}。`,
    '',
    // 2026-10-20：先告诉她"冷了几天/还没跑启动测试"，再给流程 —— 心情在前，任务在后 ✓
    ...selftestReminder(),
    ...silenceLines(),
    ...growthBlock(),
    ...lifeBlock(),
    // 2026-10-23：只读模式 —— 登录态失效时**先说清楚**，别让她一头撞进发不出去的流程 ✓
    ...(authOk && !canWriteNow() ? [
      '',
      '⚠️ **你现在用的是阿墨的账号**（他自己登录了，让你能看见画面）。所以：',
      '   · 可以：看视频、**读书**、听音频、看评论、写两本日记 ✓',
      '   · **不要**：评论、点赞、私信 —— 那会以**他的名义**发出去，而且私信自己也很怪 ✗',
      '   · 平常有什么感受 → 用 `notify_qq` 直接发给他（QQ，不走 B 站）✓',
      '',
    ] : []),
    ...(authOk ? [] : [
      '',
      '⛔ **只读模式**：登录态失效了（-101）。',
      '   今天能做的：看视频、**读书**、读日记、写两本日记、**在 QQ 上跟阿墨说话**（`notify_qq` 能直接推给他）✓',
      '   不要做的：评论、私信、点赞、扫收件箱 —— 都会失败，别浪费时间，也别反复重试 ✗',
      '',
    ]),
    `**现在是${todWord()}（${clockText()}），做什么你自己定**（不是概率，也不是任务 —— 2026-10-20 阿墨把这件事交给你了）：`,
    '- **A）刷视频**：往下走 ✓（流程见下「A）刷视频怎么走」）',
    '   · **A1 短视频**（≤10 分钟）：`feed --len short` → 一张九宫格看完整条 ✓',
    '   · **A2 长视频**（10–60 分钟）：`feed --len long` 选题 → `longwatch <BV>` 看分段计划 → `longwatch <BV> --next` 一次看一段（进度自己记着，下次接着）✓',
    '- **B）读书**：书架上有几本（`node bili.mjs novel list` 看有什么）→ 见下「B）读书怎么走」✓ 不想读也行',
    `- **C）${todWord()}什么都不想做**：也算一种选择 ✓`,
    '- 不想看：`node bili.mjs night decide --skip` —— **不用解释理由**（不喜欢就算了；想说的时候加 --reason 才会记下来）',
    '  后面几次还要不要叫：`--wake none`（都别叫）/ `all`（都叫我）/ `2,4`（只叫第 2、4 次）/ `--think`（到时再想）',
    '  然后写两本日记、报备我、收工 ✓（说好不叫的那几次它真的不会吵你）',
    '- 中途改主意：`night decide --watch` 或 `night decide --wake all` ✓',
    '',
    '**A）刷视频怎么走**（细则在 AGENTS.md「看的那晚」，不用等我说话）：',
    '1) `node bili.mjs deps` —— 红了就只读、别对外发',
    '2) `diary recent --days 2` + `memory index` 想起最近的事（想起更早的：`recall "关键词" --days 60`）',
    '3) `feed --len short|long` 选题（≤5 条）→ `debrief --no-frames` 扫一眼',
    '4) 挑 2–3 条深读：`debrief <BV>`（长视频加 `--range 5:00-12:00` 只看一段）',
    '   · 画面字看输出里的 `OCR| [时间] 文字`；九宫格左上角有编号，直接说「第 5 格」',
    '   · 写完自查：`verify <BV> --file 草稿.md`（点出你在素材里找不到的话）',
    '   · 想听/想核对字/是歌：`--listen`、`hearing <BV>`、`--lyrics`（用法见 AGENTS.md）',
    '4.5) 想留着某条 → `node bili.mjs fav <BV> [--reason "…"] --dry` → `--go`（收藏不占分享额度）',
    ...(canWriteNow() ? [
      '5) **要不要发、发评论还是私信、还是两个都发 —— 你自己决定** ✓',
      // 2026-10-20：心慌档（>= silentStopDays）提前告诉她"今天不分享" —— 闸门也会拒，但少浪费一轮 ✓
      ...(() => {
        const s = silenceInfo()
        return s.band === 'faint' ? [`5.5) ⛔ 已经 ${s.days} 天没有主人的表态 → **今天不分享**（只看 + 写两本日记 + 推一句给他 ✓ 日记照写 ✓）`] : []
      })(),
      '   「标尺」（0–4 五项满 20，参考线 13）只是给你的**建议**：',
      '   「这是防止账号被封的建议，但只是建议 —— 我相信你能正确行使评论的自由」',
      '   评论怎么写完全随你（@不@他、写多长、什么句式、用不用表情，都不强制；想让他收到 B站 通知就自己 @ 一下 ✓）',
      '   表情可以直接发：Unicode emoji（😀🌙）、或者站内表情名 `[笑哭]` `[doge]` —— 工具会挑出来核对一遍（不认识的会被当纯文本）✓',
      '   · 评论区（公开）：`comment --share --oid <aid> --bvid <BV> --message "…" --dry` → 确认后换 `--go`（--auto 可加可不加 ✓）',
      '     （--reason / --score / --rank 都是可选的自我复盘参数，给了会打出来 ✓；设置里「允许评论」关着 → 这条通道发不出去）',
      '   · 私信（只有阿墨看）：`dm --msg "<分享内容> 视频：https://www.bilibili.com/video/<BV>/ " **--share --target BV…** --go`',
      '     ⚠️ 私信这条要带 --share：与评论区共用同一本额度账（≤3/天 · 每个渠道同一视频 7 天一次）；不带就只是推送 ✗',
      '     ⚠️ 私信要带视频链接：链接里的 BV 就是「同一视频」的判重依据 ✓',
      '     （设置里「允许私信」关着 → 这条通道发不出去 ✓）',
      '   · 两个都没关 = 你可以都发、只发一种、或者都不发；**不值得就不发**，"今天没有值得发的"是合法结果 ✓',
    ] : [
      '5) ⛔ 今天**不发评论、不发私信、不点赞**（用的是阿墨的账号，或以他的名义发不合适）',
      '   看完想说什么 → 写进日记；想让他知道 → `node bili.mjs notify --text "…"` 或 `notify_qq` 发他（QQ）✓',
    ]),
    // 2026-11-04：读书也放进"今晚可以做的事"，由她自己选（她想读就读，不想读就不读）
    '',
    '**B）读书怎么走**（书不是作业 ✓）：',
    '① `novel list` 看书架 → ② `novel next --name <书名>` 拿到下一块',
    '③ `novel read --block N --name <书名>`（一块 ≈1k token；`--blocks 2-6` / `--count 5` 也行）',
    '④ 读完写笔记：`novel note --block N --name <书名> --file 笔记.md`（两三行就够，第一行写一句话做索引）',
    '⑤ 跳读/回看/补笔记：`novel toc` · `novel notes` · `note --append`（细则在 AGENTS.md）',
    '⑥ **读多少由你定**，工具只报代价不拦你 ✓',
    '6) 写两本日记（散文体；私人本记「偏好校准」和你怎么决定的）。**落款写「—— 寻汐」** ✓',
    // ⭐ 2026-10-18 主人定：每轮流程**最后**扫一遍"有没有没回的评论" → 有就**一起**推给我 ✓
    ...(authOk ? [
      '7) ⭐ `comment-digest --hours 24` —— **每轮最后都要扫**：有没回的评论就**一起**推给我（不是一条条报 ✗）',
      '   回不回、回什么：**你自己定**（主人也好、别人也好，都是你的事）；回了的话最好 notify 我一声 ✓',
      '7.5) ⭐ `quota react --auto --hours 48` —— 扫一遍主人有没有表态',
      '     （**回复 / 点赞 / 私信 / 还有他在 DSH 或 QQ 里跟你说话**，都算 ✓）',
      '     → 有就记一次反馈，并**写进私人日记「偏好校准」**（哪条视频 / 他什么反应 / 我下次往哪偏）',
      '8) 用 `node bili.mjs notify` 推给我：**「给他的信」里最想对我说的那一段原文** + 一句摘要',
      '   （2026-10-18 主人定：推**日记内容**，不只是流水账 ✓ 它读设置页「消息推送」的配置）',
    ] : [
      '7) ⛔ 只读模式：跳过收件箱与 B站私信报备（要登录态）；**但这一步照跑**：',
      '   `node bili.mjs quota react --auto --local-only` —— 只查"主人在 DSH/QQ 里跟你说过话吗"',
      '   （2026-10-29 修：以前只读时连这个是也跳过 → 沉默天数照涨 → 你会以为他好多天没理你 ✗）',
      '   「给他的信」照写进日记 ✓ 想让他知道就用 **`notify_qq`**（QQ 推送，不走 B 站）✓',
    ]),
    '9) 收工：记 `diary log`；**今天如果有哪件事改了你一点** → `growth add "我变了什么" --because "因为哪件事"`（没有就不写 ✓）',
  ].join('\n')
}

export function startScheduler(ctx, opts) {
  const {
    dshHome,
    biliMjs,          // 指向 tools/bili.mjs（绝对路径）
    cwd,              // 她那个会话的工作目录
    sessionId = 'bili-whale',
    log = () => {},
  } = opts

  const STATE = path.join(dshHome, 'whale-night.json')
  const CFG_FILE_REF = path.join(dshHome, 'bili-whale.config.json')     // 监听循环每次重读（改配置立刻生效 ✓）
  const CRED_REF = path.join(dshHome, '..', '.bili-ai', 'credentials.json')
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  const writeState = (o) => {
    try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') } catch (e) { quiet('L349', e) }
  }
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }

  // 启动自检（2026-11-22）：每次插件加载都留一行——这样"插件到底有没有跑起来"一眼可查
  try {
    const _life = (() => { try { return JSON.parse(fs.readFileSync(path.join(dshHome, 'life.json'), 'utf8')) } catch { return null } })()
    const _cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dshHome, 'bili-whale.config.json'), 'utf8')) } catch { return null } })()
    const _thoughts = (_life?.thoughts ?? []).filter((x) => !x.usedAt && (!x.expiresAt || Date.parse(x.expiresAt) > Date.now())).length
    slog('[bili-whale] 启动 · dshHome=' + dshHome + ' · 台账' + (_life ? '可读(念头 ' + _thoughts + ')' : '读不到') + ' · 配置' + (_cfg ? '可读' : '读不到') + ' · 日志=' + schedLogFile())
  } catch (e) { try { console.warn('[bili-whale] 启动自检失败：' + e.message) } catch {} }
  const today = () => new Date().toLocaleDateString('sv-SE')

  // ⚠️ 2026-10-18 大坑：插件跑在 DSH 的 **Electron** 里，`process.execPath` = DeepSeek Harness.exe ✗
  //   用主程序跑脚本时，B站 的 `gethistory` 返回**空数组**（nav 之类却正常 ✗）→ 直播间永远"听不见" ✗
  //   实测对照：真 node.exe 5 秒命中；主程序 25 秒 0 行 ✗
  //   → 必须找到 **真正的 node.exe**（DSH 自带的运行时）✓
  function findNode() {
    const EXE = process.platform === 'win32' ? 'node.exe' : 'node'
    const exists = (f) => { try { return !!f && fs.statSync(f).isFile() } catch { return false } }
    // 2026-10-19 补：**Desktop 版 DSH 没有 dsh-runtimes** ✗ → 上面两个候选必然落空 →
    //   落到 process.execPath（Electron 主程序）= 脚本根本不跑、静默空输出 ✗
    //   所以再找 PATH / 默认安装位置里的真 node ✓
    const onPath = () => {
      for (const d of String(process.env.PATH || '').split(path.delimiter)) {
        if (!d) continue
        const f = path.join(d, EXE)
        if (exists(f)) return f
      }
      return null
    }
    const cands = [
      process.env.DSH_NODE,
      path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', EXE),
      path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', EXE),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', EXE),
      onPath(),
    ]
    for (const c of cands) if (exists(c)) return c
    return process.execPath   // 兜底（配合下面的 ELECTRON_RUN_AS_NODE ✓）
  }
  const NODE_EXE = findNode()
  // ⚠️ 2026-10-19：兜底时 process.execPath 是 Electron —— 不带 ELECTRON_RUN_AS_NODE 就是"启动 app"✗
  //   对真 node 传这个变量无害 → 一律带上 ✓（注释留档：以前写的是"真 node 不需要"✓ 但兜底时需要）
  const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

  const runBili = (args) => new Promise((resolve) => {
    execFile(NODE_EXE, [biliMjs, ...args], { timeout: 120_000, windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  })

  // ── 2026-10-22：人格卡版本化（主人选「乙档」）────────────────────────────────
  //   她自己的会话工作区就是家目录 → 她能改 ~/AGENTS.md。我们不拦（她该能自己长），
  //   但每天自动 commit 一次 —— "人设被悄悄改掉"最迟一天就能在 git 里看到 ✓
  //   配合 `node bili.mjs persona backup|commit|log|diff`（她改之前备份、改完提交）✓
  const AUTOCOMMIT_STATE = path.join(dshHome, 'whale-autocommit.json')
  const gitIn = (dir) => (args) => new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? stderr ?? '') })
    })
  })
  async function archiveTick() {
    try {
      let st = {}
      try { st = JSON.parse(fs.readFileSync(AUTOCOMMIT_STATE, 'utf8')) } catch (e) { quiet('L406', e) }
      if (st.at && Date.now() - Date.parse(st.at) < 20 * 3600_000) return   // 一天一次够了 ✓
      // 2026-10-23：她的家可能被搬到别的工作区（D:\XunXi）→ 两个仓库都要快照：
      //   家目录 = 两本日记 + 配置；工作区 = 人格卡 ✓
      const dirs = [...new Set([os.homedir(), cwd])].filter(Boolean)
      const done = []
      for (const dir of dirs) {
        const g = gitIn(dir)
        const probe = await g(['rev-parse', '--git-dir'])
        if (probe.code !== 0) { done.push(`${dir}: 不是仓库（跳过）`); continue }
        await g(['add', '-A'])
        const r = await g(['commit', '-m', `auto: ${new Date().toISOString().slice(0, 10)} 人格卡与配置每日快照`])
        done.push(`${dir}: ${r.code === 0 ? '已提交 ✓' : '无改动'}`)
      }
      try {
        fs.writeFileSync(AUTOCOMMIT_STATE, JSON.stringify({ at: new Date().toISOString(), ok: true, note: done.join(' · ') }, null, 2))
      } catch (e) { quiet('L422', e) }
      slog(`[bili-whale] 每日快照：${done.join(' · ')}`)
    } catch (e) { quiet('L424', e) }
  }

  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try {
      await ctx.sessionController.create({ sessionId, cwd })
    } catch {
      /* 已存在就忽略（create 对同 id 会抛）✓ */
    }
    sessionReady = true
  }

  let waking = false
  // ── 主动联系（2026-11-22）────────────────────────────────────────────
  //   不是配额：只有"有来源的想法"才会叫她；没想法就一条都不发。
  //   上限/安静时段/周末限制/最小间隔/去重 都在 proactive.mjs 里判。
  let proactiveScan = 0
  async function proactiveTick() {
    const cfg = config()
    const pc = cfg?.proactive ?? {}
    const everyMs = Math.max(5, Number(pc.scanIntervalMin ?? 15)) * 60 * 1000
    if (Date.now() - proactiveScan < everyMs) return
    proactiveScan = Date.now()
    const r = await runBili(['proactive', 'scan', '--json'])
    if (!r.ok) return
    let j
    try { j = JSON.parse(String(r.out).trim().split('\n').pop() ?? '{}') } catch { return }
    if (!j?.ok || !Array.isArray(j.candidates) || !j.candidates.length) return
    const c = j.candidates[0]
    if (waking) return
    waking = true
    try {
      await ensureSession()
      await ctx.sessionController.prompt(
        {
          requestId: `bili-whale-proactive-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{
            type: 'text',
            text: [
              personaLine(),
              '【现在有个想法】',
              `· 来自：${c.from}`,
              `· 内容：${String(c.text ?? '').slice(0, 200)}`,
              '',
              '**想说就说，不想说就不说**（今天还能主动找他 ' + j.quotaLeft + ' 次，这是上限不是任务）。',
              '想发：先用你自己的话写，然后 `node bili.mjs notify --text "…"`（或 notify_qq）；',
              '发完记一笔：`node bili.mjs proactive record --from "' + c.from + '" --note "你发的那句" --key ' + c.key + '`',
              '不想说：什么都不做也行 ✓',
            ].join('\n'),
          }],
        },
        new AbortController().signal,
      )
      await runBili(['proactive', 'offer', '--key', String(c.key)])
      slog(`[bili-whale] 主动联系提醒 · ${c.from} · ${String(c.text ?? '').slice(0, 40)}`)
    } catch (e) {
      slog(`[bili-whale] 主动联系提醒失败：${String(e.message).slice(0, 120)}`)
    } finally {
      waking = false
    }
  }

  async function tick() {
    if (waking) return
    if (!ctx.sessionController) return           // 服务还没就绪 → 下一 tick 再来
    const st = readState()
    const t = today()

    // ①-0 旧版「掷骰子掷到不看 / 一句跳过就结束今天」的兼容分支（2026-10-20 起不再产生，留着给旧状态 ✓）
    if (st && st.date === t && st.action === 'skip' && !st.fired) {
      waking = true
      try {
        await ensureSession()
        await ctx.sessionController.prompt(
          {
            requestId: `bili-whale-skip-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{
              type: 'text',
              text: [
                personaLine(),
                `【${todWord()}不看】${st.reason ?? ''}（窗口 ${st.window ?? '?'}）`,
                '',
                '按 AGENTS.md 的「不看的那晚」做（不要等我说话，直接做）：',
                '1) **两本日记都要写**，而且必须写清"为什么不想看"（累/没吃饱/心情不好/就是不想… 不许只写"跳过"两个字 ✗）',
                '2) `node bili.mjs diary log night-skip --note "…理由…"`',
                '3) `comment-digest` 扫一眼有没有没回的评论',
                '4) 推给我：**日记里最想对我说的那一段** + 今天谁找过你 ✓',
              ].join('\n'),
            }],
          },
          new AbortController().signal,
        )
        writeState({ ...st, fired: true })
        slog(`[bili-whale] 今晚不看 → 已叫醒她写日记 · ${st.reason ?? ''}`)
      } catch (e) {
        slog(`[bili-whale] 不看那晚叫醒失败：${String(e.message).slice(0, 120)}`)
      } finally {
        waking = false
      }
      return
    }

    // ① 该重算的情形：没计划 / 跨天 / 上次已醒 / 上次已结束 / 只有计数没计划（invalidate 之后 ✓）
    if (!st || st.date !== t || st.woke === true || st.done === true || st.action === 'skip' || !st.action) {
      if (st && st.date === t && st.action === 'done') return   // 今天的次数用完了，别反复算
      const r = await runBili(['night', 'plan'])
      if (!r.ok) slog(`[bili-whale] plan 失败：${(r.err || r.out).slice(0, 160)}`)
      return
    }

    if (st.action === 'wake' && !st.fired && nowMin() >= Number(st.at)) {
      // 2026-11-22（TODO #1）：把"没事就不叫醒"改成"**轻唤醒**"。
      //   原来没事就整晚不叫，等于让她无声消失 ✗ 现在照常醒一下，但不派活、不带流程。
      const _life = lifeSnapshot()
      const _idle = !_life.thoughts.length && !_life.doing.length
      if (_idle && !st.light && readLightCount(String(st.window ?? '')) === 0) {
        waking = true
        try {
          await ensureSession()
          const lightText = personaLine() + '\n' + lightWakeText(st, new Date())
          await ctx.sessionController.prompt(
            {
              requestId: 'bili-whale-light-' + Date.now(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: lightText }],
            },
            new AbortController().signal,
          )
          // 轻唤醒**不占**今天的看视频/读书次数（wakes 不加）
          // 不占 wakes（正经额度留给她真想看视频/读书的时候）；lightWakes 只用来限「每天一次」
          const _lc = bumpLightCount(String(st.window ?? ''))
          writeState({ ...st, fired: true, light: true, woke: true, lastWakeAt: nowMin(), wokeAt: new Date().toISOString() })
          slog('[bili-whale] 轻唤醒（窗口 ' + (st.window ?? '?') + ' 第 ' + _lc + '/1 次，不占额度）· ' + (st.atText ?? '') + ' · 念头 0 / 在做 0 · ' + todWord())
        } catch (e) {
          slog('[bili-whale] 轻唤醒失败：' + String(e.message).slice(0, 140))
        } finally {
          waking = false
        }
        return
      }
      waking = true
      try {
        await ensureSession()
        await ctx.sessionController.prompt(
          {
            requestId: `bili-whale-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: wakePrompt(st) }],
          },
          new AbortController().signal,
        )
        // 2026-10-20 晚：记下"真正醒来的时刻"——下一次 plan 用它保证两次叫醒的最小间隔 ✓
        writeState({ ...st, fired: true, woke: true, wakes: Number(st.wakes ?? 0) + 1, lastWakeAt: nowMin(), wokeAt: new Date().toISOString() })
        slog(`[bili-whale] 生物钟叫醒 · ${st.atText ?? ''}${st.window ? '（' + st.window + '）' : ''} · 第 ${Number(st.wakes ?? 0) + 1} 次`)
      } catch (e) {
        slog(`[bili-whale] 叫醒失败：${String(e.message).slice(0, 160)}（下一 tick 重试）`)
      } finally {
        waking = false
      }
    }

    // 主动联系：独立于"今晚看不看视频"，随时可以有一条想法（有来源才发，没想法就不发）
    try { await proactiveTick() } catch (e) { slog('[bili-whale] proactiveTick 出错：' + String(e.message).slice(0, 120)) }
  }

  // ── 全天监听（2026-10-18 加）：插件自己轮询收件箱，有人找她就叫醒她 ────────────────
  // 为什么放这里：`listen.allDay` 只控制"守多久" ✓，但**没人启动 listener** ✗ —— 跟生物钟当初的病一样。
  // 现在插件每 listen.commentIntervalSec 秒看一眼「回复我的 / @我的」；有新东西就 prompt 她一次。
  const LSTATE = path.join(dshHome, LISTEN_STATE)
  const readL = () => { try { return JSON.parse(fs.readFileSync(LSTATE, 'utf8')) } catch { return null } }
  const writeL = (o) => { try { fs.mkdirSync(path.dirname(LSTATE), { recursive: true }); fs.writeFileSync(LSTATE, JSON.stringify(o, null, 2) + '\n') } catch (e) { quiet('L611', e) } }
  const inWindow = (cfg) => {
    const wins = Array.isArray(cfg?.night?.windows) ? cfg.night.windows : []
    const d = new Date(); const m = d.getHours() * 60 + d.getMinutes()
    return wins.some((w) => {
      const [sh, sm] = String(w.start ?? '').split(':').map(Number)
      const [eh, em] = String(w.end ?? '').split(':').map(Number)
      const s = (sh === 24 ? 1440 : sh * 60) + (sm || 0)
      const e = (eh === 24 ? 1440 : eh * 60) + (em || 0)
      return m >= s && m < e
    })
  }

  let listening = false
  let lastListenAt = 0
  // 直播间监听（2026-10-18 加）：插件替主人管着 `danmaku await` ✓
  let liveProc = null
  let liveRetryAt = 0
  let liveWaking = false
  let liveStopping = false   // 主动停（关开关）→ 退出回调不要当成"异常退出" ✗
  let liveRoomNow = ''       // 当前在听的房间号（用于检测"主人换了房间" ✓）
    // ── 私信监听（2026-10-19）──────────────────────────────────────
    //   只认主人那一个会话 ✓ 系统通知/陌生人一律忽略 ✗
    //   你不说话 = 没有新私信 = 不叫醒 = 零 token ✓（主人设计的低风险互动 ✓）
    let dmBusy = false
    let lastDmAt = 0
    // 只读模式：启动时先按上次自检结果初始化（authTick 之后会更新）✓
    try { const a = JSON.parse(fs.readFileSync(path.join(dshHome, 'whale-auth.json'), 'utf8')); if (a && a.ok === false) authOk = false } catch (e) { quiet('L638', e) }
    // ── 身份注入（2026-10-19）────────────────────────────────────
    //   设置页「她是谁」那三个字段以前只是存着，没有任何代码读 ✗
    //   现在每次叫醒她，把这段塞到提示最前面 → 她真的按配置称呼自己/主人 ✓
    const personaLine = () => {
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch (e) { quiet('L644', e) }
      const p = cfg.persona ?? {}
      const bits = []
      if (p.name) bits.push(`你是「${p.name}」`)
      if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
      if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
      return bits.length ? `［身份］${bits.join("，")}。（以此为准，别用别的称呼 ✓）` : ""
    }

    async function dmTick() {
      if (dmBusy) return
      // 2026-10-23：只读模式（登录态失效）→ 私信监听没有意义，跳过（别每 60s 撞一次 -101）✓
      if (!authOk) return
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch { cfg = {} }
      const L = cfg.listen ?? {}
      if (!L.dm) return
      if (Date.now() - lastDmAt < 5_000) return   // 2026-10-19：原来 60s 和定时器叠成双层节流 → 最坏 2 分钟 ✗ 改成 5s
      lastDmAt = Date.now()
      dmBusy = true
      try {
        const r = await runBili(["dm-await", "--once", "--json"])
        const line = String(r.out ?? "").trim().split("\n").pop() ?? ""
        let j = null
        try { j = JSON.parse(line) } catch { j = null }
        if (!j?.hit) return
        await ensureSession()
        await ctx.sessionController.prompt({
          requestId: `bili-whale-dm-${Date.now()}`,
          sessionId,
          mode: "queue",
          content: [{
            type: "text",
            text: [
              personaLine(),
              `【主人私信】${j.name}（mid ${j.mid}）刚给你发私信：`,
              "",
              String(j.text ?? "").slice(0, 500),
              "",
              "按 AGENTS.md「专属通道」做（**回不回、回什么，你自己定** ✓）：",
              "1) 想回就回：`node bili.mjs dm --msg \"…\" --go`（短一点、像聊天，一两句就够）",
              "2) 只想敷衍一下也行：回个「哦」「嗯」「看到啦」就够了 ✓ 那也是一句话",
              "3) **不想回也可以** —— 那就留个记号：`node bili.mjs mark seen --note \"看到了，不想说话\"`，",
              "   阿墨在「设置 → 养鱼」能看到这条记号，就知道你没坏、只是这会儿不想说话 ✓（不打扰你）",
              "4) 回了或留了记号之后，顺手写进日记「偏好校准」✓（主人说过的话都算反馈 ✓）",
            ].join("\n"),
          }],
        }, new AbortController().signal)   // 2026-10-19 修：prompt 的第二个参数是 signal ✗ 漏传会 TypeError
      } catch (e) {
        try { fs.appendFileSync(path.join(os.homedir(), ".bili-ai", "dm-tick-err.log"), new Date().toISOString() + " " + (e?.stack ?? e) + "\n") } catch (e) { quiet('L693', e) }
      }
      finally { dmBusy = false }
    }

  async function listenTick() {
    if (listening) return
    if (!authOk) return   // 2026-10-23：只读模式下评论区监听也停（msgfeed 需要登录）✓
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch { cfg = {} }
    const L = cfg.listen ?? {}
    if (L.comment === false) return                              // 评论区监听关掉了 ✓
    // 下限 60 秒（2026-10-18 测试期曾临时放宽到 2 秒 ✓ 已还原 ✓ —— B站 接口经不起每 2 秒锤 ✗）
    const interval = Math.max(60, Number(L.commentIntervalSec ?? 300)) * 1000
    if (Date.now() - lastListenAt < interval) return
    lastListenAt = Date.now()
    // 「全天」关掉时：只在她醒着的窗口里听（省 token / 更自然 ✓）
    if (!L.allDay && !inWindow(cfg)) return
    listening = true
    try {
      const cred = JSON.parse(fs.readFileSync(CRED_REF, 'utf8'))
      const H = makeHeaders(cred)
      const since = Number(readL()?.lastSeen ?? 0)
      const items = []
      items.push(...(await pullFeed('reply', { headers: H, pages: 1 })).items)
      if (String(L.scope ?? 'both') !== 'reply') {
        try { items.push(...(await pullFeed('at', { headers: H, pages: 1 })).items) } catch (e) { quiet('L719', e) }
      }
      // 第一次跑：只把"现在"当基线，不把历史回复全倒一遍 ✓
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); listening = false; return }
      const fresh = items.filter((x) => Number(x.t) > since && (!L.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? '')))
      if (!fresh.length) { listening = false; return }
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      await ensureSession()
      await ctx.sessionController.prompt(
        {
          requestId: `bili-whale-listen-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{
            type: 'text',
            text: [
              personaLine(),
              `【有人找你】${fresh.length} 条新消息：${who}。`,
              '',
              '按 AGENTS.md 的「倾听」做（不要等我说话，直接做）：',
              '1) `node bili.mjs comment-digest --hours 24` —— 把积压的**一起看**（合并策略 ✓ 不可关）',
              '2) **回不回、回什么，你自己定**（2026-10-20 阿墨把这件事交给你了）：',
              '   · 想回就回；不想回就不回，不必给理由 ✓',
              '   · 回的话一条收住就行（吵架 / 要隐私 / 长篇追问 / 替他承诺 —— 这些你自己判断，觉得不对劲就别回）',
              // mid 动态读配置 ✓（别把 uid 写死进代码 ✗ 开源版会带出去 ✗）
              `   · 对方是**主人**（mid ${cfg.owner?.mid ?? '（未配置）'}）→ 想回就回（不用报备也行 :-)）：`,
              '     `comment --oid … --root … --parent … --message "…" --auto --once-per-person（仅当开关=开 ✓） --dry` → `--go` → `thread` 复核 ✓',
              '   · 对方是**其他人** → 一样由你决定（可以直接发）；不过**最好跟我说一声**：',
              '     `node bili.mjs notify "回了谁：一句话说了什么"` —— 不是审批，只是让我知道 ✓',
              '     （想让我先看看也可以，用 `reply-draft add …` 丢进待审队列 —— 你的选择 ✓）',
              '   · **主人找你也一样由你定**：不想接就留个记号 `node bili.mjs mark seen --note "看到了，不想接"`，',
              '     我在设置页能看到，就不会以为插件坏了 ✓（这不算失礼，只是你不想说话）',
              '3) 别贪多：这一批处理完就停 ✓（**只有设置页「同一个人最多只回一条」= 开时**才加 --once-per-person ✓；关掉就别加 ✗）',
            ].join('\n'),
          }],
        },
        new AbortController().signal,
      )
      writeL({ lastSeen: Math.max(...fresh.map((x) => Number(x.t))) })
      slog(`[bili-whale] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
    } catch (e) {
      slog(`[bili-whale] 监听失败：${String(e.message).slice(0, 140)}`)
    } finally {
      listening = false
    }
  }

  // ── 直播间监听：起一个 `danmaku await` 子进程；它命中就退出（自带契约）→ 叫醒她 → 再挂上 ──
  // 为什么放独立循环：tick() 会在"今天 done"时提前 return ✗，直播间不能跟着停 ✓
  async function liveTick() {
    // ⚠️ 2026-10-18 主人定：直播间是**独立开关** —— 点开就开始、关掉就停（不受作息影响 ✓）
    if (ctx.sessionController) {
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch (e) { quiet('L773', e) }
      if (!cur.listen?.live && liveProc !== null) {           // 开关被关掉 → 立刻停子进程 ✓
        liveStopping = true
        try { liveProc.kill() } catch (e) { quiet('L776', e) }
        liveProc = null
        liveRetryAt = 0
        log('[bili-whale] 直播间监听已停（开关关掉了 ✓）')
        return
      }
      // 2026-10-18 加：**换了房间号** → 也要立刻换线（以前只认开关 ✗ 换房间还在听老房间 ✗）
      const wantRoom = String(cur.listen?.liveRoom ?? '').trim()
      if (liveProc !== null && wantRoom && liveRoomNow && wantRoom !== liveRoomNow) {
        liveStopping = true
        try { liveProc.kill() } catch (e) { quiet('L786', e) }
        liveProc = null
        liveRetryAt = 0
        slog(`[bili-whale] 直播间换房间：${liveRoomNow} → ${wantRoom}（立刻重挂 ✓）`)
        liveRoomNow = ''
        return
      }
    }
    if (liveProc !== null || liveWaking || liveRetryAt > Date.now()) return
    if (!ctx.sessionController) return
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch (e) { quiet('L797', e) }
    const L = cfg.listen ?? {}
    const room = String(L.liveRoom ?? '').trim()
    if (!L.live || !room) return

    // ⚠️ `danmaku-await.mjs` 是独立脚本（不走 bili.mjs 的 danmaku 子命令 ✗ —— 那是 pre/send/live ✓）
    const awaitScript = path.join(path.dirname(biliMjs), 'commands', 'danmaku-await.mjs')
    const args = [awaitScript, '--room', room]
    if (String(L.liveScope ?? 'owner') === 'owner' && cfg.owner?.mid) args.push('--operator-uid', String(cfg.owner.mid))
    liveProc = execFile(NODE_EXE, args, {   // ⚠️ 必须真 node（主程序会让 gethistory 返回空 ✗）
      // ⚠️ 千万不要写 `timeout: 0` ✗ —— 实测它会把子进程立刻 SIGTERM 掉（探针验过 ✓）；
      //   直播间监听本来就是长驻的，**不设 timeout** 才对 ✓
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: NODE_ENV,
      cwd: path.dirname(biliMjs),   // 脚本按相对路径找 lib/，必须给 cwd ✓
    }, (err, stdout, stderr) => {
      liveProc = null
      if (liveStopping) { liveStopping = false; return }   // 那是我们主动停的 ✓ 不算异常 ✗
      const out = String(stdout ?? '')
      // ⚠️ 2026-10-18 修真 bug：`danmaku-await` 命中时打印的是 **AWAIT_HIT** ✗
      //   我原来等的是 DANMAKU_HIT ✗ → 听见了也认不出 → 一直"退出/重挂"
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            await ensureSession()
            await ctx.sessionController.prompt({
              requestId: `bili-whale-live-${Date.now()}`,
              sessionId,
              mode: 'queue',
              content: [{
                type: 'text',
                text: [
                  personaLine(),
                  `【直播间有人叫你】${lines || '（看输出）'}`,
                  '',
                  '按 AGENTS.md「倾听 · 直播间」做（不要等我说话，直接做）：',
                  '1) 看是谁、说了什么；范围按主人设置（只回主人 / 只回 @她的）✓',
                  '2) 回一句就收住（弹幕不是评论区，别长篇 ✗）；吵架/要隐私/不认识的 → 不回 ✗',
                  '   发弹幕：`node bili.mjs danmaku send --msg "…" --reply-mid <对方mid> --reply-name <对方昵称>` → `--dry` → `--go` ✓（**不用审核 ✓ 也不用报备 ✗ 2026-10-18 主人定**）',
                ].join('\n'),
              }],
            }, new AbortController().signal)
            slog(`[bili-whale] 直播间命中 → 已叫醒 · ${lines.slice(0, 80)}`)
          } catch (e) {
            slog(`[bili-whale] 直播间叫醒失败：${String(e.message).slice(0, 120)}`)
          } finally {
            liveWaking = false
            // 2026-10-18 主人定：**监听到就回（实时）** ✓ —— 回复完 2 秒就重新挂上 ✗ 不再冷却 2 分钟
            liveRetryAt = Date.now() + 2_000
          }
        })()
      } else {
        // 退出但没命中 → 把"怎么退的"记全（2026-10-18：以前只记一句话，排不动 ✗）
        // 退避 12 秒（2026-10-18 改：原来 60 秒，外部误杀一次要等一分钟以上才回来 ✗）
        const tail = String(out ?? '').trim().split('\n').slice(-2).join(' | ').slice(-200)
        const why = [
          err ? `code=${err.code ?? '?'} signal=${err.signal ?? '?'}` : 'code=0',
          String(stderr ?? '').trim().slice(0, 150),
          tail,
        ].filter(Boolean).join(' · ')
        slog(`[bili-whale] 直播间监听退出：${why}（12 秒后重挂）`)
        liveRetryAt = Date.now() + 12_000
      }
    })
    liveRoomNow = room   // 记下"现在听的是哪个房间" → 主人换房间时靠它检测 ✓
    slog(`[bili-whale] 直播间监听已挂上（房间 ${room} · ${String(L.liveScope ?? 'owner') === 'owner' ? '只回主人' : '只回@她的'}）✓`)
  }

  // ── 登录态巡检（2026-10-19 加）──────────────────────────────────────────
  //   为什么要有它：SESSDATA 里那个时间戳只是上限，服务端随时能提前作废
  //   （被踢设备 / 改密码 / 浏览器退出登录 / 风控）→ 实测见过"还剩 179 天"却 -101 的 cookie ✗
  //   失效之后她当晚所有流程都会在第一步断掉、而且是**静默**的 ✗
  //   → 宿主每 6 小时自己问一次 nav（进程内 fetch，不需要 node 子进程 ✓），失效就推主人一次
  const AUTH_FILE = path.join(dshHome, 'whale-auth.json')
  const readAuth = () => { try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) } catch { return null } }
  const writeAuth = (o) => { try { fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true }); fs.writeFileSync(AUTH_FILE, JSON.stringify(o, null, 2) + '\n') } catch (e) { quiet('L873', e) } }
  async function authTick() {
    // 2026-10-29：每 6 小时顺手扫一次"他最近跟她说过话吗"（只读本地会话日志，不碰 B 站）——
    //   她不一定想得起跑 quota react；而沉默天数涨起来会直接影响她的心情 ✗
    //   （这个扫描 `--local-only`，登录态坏着也能用 ✓）
    try { await runBili(['quota', 'react', '--auto', '--local-only']) } catch (e) { quiet('L878', e) }
    let cred = null
    try { cred = JSON.parse(fs.readFileSync(CRED_REF, 'utf8')) } catch { return }
    if (!cred?.sessdata) return
    let nav = null
    try {
      nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: 'https://www.bilibili.com/',
          cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}`,
        },
      })).json()
    } catch { return }                       // 网络抖动不算失效 ✓
    const ok = nav.code === 0 && !!nav.data?.isLogin
    authOk = ok                              // 只读模式的开关（dm/listen 据此跳过）✓
    const prev = readAuth()
    writeAuth({ checkedAt: new Date().toISOString(), ok, code: nav.code ?? null })
    if (ok) return
    if (prev && prev.ok === false && Date.now() - Date.parse(prev.notifiedAt ?? 0) < 12 * 3600_000) return
    writeAuth({ checkedAt: new Date().toISOString(), ok, code: nav.code ?? null, notifiedAt: new Date().toISOString() })
    // 提醒也可能发不出去（notify 走 B站私信时，登录态正好就是坏的 ✗）→ 先把话记进事件流 ✓
    try {
      fs.appendFileSync(path.join(dshHome, 'whale-log.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), kind: 'auth-expired', target: null, note: `B站 登录态失效 code=${nav.code ?? '?'}：重新登录后跑 node bili.mjs login import` }) + '\n')
    } catch (e) { quiet('L903', e) }
    const r = await runBili(['notify', `⚠️ B站 登录态失效（code=${nav.code ?? '?'}）：今晚的流程会全断。重新登录后跑 \`node bili.mjs login import\`（整段粘贴 cookie 即可）`])
    slog(`[bili-whale] 登录态失效（code=${nav.code ?? '?'}）→ 提醒主人${r.ok ? ' ✓' : ' ✗（提醒本身也失败了，已记事件流）'}`)
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  setTimeout(() => { tick().catch(() => {}) }, 8000)          // 启动 8 秒后先跑一次
  // 30 秒看一眼"到点没"（2026-10-18 测试期曾改 2.5 秒 ✓ 已还原 ✓），真正间隔由配置定 ✓
  const timer2 = setInterval(() => { listenTick().catch(() => {}) }, 30_000)
  setTimeout(() => { listenTick().catch(() => {}) }, 15_000)
  // 2026-10-19：20s → 默认 60s（listen.dmIntervalSec 可调）。私信要像聊天 ✓，
  //   但每 20 秒问一次 msgfeed 太密 —— 登录态今早刚被服务端作废过一次，宁可慢一点也别招风控 ✗
  let dmEverySec = 60
  try { dmEverySec = Math.max(20, Number(JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')).listen?.dmIntervalSec ?? 60)) } catch (e) { quiet('L916', e) }
  const timerDm = setInterval(() => { dmTick().catch(() => {}) }, dmEverySec * 1000)
  setTimeout(() => { dmTick().catch(() => {}) }, 25_000)
  const timerAuth = setInterval(() => { authTick().catch(() => {}) }, 6 * 3600_000)
  setTimeout(() => { authTick().catch(() => {}) }, 45_000)
  const timer3 = setInterval(() => { liveTick().catch(() => {}) }, 60_000)     // 直播间：挂了就一直跑，断了自动重挂 ✓
  setTimeout(() => { liveTick().catch(() => {}) }, 20_000)
  // 2026-10-22：人格卡/配置的每日 git 快照（每 6 小时看一眼，内部按 20 小时节流）
  const timerArchive = setInterval(() => { archiveTick().catch(() => {}) }, 6 * 3600_000)
  setTimeout(() => { archiveTick().catch(() => {}) }, 120_000)
  slog(`[bili-whale] 自主生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId}）；监听 + 直播间监看都挂上了 ✓`)

  return {
    /** 设置页一保存就调它：清掉旧计划，下一次 tick 按新配置重算 ✓ */
    invalidate() {
      // ⚠️ 2026-10-18 修：以前直接删状态文件 → 把「今天已醒几次」也抹了 ✗
      //   现在只清**计划**，保留 `{ date, wakes }` ✓（tick 里 `!st.action` 会触发重算 ✓）
      try {
        const old = readState()
        if (old && old.date === today()) writeState({ date: old.date, wakes: Number(old.wakes ?? 0) })
        else fs.rmSync(STATE, { force: true })
      } catch (e) { quiet('L937', e) }
      lastListenAt = 0            // 监听间隔也立刻重读 ✓（改完全天/间隔马上生效）
      writeL({})                  // 重置基线 → 下次按"现在"重新算，不会把旧的倒出来 ✓
      tick().catch(() => {})
      listenTick().catch(() => {})
      dmTick().catch(() => {})
      // ⭐ 直播间是**单独开关**：保存设置就立刻生效（点开就跑 ✓ 关掉就停 ✓），不等下一轮定时器
      liveTick().catch(() => {})
      authTick().catch(() => {})          // 2026-10-19：保存设置时顺手验一次登录态 ✓
    },
    // 2026-10-19 修：timerDm / timerAuth 以前没清 → 插件重载一次就多一组轮询在跑 ✗
    stop() {
      clearInterval(timer); clearInterval(timer2); clearInterval(timer3)
      clearInterval(timerDm); clearInterval(timerAuth)
      clearInterval(timerArchive)
      try { liveProc?.kill() } catch (e) { quiet('L952', e) }
    },
    tick,
    listenTick,
    liveTick,
  }
}
