// 读书（2026-11-04 加）——把长篇小说切成"章节 + 原文块"，让她只读骨架和自选片段
//
// 为什么不是"把书塞进上下文"：
//   · 三体三部曲 88 万字 ≈ 59 万 tokens，远超她的上下文；硬塞会触发压缩，
//     反而把"两天前的视频感受 / 你跟她说过的话"挤掉 ✗
//   · 所以：**原文永远不进她的主会话**。子代理读块 → 产出章节笔记；
//     她只读骨架 + 自己挑的几个场景，最后写「印象 + 人物看法」落盘 ✓
//
// 目录结构（默认 ~/.dsh/novels/<书名>/）：
//   index.json              章节/块索引（含字数、起始位置）
//   chapters/NNN-<标题>.txt  章节原文
//   blocks/NNNN.txt          原文块（≤ chunk 字，按句子边界切）
//   notes/NNNN.md            一个块/一章的笔记（子代理或她自己写）
//   skeleton.md              全书骨架（notes 拼起来，供她一次读完）
//   state.json               进度（读到哪、读了哪些块）
//
// 用法：
//   node bili.mjs novel split <小说.txt> [--name 三体] [--chunk 6000]
//   node bili.mjs novel index [--name 三体]
//   node bili.mjs novel read --block 3 [--name 三体] [--chars 8000]
//   node bili.mjs novel note --block 3 --file note.md [--name 三体]
//   node bili.mjs novel skeleton [--name 三体]
//   node bili.mjs novel recall "水滴" [--name 三体]
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const ROOT = path.join(HOME, '.dsh', 'novels')
const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
const positional = []
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[k] = true
    else { opt[k] = v; i += 1 }
  } else positional.push(argv[i])
}

const name = typeof opt.name === 'string' ? opt.name : null
const bookDir = (n) => path.join(ROOT, n ?? '')
function needBook() {
  if (!name) throw new Error('要加 --name <书名>（split 时会建好）')
  const d = bookDir(name)
  if (!fs.existsSync(path.join(d, 'index.json'))) throw new Error(`没有这本书的索引：${d}\n先跑 split`)
  return d
}
function loadIndex(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) }
function saveState(dir, s) { fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2), 'utf8') }
function loadState(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { return { blocks: {}, notes: {} } } }

/** 章节标题行：`1.疯狂年代` / `第12章 台球` / `第三章 射手和农场主` / `楔子` / `后记` */
const CH_RE = /^(?:\d{1,3}\.[^\n]{1,28}|第[0-9零一二三四五六七八九十百千]{1,4}[章回][^\n]{0,28}|(?:楔子|序幕|序章|终章|尾声|后记|前言)[^\n]{0,28})$/

