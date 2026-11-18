// ASR 切片转写（2026-11-18）——从 dsh-video-storyboard 借来的做法
//
// 为什么不能整段丢给 whisper：
//   · 实测（作者数据）299 秒单请求会把时间码整体**压早 13 秒**
//   · 纯音乐段容易吐出一条几十秒的假台词
// 做法：按 ≤45 秒切片、**切点落在静音中点**（固定切会把词劈两半），每片单独转写，
//   再把每片的时间轴加上偏移 —— 时间码才是准的 ✓
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function durationOf(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  } catch { return 0 }
}

/** 静音区间的中点（silencedetect 的输出） */
function silenceMidpoints(file) {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-35dB:d=0.25', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    const starts = [...out.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]))
    const ends = [...out.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
    const mids = []
    for (const e of ends) {
      const prev = starts.filter((s) => s < e).pop()
      if (prev !== undefined) mids.push((prev + e) / 2)
    }
    return mids
  } catch (e) {
    // silencedetect 把结果打到 stderr —— execFileSync 正常返回时拿不到，必须容错
    const txt = String(e?.stderr ?? '')
    const starts = [...txt.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]))
    const ends = [...txt.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
    const mids = []
    for (const e of ends) {
      const prev = starts.filter((s) => s < e).pop()
      if (prev !== undefined) mids.push((prev + e) / 2)
    }
    return mids
  }
}

/** 按静音中点把 [0, dur] 切成 ≤maxChunk 的窗口 */
export function chunkWindows(dur, mids, { maxChunk = 45, minChunk = 8 } = {}) {
  if (dur <= maxChunk) return [[0, dur]]
  const wins = []
  let cursor = 0
  while (dur - cursor > maxChunk) {
    const lo = cursor + Math.max(minChunk, maxChunk * 0.5)
    const hi = cursor + maxChunk
    const cands = mids.filter((m) => m > lo && m < hi)
    const cut = cands.length
      ? cands.reduce((b, m) => (Math.abs(m - hi) < Math.abs(b - hi) ? m : b), cands[0])
      : hi
    wins.push([cursor, cut])
    cursor = cut
  }
  wins.push([cursor, dur])
  return wins
}

/**
 * 转写（自动切片）。返回 { language, duration, segments }，segments 的时间已按整段对齐。
 */
export function transcribeChunked({ wav, python, script, model, maxChunk = 45, tmpDir }) {
  if (!fs.existsSync(wav)) throw new Error('音频不存在: ' + wav)
  const dur = durationOf(wav)
  const mids = dur > maxChunk ? silenceMidpoints(wav) : []
  const wins = chunkWindows(dur, mids, { maxChunk })
  const segments = []
  let language = 'zh'
  let chunks = 0
  for (const [a, b] of wins) {
    let target = wav
    if (wins.length > 1) {
      target = path.join(tmpDir ?? path.dirname(wav), `chunk-${Math.round(a * 10)}-${Math.round(b * 10)}.wav`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(a), '-to', String(b), '-i', wav, '-ac', '1', '-ar', '16000', target],
        { stdio: 'ignore' })
    }
    const raw = execFileSync(python, [script, target, '--model', model, '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const j = JSON.parse(raw)
    if (j.error) throw new Error(j.error)
    language = j.language ?? language
    for (const s of j.segments ?? []) {
      segments.push({ ...s, start: Number((s.start + a).toFixed(2)), end: Number((s.end + a).toFixed(2)) })
    }
    chunks += 1
    if (target !== wav) { try { fs.unlinkSync(target) } catch {} }
  }
  segments.sort((x, y) => x.start - y.start)
  return { language, duration: dur, segments, chunks, windows: wins.map(([a, b]) => `${fmt(a)}-${fmt(b)}`) }
}
