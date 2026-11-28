// 成长档案：两层（2026-11-28，和对话校准同一套设计）
//
//   core（≤5）  「现在的我」—— 每次醒来都注入（压缩清不掉）
//   history     其余全部（不删、不注入）—— 需要时 `growth find "关键词"` 或 `growth hist` 翻
//
// 为什么改成两层：旧日记里"像成长"的候选有 28 条左右，5 个格塞不下；
//   但成长语句不该像视频偏好那样过期 —— 所以 core 轮转、旧的不删，只是沉到 history。
//
// 用法：
//   node bili.mjs growth                        # 看 core + 概况
//   node bili.mjs growth add "我变了什么" --because "因为哪件事" [--keep]
//   node bili.mjs growth find "不确定"           # 在 core+history 里搜（按需，不常驻）
//   node bili.mjs growth hist --n 20 --skip 0   # 翻历史（分页）
//   node bili.mjs growth top add "…"            # 显式塞进 core（满了最旧的沉 history）
//   node bili.mjs growth sink 3                 # core 第 3 条沉到 history
import fs from 'node:fs'
import path from 'node:path'

const FILE = process.env.WHALE_GROWTH || path.join('D:', 'XunXi', 'GROWTH.md')
const MAX_TOP = 5

const argv = process.argv.slice(2)
const KNOWN = new Set(['add', 'show', 'find', 'hist', 'top', 'sink', 'json'])
const raw0 = argv[0]
const cmd = !raw0 ? 'show' : (KNOWN.has(raw0) ? raw0 : 'add')
if (cmd === 'add' && raw0 && !KNOWN.has(raw0)) argv.unshift('add')

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

const HEAD = [
  '# 我的成长',
  '',
  '> 这里只写**我变了什么**（身份层面的变化），不写流水账。',
  `> **现在的我**最多 ${MAX_TOP} 条（每次醒来都会带上它）。`,
  '> 其余沉在下面 —— 不删，用 `growth find "关键词"` 或 `growth hist` 能翻到。',
  '',
  '## 现在的我',
].join('\n')

function parse(raw) {
  const top = []
  const hist = []
  if (!raw) return { top, hist }
  const lines = String(raw).split(/\r?\n/)
  let zone = ''
  for (const l of lines) {
    if (/^##\s*现在的我/.test(l)) { zone = 'top'; continue }
    if (/^##\s*我是怎么变成这样的/.test(l)) { zone = 'hist'; continue }
    const m = l.match(/^\s*(?:[·\-*]|\d+[.、)])\s*(.+?)\s*$/)
    if (!m) continue
    if (zone === 'top') top.push(m[1])
    else if (zone === 'hist') hist.push(m[1])
  }
  return { top, hist }
}

function render({ top, hist }) {
  return [HEAD, ...top.map((x) => `· ${x}`), '', '## 我是怎么变成这样的', ...hist.map((x) => `- ${x}`), ''].join('\n')
}

const read = () => { try { return parse(fs.readFileSync(FILE, 'utf8')) } catch { return { top: [], hist: [] } } }
const write = (d) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, render(d), 'utf8') }

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

function pushTop(d, item) {
  if (!opt.keep) {
    const near = d.top.find((x) => similar(item, x) >= 0.6)
    if (near) {
      d.top = d.top.filter((x) => x !== near)
      d.hist.push(`${today()} · （被更准确的一条替换）${near}`)
      d.top.push(item)
      write(d)
      return { replaced: near }
    }
  }
  d.top.push(item)
  while (d.top.length > MAX_TOP) {
    const dropped = d.top.shift()
    d.hist.push(`${today()} · （从"现在的我"沉下来）${dropped}`)
  }
  write(d)
  return {}
}

