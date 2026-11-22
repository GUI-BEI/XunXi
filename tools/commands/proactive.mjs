// 主动联系（2026-11-22）——"有想法就聊，没想法就不聊"
//
// 先说清楚**它不是配额制**：
//   dailyMax 是**天花板**，不是"今天必须发 5 条"。没有想法 → 今天一条都不发，完全正常。
//   候选必须能说出"我因为什么想说这句话"；说不出就不发。
//
// 参考 astrbot_plugin_private_companion 的 proactive 思路（事件→候选→预算→去重→投递），
//   但只借骨架：它 15 类事件里我们只用**真实发生过的**（台账念头 / 刚读完 / 刚看完 / 日记情绪）。
//   天气、新闻、吃饭、余额那类它靠外部定时器撑起来的"规律"，我们不要。
//
// 用法：
//   node bili.mjs proactive scan            # 现在有没有想法；有就列出候选（不发送）
//   node bili.mjs proactive scan --json     # 给调度器看
//   node bili.mjs proactive record --from "三体 第 62 块" --note "我发的那句话"
//   node bili.mjs proactive status          # 今天发了几条、还剩几条、安静时段
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = path.join(HOME, '.dsh')
const LIFE = path.join(DSH, 'life.json')
const LOG = path.join(DSH, 'whale-log.jsonl')
const STATE = path.join(DSH, 'proactive.json')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'scan'
const getOpt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }

const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DSH, 'bili-whale.config.json'), 'utf8')).proactive ?? {} } catch { return {} }
})()
const DAILY_MAX = Number(cfg.dailyMax ?? 5)
const MIN_GAP_H = Number(cfg.minGapHours ?? 4)
const QUIET = String(cfg.quiet ?? '23:30-08:00')
const DAYS = Array.isArray(cfg.days) && cfg.days.length ? cfg.days.map((d) => String(d).toLowerCase()) : ['sat', 'sun']
const DEDUPE_DAYS = Number(cfg.dedupeDays ?? 7)

const now = new Date()
const dayKey = now.toLocaleDateString('sv-SE')
const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }
const state = readJson(STATE, { sent: [], seen: {} })
state.sent = Array.isArray(state.sent) ? state.sent : []
state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {}
state.offered = state.offered && typeof state.offered === 'object' ? state.offered : {}

const todaySent = state.sent.filter((s) => String(s.at).slice(0, 10) === dayKey)
const lastAt = state.sent.length ? new Date(state.sent[state.sent.length - 1].at) : null
const gapOk = !lastAt || (now.getTime() - lastAt.getTime()) >= MIN_GAP_H * 3600 * 1000

function inQuiet() {
  const m = QUIET.split('-').map((x) => x.trim())
  const toMin = (t) => { const [h, mm] = t.split(':').map(Number); return h * 60 + (mm || 0) }
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = toMin(m[0]), e = toMin(m[1])
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)   // 跨午夜
}

const dayOk = DAYS.includes(dayName)
const quotaLeft = Math.max(0, DAILY_MAX - todaySent.length)

// ── 候选 ─────────────────────────────────────────────
function candidates() {
  const out = []
  const life = readJson(LIFE, {})
  // ① 待用念头：跨天也留着（它有自己的 expiresAt；过期才消失）
  for (const t of (life.thoughts ?? [])) {
    if (t.usedAt) continue
    if (t.expiresAt && Date.parse(t.expiresAt) < Date.now()) continue
    const h = crypto.createHash('sha1').update(String(t.text ?? '')).digest('hex').slice(0, 10)
    out.push({ key: `think:${h}`, from: t.from || '一个念头', text: t.text, kind: 'think' })
  }
  // ② 最近 12 小时真实发生过的事（读完一块 / 看完一段视频）
  const since = Date.now() - 12 * 3600 * 1000
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n') } catch {}
  for (const line of lines.slice(-40)) {
    try {
      const e = JSON.parse(line)
      if (Date.parse(e.at) < since) continue
      if (!['novel-read', 'wake-watch', 'longwatch-seg', 'life-first'].includes(e.kind)) continue
      const h = crypto.createHash('sha1').update(String(e.note ?? '')).digest('hex').slice(0, 10)
      out.push({ key: `log:${h}`, from: e.kind === 'novel-read' ? '刚读完的那块书' : '刚看完的那段视频', text: String(e.note ?? '').slice(0, 120), kind: 'event' })
    } catch {}
  }
  return out
}

