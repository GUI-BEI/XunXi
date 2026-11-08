// 听歌（2026-11-08 加）——和"听懂说话"分开：**只有歌曲类视频才走这里**
//
// 为什么要分：
//   · 大多数视频的 BGM 对人类也只是旋律背景，听清歌词没有意义
//   · 环境声（风声/雨声/脚步）被 whisper 硬转成文字，是纯粹的噪声污染
//   · 歌曲才需要：情绪 + 编制 + 歌词（而且是"改过词的二创"也要能识别出来）
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

function findVideo(target) {
  if (fs.existsSync(target)) return target
  if (!fs.existsSync(SHOTS)) return null
  const files = fs.readdirSync(SHOTS)
    .filter((f) => f.startsWith(target) && /\.(mp4|m4a|mkv|webm|wav|mp3)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? path.join(SHOTS, files[0].f) : null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** 只抓音频流（比整段视频省得多）；缓存到 TMP 里复用 */
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
  const url = best.baseUrl || best.base_url
  const buf = Buffer.from(await (await fetch(url, { headers: h })).arrayBuffer())
  if (buf.length < 50000) throw new Error('音频下载太小，可能被拦')
  fs.writeFileSync(cached, buf)
  return cached
}

let video = findVideo(String(src))
if (!video && /^BV[0-9A-Za-z]{10}$/.test(String(src))) {
  console.log('本地没有这条视频，只抓音频流…')
  try { video = await fetchAudio(String(src)) } catch (e) { console.error('✗ ' + String(e.message).slice(0, 160)); process.exit(4) }
}
if (!video) { console.error(`找不到音视频：${src}（先跑一次 bili-watch）`); process.exit(4) }
const bvid = (path.basename(video).match(/BV[0-9A-Za-z]{10}/) ?? [''])[0]

// ── ① 判定：这是不是"歌" ──
let title = ''
let tname = ''
if (bvid) {
  try {
    const j = JSON.parse(execFileSync(process.execPath, ['-e', `
      fetch('https://api.bilibili.com/x/web-interface/view?bvid=${bvid}', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' } })
        .then(r => r.json()).then(j => console.log(JSON.stringify({ title: j.data?.title ?? '', tname: j.data?.tname ?? '', dur: j.data?.duration ?? 0 })))
    `], { encoding: 'utf8', timeout: 20000 }).trim())
    title = j.title ?? ''
    tname = j.tname ?? ''
  } catch { /* 网络不好就靠标题猜 */ }
}
const MUSIC_ZONE = /音乐|翻唱|演奏|MV|VOCALOID|原创音乐/
const MUSIC_WORDS = /翻唱|cover|COVER|歌曲|单曲|原曲|二创|填词|改编|MV|PV|纯音乐|伴奏|BGM|ost|主题曲|片头|片尾|remix/i
const isMusic = MUSIC_ZONE.test(tname) || MUSIC_WORDS.test(title)
console.log(`《${title || path.basename(video)}》${tname ? ' · 分区：' + tname : ''}`)
if (isMusic) console.log('判定：歌曲类（走音乐分析）')
if (!isMusic && !opt.force) {
  // 2026-11-08：标题/分区没写"歌"，不代表不是歌（实测 BV1bGJR6HErW 就是这样）。
  //   让他自己听一句："有唱歌吗？" —— 一次约 25 秒，只在"拿不准"的时候问。
  console.log('\n标题/分区没写是歌，先听一句确认…')
  try {
    fs.mkdirSync(TMP, { recursive: true })
    const probe = path.join(TMP, `probe-${bvid || 'local'}.wav`)
    if (!fs.existsSync(probe)) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '5', '-t', '20', '-i', video, '-vn', '-ac', '1', '-ar', '16000', probe], { stdio: 'ignore' })
    }
    const r = execFileSync(PY, [QWEN_SCRIPT, probe, '--model', QA_MODEL, '--ask',
      '这段音频里有没有人在唱歌？只回答一句：有唱歌/没有唱歌，并说明有没有人说话、有没有音乐。', '--json'], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000,
      env: { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONWARNINGS: 'ignore' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ans = (JSON.parse(r)[0]?.answer ?? '').trim()
    console.log('  它说：' + ans)
    if (!/有唱歌/.test(ans) || /没有唱歌/.test(ans)) {
      console.log('\n判定：不是歌 —— 普通视频的 BGM 只要旋律，不输出歌词、也不逐句转写 ✓')
      process.exit(0)
    }
    console.log('判定：听到了唱歌 → 按歌曲处理')
  } catch (e) {
    console.log('（确认失败：' + String(e.message).slice(0, 80) + '）')
    console.log('普通视频里 BGM 只要旋律，不需要歌词 —— 这里不输出歌词。真要强行分析，加 --force。')
    process.exit(0)
  }
}

