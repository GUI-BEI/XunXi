// 核验（2026-11-04 加）——防"编造"：把她写的东西里的数字/名字/引文，逐条对回**素材原文**
//
// 为什么需要：她会"顺着记忆补全"，而她的红线写着"不编造"。这件事不该只靠自觉 ✓
// 素材从哪来（都是她真能看到的）：
//   ① 视频简介 + 标题（view 接口）
//   ② 官方字幕（登录态可用时）
//   ③ OCR 出来的画面文字（bili-watch 会写 `<BV>-*-ocr.txt`）
// 用法：
//   node bili.mjs verify <BV> --text "她的总结全文"
//   node bili.mjs verify <BV> --file draft.md
// 退出码：0 = 全部找得到 / 5 = 有找不到的（她该回头看原文，或改写成"我猜"）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const SHOTS = path.join(HOME, '.dsh', 'shots', 'video')
const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[k] = true
    else { opt[k] = v; i += 1 }
  } else positional.push(argv[i])
}
const bvid = positional[0]
if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('用法: node bili.mjs verify <BV> --text "…" | --file draft.md'); process.exit(2) }

let claimText = ''
if (typeof opt.text === 'string') claimText = opt.text
else if (typeof opt.file === 'string') { try { claimText = fs.readFileSync(opt.file, 'utf8') } catch (e) { console.error('读不到 --file：' + e.message); process.exit(2) } }
else { console.error('要么 --text "…"，要么 --file 草稿.md'); process.exit(2) }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cred = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8')) } catch { return null } })()
const H = cred
  ? { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}` }
  : { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

const sources = []   // { label, text }
const norm = (s) => String(s ?? '')
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
  .replace(/[「」『』“”"'’‘`]/g, '')
  .replace(/\s+/g, '')
  .toLowerCase()

// ① 标题 + 简介
try {
  const j = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
  if (j.code === 0) {
    sources.push({ label: '标题', text: j.data.title ?? '' })
    sources.push({ label: '简介', text: j.data.desc ?? '' })
    console.log(`素材①  标题/简介：${String(j.data.title ?? '').slice(0, 40)}（简介 ${String(j.data.desc ?? '').length} 字）`)
  }
} catch (e) { console.log('（标题/简介取不到：' + String(e.message).slice(0, 60) + '）') }

// ② 官方字幕（需要登录态；拿不到就跳过，不报错）
try {
  const page = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
  const cid = page?.data?.pages?.[0]?.cid ?? page?.data?.cid
  if (cid) {
    const p2 = await (await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { headers: H })).json()
    const list = p2?.data?.subtitle?.subtitles ?? []
    if (list.length) {
      const u = list[0].subtitle_url ?? list[0].url
      const url = String(u).startsWith('//') ? 'https:' + u : String(u)
      const sub = await (await fetch(url, { headers: H })).json()
      const body = (sub.body ?? []).map((x) => x.content ?? '').join('\n')
      if (body) { sources.push({ label: '官方字幕', text: body }); console.log(`素材②  官方字幕：${body.length} 字`) }
    } else console.log('素材②  官方字幕：这条没有可用的字幕轨')
  }
} catch { console.log('素材②  官方字幕：取不到（登录态或权限）') }

// ③ OCR 出来的画面文字（取这条 BV 最新的一份）
try {
  const files = fs.readdirSync(SHOTS).filter((f) => f.startsWith(bvid) && f.endsWith('-ocr.txt')).sort()
  const latest = files[files.length - 1]
  if (latest) {
    const body = fs.readFileSync(path.join(SHOTS, latest), 'utf8')
    sources.push({ label: `画面OCR(${latest})`, text: body })
    console.log(`素材③  画面 OCR：${body.length} 字（${latest}）`)
  } else console.log('素材③  画面 OCR：还没有（先跑一次 bili-watch / debrief）')
} catch {}

const haystack = norm(sources.map((s) => s.text).join('\n'))
if (!haystack) { console.error('✗ 一条素材都没拿到 —— 没法核验'); process.exit(3) }

// ── 从她写的东西里抽"可核对的东西" ──
// 抽四类：带单位的数字、BV 号、@某人、引号里的原话
const claims = []
const push = (kind, text) => { if (text && !claims.some((c) => c.text === text)) claims.push({ kind, text }) }
for (const m of claimText.matchAll(/\d+(?:\.\d+)?\s*(?:万|亿|千|%|秒|分钟|小时|播放|赞|条|字|元|块|次|个)/g)) push('数字', m[0].replace(/\s+/g, ''))
for (const m of claimText.matchAll(/[￥¥]\s*\d+(?:\.\d+)?/g)) push('金额', m[0].replace(/\s+/g, ''))
for (const m of claimText.matchAll(/BV[0-9A-Za-z]{10}/g)) push('BV号', m[0])
for (const m of claimText.matchAll(/@([^\s，。、,;；:：)）]{1,16})/g)) push('@人', m[1])
for (const m of claimText.matchAll(/[「“"]([^」”"]{6,40})[」”"]/g)) push('引文', m[1])

if (!claims.length) { console.log('（没抽到可核对的内容：没有数字、BV 号、@人、引号原话）'); process.exitCode = 0 }
else {
  const bad = []
  console.log(`\n核对 ${claims.length} 条：`)
  for (const c of claims) {
    const ok = haystack.includes(norm(c.text))
    if (!ok) bad.push(c)
    console.log(`  ${ok ? '✓' : '✗'} [${c.kind}] ${c.text}`)
  }
  if (!bad.length) {
    console.log('\n✓ 全部能在素材里找到 —— 这条总结没有凭空造出来的数字/名字/原话')
    process.exitCode = 0
  } else {
    console.log(`\n✗ ${bad.length} 条在素材里找不到 —— 要么改成"我可能记错"，要么回去看原文：`)
    for (const c of bad) console.log(`   · [${c.kind}] ${c.text}`)
    console.log('（素材：标题/简介 + 官方字幕 + 画面 OCR；不确定的内容请标成"不确定"而不是写成事实）')
    process.exitCode = 5
  }
}
