// 这条鱼的「生物钟」—— 决定今天醒几次、什么时候醒，到点**退出**来叫醒她。
//
// 为什么用"退出"叫醒：后台任务没法给 agent 注入一个回合 ✗，但它**结束**时系统会通知 agent ✓
// —— 跟直播间 `danmaku await` 是同一个套路（已在实战验证过）。
//
// 用法:
//   node whale-night.mjs plan      生成今天的计划（写 ~/.dsh/whale-night.json + 事件）
//   node whale-night.mjs clock     常驻：算计划 → 到点退出（WHALE_WAKE）/ 次数用完（WHALE_DONE）
//   node whale-night.mjs decide --skip [--reason "…"] --wake none|all|2,3|--think
//                                  --reason 可选（2026-10-20 主人定：她不喜欢被要求解释理由 ✓）
//                                  她自己决定「这次不看」，并顺带安排今天**后面几次**要不要叫醒她
//   node whale-night.mjs decide --watch | decide --wake all
//                                  她自己决定「看」/ 临时改主意（取消"别叫"）
//   node whale-night.mjs mark      写"今晚醒过"的标记（给 Windows 计划任务兜底用：DSH 关着时也能留痕）
//   node whale-night.mjs status    看配置 / 今天的计划 / 剩余唤醒机会 / 她说过别叫的那几次
//   node whale-night.mjs clock --test [秒]   自测：不走配置窗口，几秒后退出叫醒
//
// 配置（~/.dsh/bili-whale.config.json 的 night 段，缺字段用默认值）：
//   {
//     "windows": [ {"start":"07:00","end":"09:00","wakes":1}, {"start":"17:00","end":"18:00","wakes":1} ],
//     "maxWakesPerDay": 2,
//     "maxVideos": 5
//   }
//   兼容旧配置：没有 windows 时，用 windowStart/windowEnd 当成"一个窗口"。
//
// 设计原则（2026-10-14 起，2026-10-17 扩成多窗口，2026-10-20 改"看不看"）：
//   · **窗口固定，时刻随机但均分** —— 机器才准点 ✗。同一窗口的 N 趟把窗口均分成 N 段，
//     每趟只在自己那一段里随机（2026-10-20 主人反馈：以前几次会挤在一起）；
//     再兜一条最小间隔 night.minGapMinutes（默认 30 分钟）✓
//   · **窗口 = 一次醒来的机会**，但**每天合计 ≤ maxWakesPerDay**（默认 = 窗口数，硬上限 3）——
//     窗口可以设四个，但不能醒四次（每次醒来都是一笔真开销）。
//   · **看不看，她自己定**（2026-10-20 主人定）—— 不再掷 skipChance 骰子 ✗。
//     而且「看不看」和「要不要被叫醒」**绑在一起**：她这一次说不想看 → 顺带回答今天后面几次还叫不叫她；
//     说"别叫"的那几次直接跳过、不唤醒她（免得吵醒她只为了问一句"看不看"）；说"叫"或者"还要想"的就叫醒。
//     任何时候都能改主意（`decide --watch` / `decide --wake all`）✓
//   · **有上限** —— 条数 + 分钟数写死在配置里，防烧白饭。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const STATE = path.join(HOME, '.dsh', 'whale-night.json')
const MARK = path.join(HOME, '.dsh', 'whale-wake')
const CFG = path.join(HOME, '.dsh', 'whale-night.config.json')
// 作息默认值来自统一配置（lib/config.mjs）；本文件自己的 whale-night.config.json 仍可覆盖
const DEFAULTS = { ...config().night }

const argv = process.argv.slice(2)
const cmd = argv[0]
const TEST = argv.includes('--test')
const testSecs = TEST ? Number(argv[argv.indexOf('--test') + 1] ?? 5) : 0

const load = (f, dflt) => { try { return { ...dflt, ...JSON.parse(fs.readFileSync(f, 'utf8')) } } catch { return { ...dflt } } }
const save = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const parseHHMM = (s) => { const [h, m] = String(s).split(':').map(Number); return (h === 24 ? 1440 : h * 60) + (m || 0) }
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = load(CFG, DEFAULTS)

