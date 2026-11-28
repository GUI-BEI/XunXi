// 感悟 → 三个落点（2026-11-28）
//
// 设计：一个入口，三个可选的消费者。
//   感悟（insight）  ← 看完视频 / 读完一段 / 跟他聊完
//      ├─ 视频偏好（可检索的关键词） → feed 用它搜索 + 加分
//      ├─ 对话校准（可执行的说话方式）→ 唤醒 / 主动联系提示
//      └─ 成长（身份层面的变化）    → 唤醒提示的「现在的我」
//
// 判断口诀：能搜的是偏好，能照做的是对话，能定义我的是成长。
// 三个 -- 都可以省；省光就只留一句在日记里。
//
// 用法：
//   node bili.mjs insight "我不再把'不要'当成'不敢'" --from "张伟丽那几段" --growth
//   node bili.mjs insight "…" --from "…" --prefer "拳击访谈 / 张伟丽"
//   node bili.mjs insight "…" --from "…" --talk "他累的时候别追问，先给一句短的"
//   node bili.mjs insight list          # 看三个落点现在有什么
//   node bili.mjs insight prune         # 手动跑一次衰减/清理（feed 也会自动跑）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = path.join(HOME, '.dsh')
const PREFS = path.join(DSH, 'prefs.learned.json')
const TALK = path.join(DSH, 'talk.json')
const GROWTH = process.env.WHALE_GROWTH || path.join('D:', 'XunXi', 'GROWTH.md')

const MAX_PREFS = 30
const MAX_TALK = 5
const HALF_LIFE_DAYS = 60
const MIN_WEIGHT = 0.2

const KNOWN = new Set(['add', 'list', 'prune', 'json'])
const argv = process.argv.slice(2)
const rawCmd = argv[0]
const implicit = rawCmd && !KNOWN.has(rawCmd) ? 'add' : (rawCmd ?? 'list')
const cmd = implicit
if (implicit === 'add' && rawCmd && !KNOWN.has(rawCmd)) argv.unshift('add')
const words = []
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[k] = true
    else { opt[k] = v; i += 1 }
  } else words.push(a)
}
const text = (w) => w.join(' ').trim()
const today = () => new Date().toLocaleDateString('sv-SE')

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n', 'utf8') }

/** 视频偏好：{ items: [{ like|dislike, kw, from, at, weight }] } */
function loadPrefs() {
  const j = readJson(PREFS, { items: [] })
  return { items: Array.isArray(j.items) ? j.items : [] }
}
function decayPrefs(d) {
  const now = Date.now()
  const kept = []
  for (const it of d.items) {
    const days = Math.max(0, (now - Date.parse(it.at ?? it.from ?? new Date().toISOString())) / 86400000)
    const w = Number(it.weight ?? 1) * Math.pow(0.5, days / HALF_LIFE_DAYS)
    if (w >= MIN_WEIGHT) kept.push({ ...it, weight: Number(w.toFixed(3)) })
  }
  kept.sort((a, b) => b.weight - a.weight)
  return { items: kept.slice(0, MAX_PREFS) }
}
function loadTalk() {
  const j = readJson(TALK, { active: [], history: [] })
  return { active: Array.isArray(j.active) ? j.active : [], history: Array.isArray(j.history) ? j.history : [] }
}

function addPref(kind, kwText, from) {
  const d = decayPrefs(loadPrefs())
  const kws = String(kwText).split(/[\/、,，·]/).map((s) => s.trim()).filter(Boolean)
  for (const kw of kws) {
    if (kw.length < 2) continue
    const exists = d.items.find((x) => x.kw === kw)
    if (exists) { exists.weight = Math.min(3, Number(exists.weight ?? 1) + 0.5); exists.at = new Date().toISOString() }
    else d.items.push({ [kind]: true, kw, from: from ?? '', at: new Date().toISOString(), weight: 1 })
  }
  writeJson(PREFS, decayPrefs(d))
  return kws
}

function addTalk(txt, from) {
  const d = loadTalk()
  if (d.active.some((x) => x.text === txt)) return false
  d.active.push({ text: txt, from: from ?? '', at: new Date().toISOString() })
  while (d.active.length > MAX_TALK) {
    const dropped = d.active.shift()
    d.history.push({ ...dropped, droppedAt: new Date().toISOString(), why: '超过 5 条' })
  }
  writeJson(TALK, d)
  return true
}

