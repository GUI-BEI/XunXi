// 听懂声音（2026-11-08 加）——本地 Qwen2-Audio，跑在 D:\AIWork\py311
//
// 为什么不是曲线上阵：她要的不是"音高 219Hz"，是"这段是温柔还是敷衍"。
// 曲线只能给形状，给不了判断；所以这里直接上能听音频的模型：
//   音频 → Qwen2-Audio（4bit，8G 显存够）→ 一句人话（说了什么 + 什么情绪 + 有没有唱）
//
// 用法：
//   node bili.mjs audio <BV号|音视频文件> [--range 0:30-1:20] [--ask "自定义问题"]
//   node bili.mjs audio <BV> --segments "0:10-0:30,1:00-1:20"   # 分段各问一次
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'shots', 'video')
const TMP = path.join(process.env.USERPROFILE || '.', '.dsh', 'shots', 'audio')
const PY_CANDS = [process.env.AUDIO_PYTHON, 'D:\\AIWork\\py311\\python.exe'].filter(Boolean)
const SCRIPT = path.join(HERE, '..', 'lib', 'audio-qwen.py')
const MODEL = process.env.AUDIO_MODEL || 'D:\\AIWork\\Qwen2-Audio-7B-Instruct'

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
if (!src) { console.error('用法: node bili.mjs audio <BV号|文件> [--range a-b] [--ask "…"]'); process.exit(2) }

const python = PY_CANDS.find((p) => { try { return fs.existsSync(p) } catch { return false } })
if (!python) { console.error('找不到 python（预期 D:\\AIWork\\py311\\python.exe；可用 AUDIO_PYTHON 指定）'); process.exit(3) }
if (!fs.existsSync(MODEL)) { console.error(`模型还没准备好：${MODEL}\n（正在下的那个 setup-omni.ps1 跑完就有）`); process.exit(3) }
if (!fs.existsSync(path.join(MODEL, 'model.safetensors.index.json')) && !fs.existsSync(path.join(MODEL, 'model-00005-of-00005.safetensors'))) {
  console.error(`模型文件还没下完：${MODEL}`); process.exit(3)
}

/** BV → 本地的 mp4（bili-watch 默认会把原片留下） */
function findVideo(target) {
  if (fs.existsSync(target)) return target
  if (!/^BV[0-9A-Za-z]{10}$/.test(target)) return null
  if (!fs.existsSync(SHOTS)) return null
  const files = fs.readdirSync(SHOTS)
    .filter((f) => f.startsWith(target) && /\.(mp4|m4a|mkv|webm|wav|mp3)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? path.join(SHOTS, files[0].f) : null
}

const video = findVideo(String(src))
if (!video) {
  console.error(`找不到可用的音视频：${src}\n先跑一次 \`node bili.mjs bili-watch ${src} 2x2\`（它会把原片留在 ~/.dsh/shots/video）`)
  process.exit(4)
}

fs.mkdirSync(TMP, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = path.basename(video).replace(/\.[^.]+$/, '')

function parseClock(s) {
  const t = String(s ?? '').trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

const segs = []
if (typeof opt.segments === 'string') {
  for (const part of opt.segments.split(',')) {
    const m = part.trim().match(/^([^-]+)-(.+)$/)
    if (!m) continue
    const a = parseClock(m[1])
    const b = parseClock(m[2])
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) segs.push([a, b])
  }
} else if (typeof opt.range === 'string') {
  const m = opt.range.match(/^([^-]+)-(.+)$/)
  if (m) {
    const a = parseClock(m[1])
    const b = parseClock(m[2])
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) segs.push([a, b])
  }
}
// 2026-11-08：模型对 ≤30 秒的音频最稳；长视频自动挑 3 段（前中后），避免"一口气喂 3 分钟"
const AUTO_SEG = 22
function durationOf(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  } catch { return 0 }
}
if (!segs.length) {
  const dur = durationOf(video)
  if (dur > AUTO_SEG * 1.6) {
    const picks = [0.15, 0.5, 0.85].map((r) => Math.max(0, Math.min(dur - AUTO_SEG, r * dur)))
    for (const s of picks) segs.push([Number(s.toFixed(1)), Number((s + AUTO_SEG).toFixed(1))])
    console.log(`（视频 ${dur.toFixed(0)}s，自动挑 3 段：${segs.map(([a, b]) => `${Math.round(a)}–${Math.round(b)}s`).join('、')}）`)
  } else {
    segs.push([0, dur])
  }
}
const jobs = segs

const wavs = []
for (const [a, b] of jobs) {
  const label = b > 0 ? `${base}-${String(a).replace('.', '_')}-${String(b).replace('.', '_')}` : base
  const out = path.join(TMP, `${label}-${stamp}.wav`)
  const args = ['-y', '-loglevel', 'error']
  if (b > 0) args.push('-ss', String(a), '-to', String(b))
  args.push('-i', video, '-vn', '-ac', '1', '-ar', '16000', out)
  execFileSync('ffmpeg', args, { stdio: 'inherit' })
  if (!fs.existsSync(out)) { console.error('抽音轨失败'); process.exit(5) }
  wavs.push(out)
}

console.log(`音频：${wavs.length} 段 · 来源 ${path.basename(video)}`)
const ask = typeof opt.ask === 'string' ? opt.ask : undefined
const pyArgs = [SCRIPT, ...wavs, '--model', MODEL, '--json']
if (ask) pyArgs.push('--ask', ask)

const t0 = Date.now()
const out = execFileSync(python, pyArgs, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30 * 60 * 1000,
  env: { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONWARNINGS: 'ignore', TQDM_DISABLE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],   // 2026-11-08：把 python 的警告收进管道，别混进给她的正文
})
const results = JSON.parse(out)
if (results.error) { console.error('✗ ' + results.error); process.exit(6) }

const noteFile = path.join(TMP, `${base}-${stamp}-audio.txt`)
const lines = []
for (const r of results) {
  console.log(`\n【${path.basename(r.wav)}】`)
  if (r.error) { console.log('  (失败：' + r.error + ')'); continue }
  console.log('  ' + r.answer.replace(/\n/g, '\n  '))
  lines.push(`=== ${path.basename(r.wav)} ===\n${r.answer}`)
}
fs.writeFileSync(noteFile, lines.join('\n\n') + '\n', 'utf8')
console.log(`\n（用时 ${Math.round((Date.now() - t0) / 1000)}s · 原文已存 ${noteFile}）`)
