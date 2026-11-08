// 听歌（2026-11-08）——**只对音乐分区的视频**做音乐/歌词分析
//
// 为什么要有这道门（阿墨定的）：
//   · 大多数视频里 BGM 对人类也只是旋律背景，听清歌词没有意义
//   · 环境声（风声/雨声/脚步）被 whisper 硬转成文字，是纯噪声污染
//   · 所以：**B站分区是音乐（tid 3/28/29/30/31/59/130/193/243）或标题写明是歌，才走这里**
//     没有分区、没有关键词 → 当普通视频处理，直接退出（要强行分析加 --force）
//
// 用法：
//   node bili.mjs music <BV|音视频文件> [--force] [--ask "…"]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const TMP = path.join(HOME, '.dsh', 'shots', 'music')
const SHOTS = path.join(HOME, '.dsh', 'shots', 'video')
const PY = process.env.AUDIO_PYTHON || 'D:\\AIWork\\py311\\python.exe'
const ASR_PY = process.env.ASR_PYTHON || 'D:\\AIWork\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe'
const ASR_SCRIPT = path.join(HERE, '..', 'lib', 'asr-faster.py')
const QWEN_SCRIPT = path.join(HERE, '..', 'lib', 'audio-qwen.py')
const ASR_MODEL = process.env.ASR_MODEL || 'D:\\AIWork\\faster-whisper-large-v3'
const QA_MODEL = process.env.AUDIO_MODEL || 'D:\\AIWork\\Qwen2-Audio-7B-Instruct'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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
const src = positional[0]
if (!src) { console.error('用法: node bili.mjs music <BV|文件> [--force]'); process.exit(2) }

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const BV = /^BV[0-9A-Za-z]{10}$/

// 音乐相关分区（B站 tid）：3 音乐 · 28 原创音乐 · 29 演奏 · 30 VOCALOID · 31 翻唱 ·
//   59 音乐现场 · 130 音乐综合 · 193 MV · 243 乐评
const MUSIC_TIDS = new Set([3, 28, 29, 30, 31, 59, 130, 193, 243])
const MUSIC_WORDS = /翻唱|cover|COVER|歌曲|单曲|原曲|填词|改编|纯音乐|伴奏|BGM|ost|主题曲|片头曲|片尾曲|remix|MV|PV/i

