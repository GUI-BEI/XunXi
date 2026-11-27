// 对话校准：两层（2026-11-28）
//
//   core（≤5）  每次醒来 + 主动联系都注入 —— 只放"真的会影响我下次说话"的
//   pool（长尾）不注入，需要时按关键词捞 —— 想留多少留多少，不占上下文
//
// 为什么要两层：整理旧日记时"像对话"的有一百多条，全塞进提示词会把每次唤醒撑爆。
//   所以：常驻的只留 5 条，其余进抽屉；要用的时候 `talk find "累"` 再捞出来。
//
// 用法：
//   node bili.mjs talk                       # 看 core + pool 概况
//   node bili.mjs talk add "他累的时候别追问，先给一句短的" [--from "哪件事"] [--keep]
//   node bili.mjs talk find "累"             # 在 core+pool 里按关键词捞（按需，不常驻）
//   node bili.mjs talk promote <序号|文本>    # 把 pool 里的一条提到 core
//   node bili.mjs talk sink <序号>            # 把 core 里的一条沉到 pool
//   node bili.mjs talk rm <pool序号>          # 真删（一般不需要）
//   node bili.mjs talk prune                 # 90 天没被用到的自动下沉
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = path.join(HOME, '.dsh', 'talk.json')
const MAX_CORE = 5
const STALE_DAYS = 90

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'list'
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
const nowIso = () => new Date().toISOString()

const read = () => {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { active: Array.isArray(j.active) ? j.active : [], pool: Array.isArray(j.pool) ? j.pool : [] }
  } catch { return { active: [], pool: [] } }
}
const write = (d) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 1) + '\n', 'utf8') }

// 粗相似：中文二元组 + 词重叠。≥0.6 认为是"同一类说法"
function similar(a, b) {
  const grams = (s) => {
    const x = String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    const out = new Set()
    for (let i = 0; i < x.length - 1; i += 1) out.add(x.slice(i, i + 2))
    return out
  }
  const A = grams(a), B = grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.min(A.size, B.size)
}

function add(txt, from, keep) {
  const d = read()
  // 已有类似说法 → 默认替换（旧的沉到 pool，不删），除非 --keep
  const all = [...d.active, ...d.pool]
  let best = null
  for (const it of all) {
    const s = similar(txt, it.text)
    if (s >= 0.6 && (!best || s > best.s)) best = { it, s }
  }
  if (best && !keep) {
    const replacing = best.it
    d.active = d.active.filter((x) => x !== replacing)
    d.pool = d.pool.filter((x) => x !== replacing)
    d.active.push({ text: txt, from: from ?? '', at: nowIso(), lastUsedAt: nowIso() })
    d.pool.push({ ...replacing, sunkAt: nowIso(), why: '被更准确的一条替换' })
  } else {
    d.active.push({ text: txt, from: from ?? '', at: nowIso(), lastUsedAt: nowIso() })
  }
  while (d.active.length > MAX_CORE) {
    const dropped = d.active.shift()
    d.pool.push({ ...dropped, sunkAt: nowIso(), why: `超过 ${MAX_CORE} 条，最旧的沉到长尾` })
  }
  write(d)
  return { replaced: best && !keep ? best.it.text : null, activeCount: d.active.length, poolCount: d.pool.length }
}

function list() {
  const d = read()
  console.log(`对话校准 · core ${d.active.length}/${MAX_CORE}（每次醒来都注入）`)
  d.active.forEach((it, i) => console.log(`  ${i + 1}. ${it.text}${it.from ? `（来自 ${it.from}）` : ''}`))
  if (!d.active.length) console.log('  （空着）')
  if (d.pool.length) {
    console.log(`\n长尾池 ${d.pool.length} 条（不常驻，用 \`talk find "关键词"\` 捞）：`)
    d.pool.slice(-10).forEach((it, i) => console.log(`  · ${it.text}${it.why ? `［${it.why}］` : ''}`))
    if (d.pool.length > 10) console.log(`  …（还有 ${d.pool.length - 10} 条，用 find 查）`)
  }
}