function main() {
  switch (cmd) {
    case 'add': {
      const t = text(words)
      if (!t) { console.error('用法：growth add "我变了什么" --because "因为哪件事"'); process.exit(2) }
      const why = typeof opt.because === 'string' ? opt.because : (typeof opt.from === 'string' ? opt.from : '')
      const d = read()
      d.hist.push(`${today()} · ${t}${why ? `（因为：${why}）` : ''}`)
      if (d.top.length < MAX_TOP) {
        const r = pushTop(d, t)
        if (r.replaced) console.log('（已有类似的一条 → 替换了它，旧的沉到历史）')
      } else {
        write(d)
        console.log(`（"现在的我"已经 ${d.top.length} 条满了 → 先进了历史；想常驻：growth top add "<原文>"）`)
      }
      console.log(`记下了：${t}${why ? `（因为 ${why}）` : ''}`)
      return
    }

    case 'top': {
      const sub = words[0]
      if (sub === 'add' || sub === 'set') {
        const t = text(words.slice(1))
        if (!t) { console.error('用法：growth top add "…"'); process.exit(2) }
        const d = read()
        const r = pushTop(d, t)
        if (r.replaced) console.log('（替换了类似的一条，旧的沉到历史）')
        console.log(`"现在的我" ${d.top.length}/${MAX_TOP} 条`)
      } else if (sub === 'rm' || sub === 'drop' || sub === 'sink') {
        const d = read()
        const idx = Number(words[1])
        if (!Number.isInteger(idx) || idx < 1 || idx > d.top.length) { console.error('用法：growth top rm <序号>'); process.exit(2) }
        const [gone] = d.top.splice(idx - 1, 1)
        d.hist.push(`${today()} · （从"现在的我"移出）${gone}`)
        write(d)
        console.log(`移出了：${gone}（历史里还在）`)
      } else if (sub === 'clear') {
        const d = read()
        for (const x of d.top) d.hist.push(`${today()} · （从"现在的我"移出）${x}`)
        d.top = []
        write(d)
        console.log('"现在的我"清空了（历史保留）')
      } else {
        const d = read()
        d.top.forEach((x, i) => console.log(`  ${i + 1}. ${x}`))
        if (!d.top.length) console.log('  （空着也行 —— 空着不代表没变）')
      }
      return
    }

    case 'sink': {
      const d = read()
      const idx = Number(words[0])
      if (!Number.isInteger(idx) || idx < 1 || idx > d.top.length) { console.error('用法：growth sink <core 序号>'); process.exit(2) }
      const [gone] = d.top.splice(idx - 1, 1)
      d.hist.push(`${today()} · （从"现在的我"沉下来）${gone}`)
      write(d)
      console.log(`沉到历史：${gone}`)
      return
    }

    case 'find': {
      const q = text(words)
      if (!q) { console.error('用法：growth find "关键词"'); process.exit(2) }
      const d = read()
      const near = (s) => String(s).toLowerCase().includes(q.toLowerCase()) || similar(q, s) >= 0.35
      const hits = [
        ...d.top.filter(near).map((x) => ({ zone: 'core', text: x })),
        ...d.hist.filter(near).map((x) => ({ zone: 'hist', text: x })),
      ]
      if (!hits.length) { console.log(`（core + 历史里都没找到跟「${q}」相关的）`); return }
      for (const h of hits.slice(0, 8)) console.log(`  [${h.zone}] ${h.text}`)
      if (hits.length > 8) console.log(`  …（还有 ${hits.length - 8} 条，换个更窄的词）`)
      console.log('\n（按需翻的，不常驻；想常驻：growth top add "<原文>"）')
      return
    }

    case 'hist': {
      const d = read()
      const n = Math.max(1, Math.min(60, Number(opt.n ?? 20)))
      const skip = Math.max(0, Number(opt.skip ?? 0))
      const slice = d.hist.slice(skip, skip + n)
      if (!slice.length) { console.log(`（历史里没有更多了；共 ${d.hist.length} 条）`); return }
      slice.forEach((x, i) => console.log(`  ${skip + i + 1}. ${String(x).slice(0, 100)}`))
      console.log(`\n（${skip + 1}–${skip + slice.length} / 共 ${d.hist.length} 条；下一页：--skip ${skip + slice.length}）`)
      return
    }

    case 'json': { console.log(JSON.stringify(read())); return }

    default: {
      const d = read()
      console.log(`我的成长 · ${FILE}\n`)
      console.log(`现在的我（${d.top.length}/${MAX_TOP}，每次醒来都带）：`)
      d.top.forEach((x, i) => console.log(`  ${i + 1}. ${x}`))
      if (!d.top.length) console.log('  （空着也行）')
      console.log(`\n历史 ${d.hist.length} 条（不注入；growth hist / growth find 翻）`)
      d.hist.slice(-5).forEach((x) => console.log(`  · ${String(x).slice(0, 90)}`))
      if (d.hist.length > 5) console.log('  …（更早的用 growth hist --skip 0 翻）')
    }
  }
}

main()