function findVideo(target) {
  if (fs.existsSync(target)) return target
  if (!fs.existsSync(SHOTS)) return null
  const files = fs.readdirSync(SHOTS)
    .filter((f) => f.startsWith(target) && /\.(mp4|m4a|mkv|webm|wav|mp3)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? path.join(SHOTS, files[0].f) : null
}

/** 只抓音频流（比整段视频省得多）；缓存复用 */
async function fetchAudio(bvid) {
  const cached = path.join(TMP, `${bvid}.m4a`)
  if (fs.existsSync(cached) && fs.statSync(cached).size > 100000) return cached
  fs.mkdirSync(TMP, { recursive: true })
  const h = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
  const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: h })).json()
  if (v.code !== 0) throw new Error('取视频信息失败 ' + v.code)
  const cid = v.data.pages?.[0]?.cid ?? v.data.cid
  const pu = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`, { headers: h })).json()
  const audios = pu?.data?.dash?.audio ?? []
  if (!audios.length) throw new Error('没有音频流（可能需要登录）')
  const best = audios.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
  const buf = Buffer.from(await (await fetch(best.baseUrl || best.base_url, { headers: h })).arrayBuffer())
  if (buf.length < 50000) throw new Error('音频下载太小，可能被拦')
  fs.writeFileSync(cached, buf)
  return cached
}

let video = findVideo(String(src))
let bvid = BV.test(String(src)) ? String(src) : ''
if (!video && bvid) {
  console.log('本地没有这条视频，只抓音频流…')
  try { video = await fetchAudio(bvid) } catch (e) { console.error('✗ ' + String(e.message).slice(0, 160)); process.exit(4) }
}
if (!video) { console.error(`找不到音视频：${src}`); process.exit(4) }
if (!bvid) bvid = (path.basename(video).match(/BV[0-9A-Za-z]{10}/) ?? [''])[0]

// ── ① 判定：只看"是不是音乐分区/标题写明" ──
let title = path.basename(video)
let tid = 0
let tname = ''
if (bvid) {
  try {
    const j = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })).json()
    if (j.code === 0) {
      title = j.data.title ?? title
      tid = Number(j.data.tid ?? 0)
      tname = j.data.tname ?? ''
    }
  } catch { /* 网络不好就只看标题 */ }
}
const isMusic = MUSIC_TIDS.has(tid) || MUSIC_WORDS.test(title)
console.log(`《${title}》${tid ? ` · 分区 tid ${tid}${tname ? '（' + tname + '）' : ''}` : ''}`)

if (!isMusic && !opt.force) {
  console.log('\n判定：不是音乐分区 → 当普通视频处理。')
  console.log('（BGM 只要旋律，不需要歌词；风声雨声也不转成文字 ✓ 要强行分析加 --force）')
  process.exit(0)
}
console.log('判定：音乐分区 → 做音乐分析')

fs.mkdirSync(TMP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const wav = path.join(TMP, `${bvid || 'local'}-${stamp}.wav`)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: 'inherit' })

// ── ② 情绪与编制（Qwen2-Audio）──
const ask = typeof opt.ask === 'string'
  ? opt.ask
  : '你在听一段歌。用三四句话回答：①这是什么样的歌（风格、速度、情绪）；②主要用了哪些乐器或声音；③人声是男是女、唱得轻松还是用力、有没有明显的高潮或转调。不要转写歌词，不要编造没听见的东西。'
const qaRaw = execFileSync(PY, [QWEN_SCRIPT, wav, '--model', QA_MODEL, '--ask', ask, '--json'], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000,
  env: { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONWARNINGS: 'ignore' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
console.log('\n══════ 这首歌听起来是什么样 ══════')
for (const r of JSON.parse(qaRaw)) console.log(r.answer || `(失败：${r.error})`)

// ── ③ 歌词：库版（带时间轴）优先；改词版自动改用听写 ──
console.log('\n══════ 歌词 ══════')
let libLyrics = ''
let libName = ''
try {
  const q = (title.match(/[《「]([^》」]{2,20})[》」]/) ?? [, title])[1].replace(/(翻唱|cover|COVER|完整版|真完整|高燃|字幕版)/g, '').trim()
  const r = await (await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`)).json()
  const hit = Array.isArray(r) ? r.find((x) => x.syncedLyrics || x.plainLyrics) : null
  if (hit) {
    libLyrics = hit.syncedLyrics || hit.plainLyrics || ''
    libName = `${hit.trackName} — ${hit.artistName}`
    console.log(`库版：${libName}（${hit.syncedLyrics ? '带时间轴' : '纯文本'}）`)
  } else console.log(`库版：没找到「${q}」`)
} catch (e) { console.log(`库版：查询失败（${String(e.message).slice(0, 60)}）`) }

const asr = JSON.parse(execFileSync(ASR_PY, [ASR_SCRIPT, wav, '--model', ASR_MODEL, '--json'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
}))
const heard = (asr.segments ?? []).filter((s) => (s.text ?? '').replace(/[^一-龥a-zA-Z0-9]/g, '').length >= 2)
const heardText = heard.map((s) => s.text).join(' ')
console.log(`听写：${heard.length} 句`)

function bigrams(s) {
  const x = String(s ?? '').replace(/\[\d{1,2}:\d{2}(\.\d+)?\]/g, '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
  const out = new Set()
  for (let i = 0; i < x.length - 1; i += 1) out.add(x.slice(i, i + 2))
  return out
}
function coverage(heardStr, lib) {
  const h = bigrams(heardStr)
  const l = bigrams(lib)
  if (!h.size) return 0
  let hit = 0
  for (const g of h) if (l.has(g)) hit += 1
  return hit / h.size
}

const ratio = libLyrics ? coverage(heardText, libLyrics) : 0
if (libLyrics) console.log(`听写的字能在库版里找到 ${(ratio * 100).toFixed(0)}%`)
if (libLyrics && ratio >= 0.25) {
  console.log('（以库版为准 —— 带时间轴，听写只用来核对）')
  console.log(libLyrics.split('\n').slice(0, 40).join('\n'))
} else if (!heard.length) {
  console.log('（听不出歌词 —— 更像纯音乐/哼唱；上面那段「听起来是什么样」就是全部信息）')
} else {
  console.log(libLyrics ? '（库版对不上 → 大概率改过词，以**听写**为准）' : '（库里没有 → 以**听写**为准）')
  for (const s of heard.slice(0, 24)) console.log(`[${fmt(s.start)}] ${s.text}`)
}
console.log(`\n（音轨已存 ${wav}；想再问别的：--ask "…"）`)
