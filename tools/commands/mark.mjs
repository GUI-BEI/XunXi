// 「留记号」—— 她决定不回（或只敷衍一下）时，让主人**看得出来**这不是插件坏了
//
// 为什么要有这个文件（2026-10-20 主人定）：
//   她可以不想回消息（人设里已经写着"不必给理由"）。私信不回时，主人那边是**没有任何回执**的 ——
//   分不清"她不想说话"和"DSH 挂了 / 定时任务没跑"✗
//   → 留一笔本地记号：不打扰、不走 B站、一个字符都不发出去，主人去设置页就能看见 ✓
//
// 用法:
//   node mark.mjs seen [--note "…"]    记一笔「看到了，但没回」
//   node mark.mjs list                 看最近 10 条（人读）
//
// 文件: ~/.dsh/whale-seen.json  { lastAt, lastNote, items: [{ at, note }] }（留最近 50 条）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = path.join(HOME, '.dsh', 'whale-seen.json')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'seen'
const ni = argv.indexOf('--note')
const note = ni >= 0 ? String(argv[ni + 1] ?? '').trim().slice(0, 120) : ''

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { items: [] } } }
const save = (o) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n') }

if (cmd === 'seen') {
  const at = new Date().toISOString()
  const cur = load()
  const items = [...(cur.items ?? []), { at, note }].slice(-50)
  save({ lastAt: at, lastNote: note, items })
  console.log(`已留记号：${at}${note ? '（' + note + '）' : ''} —— 主人下次开「设置 → 养鱼」就能看到，不是插件出问题 ✓`)
  process.exitCode = 0
} else if (cmd === 'list') {
  const cur = load()
  const items = (cur.items ?? []).slice(-10).reverse()
  if (!items.length) console.log('（没有记录 —— 她还没留过记号）')
  else {
    console.log(`【已读不回的记号】共 ${(cur.items ?? []).length} 条，最近 ${items.length} 条：`)
    for (const it of items) console.log(`· ${new Date(it.at).toLocaleString('zh-CN', { hour12: false })}  ${it.note || '（没写备注）'}`)
  }
  process.exitCode = 0
} else {
  console.error('用法: node mark.mjs seen [--note "…"]  |  node mark.mjs list')
  process.exitCode = 2
}
