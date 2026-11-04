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
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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

/** 解码：先按 UTF-8，替代字符太多就按 GB18030（老 txt 常见） */
function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/\uFFFD/g) ?? []).length
  if (bad / Math.max(1, utf8.length) < 0.002) return { text: utf8, encoding: 'utf-8' }
  try {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' }
  } catch {
    return { text: utf8, encoding: 'utf-8（有乱码）' }
  }
}

/** 从 EPUB 按 spine 顺序抽纯文本（解压用 Windows 自带 tar；临时目录用完就删） */
function epubText(file) {
  const tmp = path.join(os.tmpdir(), 'novel-epub-' + Date.now())
  fs.mkdirSync(tmp, { recursive: true })
  try {
    execFileSync('tar', ['-xf', file, '-C', tmp], { stdio: 'ignore' })
    const container = fs.readFileSync(path.join(tmp, 'META-INF', 'container.xml'), 'utf8')
    const opfRel = container.match(/full-path="([^"]+)"/)[1]
    const opfPath = path.join(tmp, decodeURIComponent(opfRel))
    const opfDir = path.dirname(opfPath)
    const opf = fs.readFileSync(opfPath, 'utf8')
    const items = new Map()
    for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = m[0].match(/id="([^"]+)"/)?.[1]
      const href = m[0].match(/href="([^"]+)"/)?.[1]
      if (id && href) items.set(id, decodeURIComponent(href))
    }
    const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => items.get(m[1])).filter(Boolean)
    const strip = (html) => html
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    let out = ''
    for (const rel of spine) {
      const f = path.join(opfDir, rel)
      if (!fs.existsSync(f)) continue
      out += strip(fs.readFileSync(f, 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean).join('\n') + '\n'
    }
    return out
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** 真正的切分（split 与 import 共用） */
function doSplit(rawIn, bookName, options = {}) {
  const chunkSize = Number(options.chunkSize ?? 6000)
  const segChars = Number(options.segChars ?? 12000)
  const raw = rawIn.replace(/\r\n/g, '\n').replace(/\u3000/g, ' ')
  const dir = bookDir(bookName)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const sub of ['chapters', 'blocks', 'notes']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const chapters = segmentLongChapters(splitChapters(raw), segChars)
  const index = { book: bookName, source: options.source ?? '', chunkSize, chars: raw.replace(/\s/g, '').length, chapters: [], blocks: [] }
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
  const first = index.chapters.slice(0, 6).map((c) => `${c.no}. ${c.title}（${c.chars} 字 / 块 ${c.blocks.join(',')}）`)
  console.log(`✓ 已切分：${bookName}`)
  console.log(`  字数 ${index.chars.toLocaleString()} · 单元 ${index.chapters.length} · 原文块 ${index.blocks.length}（每块 ≤${chunkSize} 字）`)
  console.log(`  目录：${dir}`)
  console.log('  前几个单元：\n    ' + first.join('\n    '))
  return index
}


try {
  if (cmd === 'split' || cmd === 'import') {
    const file = positional[0]
    if (!file) {
      console.error(cmd === 'import' ? '用法: novel import <书.epub|.txt> [--name 书名]' : '用法: novel split <小说.txt> [--name 书名] [--chunk 6000]')
      process.exit(2)
    }
    if (!fs.existsSync(file)) { console.error('找不到文件：' + file); process.exit(2) }
    const bookName = name ?? path.basename(file).replace(/\.[^.]+$/, '')
    const isEpub = /\.epub$/i.test(file)
    let text = ''
    if (isEpub) {
      console.log('正在解包 EPUB…')
      text = epubText(file)
    } else {
      const dec = decodeText(fs.readFileSync(file))
      text = dec.text
      console.log(`编码：${dec.encoding}`)
    }
    if (!text.trim()) { console.error('抽不出正文（文件可能加密或不支持）'); process.exit(3) }
    // import 会把抽好的纯文本存进 _src（原文不留在工作区，防手滑整本 read）
    if (cmd === 'import') {
      const srcDir = path.join(ROOT, '_src')
      fs.mkdirSync(srcDir, { recursive: true })
      const out = path.join(srcDir, `${bookName}.txt`)
      fs.writeFileSync(out, text, 'utf8')
      console.log(`原文已存：${out}`)
    }
    doSplit(text, bookName, { chunkSize: opt.chunk, segChars: opt['seg-chars'], source: file })
  } else if (cmd === 'index') {
    const dir = needBook()
    const ix = loadIndex(dir)
    console.log(`《${ix.book}》 ${ix.chars.toLocaleString()} 字 · ${ix.chapters.length} 章 · ${ix.blocks.length} 块`)
    for (const c of ix.chapters) console.log(`  ${String(c.no).padStart(3)}. ${c.title.padEnd(22)} ${String(c.chars).padStart(7)} 字  块 ${c.blocks[0]}–${c.blocks[c.blocks.length - 1]}`)
  } else if (cmd === 'read') {
    const dir = needBook()
    const ix = loadIndex(dir)
    // 2026-11-04：读多少由**她**定 —— 支持一次多块，但先把代价算给她看
    //   实测：1 块 ≈ 6000 字 ≈ 1k tokens；她的上下文就那么大，读多少都是她的判断 ✓
    let picked = []
    if (typeof opt.blocks === 'string') {
      const m = opt.blocks.match(/^(\d+)\s*[-–~]\s*(\d+)$/)
      if (!m) { console.error('--blocks 格式：`2-6`'); process.exit(2) }
      const a = Number(m[1])
      const b = Number(m[2])
      picked = ix.blocks.filter((x) => x.no >= Math.min(a, b) && x.no <= Math.max(a, b))
    } else if (opt.count) {
      // 从"下一块没读过的地方"开始，连续拿 N 块
      const st = loadState(dir)
      let noteFiles = []
      try { noteFiles = fs.readdirSync(path.join(dir, 'notes')).filter((f) => f.endsWith('.md')) } catch {}
      const done = new Set([...Object.keys(st.notes ?? {}).map(Number), ...noteFiles.map((f) => Number(f.replace('.md', '')))])
      picked = ix.blocks.filter((x) => !done.has(x.no)).slice(0, Math.max(1, Number(opt.count)))
    } else {
      const no = Number(opt.block)
      const one = ix.blocks.find((x) => x.no === no)
      if (!one) { console.error(`没有第 ${no} 块（共 ${ix.blocks.length} 块）`); process.exit(2) }
      picked = [one]
    }
    if (!picked.length) { console.error('这块区间里没有内容'); process.exit(2) }
    const chars = picked.reduce((s, x) => s + x.chars, 0)
    const tokens = Math.round(chars / 1.6)
    const limit = Number(opt.chars ?? 0)
    console.log(`【${ix.book} · ${picked.length} 块（${picked[0].no}–${picked[picked.length - 1].no}）· 共 ${chars.toLocaleString()} 字 ≈ ${tokens.toLocaleString()} tokens】`)
    if (picked.length > 1) console.log(`  代价：这一下会占掉你上下文约 ${Math.round((tokens / 128000) * 100)}%（128k 算）。读多少是你的判断 ✓`)
    for (const b of picked) {
      const text = fs.readFileSync(path.join(dir, 'blocks', b.file), 'utf8')
      console.log(`\n──── 块 ${b.no} · ${b.chapterTitle} · ${b.chars} 字 ────`)
      console.log(limit > 0 ? text.slice(0, limit) : text)
      if (limit > 0 && limit < text.length) console.log(`…（后面还有 ${text.length - limit} 字）`)
    }
  } else if (cmd === 'toc') {
    // 只看目录：挑"我想读哪几个单元"，不读正文（很便宜）
    const dir = needBook()
    const ix = loadIndex(dir)
    const limit = Number(opt.limit ?? 40)
    const from = Number(opt.from ?? 1)
    const rows = ix.chapters.filter((c) => c.no >= from).slice(0, limit)
    console.log(`《${ix.book}》目录（${rows.length}/${ix.chapters.length} 个单元）`)
    for (const c of rows) console.log(`  ${String(c.no).padStart(3)}. ${c.title.padEnd(24)} ${String(c.chars).padStart(6)} 字  块 ${c.blocks[0]}–${c.blocks[c.blocks.length - 1]}`)
    if (rows.length < ix.chapters.length) console.log(`（后面还有 ${ix.chapters.length - rows[0].no - rows.length + 1} 个单元，--from N 继续看）`)
  } else if (cmd === 'note') {
    const dir = needBook()
    const no = Number(opt.block)
    // 2026-11-04 修：漏 --block 会写成 notes/0NaN.md（实测踩到）
    if (!opt.block || !Number.isFinite(no) || no <= 0) { console.error('要指定块号：--block N（用 novel next 查下一块是哪个）'); process.exit(2) }
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
    // _src 是原文存放处（防手滑 read），不是书 ✓
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name)
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
