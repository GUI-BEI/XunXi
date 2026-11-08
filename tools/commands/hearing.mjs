// 对照（2026-11-08 加）：画面上的字 vs 耳朵听到的字，让她自己判断哪个更可信
//
// 为什么不是"两段并列"：现在 ASR 换了 faster-whisper-large-v3，两边都靠谱，
//   并列只会浪费她的上下文；**只给冲突项**，一致的不占地方 ✓
//
// 可信度线索（让她有据可依，而不是凭感觉）：
//   · 画面：同一句话在几帧里重复出现（≥2 帧 = 更稳）+ 是否有弹幕噪声被过滤
//   · 声音：whisper 的 avg_logprob（> -0.5 高 / -1.0 以下低）
//
// 用法：
//   node bili.mjs hearing <BV|音视频文件> [--range 0:30-1:20] [--all]（--all = 连一致的也列）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const SHOTS = path.join(HOME, '.dsh', 'shots', 'video')
const OUT = path.join(HOME, '.dsh', 'shots', 'hearing')
const RUNTIME_PY = process.env.ASR_PYTHON || 'D:\\AIWork\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe'
const ASR_SCRIPT = path.join(HERE, '..', 'lib', 'asr-faster.py')
const ASR_MODEL = process.env.ASR_MODEL || 'D:\\AIWork\\faster-whisper-large-v3'
const WATCH = path.join(HERE, 'bili-watch.mjs')

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
if (!src) { console.error('用法: node bili.mjs hearing <BV|文件> [--range a-b] [--all]'); process.exit(2) }

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const parseClock = (s) => {
  const t = String(s ?? '').trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}