// 窗口：优先 windows[]；没有就退回 windowStart/windowEnd 一个窗口（兼容旧配置）
// 每个窗口自带 wakes（醒来几次，2026-10-18 主人定）；0 = 这个窗口不醒 ✓
function windowsOf(c) {
  const list = Array.isArray(c.windows) && c.windows.length
    ? c.windows
    : [{ start: c.windowStart ?? '20:00', end: c.windowEnd ?? '24:00', wakes: c.maxWakesPerDay ?? 1 }]
  return list
    .map((w) => ({
      start: parseHHMM(w.start),
      end: parseHHMM(w.end),
      label: `${w.start}–${w.end}`,
      wakes: Math.max(0, Number(w.wakes ?? 1) || 0),
    }))
    .filter((w) => w.end > w.start)
}
const WINDOWS = windowsOf(cfg)
// 总次数 = 各窗口之和；一个窗口都没配次数 → 退回 maxWakesPerDay（旧配置）→ 再退回窗口数
const MAX_WAKES = Math.min(
  12,
  Math.max(0, WINDOWS.reduce((s, w) => s + w.wakes, 0) || Number(cfg.maxWakesPerDay ?? WINDOWS.length) || WINDOWS.length),
)

const st = load(STATE, {})
const wakesToday = (s) => (s.date === today() ? Number(s.wakes ?? 0) : 0)
// 2026-10-20：旧状态文件只记了 wakes、没记 usedCount（上一版把 done 写成 { date, action, wakes, reason }）
//   → 直接读会得到"今天还剩几次"的错数 ✗。这里按"前 N 次机会已经用掉"把它还原出来 ✓
const usedOf = (s) => {
  if (s.date !== today()) return {}
  if (s.usedCount && typeof s.usedCount === 'object') return { ...s.usedCount }
  const n = Math.max(0, Number(s.wakes ?? 0))
  const used = {}
  for (const x of DAY_SLOTS.slice(0, n)) used[x.label] = (used[x.label] ?? 0) + 1
  return used
}
const sumUsed = (used) => Object.values(used).reduce((a, b) => a + Number(b || 0), 0)
const vetoOf = (s) => (s.date === today() && Array.isArray(s.veto) ? s.veto.map(Number) : [])
const vetoedSlotsOf = (s) => (s.date === today() && Array.isArray(s.vetoedSlots) ? s.vetoedSlots.map(Number) : [])

// 今天所有"唤醒机会"，编号固定 —— **#N = 今天的第 N 次唤醒**（按窗口先后、每个窗口 wakes 次）
// 编号与"现在几点"无关：她回答时用的 #2/#3，过几分钟再排也还是同一趟 ✓
const DAY_SLOTS = (() => {
  const out = []
  for (const w of [...WINDOWS].sort((a, b) => a.start - b.start)) {
    for (let i = 1; i <= w.wakes; i += 1) out.push({ ordinal: out.length + 1, label: w.label, nth: i, of: w.wakes })
  }
  return out
})()

/**
 * 今天还剩哪些"唤醒机会"（窗口没过完 + 该窗口里那一趟还没用掉）。
 * 2026-10-20 主人定：「看不看」和「要不要被叫醒」绑在一起 ——
 *   她这一次选择不看之后，要顺带安排今天后面几次还叫不叫她 ✓
 */
function remainingSlots(s = st) {
  const used = usedOf(s)
  const now = nowMin()
  return DAY_SLOTS.filter((x) => {
    const w = WINDOWS.find((v) => v.label === x.label)
    return !!w && w.end > now && (used[x.label] ?? 0) < x.nth
  })
}