function freshOnes(list) {
  const seenText = new Set()
  const keep = []
  for (const c of list) {
    const seenAt = state.seen[c.key]
    if (seenAt && Date.now() - Date.parse(seenAt) < DEDUPE_DAYS * 24 * 3600 * 1000) continue
    const offAt = state.offered[c.key]
    if (offAt && Date.now() - Date.parse(offAt) < 12 * 3600 * 1000) continue   // 提醒过就别反复戳她
    if (state.sent.some((s) => s.key === c.key)) continue
    if (seenText.has(c.text)) continue
    seenText.add(c.text)
    keep.push(c)
  }
  return keep
}

if (cmd === 'scan') {
  const all = freshOnes(candidates())
  const blockers = []
  if (!dayOk) blockers.push(`今天不是主动联系日（只在 ${DAYS.join('/')}）`)
  if (inQuiet()) blockers.push(`安静时段 ${QUIET}`)
  if (quotaLeft <= 0) blockers.push(`今天已经发了 ${todaySent.length} 条（上限 ${DAILY_MAX}）`)
  if (!gapOk) blockers.push(`离上一条不足 ${MIN_GAP_H} 小时`)

  if (getOpt('json') !== undefined || argv.includes('--json')) {
    console.log(JSON.stringify({ ok: blockers.length === 0 && all.length > 0, blockers, quotaLeft, candidates: all.slice(0, 5), dayOk, quiet: inQuiet() }))
    process.exit(0)
  }

  console.log(`主动联系 · ${dayKey}（${dayName}）· 今天已发 ${todaySent.length}/${DAILY_MAX}`)
  if (blockers.length) { console.log('\n现在不发：'); for (const b of blockers) console.log('  · ' + b); }
  if (!all.length) { console.log('\n现在没有想法 —— **一条都不发是正常的**（这里不是配额）✓'); process.exit(0) }
  if (!blockers.length) {
    console.log('\n现在有想法可以说（有来源才列出来）：')
    for (const c of all.slice(0, 5)) console.log(`  · [${c.kind}] ${c.text}\n    来源：${c.from}`)
    console.log('\n想说就说；不想说就不说。发完记一笔：')
    console.log(`  node bili.mjs proactive record --from "<来源>" --note "你发的那句"`)
  }
  process.exit(0)
}

if (cmd === 'record') {
  const from = String(getOpt('from') ?? '')
  const note = String(getOpt('note') ?? '')
  if (!note) { console.error('要带 --note "你发给他的是什么"'); process.exit(2) }
  state.sent.push({ at: now.toISOString(), from, note: note.slice(0, 200), key: String(getOpt('key') ?? '') })
  if (argv.includes('--key')) { /* 已用 --key 值 */ }
  const k = getOpt('key')
  if (k) state.seen[k] = now.toISOString()
  fs.mkdirSync(DSH, { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n', 'utf8')
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: now.toISOString(), kind: 'proactive', target: null, note: `${from ? '来源：' + from + ' · ' : ''}${note.slice(0, 160)}` }) + '\n', 'utf8')
  } catch {}
  console.log(`记下了（今天 ${state.sent.filter((s) => String(s.at).slice(0, 10) === dayKey).length}/${DAILY_MAX}）`)
  process.exit(0)
}

if (cmd === 'offer') {
  const k = String(getOpt('key') ?? '')
  if (!k) { console.error('要带 --key'); process.exit(2) }
  state.offered[k] = now.toISOString()
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n', 'utf8')
  process.exit(0)
}

if (cmd === 'status') {
  console.log(`主动联系 · ${dayKey}（${dayName}）`)
  console.log(`  · 允许的日子：${DAYS.join(' / ')}${dayOk ? '（今天可以）' : '（今天不行）'}`)
  console.log(`  · 安静时段：${QUIET}${inQuiet() ? '（现在正在安静里）' : ''}`)
  console.log(`  · 今天已发：${todaySent.length} / ${DAILY_MAX}（这是**上限**，不是配额）`)
  console.log(`  · 距上一条：${lastAt ? Math.round((now - lastAt) / 60000) + ' 分钟' : '还没发过'}（最小间隔 ${MIN_GAP_H} 小时）`)
  process.exit(0)
}

console.error('用法: proactive scan|record|offer|status');
process.exit(2)
