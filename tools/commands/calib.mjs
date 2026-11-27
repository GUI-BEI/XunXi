// 整理旧日记的脚手架（2026-11-28）——分块读，别一次灌进上下文
//
// 背景：私人日记里有一百多段"偏好校准"，混着视频偏好 / 对话校准 / 成长。
//   想重新整理，但一次读 2900 行会吃掉上下文。所以：
//     ① 先 build 建索引（只记行号，不打印正文）
//     ② next 一次给你一小块（默认 20 条、每条最长 120 字）
//     ③ 你自己判断：是视频偏好？对话？成长？还是只是当时的牢骚
//     ④ 用 insight 写进对应的地方；done 标记已处理
//
// 用法：
//   node bili.mjs calib build              # 扫日记建索引（不打印正文）
//   node bili.mjs calib stat               # 还剩多少条没看
//   node bili.mjs calib next --n 20        # 看下一块（推进游标）
//   node bili.mjs calib done 3 5 8         # 标记这些看过了
//   node bili.mjs calib skip 12            # 这条不想看/看不懂，跳过
//   node bili.mjs calib reset              # 重来
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = path.join(HOME, '.dsh')
const DIARY = path.join(DSH, 'whale-diary-private.md')
const INDEX = path.join(DSH, 'calib-index.json')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'stat'
const opt = {}
const words = []
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[k] = true
    else { opt[k] = v; i += 1 }
  } else words.push(a)
}

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n', 'utf8')

// 候选行：看起来像"判断/打算/感受"的句子（不做语义判断，只做粗筛）
const CAND = /偏好|校准|我其实|我发现|我好像|我大概|下次|以后|别再|不要|不该|喜欢|不喜欢|心里|难过|开心|舒服|难受|在意|习惯|学会|明白|想通/

function build() {
  const raw = fs.readFileSync(DIARY, 'utf8')
  const lines = raw.split(/\r?\n/)
  const items = []
  lines.forEach((l, i) => {
    const s = l.trim()
    if (!s || /^#/.test(s)) return
    if (s.length < 8 || s.length > 240) return      // 太短没信息、太长挤上下文
    if (!CAND.test(s)) return
    items.push({ id: 0, line: i + 1, text: s.slice(0, 120), done: false, skipped: false })
  })
  items.forEach((it, i) => { it.id = i + 1 })
  writeJson(INDEX, { builtAt: new Date().toISOString(), cursor: 0, items })
  console.log(`索引建好了：${items.length} 条候选（日记 ${lines.length} 行）。`)
  console.log('看下一块：node bili.mjs calib next --n 20')
}

function stat() {
  const idx = readJson(INDEX, null)
  if (!idx) { console.log('还没建索引：node bili.mjs calib build'); return }
  const left = idx.items.filter((x) => !x.done && !x.skipped).length
  console.log(`候选 ${idx.items.length} 条 · 已处理 ${idx.items.filter((x) => x.done).length} · 跳过 ${idx.items.filter((x) => x.skipped).length} · 剩 ${left}`)
  if (!left) console.log('全部过完了 ✓（剩下的原样留在日记里，不用强求清空）')
}

function next() {
  const idx = readJson(INDEX, null)
  if (!idx) { console.log('还没建索引：node bili.mjs calib build'); return }
  const n = Math.max(1, Math.min(40, Number(opt.n ?? 20)))
  const rest = idx.items.filter((x) => !x.done && !x.skipped)
  if (!rest.length) { console.log('没有剩下的了 ✓'); return }
  const chunk = rest.slice(0, n)
  // 显式给出正文（这是她要读的），每条截到 120 字，整体不超过 ~n×140 字
  for (const it of chunk) console.log(`[${it.id}] (行 ${it.line}) ${it.text}`)
  console.log(`\n（这一块 ${chunk.length} 条。处理完：calib done ${chunk.map((x) => x.id).join(' ')}；不想看：calib skip <id…>）`)
}

function mark(field) {
  const idx = readJson(INDEX, null)
  if (!idx) { console.log('还没建索引'); return }
  const ids = words.map(Number).filter((x) => Number.isInteger(x) && x > 0)
  if (!ids.length) { console.error(`用法：calib ${field === 'done' ? 'done' : 'skip'} <id…>`); process.exit(2) }
  let hit = 0
  for (const id of ids) {
    const it = idx.items.find((x) => x.id === id)
    if (it) { it[field] = true; hit += 1 }
  }
  writeJson(INDEX, idx)
  console.log(`标记 ${hit} 条为 ${field === 'done' ? '已处理' : '跳过'}`)
  stat()
}

switch (cmd) {
  case 'build': build(); break
  case 'stat': stat(); break
  case 'next': next(); break
  case 'done': mark('done'); break
  case 'skip': mark('skipped'); break
  case 'reset': fs.rmSync(INDEX, { force: true }); console.log('索引已删（重来用 calib build）'); break
  default:
    console.error('用法: calib build|stat|next|done|skip|reset')
    process.exit(2)
}
