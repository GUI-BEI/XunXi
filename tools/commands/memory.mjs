// 记忆索引（2026-10-23 加）—— 让她"一屏看完全史"，而不是把日记全文塞进上下文
//
// 为什么：日记无限追加；每轮全文读两本 → 上下文线性膨胀，几周后必然被压缩（连日记也变摘要）✗
//   这套做法（和 `recall` 配套）把"记忆"分三层：
//     ① 最近 N 天：全文（`diary recent --days 2`）
//     ② 全史：索引（本命令）—— 每条一段：日期 + 标题 + 第一句，一屏能扫
//     ③ 细节：按需检索（`recall "关键词"`）
//
// 用法:
//   node bili.mjs memory index           生成/刷新 ~/.dsh/memory/INDEX.md，并打印摘要
//   node bili.mjs memory index --print   直接打印整份索引（想通读时用）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = process.env.DSH_HOME || path.join(HOME, '.dsh')
const MEM_DIR = path.join(DSH, 'memory')
const INDEX = path.join(MEM_DIR, 'INDEX.md')
const SOURCES = [
  { label: '公开', file: path.join(DSH, 'whale-diary.md') },
  { label: '私人', file: path.join(DSH, 'whale-diary-private.md') },
]
try {
  for (const f of fs.readdirSync(MEM_DIR)) {
    if (/^\d{4}-\d{2}\.md$/.test(f)) SOURCES.push({ label: f.slice(0, 7), file: path.join(MEM_DIR, f) })
  }
} catch {}

const argv = process.argv.slice(2)
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
}
const cmd = argv[0] ?? 'index'

/** 抽取所有 `## YYYY-MM-DD` 段：日期 + 标题 + 第一句正文（截断） */
function blocksOf(file, label) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})(.*)$/)
    if (h) { cur = { date: h[1], head: (h[2] || '').replace(/^[\s·—-]+/, '').trim(), first: '', label, lines: 0 }; out.push(cur); continue }
    if (!cur) continue
    if (/^###?\s/.test(line)) continue
    const t = line.replace(/^[>\-*\s]+/, '').trim()
    if (!t) continue
    cur.lines += 1
    if (!cur.first) cur.first = t
  }
  return out
}

const all = SOURCES.flatMap((s) => blocksOf(s.file, s.label))
all.sort((a, b) => String(a.date).localeCompare(String(b.date)))
if (!all.length) { console.log('（还没有日记段 —— 她第一次写日记后再来）'); process.exitCode = 0 }
else {
  const byMonth = {}
  for (const b of all) (byMonth[b.date.slice(0, 7)] ??= []).push(b)
  const lines = ['# 记忆索引（自动生成，可随时重建）', '', `> 共 ${all.length} 段 · 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '> 用法：先扫这里找线索 → `recall "关键词" --days N` 看细节；最近 2~3 天直接 `diary recent` ✓', '']
  for (const m of Object.keys(byMonth).sort().reverse()) {
    lines.push(`## ${m}（${byMonth[m].length} 段）`, '')
    for (const b of byMonth[m].reverse()) {
      const first = b.first ? b.first.slice(0, 44) : '（没写正文）'
      lines.push(`- ${b.date.slice(5)} · ${b.head || '（无标题）'} · ${b.label} —— ${first}`)
    }
    lines.push('')
  }
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
    fs.writeFileSync(INDEX, lines.join('\n'))
  } catch (e) { console.error('✗ 写索引失败：' + e.message); process.exitCode = 3 }

  if (cmd !== 'index') { console.error('用法: node bili.mjs memory index [--print]'); process.exitCode = 2 }
  else if (opt.print) { console.log(lines.join('\n')); process.exitCode = 0 }
  else {
    const recent = all.slice(-6).reverse()
    console.log(`记忆索引：共 ${all.length} 段，覆盖 ${all[0].date} ~ ${all[all.length - 1].date}`)
    console.log('  各月：' + Object.keys(byMonth).sort().reverse().map((m) => `${m} ${byMonth[m].length} 段`).join(' · '))
    console.log('  最近几段：')
    for (const b of recent) console.log(`    · ${b.date.slice(5)} ${b.head || ''} —— ${(b.first || '').slice(0, 40)}`)
    console.log(`\n  全文在 ${INDEX}（想通读就 \`memory index --print\`）；细节用 \`recall "关键词"\` ✓`)
    process.exitCode = 0
  }
}