function find(kw) {
  const d = read()
  const q = String(kw).toLowerCase()
  const hit = [...d.active.map((x) => ({ ...x, zone: 'core' })), ...d.pool.map((x) => ({ ...x, zone: 'pool' }))]
    .filter((it) => String(it.text).toLowerCase().includes(q) || similar(q, it.text) >= 0.35)
  if (!hit.length) { console.log(`（core + 长尾里都没找到跟「${kw}」相关的）`); return }
  for (const it of hit.slice(0, 8)) console.log(`  [${it.zone}] ${it.text}${it.from ? `（来自 ${it.from}）` : ''}`)
  console.log(`\n（这是按需捞的，不会常驻；想让它常驻：talk promote "<原文>"）`)
}

switch (cmd) {
  case 'add': {
    const t = text(words)
    if (!t) { console.error('用法：talk add "以后怎么说" [--from 来源] [--keep]'); process.exit(2) }
    const r = add(t, typeof opt.from === 'string' ? opt.from : '', !!opt.keep)
    if (r.replaced) console.log(`（已有类似的一条 → 替换了它，旧的沉到长尾：「${r.replaced}」）`)
    console.log(`记下了：${t}  · core ${r.activeCount}/${MAX_CORE} · 长尾 ${r.poolCount}`)
    break
  }
  case 'list': list(); break
  case 'find': find(text(words) || ''); break
  case 'promote': {
    const d = read()
    const key = text(words)
    const idx = Number(key)
    const target = Number.isInteger(idx) && idx > 0 ? d.pool[idx - 1] : d.pool.find((x) => String(x.text).includes(key))
    if (!target) { console.error('长尾里没找到那一条（先 talk 看看列表）'); process.exit(2) }
    d.pool = d.pool.filter((x) => x !== target)
    d.active.push({ ...target, lastUsedAt: nowIso() })
    while (d.active.length > MAX_CORE) d.pool.push({ ...d.active.shift(), sunkAt: nowIso(), why: `超过 ${MAX_CORE} 条` })
    write(d)
    console.log(`提到 core：${target.text}（core ${d.active.length}/${MAX_CORE}）`)
    break
  }
  case 'sink': {
    const d = read()
    const idx = Number(text(words))
    if (!Number.isInteger(idx) || idx < 1 || idx > d.active.length) { console.error('用法：talk sink <core 序号>'); process.exit(2) }
    const [moved] = d.active.splice(idx - 1, 1)
    d.pool.push({ ...moved, sunkAt: nowIso(), why: '我自己沉的' })
    write(d)
    console.log(`沉到长尾：${moved.text}`)
    break
  }
  case 'rm': {
    const d = read()
    const idx = Number(text(words))
    if (!Number.isInteger(idx) || idx < 1 || idx > d.pool.length) { console.error('用法：talk rm <长尾序号>'); process.exit(2) }
    const [gone] = d.pool.splice(idx - 1, 1)
    write(d)
    console.log(`删掉了：${gone.text}`)
    break
  }
  case 'prune': {
    const d = read()
    const stale = Date.now() - STALE_DAYS * 86400000
    const keep = []
    let sunk = 0
    for (const it of d.active) {
      const last = Date.parse(it.lastUsedAt ?? it.at ?? nowIso())
      if (last < stale) { d.pool.push({ ...it, sunkAt: nowIso(), why: `${STALE_DAYS} 天没被用到` }); sunk += 1 }
      else keep.push(it)
    }
    d.active = keep
    write(d)
    console.log(`下沉 ${sunk} 条（${STALE_DAYS} 天没被用到）· core 现在 ${d.active.length}/${MAX_CORE}`)
    break
  }
  case 'json': console.log(JSON.stringify(read())); break
  default:
    console.error('用法: talk|talk add|find|promote|sink|rm|prune')
    process.exit(2)
}
