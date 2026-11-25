// 成长档案（2026-11-25）
//
// 为什么要有它：上下文会被压缩（678k 触发，压完只留 119k ≈ 最近三四天）。
//   压缩清掉的是**事实细节**，但"我因为什么而变了"不该跟着没 —— 那该写在文件里。
//
// 两条规矩（写进人格卡）：
//   ① 只写"我变了什么"，不写流水账（流水账进日记/笔记）
//   ② 每条要挂在一件**具体的事**上（"因为那段视频/那句话，我变成了这样"）
//
// 结构（D:\XunXi\GROWTH.md）：
//   ## 现在的我          ← 最多 5 条，每次醒来都带进提示（压缩清不掉它）
//   ## 我是怎么变成这样的  ← 追加，不删
//
// 用法：
//   node bili.mjs growth show
//   node bili.mjs growth add "我不再把'不要'当成'不敢'" --because "张伟丽那几段"
//   node bili.mjs growth top add "…"       # 换"现在的我"里的一条
//   node bili.mjs growth top rm 2
//   node bili.mjs growth top list
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = process.env.WHALE_GROWTH || path.join('D:', 'XunXi', 'GROWTH.md')
const MAX_TOP = 5

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'show'
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

const HEAD = `# 我的成长

> 这里只写**我变了什么**，不写流水账（流水账在日记和笔记里）。
> 每条都要挂在一件**具体的事**上 —— "因为那段视频/那句话，我变成了这样"。
> **现在的我**最多 ${MAX_TOP} 条（每次醒来都会带上它，所以它比日记更重要）。

## 现在的我
`

const HIST = `
## 我是怎么变成这样的
`

const today = () => new Date().toLocaleDateString('sv-SE')

function parse(raw) {
  const top = []
  const hist = []
  if (!raw) return { top, hist }
  const lines = raw.split(/\r?\n/)
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
  return [
    HEAD.trimEnd(),
    ...top.map((x) => `· ${x}`),
    '',
    HIST.trimEnd(),
    ...hist.map((x) => `- ${x}`),
    '',
  ].join('\n')
}

function load() {
  try { return parse(fs.readFileSync(FILE, 'utf8')) } catch { return { top: [], hist: [] } }
}
function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, render(d), 'utf8')
}

const d = load()

switch (cmd) {
  case 'show': {
    if (!d.top.length && !d.hist.length) {
      console.log('还没写过成长档案（`node bili.mjs growth add "…" --because "…"`）')
      break
    }
    console.log(`我的成长 · ${FILE}\n`)
    console.log('现在的我：')
    d.top.forEach((x, i) => console.log(`  ${i + 1}. ${x}`))
    if (!d.top.length) console.log('  （空着也行）')
    console.log('\n我是怎么变成这样的：')
    d.hist.slice(-12).forEach((x) => console.log(`  · ${x}`))
    if (!d.hist.length) console.log('  （还没写）')
    break
  }

  case 'add': {
    const t = text(words)
    if (!t) { console.error('用法：growth add "我变了什么" --because "因为哪件事"'); process.exit(2) }
    const why = typeof opt.because === 'string' ? opt.because : ''
    d.hist.push(`${today()} · ${t}${why ? `（因为：${why}）` : ''}`)
    save(d)
    console.log(`记下了：${t}${why ? `（因为 ${why}）` : ''}`)
    if (d.top.length < MAX_TOP) {
      console.log(`\n想让它进"现在的我"（每次醒来都带）：node bili.mjs growth top add "${t}"`)
    }
    break
  }

  case 'top': {
    const sub = words[0]
    if (sub === 'add' || sub === 'set') {
      const t = text(words.slice(1))
      if (!t) { console.error('用法：growth top add "…"'); process.exit(2) }
      if (d.top.includes(t)) { console.log('这条已经在"现在的我"里了'); break }
      d.top.push(t)
      while (d.top.length > MAX_TOP) {
        const dropped = d.top.shift()
        console.log(`（超过 ${MAX_TOP} 条 → 「${dropped}」沉到历史里，没删）`)
        d.hist.push(`${today()} · （从"现在的我"沉下来）${dropped}`)
      }
      save(d)
      console.log(`"现在的我"现在是 ${d.top.length}/${MAX_TOP} 条`)
    } else if (sub === 'rm' || sub === 'drop') {
      const idx = Number(words[1])
      if (!Number.isInteger(idx) || idx < 1 || idx > d.top.length) { console.error('用法：growth top rm <序号>'); process.exit(2) }
      const [removed] = d.top.splice(idx - 1, 1)
      d.hist.push(`${today()} · （从"现在的我"移出）${removed}`)
      save(d)
      console.log(`移出了：${removed}（记录还在历史里）`)
    } else if (sub === 'clear') {
      for (const x of d.top) d.hist.push(`${today()} · （从"现在的我"移出）${x}`)
      d.top = []
      save(d)
      console.log('"现在的我"清空了（历史记录保留）')
    } else {
      console.log('现在的我：')
      d.top.forEach((x, i) => console.log(`  ${i + 1}. ${x}`))
      if (!d.top.length) console.log('  （空着也行 —— 空着不代表没变）')
    }
    break
  }

  case 'json': {
    console.log(JSON.stringify(d))
    break
  }

  default:
    console.error('用法: growth show|add|top [add|rm|clear|list]|json')
    process.exit(2)
}