fs.mkdirSync(TMP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const wav = path.join(TMP, `${bvid || 'local'}-${stamp}.wav`)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: 'inherit' })

// ── ② 情绪与编制（Qwen2-Audio，问法按"听歌"来）──
const ask = typeof opt.ask === 'string'
  ? opt.ask
  : '你在听一段歌。用三四句话回答：①这是什么样的歌（风格、速度、情绪）；②主要用了哪些乐器或声音；③人声是男是女、唱得轻松还是用力、有没有明显的高潮或转调。不要转写歌词，不要编造没听见的东西。'
const qaRaw = execFileSync(PY, [QWEN_SCRIPT, wav, '--model', QA_MODEL, '--ask', ask, '--json'], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000,
  env: { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONWARNINGS: 'ignore' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const qa = JSON.parse(qaRaw)
console.log('\n══════ 这首歌听起来是什么样 ══════')
for (const r of qa) console.log(r.answer || `(失败：${r.error})`)

// ── ③ 歌词：库版（带时间轴）vs 听写版（二创改词时以听写为准）──
console.log('\n══════ 歌词 ══════')
let libLyrics = ''
try {
  const q = (title.match(/[《「]([^》」]{2,20})[》」]/) ?? [, title])[1].replace(/(翻唱|cover|COVER|完整版|真完整|高燃|字幕版)/g, '').trim()
  const r = await (await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`)).json()
  const hit = Array.isArray(r) ? r.find((x) => x.syncedLyrics || x.plainLyrics) : null
  if (hit) {
    libLyrics = hit.syncedLyrics || hit.plainLyrics || ''
    console.log(`库版：${hit.trackName} — ${hit.artistName}（${hit.syncedLyrics ? '带时间轴' : '纯文本'}）`)
  } else {
    console.log(`库版：没找到「${q}」`)
  }
} catch (e) { console.log(`库版：查询失败（${String(e.message).slice(0, 60)}）`) }

const asrRaw = execFileSync(ASR_PY, [ASR_SCRIPT, wav, '--model', ASR_MODEL, '--json'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
})
const asr = JSON.parse(asrRaw)
const heard = (asr.segments ?? []).filter((s) => (s.text ?? '').replace(/[^一-龥a-zA-Z0-9]/g, '').length >= 2)
console.log(`听写：${heard.length} 句`)
const heardText = heard.map((s) => s.text).join(' ')

// 二创改词判断：**听写里的字，有多大比例能在库版里找到**（bigram 覆盖率）
//   2026-11-08 修正：原来用"最长公共子串 / 较短句"，对长文本几乎恒为 0.0x，
//   把同一首歌判成"改词版" ✗。覆盖率才对：同一首歌词 ≈ 0.3–0.7；不相干 ≈ 0.0x。
function bigrams(s) {
  const x = String(s ?? '')
    .replace(/\[\d{1,2}:\d{2}(\.\d+)?\]/g, '')   // 时间轴
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')       // 只留字
    .toLowerCase()
  const out = new Set()
  for (let i = 0; i < x.length - 1; i += 1) out.add(x.slice(i, i + 2))
  return { x, out }
}
function coverage(heard, lib) {
  const h = bigrams(heard)
  const l = bigrams(lib)
  if (!h.out.size) return 0
  let hit = 0
  for (const g of h.out) if (l.out.has(g)) hit += 1
  return hit / h.out.size
}
const ratio = libLyrics ? coverage(heardText, libLyrics) : 0
const useHeard = !libLyrics || ratio < 0.25
console.log(`听写的字能在库版里找到 ${(ratio * 100).toFixed(0)}%${libLyrics ? (useHeard ? ' ← 太低，按改词版处理' : ' ← 对得上，以库版为准') : ''}`)
if (libLyrics && !useHeard) {
  console.log('（以库版为准 —— 带时间轴，听写只用来核对）')
  console.log(libLyrics.split('\n').slice(0, 40).join('\n'))
} else if (!heard.length) {
  console.log('（听不出歌词 —— 更像纯音乐/哼唱，没有可转写的字；上面那段「听起来是什么样」就是全部信息）')
} else {
  console.log('（以**听写**为准 —— 库版对不上，大概率是改过词的版本）')
  for (const s of heard.slice(0, 24)) console.log(`[${fmt(s.start)}] ${s.text}`)
}
console.log(`\n（音轨已存 ${wav}；想再问别的：--ask "…"）`)