function loadGrowth() {
  try {
    const raw = fs.readFileSync(GROWTH, 'utf8')
    const zone = raw.split(/^##\s*我是怎么变成这样的/m)[0]
    const items = zone.split(/\r?\n/).map((l) => l.match(/^\s*(?:[·\-*]|\d+[.、)])\s*(.+?)\s*$/)).filter(Boolean).map((m) => m[1])
    const histPart = (raw.split(/^##\s*我是怎么变成这样的/m)[1] ?? '')
    const hist = histPart.split(/\r?\n/).map((l) => l.match(/^\s*[-*]\s*(.+?)\s*$/)).filter(Boolean).map((m) => m[1])
    return { top: items.slice(0, MAX_TALK), hist }
  } catch { return { top: [], hist: [] } }
}

function addGrowth(txt, why) {
  const g = loadGrowth()
  g.hist.push(`${today()} · ${txt}${why ? `（因为：${why}）` : ''}`)
  if (g.top.length < MAX_TALK) g.top.push(txt)
  else {
    const dropped = g.top.shift()
    g.hist.push(`${today()} · （从"现在的我"沉下来）${dropped}`)
    g.top.push(txt)
  }
  const out = [
    '# 我的成长',
    '',
    '> 这里只写**我变了什么**（身份层面的变化），不写流水账。',
    '> **现在的我**最多 5 条（每次醒来都会带上它）。',
    '',
    '## 现在的我',
    ...g.top.map((x) => `· ${x}`),
    '',
    '## 我是怎么变成这样的',
    ...g.hist.map((x) => `- ${x}`),
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(GROWTH), { recursive: true })
  fs.writeFileSync(GROWTH, out, 'utf8')
}

switch (cmd) {
  case 'add': {
    const t = text(words)
    if (!t) { console.error('用法：insight "感悟" [--from 来源] [--prefer "关键词 / 关键词"] [--talk "怎么说"] [--growth]'); process.exit(2) }
    const from = typeof opt.from === 'string' ? opt.from : ''
    const did = []
    if (typeof opt.prefer === 'string') {
      const kws = addPref('like', opt.prefer, from || t.slice(0, 20))
      if (kws.length) did.push(`视频偏好：${kws.join('、')}`)
    }
    if (typeof opt.dislike === 'string') {
      const kws = addPref('dislike', opt.dislike, from || t.slice(0, 20))
      if (kws.length) did.push(`视频避雷：${kws.join('、')}`)
    }
    if (typeof opt.talk === 'string') {
      // 交给 talk.mjs：那边有 core/pool 两层 + 相似替换逻辑
      try {
        const out = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'talk.mjs'), 'add', opt.talk, '--from', from || t.slice(0, 20)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        const first = String(out).trim().split('\n').filter(Boolean).pop() ?? ''
        did.push('对话校准：' + first)
      } catch (e) { did.push('对话校准写入失败：' + String(e.message).slice(0, 60)) }
    }
    if (opt.growth) {
      // 交给 growth.mjs：那边有 core/history 两层 + 相似替换
      try {
        const out = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'growth.mjs'), 'add', t, '--because', from || t.slice(0, 20)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        did.push('成长档案：' + String(out).trim().split('\n').filter(Boolean).pop())
      } catch (e) { did.push('成长写入失败：' + String(e.message).slice(0, 60)) }
    }
    console.log(`感悟：${t}`)
    if (did.length) { console.log('落到：'); for (const x of did) console.log('  · ' + x) }
    else console.log('（这条只留在日记里 —— 没落到三处，也完全可以 ✓）')
    break
  }

  case 'list': {
    const p = decayPrefs(loadPrefs())
    const k = loadTalk()
    const g = loadGrowth()
    console.log('视频偏好（feed 用）：')
    if (!p.items.length) console.log('  （空着）')
    for (const it of p.items.slice(0, 10)) console.log(`  ${it.dislike ? '✗' : '✓'} ${it.kw}  w=${it.weight}${it.from ? `  来自：${it.from}` : ''}`)
    console.log('\n对话校准（唤醒/主动联系时注入）：')
    if (!k.active.length) console.log('  （空着）')
    for (const it of k.active) console.log(`  · ${it.text}${it.from ? `（来自 ${it.from}）` : ''}`)
    console.log('\n成长（现在的我）：')
    if (!g.top.length) console.log('  （空着）')
    for (const x of g.top) console.log(`  · ${x}`)
    break
  }

  case 'prune': {
    const before = loadPrefs().items.length
    writeJson(PREFS, decayPrefs(loadPrefs()))
    const after = loadPrefs().items.length
    console.log(`视频偏好衰减：${before} → ${after} 条（半衰期 ${HALF_LIFE_DAYS} 天，低于 ${MIN_WEIGHT} 清掉）`)
    break
  }

  case 'json': {
    console.log(JSON.stringify({ prefs: decayPrefs(loadPrefs()), talk: loadTalk(), growth: loadGrowth() }))
    break
  }

  default:
    console.error('用法: insight add|list|prune|json')
    process.exit(2)
}
