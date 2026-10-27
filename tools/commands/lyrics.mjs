// 歌词（2026-10-27 加，方案 A：让她"听见"一首歌）
//
// 为什么需要：她是文本模型，听不到旋律 ✗；但**歌在唱什么**可以给她 ——
//   ① 官方字幕轨（要登录，她现在 -101，取不到）
//   ② 画面里烧录的字幕（`bili-watch --lyrics` 抽文字带，能读到一部分）
//   ③ **在线歌词库**（本命令）：按视频标题里的歌名去搜，拿到整首歌词文本 ✓ 最完整
//
// 用法:
//   node bili.mjs lyrics <BV号>              # 从视频标题里抠歌名 → 搜歌词 → 打印 + 存文件
//   node bili.mjs lyrics "人是猫"            # 直接给歌名
//   node bili.mjs lyrics <BV> --raw          # 连 [00:12.34] 时间轴一起打印
//   node bili.mjs lyrics <BV> --limit 5      # 列出候选（调试匹配用）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const OUT = path.join(HOME, '.dsh', 'shots', 'lyrics')
const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else positional.push(argv[i])
}
const arg = positional[0]
if (!arg) { console.error('用法: node bili.mjs lyrics <BV号|歌名> [--raw] [--limit 5]'); process.exit(2) }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cred = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8')) } catch { return null } })()
const BH = cred ? { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}` } : { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

/** 从视频标题里抠歌名 */
function songNameFrom(title) {
  const t = String(title ?? '')
  const bracket = t.match(/[《〈【「]([^》〉】」]{2,40})[》〉】」]/)
  if (bracket) return bracket[1].trim()
  return t
    .replace(/^(【[^】]*】|\[[^\]]*\])/g, '')
    .replace(/deep\s*seek|AI|ai|翻唱|真完整版|完整版|纯音乐|cover|COVER|翻自|原曲|高燃|字幕版/g, ' ')
    .replace(/[，,。.！!？?、~～\-—_/｜|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let song = arg
let bv = null
if (/^BV[0-9A-Za-z]{10}$/.test(arg)) {
  bv = arg
  try {
    const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: BH })).json()
    if (v.code !== 0) { console.error(`取视频信息失败 code=${v.code} ${v.message}`); process.exit(3) }
    const title = v.data.title
    const up = v.data.owner?.name ?? ''
    song = songNameFrom(title)
    console.log(`视频: ${title}`)
    console.log(`UP:   ${up}`)
    console.log(`歌名: ${song}　（从标题里抠的；不对就直接传歌名）`)
  } catch (e) { console.error('取视频信息失败：' + e.message); process.exit(3) }
}

// ── 搜索（网易云公开接口；只读，不登录）──
const mk = () => ({
  headers: { 'user-agent': UA, referer: 'https://music.163.com/', accept: 'application/json' },
})
// 网络抖一下不该让她以为"没歌词" → 重试 3 次（网易云偶尔掐连接）✓
async function getJSON(url, tries = 3) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, mk())
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 700 * (i + 1))) }
  }
  throw last
}
let songs = []
try {
  const j = await getJSON(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(song)}&type=1&limit=${Number(opt.limit) || 5}`)
  songs = j?.result?.songs ?? []
} catch (e) { console.error('搜索失败（重试 3 次）：' + String(e?.message ?? e)); process.exit(4) }
if (!songs.length) {
  console.log(`（没搜到「${song}」的歌词版本）`)
  console.log('  可以试试：`bili.mjs lyrics "完整歌名"`，或者用画面文字：`bili.mjs bili-watch <BV> --lyrics`')
  process.exitCode = 5
} else {
  const artistsOf = (s) => (s.artists ?? []).map((a) => a.name).join('/')
  // 匹配偏好：同名 > 歌名包含 > 名字里带「大肥鱼/鲸鱼」的版本 > 第一个
  const exact = songs.find((s) => s.name === song)
  const contains = songs.find((s) => s.name.includes(song) || song.includes(s.name))
  const pick = exact ?? contains ?? songs[0]
  if (opt.limit) {
    console.log('\n候选：')
    for (const s of songs) console.log(` · ${s.name} — ${artistsOf(s)}  (id=${s.id})`)
  }
  console.log(`\n匹配到: 《${pick.name}》 — ${artistsOf(pick)}  (id=${pick.id})${exact ? '（同名）' : ''}`)
  try {
    const lj = await getJSON(`https://music.163.com/api/song/lyric?id=${pick.id}&lv=1&kv=1&tv=-1`)
    const lrc = String(lj?.lrc?.lyric ?? '')
    const tlyric = String(lj?.tlyric?.lyric ?? '')
    if (!lrc.trim()) {
      console.log('（这个版本没有歌词）')
      process.exitCode = 6
    } else {
      fs.mkdirSync(OUT, { recursive: true })
      const base = path.join(OUT, `${bv ?? song.replace(/[\\/:*?"<>|]/g, '_')}`)
      fs.writeFileSync(`${base}.lrc`, lrc)
      const plain = lrc
        .replace(/^\[[0-9:.]+\]/gm, '')
        .replace(/^\s*作词\s*:.*$/gm, '')
        .replace(/^\s*作曲\s*:.*$/gm, '')
        .replace(/^\s*编曲\s*:.*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      fs.writeFileSync(`${base}.txt`, plain)
      const show = opt.raw ? lrc : plain
      console.log('\n──────────── 歌词 ────────────')
      console.log(show)
      console.log('──────────────────────────────')
      if (tlyric.trim()) {
        console.log('\n（有中文翻译，已存在 .lrc 里）')
      }
      console.log(`\n已存: ${base}.txt${opt.raw ? ' / .lrc' : '（时间轴版在 .lrc）'}`)
      console.log('（她是"读"这份词的 —— 歌的旋律她听不到，但唱了什么、想说什么，这份词能给她）')
      process.exitCode = 0
    }
  } catch (e) { console.error('取歌词失败：' + e.message); process.exit(4) }
}
