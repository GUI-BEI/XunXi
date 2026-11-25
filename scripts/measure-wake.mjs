// 唤醒文案体检：量出长文本到底多长、哪些块最占地方
//   node scripts/measure-wake.mjs
import { wakePrompt } from '../lib/scheduler.js'

const st = { atText: '18:03', window: '18:00–24:00', maxVideos: 5, roll: 'watch', wakes: 1 }
const txt = wakePrompt(st)
const lines = txt.split('\n')

function tok(s) {
  // 中文约 1 字 ≈ 1 token；英文/数字约 4 字符 1 token
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length
  return Math.round(cjk + (s.length - cjk) / 3.5)
}

console.log(`总行数 ${lines.length} · 总字符 ${txt.length} · 约 ${tok(txt)} token\n`)

// 按"空行"切块，量每块多大
const blocks = []
let cur = []
for (const l of lines) {
  if (l.trim() === '') { if (cur.length) { blocks.push(cur.join('\n')); cur = [] } } else cur.push(l)
}
if (cur.length) blocks.push(cur.join('\n'))

const rows = blocks
  .map((b, i) => ({ i: i + 1, first: b.split('\n')[0].replace(/^[#*\-\s]+/, '').slice(0, 40), chars: b.length, tok: tok(b), lines: b.split('\n').length }))
  .sort((a, b) => b.tok - a.tok)

console.log('按 token 排序的块（前 18）：')
for (const r of rows.slice(0, 18)) {
  console.log(`  ${String(r.tok).padStart(4)} tok  ${String(r.lines).padStart(2)} 行  ${r.first}`)
}
console.log(`\n合计 ${rows.reduce((s, r) => s + r.tok, 0)} tok`)