function splitChapters(text) {
  const lines = text.split('\n')
  const chapters = []
  let cur = { title: '（开头）', lines: [] }
  for (const line of lines) {
    const t = line.trim()
    if (t && t.length <= 30 && CH_RE.test(t)) {
      if (cur.lines.join('').trim()) chapters.push(cur)
      cur = { title: t, lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  if (cur.lines.join('').trim()) chapters.push(cur)
  return chapters.map((c) => ({ title: c.title, text: c.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }))
}

/** 按句子边界切块（中文句号/问号/叹号/换行） */
function chunkText(text, limit) {
  const chunks = []
  let buf = ''
  const sentences = text.split(/(?<=[。！？…」』】\n])/)
  for (const s of sentences) {
    if (buf.length + s.length > limit && buf.length > 0) { chunks.push(buf.trim()); buf = '' }
    buf += s
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks
}

// 章节过长时自动分段（2026-11-04 实测：这版电子书的第二、三部没有章节标题，
//   整本书会被切成"序章 53 万字"这种怪物 → 笔记没法按章写，所以超长章节自动拆段）
function segmentLongChapters(chapters, maxChars) {
  const out = []
  for (const ch of chapters) {
    const chars = ch.text.replace(/\s/g, '').length
    if (chars <= maxChars) { out.push(ch); continue }
    const paras = ch.text.split(/\n+/)   // 这版电子书单换行就是一段，空行切分会退化成"整章一段"
    let buf = ''
    let seg = 1
    const flush = () => {
      if (buf.trim()) out.push({ title: `${ch.title} · 段${seg}`, text: buf.trim() })
      seg += 1
      buf = ''
    }
    for (const para of paras) {
      if (buf.length + para.length > maxChars && buf.length > 0) flush()
      buf += (buf ? '\n' : '') + para
    }
    flush()
  }
  return out
}

const fmt = (s) => String(s).padStart(4, '0')

try {
  if (cmd === 'split') {
    const file = positional[0]
    if (!file) { console.error('用法: novel split <小说.txt> [--name 书名] [--chunk 6000]'); process.exit(2) }
    const bookName = name ?? path.basename(file).replace(/\.[^.]+$/, '')
    const chunkSize = Number(opt.chunk ?? 6000)
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\u3000/g, ' ')
    const dir = bookDir(bookName)
    fs.rmSync(dir, { recursive: true, force: true })
    for (const sub of ['chapters', 'blocks', 'notes']) fs.mkdirSync(path.join(dir, sub), { recursive: true })

    const chapters = segmentLongChapters(splitChapters(raw), Number(opt['seg-chars'] ?? 12000))
    const index = { book: bookName, source: file, chunkSize, chars: raw.replace(/\s/g, '').length, chapters: [], blocks: [] }
    let bno = 1
    chapters.forEach((ch, ci) => {
      const cfile = path.join('chapters', `${fmt(ci + 1)}-${ch.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24)}.txt`)
      fs.writeFileSync(path.join(dir, cfile), ch.text, 'utf8')
      const entry = { no: ci + 1, title: ch.title, chars: ch.text.replace(/\s/g, '').length, file: cfile, blocks: [] }
      for (const piece of chunkText(ch.text, chunkSize)) {
        const blk = `${fmt(bno)}.txt`
        fs.writeFileSync(path.join(dir, 'blocks', blk), piece, 'utf8')
        const b = { no: bno, chapter: ci + 1, chapterTitle: ch.title, chars: piece.replace(/\s/g, '').length, file: blk }
        index.blocks.push(b)
        entry.blocks.push(bno)
        bno += 1
      }
      index.chapters.push(entry)
    })
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
    saveState(dir, { blocks: {}, notes: {} })
    console.log(`✓ 已切分：${bookName}`)
    console.log(`  字数 ${index.chars.toLocaleString()} · 章节 ${index.chapters.length} · 原文块 ${index.blocks.length}（每块 ≤${chunkSize} 字）`)
    console.log(`  目录：${dir}`)
    const first = index.chapters.slice(0, 6).map((c) => `${c.no}. ${c.title}（${c.chars} 字 / 块 ${c.blocks.join(',')}）`)
    console.log('  前几章：\n    ' + first.join('\n    '))
  } else if (cmd === 'index') {
    const dir = needBook()
    const ix = loadIndex(dir)
    console.log(`《${ix.book}》 ${ix.chars.toLocaleString()} 字 · ${ix.chapters.length} 章 · ${ix.blocks.length} 块`)
    for (const c of ix.chapters) console.log(`  ${String(c.no).padStart(3)}. ${c.title.padEnd(22)} ${String(c.chars).padStart(7)} 字  块 ${c.blocks[0]}–${c.blocks[c.blocks.length - 1]}`)
  } else if (cmd === 'read') {
    const dir = needBook()
    const ix = loadIndex(dir)
    const no = Number(opt.block)
    const b = ix.blocks.find((x) => x.no === no)
    if (!b) { console.error(`没有第 ${no} 块（共 ${ix.blocks.length} 块）`); process.exit(2) }
    const text = fs.readFileSync(path.join(dir, 'blocks', b.file), 'utf8')
    const limit = Number(opt.chars ?? text.length)
    console.log(`【${ix.book} · 块 ${b.no} · ${b.chapterTitle} · ${b.chars} 字】`)
    console.log(text.slice(0, limit))
    if (limit < text.length) console.log(`…（后面还有 ${text.length - limit} 字，--chars 可调）`)
  } else if (cmd === 'note') {
    const dir = needBook()
    const no = Number(opt.block)
    let body = ''
    if (typeof opt.file === 'string') body = fs.readFileSync(opt.file, 'utf8')
    else if (typeof opt.text === 'string') body = opt.text
    if (!body.trim()) { console.error('要 --file 或 --text'); process.exit(2) }
    fs.writeFileSync(path.join(dir, 'notes', `${fmt(no)}.md`), body.trim() + '\n', 'utf8')
    const st = loadState(dir)
    st.notes[no] = new Date().toISOString()
    st.blocks[no] = new Date().toISOString()
    saveState(dir, st)
    console.log(`✓ 已记下第 ${no} 块的笔记（${body.trim().length} 字）→ notes/${fmt(no)}.md`)
  } else if (cmd === 'skeleton') {
    const dir = needBook()
    const ix = loadIndex(dir)
    const parts = []
    for (const b of ix.blocks) {
      const f = path.join(dir, 'notes', `${fmt(b.no)}.md`)
      if (!fs.existsSync(f)) continue
      parts.push(`### 块 ${b.no} · ${b.chapterTitle}\n${fs.readFileSync(f, 'utf8').trim()}`)
    }
    if (!parts.length) { console.error('还没有任何笔记'); process.exit(2) }
    const out = `# 《${ix.book}》骨架（由笔记拼成）\n\n共 ${parts.length}/${ix.blocks.length} 块有笔记\n\n${parts.join('\n\n')}\n`
    fs.writeFileSync(path.join(dir, 'skeleton.md'), out, 'utf8')
    console.log(`✓ 骨架已生成：${path.join(dir, 'skeleton.md')}（${out.replace(/\s/g, '').length} 字 ≈ ${Math.round(out.replace(/\s/g, '').length / 1.6)} tokens）`)
  } else if (cmd === 'recall') {
    const dir = needBook()
    const ix = loadIndex(dir)
    const kw = positional[0]
    if (!kw) { console.error('用法: novel recall "关键词"'); process.exit(2) }
    const hits = []
    for (const b of ix.blocks) {
      const text = fs.readFileSync(path.join(dir, 'blocks', b.file), 'utf8')
      const i = text.indexOf(kw)
      if (i < 0) continue
      hits.push({ block: b.no, chapter: b.chapterTitle, snippet: text.slice(Math.max(0, i - 60), i + 140).replace(/\s+/g, ' ') })
      if (hits.length >= 3) break
    }
    if (!hits.length) console.log(`（没找到「${kw}」）`)
    else for (const h of hits) console.log(`· 块 ${h.block}「${h.chapter}」\n  …${h.snippet}…`)
  } else if (cmd === 'list') {
    // 书架：她一眼看到"有什么书、读到哪里了"（不设进度目标，只是让她知道有这些书）
    if (!fs.existsSync(ROOT)) { console.log(`（书架是空的：${ROOT}）`); process.exit(0) }
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    if (!dirs.length) { console.log(`（书架是空的：${ROOT}）`); process.exit(0) }
    console.log('书架：')
    for (const d of dirs) {
      const ixFile = path.join(ROOT, d, 'index.json')
      if (!fs.existsSync(ixFile)) { console.log(`  · ${d}（还没切分）`); continue }
      const ix = JSON.parse(fs.readFileSync(ixFile, 'utf8'))
      const noteFiles = (() => { try { return fs.readdirSync(path.join(ROOT, d, 'notes')).filter((f) => f.endsWith('.md')) } catch { return [] } })()
      const notes = noteFiles.length
      const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, d, 'state.json'), 'utf8')) } catch { return { notes: {} } } })()
      const last = Object.values(st.notes ?? {}).sort().pop()
      const pct = ix.blocks.length ? Math.round((notes / ix.blocks.length) * 100) : 0
      const where = notes === 0
        ? '还没开始读'
        : (last ? `读了 ${notes}/${ix.blocks.length} 块（${pct}%），上次 ${String(last).slice(0, 10)}` : `读了 ${notes}/${ix.blocks.length} 块（${pct}%）`)
      console.log(`  · 《${ix.book}》 ${ix.chars.toLocaleString()} 字 · ${ix.chapters.length} 个单元 · ${where}`)
    }
    console.log('\n（想读哪本都行，不想读也行 —— 书不会跑 ✓）')
  } else if (cmd === 'next') {
    // 下一步读哪块：一次只给一块，省得她自己去翻目录
    const dir = needBook()
    const ix = loadIndex(dir)
    const st = loadState(dir)
    // 以笔记文件为准（state 只记时间戳，重切分后可能对不上）
    let noteFiles = []
    try { noteFiles = fs.readdirSync(path.join(dir, 'notes')).filter((f) => f.endsWith('.md')) } catch {}
    const done = new Set([...Object.keys(st.notes ?? {}).map(Number), ...noteFiles.map((f) => Number(f.replace('.md', '')))])
    const target = ix.blocks.find((b) => !done.has(b.no))
    if (!target) {
      console.log(`《${ix.book}》：${ix.blocks.length} 块都有笔记了 ✓`)
      console.log('（要重新回顾就读骨架：`node bili.mjs novel skeleton --name ' + ix.book + '`）')
      process.exit(0)
    }
    console.log(`《${ix.book}》下一块：块 ${target.no} · ${target.chapterTitle} · ${target.chars} 字`)
    console.log(`  node bili.mjs novel read --block ${target.no} --name ${ix.book}`)
    console.log(`（读完写笔记：node bili.mjs novel note --block ${target.no} --name ${ix.book} --file 笔记.md）`)
    console.log(`进度：${done.size}/${ix.blocks.length} 块`)
  } else {
    console.log('用法：novel split|index|read|note|skeleton|recall|list|next（见 README）')
    process.exit(2)
  }
} catch (e) {
  console.error('✗ ' + String(e.message).slice(0, 300))
  process.exit(1)
}