function makePlan(base = st) {
  const now = nowMin()
  const done = wakesToday(base)
  const used = usedOf(base)
  const veto = vetoOf(base)
  const vetoedSlots = vetoedSlotsOf(base)
  // 2026-10-20 晚：这个窗口"剩下几趟"的预排时刻（一趟一趟排的话第三趟会被挤到最后 ✗）
  const slotTimes = base.date === today() && base.slotTimes && typeof base.slotTimes === 'object' ? { ...base.slotTimes } : {}
  // ⚠️ 2026-10-20：done 也要带上 usedCount/veto/vetoedSlots —— 否则状态一变成 done 就
  //   "忘了今天用掉几次 / 吃过哪几趟"，她在同一天再跑 decide 会看到错的"还剩几次" ✗
  const doneState = (reason) => ({ date: today(), action: 'done', wakes: done, usedCount: used, veto, vetoedSlots, slotTimes, reason })
  // 2026-10-23 修：**还没落地的计划不要重排** —— 每 plan 一次就吃掉一个唤醒机会，
  //   插件重启（或两个 tick 撞一起）会把当晚剩下那一趟直接抹掉（实测：21:13 那趟被吃掉，当晚就不写日记 ✗）
  if (base.date === today() && base.action === 'wake' && base.fired !== true && Number(base.at ?? 0) > now) {
    return { ...base, reused: true }
  }
  if (MAX_WAKES === 0) return doneState('所有窗口的"醒来次数"都是 0 → 今天不醒')
  if (done >= MAX_WAKES) return doneState(`今天已经醒了 ${done} 次（上限 ${MAX_WAKES}）`)
  // 每次占一个"唤醒机会"：她说别叫的那几次直接吃掉（记进 vetoedSlots，改主意时能还回来 ✓）
  for (let guard = 0; guard < 64; guard += 1) {
    const rem = remainingSlots({ date: today(), usedCount: used })
    if (!rem.length) return doneState(vetuReason(veto) ?? '今天的窗口/次数都用完了')
    const s = rem[0]                                        // 最早的窗口先排（比随机更适合"连排几次"）
    used[s.label] = (used[s.label] ?? 0) + 1
    if (veto.includes(s.ordinal)) { vetoedSlots.push(s.ordinal); continue }   // 她说过别叫 → 吃掉，但不排
    const w = WINDOWS.find((x) => x.label === s.label) ?? WINDOWS[0]
    // ── 2026-10-20 晚（主人反馈：同一窗口里两次叫醒挨太近）────────────────────
    //   以前每次都在**整个窗口**里随机 → 两次可以只隔几分钟 ✗
    //   现在：**这个窗口剩下的几趟一起排**（存进 state.slotTimes），每趟落在自己那一格里
    //     · 窗口还早 → from = 窗口开始，均分成"还剩几趟"格 → 每格中间 60% 随机
    //     · 中途才启动 → from = max(现在, 上次叫醒+minGap) → 剩下的时间同样均分 ✓
    //   存下来是为了**三趟之间互相对齐**：不存的话每趟都按"现在"重算，第三趟会被挤到最后 ✗
    const minGap = Math.max(0, Number(cfg.minGapMinutes ?? 30))
    const lastWakeAt = base.date === today() ? Number(base.lastWakeAt ?? NaN) : NaN
    const sig = `${w.start}-${w.end}-${w.wakes}`
    let slot = slotTimes[s.label]
    const rebuild = !slot || slot.sig !== sig || !Array.isArray(slot.ats) || slot.startNth > s.nth || (slot.ats[s.nth - slot.startNth] ?? 0) <= now + 1
    if (rebuild) {
      const from0 = Math.max(now + 1, Number.isFinite(lastWakeAt) ? lastWakeAt + minGap : 0, w.start)
      const left = Math.max(1, w.wakes - (s.nth - 1))          // 含这一次还剩几趟
      const step0 = Math.max(1, (w.end - from0) / left)
      // 短窗口里"最小间隔"可能比每格还大 → 会把它顶到窗口末尾 ✗ → 按格长的 90% 收一收 ✓
      const gapUse = Math.min(minGap, Math.max(5, Math.round(step0 * 0.9)))
      const from = Math.max(from0, Number.isFinite(lastWakeAt) ? lastWakeAt + gapUse : 0)
      const step = Math.max(1, (w.end - from) / left)
      const ats = []
      for (let i = 0; i < left; i += 1) {
        const b = from + i * step
        // 每格里随机，但收在中间 60%（一趟的窗口整格随便挑 ✓）
        const jitter = Math.random() * Math.max(1, step * (left > 1 ? 0.6 : 0.98))
        ats.push(Math.min(w.end - 1, Math.round(b + jitter)))
      }
      slot = { sig, startNth: s.nth, ats }
      slotTimes[s.label] = slot
    }
    const idx = Math.min(slot.ats.length - 1, Math.max(0, s.nth - slot.startNth))
    let at = Number(slot.ats[idx] ?? now + 1)
    // 兜底：不贴着现在已经 / 不违反最小间隔（同样按格长收）/ 不越出窗口
    const gridStep = slot.ats.length > 1 ? Math.max(1, Math.abs(slot.ats[1] - slot.ats[0])) : Math.max(1, w.end - w.start)
    const gapUse = Math.min(minGap, Math.max(5, Math.round(gridStep * 0.9)))
    const floor = Math.max(now + 1, Number.isFinite(lastWakeAt) ? lastWakeAt + gapUse : 0)
    if (at < floor && floor < w.end - 1) at = floor
    if (at <= now) at = Math.min(w.end - 1, now + 1 + Math.floor(Math.random() * 5))
    if (at >= w.end) at = w.end - 1
    return {
      date: today(), action: 'wake', at, atText: hhmm(at), wakes: done, usedCount: used,
      window: s.label, withinWindow: `${s.label} 第 ${s.nth}/${s.of} 次`, atOrdinal: s.ordinal,
      // 记下这次排的时刻 —— 下一次 plan 用它算"最小间隔"，也方便 status 里看 ✓
      lastWakeAt: at,
      slotTimes,
      veto, vetoedSlots, roll: 'watch', decision: 'pending', maxVideos: cfg.maxVideos ?? 5, createdAt: new Date().toISOString(),
    }
  }
  return doneState('剩下的唤醒机会都被她自己取消了')
}