const norm = (s) => String(s ?? '').replace(/[\s，。！？、；：“”‘’"'（）()《》…—\-·,.!?;:]/g, '').toLowerCase()
const UI_NOISE = /微信支付|^now$|哔哩哔哩|bilibili|本视频由|updream|订阅|关注|点赞|投币|收藏|转发|弹幕/gi
const stripUi = (s) => String(s ?? '').replace(UI_NOISE, ' ').replace(/\s{2,}/g, ' ').trim()

/**
 * 相似度：最长公共子串 / 较短那一句。
 *
 * 为什么不用二元组 Jaccard（2026-11-08 实测）：画面的字常夹着 UI 噪声、声音那句又更长，
 * Jaccard 会把「小陈先别跑」和「小晨,先别跑,你听我解释一下」算成 0.06 ✗ ——明明就是同一句。
 * 用 LCS 子串、再用较短句归一，就变成 0.6 ✓，能反映"是不是同一句话"。
 */
function sim(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const n = x.length
  const m = y.length
  let best = 0
  const dp = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i += 1) {
    let prev = 0
    for (let j = 1; j <= m; j += 1) {
      const tmp = dp[j]
      if (x[i - 1] === y[j - 1]) {
        dp[j] = prev + 1
        if (dp[j] > best) best = dp[j]
      } else dp[j] = 0
      prev = tmp
    }
  }
  return best / Math.min(n, m)
}

function findVideo(target) {
  if (fs.existsSync(target)) return target
  if (!fs.existsSync(SHOTS)) return null
  const files = fs.readdirSync(SHOTS)
    .filter((f) => f.startsWith(target) && /\.(mp4|m4a|mkv|webm|wav|mp3)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? path.join(SHOTS, files[0].f) : null
}

const video = findVideo(String(src))
if (!video) { console.error(`找不到音视频：${src}（先跑一次 bili-watch）`); process.exit(4) }
const bvid = (path.basename(video).match(/BV[0-9A-Za-z]{10}/) ?? [''])[0]

fs.mkdirSync(OUT, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// ── ① 抽 16k 单声道音频 ──
const wav = path.join(OUT, `${bvid || 'local'}-${stamp}.wav`)
{
  const a = ['-y', '-loglevel', 'error']
  if (typeof opt.range === 'string') {
    const m = opt.range.match(/^([^-]+)-(.+)$/)
    if (m) a.push('-ss', String(parseClock(m[1])), '-to', String(parseClock(m[2])))
  }
  a.push('-i', video, '-vn', '-ac', '1', '-ar', '16000', wav)
  execFileSync('ffmpeg', a, { stdio: 'inherit' })
}

// ── ② 听：faster-whisper ──
console.log('正在听（faster-whisper large-v3）…')
const asrRaw = execFileSync(RUNTIME_PY, [ASR_SCRIPT, wav, '--model', ASR_MODEL, '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 30 * 60 * 1000,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const asr = JSON.parse(asrRaw)
if (asr.error) { console.error('✗ ' + asr.error); process.exit(5) }
const segs = (asr.segments ?? []).filter((s) => s.text && s.text.replace(/[^一-龥a-zA-Z0-9]/g, '').length >= 2)
console.log(`  听到 ${segs.length} 句（语言 ${asr.language}，时长 ${asr.duration}s）`)

// ── ③ 看：给每句 ASR 在它的中点抽一帧，现做 OCR ──
//   2026-11-08 修正：原来复用 bili-watch 的 9 帧 ocr.txt，帧太少 → 11/12 句都"画面没读到"，
//   对照表没意义。现在**按句子抽帧**，两边才是同一句话 ✓
const { ocrImages, cleanOcr } = await import('../lib/ocr.mjs')
const frameDir = path.join(OUT, `frames-${stamp}`)
fs.mkdirSync(frameDir, { recursive: true })
const frames = []
for (let i = 0; i < segs.length; i += 1) {
  const mid = (segs[i].start + segs[i].end) / 2
  const f = path.join(frameDir, `f${String(i + 1).padStart(2, '0')}.jpg`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(mid.toFixed(2)), '-i', video, '-frames:v', '1', '-q:v', '2', f], { stdio: 'ignore' })
    if (fs.existsSync(f)) frames.push({ i, file: f, t: mid })
  } catch { /* 单帧失败不影响其它句 */ }
}
let ocrBySeg = new Map()
if (frames.length) {
  console.log(`正在看（给 ${frames.length} 句各抽一帧做 OCR）…`)
  const res = ocrImages(frames.map((f) => f.file))
  if (!res.ok) {
    console.log(`（画面 OCR 不可用：${res.error}）`)
  } else {
    const cleaned = cleanOcr(res.items, { times: frames.map((f) => f.t), minWidthRatio: 0.1 })
    const byTime = new Map(cleaned.map((c) => [Number(c.at).toFixed(2), c.text]))
    for (const f of frames) ocrBySeg.set(f.i, byTime.get(f.t.toFixed(2)) ?? '')
    fs.rmSync(frameDir, { recursive: true, force: true })
  }
}

// ── ④ 对齐：先按时间窗圈候选，再按**相似度**挑最像的那句 ──
//   2026-11-08 修正：只按"时间最近"会把字幕和台词错配（画面 9 帧很稀，同一时刻常常不是同一句）
const WIN = 8
const MATCH = 0.35   // 相似度够高才算"同一句"
const rows = []
const usedOcr = new Set()
for (const [idx, s] of segs.entries()) {
  const mid = (s.start + s.end) / 2
  const ocrRaw = stripUi(ocrBySeg.get(idx) ?? '')
  // 画面一帧里常有多行（UI + 字幕）：逐行比，取最像的那行（2026-11-08）
  const frags = ocrRaw.split('｜').map((x) => x.trim()).filter(Boolean)
  const score = frags.length ? Math.max(...frags.map((f) => sim(f, s.text))) : 0
  const sameSentence = ocrRaw && score >= MATCH
  const ocrText = ocrRaw || '（画面没读到）'
  const near = sameSentence ? [1] : []
  const conf = Number(s.avg_logprob ?? 0)
  const level = conf > -0.5 ? '高' : conf > -1.0 ? '中' : '低'
  let verdict = '—'
  if (near.length) {
    if (score >= 0.6) verdict = '一致'
    else verdict = level === '低' ? '以画面为准' : '需她判断'
  } else {
    verdict = level === '高' ? '只听得到（画面没抽到）' : '只听得到（可信度低）'
  }
  rows.push({ t: mid, asr: s.text, conf: level, logprob: conf, ocr: ocrText || '（画面没读到）', ocrRepeat: near.length ? 1 : 0, score, verdict })
}

const conflicts = rows.filter((r) => r.verdict === '需她判断')
const agree = rows.filter((r) => r.verdict === '一致')
const asrOnly = rows.filter((r) => r.verdict.startsWith('只听得到'))
const show = opt.all ? rows : [...conflicts, ...asrOnly]

console.log(`\n══════ 对照：${path.basename(video)} ══════`)
console.log(`共 ${rows.length} 句：一致 ${agree.length} · 冲突待判 ${conflicts.length} · 只听得到 ${asrOnly.length}`)
if (!show.length) {
  console.log('（两边完全一致，没有需要她判断的地方 ✓）')
} else {
  for (const r of show.slice(0, 40)) {
    console.log(`\n[${fmt(r.t)}] ${r.verdict}`)
    console.log(`  画面（重复 ${r.ocrRepeat} 帧）：${r.ocr}`)
    console.log(`  声音（可信度 ${r.conf}，logprob ${r.logprob}）：${r.asr}`)
    if (r.score > 0) console.log(`  相似度 ${r.score.toFixed(2)}`)
  }
  if (show.length > 40) console.log(`\n（还有 ${show.length - 40} 条没列，--range 缩小区间）`)
}
console.log('\n（判断原则：画面是烧进视频的字，一般更准；声音在「画面没读到」和「说话没字幕」时才有信息来源。拿不准就写「听不清」。）')