/** 给"排完了"写一句人话：能分辨出是被她取消的还是窗口过完了 */
function vetuReason(veto) {
  if (!veto.length) return null
  return `今天剩下的唤醒机会她都说过别叫（#${veto.join('、#')}）`
}

function logEvent(kind, note) {
  try {
    fs.mkdirSync(path.join(HOME, '.dsh'), { recursive: true })
    fs.appendFileSync(path.join(HOME, '.dsh', 'whale-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), kind, target: null, note }) + '\n')
  } catch {}
}

const winText = () => WINDOWS.map((w) => w.label).join(' · ')

if (cmd === 'plan') {
  const p = makePlan()
  save(STATE, p)
  logEvent('night-plan', p.action === 'wake'
    ? `今天 ${p.atText} 醒来（窗口 ${p.window}）· 看不看由她自己定`
    : `不排了：${p.reason}`)
  console.log(JSON.stringify(p, null, 2))
  process.exit(0)
}

if (cmd === 'decide') {
  // 2026-10-20 主人定：**看不看由她自己定**，而且「看不看」和「要不要被叫醒」绑在一起 ✓
  //   她这次选择不看 → 顺带安排今天**后面几次**还叫不叫她（不想看的那次干脆别吵醒她）：
  //       --wake none   今天后面别叫了
  //       --wake all    都叫（想看/想再想想）
  //       --wake 2,4    只在第 2、4 次叫醒我
  //       --think       下一次叫醒我，到时候再决定
  //   不给答案 = 还没回答 → 把"还剩哪几次"列出来追问（这是设计，不是报错 ✓）
  //   也可以随时改主意：decide --watch / decide --wake all
  const skip = argv.includes('--skip')
  const watch = argv.includes('--watch')
  const think = argv.includes('--think')
  const ri = argv.indexOf('--reason')
  const reason = ri >= 0 ? String(argv[ri + 1] ?? '').trim() : ''
  const wi = argv.indexOf('--wake')
  const wakeArg = wi >= 0 ? String(argv[wi + 1] ?? '').trim().toLowerCase() : ''

  const cur = load(STATE, {})
  const rem = remainingSlots(cur)
  const fmtSlots = (list) => list.map((s) => `#${s.ordinal}  ${s.label} 第 ${s.nth}/${s.of} 次`).join('\n')

  if (!skip && !watch && !wakeArg && !think) {
    console.error('用法:\n  decide --skip --wake none|all|2,3      （--reason "…" 可选：她不喜欢解释理由 ✓）\n  decide --skip --think\n  decide --watch            （改主意：今天剩下的都叫醒我）\n  decide --wake all         （只取消之前的"别叫"）')
    process.exit(2)
  }
  // 2026-10-20 主人定：「不看」**可以不给理由** —— 她说了她不喜欢被要求解释 ✓
  //   （以前这里强制 ≥4 字；现在 --reason 完全可选，给了才会记进事件流）

  // 需要她回答"后面还要不要被叫醒"时：没答案就把剩下的次数摆出来（追问）
  let wakeSet = null
  if (skip) {
    if (think) wakeSet = rem.length ? [rem[0].ordinal] : []
    else if (wakeArg === 'none') wakeSet = []
    else if (wakeArg === 'all') wakeSet = rem.map((s) => s.ordinal)
    else if (wakeArg) wakeSet = wakeArg.split(/[,，\s]+/).map((x) => Number(String(x).replace('#', ''))).filter((n) => Number.isFinite(n))
    if (wakeSet === null) {
      if (!rem.length) wakeSet = []      // 今天没有更多机会了 → 不用问
      else {
        console.error(`今天还剩 ${rem.length} 次唤醒机会：\n${fmtSlots(rem)}\n`)
        console.error('你这次不想看 —— 那今天后面这几次还叫醒你吗？回答一个：')
        console.error('  --wake none      后面都别叫我（安静到明天）')
        console.error('  --wake all       都叫（想接着看，或者到时候再想）')
        console.error('  --wake 2,4       只在第 2、4 次叫醒我')
        console.error('  --think          下一次叫醒我，我到时再决定')
        process.exit(2)
      }
    }
  }

  // veto = 今天剩下的机会里，她明确说"别叫"的那些编号
  const veto = skip ? rem.filter((s) => !wakeSet.includes(s.ordinal)).map((s) => s.ordinal) : []

  // 2026-10-20：**改主意要能还回来** —— 上一轮因为她"别叫"而被吃掉的唤醒机会，
  //   这次没被重新 veto 的，把 usedCount 还回去（她被叫醒过的次数不受影响 ✓）
  const used = usedOf(cur)
  const oldVetoed = vetoedSlotsOf(cur)
  for (const o of oldVetoed) {
    if (veto.includes(o)) continue
    const s = DAY_SLOTS.find((x) => x.ordinal === o)
    if (s) used[s.label] = Math.max(0, (used[s.label] ?? 0) - 1)
  }

  const decidedAt = new Date().toISOString()
  // 立刻按她的回答重排（"叫"的那趟马上排上；全"别叫"就直接 done ✓）
  const planned = makePlan({ ...cur, date: today(), usedCount: used, veto, vetoedSlots: [] })
  const next = { ...planned, decision: skip ? 'skip' : 'watch', decidedAt, veto: planned.veto ?? veto }
  if (skip && reason) next.decisionReason = reason   // 理由是可选的（她不喜欢被要求解释 ✓）
  if (next.action !== 'done') next.reason = reason || next.reason
  save(STATE, next)
  logEvent('night-decision', skip
    ? `这次不看${reason ? '：' + reason : '（没写理由）'}${rem.length ? ` · 今天还要被叫醒：${wakeSet.length ? wakeSet.map((n) => '#' + n).join('、') : '不叫（安静到明天）'}` : ''}`
    : '今晚看（/ 改主意：后面都叫醒我）')
  if (!argv.includes('--json')) {
    console.log(skip
      ? `记下了：这次不看${reason ? `（${reason}）` : ''}。今天剩下的 ${rem.length} 次唤醒里，会叫醒你的：${wakeSet && wakeSet.length ? wakeSet.map((n) => '#' + n).join('、') : '（没有了，安静到明天）'}`
      : `记下了：今晚看${veto.length ? `（取消之前 ${veto.length} 次"别叫"）` : ''}`)
    if (next.action === 'wake') console.log(`下一次叫醒：${next.atText}（${next.withinWindow}）`)
    else if (next.action === 'done') console.log(`今天不再叫醒：${next.reason ?? ''}`)
  }
  console.log(JSON.stringify(next, null, 2))
  process.exit(0)
}

if (cmd === 'mark') {
  save(MARK, { date: today(), at: new Date().toISOString(), by: 'windows-task' })
  console.log(`已留标记：${MARK}（${today()}）`)
  process.exit(0)
}

if (cmd === 'status') {
  const p = load(STATE, {})
  const m = load(MARK, {})
  const done = wakesToday(p)
  console.log(`配置: 窗口 ${winText()} | 今天最多醒 ${MAX_WAKES} 次 | 看不看：她自己决定（不再掷骰子 ✓） | 一次初筛 ${cfg.maxVideos ?? 5} 条`)
  const uc = p.date === today() && p.usedCount && typeof p.usedCount === 'object' ? p.usedCount : {}
  const wdesc = WINDOWS.map((w) => `${w.label}×${w.wakes}${uc[w.label] ? `（已用 ${uc[w.label]}）` : ''}`).join(' · ')
  console.log(`今天已醒: ${done}/${MAX_WAKES} · 各窗口: ${wdesc || '(无)'}`)
  const rs = remainingSlots(p)
  const vt = vetoOf(p)
  console.log(`今天还剩 ${rs.length} 次唤醒机会${rs.length ? '：' + rs.map((s) => `#${s.ordinal}(${s.label} 第 ${s.nth}/${s.of} 次)`).join(' ') : ''}`)
  if (vt.length) console.log(`她自己说过别叫的：${vt.map((n) => '#' + n).join('、')}（会直接跳过、不吵她 ✓）`)
  console.log(`当前的计划: ${p.date ?? '(无)'} → ${p.action ?? '(未生成)'}${p.atText ? ' @ ' + p.atText : ''}${p.window ? '（窗口 ' + p.window + (p.withinWindow ? ' · ' + p.withinWindow : '') + '）' : ''}${p.reason ? '（' + p.reason + '）' : ''}`)
  console.log(`兜底标记: ${m.date ?? '(无)'}${m.date && m.date !== today() ? `  ← 有 ${m.date} 的标记（那晚 DSH 可能关着）` : ''}`)
  process.exit(0)
}

if (cmd === 'clock') {
  if (TEST) {
    console.log(`[test] 模拟生物钟：${testSecs} 秒后退出叫醒…`)
    await sleep(testSecs * 1000)
    save(STATE, { ...load(STATE, {}), date: today(), action: 'wake', at: nowMin(), atText: hhmm(nowMin()), woke: true, test: true })
    logEvent('night-wake', '[test] 生物钟自测')
    console.log('WHALE_WAKE at=' + hhmm(nowMin()) + ' (test)')
    process.exit(0)
  }
  // ⚠️ 重新算计划的三种情况（不修就会死循环 ✗）：
  //   ① 跨天了 / 没计划 ② 上一趟已经醒了（woke=true）→ 该排下一趟 ③ 上一趟是 skip 且已到窗口末（done=true）
  let p = load(STATE, {})
  const stale = p.date !== today() || !p.action || p.woke === true || p.done === true
  if (stale) {
    p = makePlan(); save(STATE, p)
    logEvent('night-plan', p.action === 'wake' ? `${p.atText} 看视频（窗口 ${p.window}${p.withinWindow ? ' · ' + p.withinWindow : ''}）` : `不醒：${p.reason}`)
  }
  console.log(`[生物钟] 这一趟：${p.action}${p.atText ? ' @ ' + p.atText : ''}${p.window ? '（窗口 ' + p.window + (p.withinWindow ? ' · ' + p.withinWindow : '') + '）' : ''}${p.reason ? '（' + p.reason + '）' : ''}`)

  // 次数用完 / 窗口都过了：立刻退出（不睡），让她知道"今天到此为止"
  if (p.action === 'done' || p.action === 'already') {
    console.log('WHALE_DONE ' + (p.reason ?? ''))
    process.exit(0)
  }

  if (p.action === 'skip') {
    // 2026-10-20：plan 已经不再产生 skip（看不看由她定 ✓）——
    //   这一段只留给**旧状态文件 / 旧版计划任务**，别删（删了跨版本升级时会退化成"叫不醒"）
    const end = Number(p.endAt) || (WINDOWS[WINDOWS.length - 1]?.end ?? nowMin())
    const waitMin = Math.max(0, end - nowMin())
    console.log(`[生物钟] 旧版「不看」计划：${waitMin} 分钟后退出（窗口 ${p.window ?? ''} 末）`)
    for (let i = 0; i < waitMin * 60; i += 60) await sleep(60_000)
    save(STATE, { ...p, done: true })
    console.log('WHALE_SKIP ' + (p.reason ?? ''))
    process.exit(0)
  }

  // 看：睡到随机点
  while (nowMin() < p.at) {
    const left = (p.at - nowMin()) * 60_000
    await sleep(Math.min(60_000, Math.max(5_000, left)))
  }
  const woke = { ...p, woke: true, wakes: wakesToday(p) + 1, wokeAt: new Date().toISOString() }
  save(STATE, woke)
  logEvent('night-wake', `生物钟叫醒（第 ${woke.wakes} 次 · 计划 ${p.atText}）`)
  console.log(`WHALE_WAKE at=${p.atText} wake=${woke.wakes}/${MAX_WAKES} maxVideos=${cfg.maxVideos ?? 5}${p.withinWindow ? ` slot=${p.withinWindow}` : ''}`)
  process.exit(0)
}

console.log('用法: node whale-night.mjs plan | clock [--test 5] | mark | status')
