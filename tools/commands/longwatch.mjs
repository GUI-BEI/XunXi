// 长视频分段看（2026-11-18）——和短视频分开：一次只看一段，下次接着
//
// 为什么必须分开：
//   · 30 分钟压进一张九宫格 = 每格 2 分钟，等于假装看过 ✗
//   · 一整片 15–18k token，她一次醒来吃不下；分段后一段约 2–3k
//   · 关键差别是**进度**：看到第几段要记住（像 novel 的块）
//
// 用法：
//   node bili.mjs longwatch <BV>                # 出分段计划（只扫描，不取帧）
//   node bili.mjs longwatch <BV> --next         # 看下一段（出一张该段九宫格 + 该段字幕）
//   node bili.mjs longwatch <BV> --seek 5       # 直接看第 5 段
//   node bili.mjs longwatch <BV> --seg 240      # 每段 4 分钟（默认 300）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { transcribeChunked } from '../lib/asr-transcribe.mjs'
import { correctLines } from '../lib/ocr-correct.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const ROOT = path.join(HOME, '.dsh', 'shots', 'longwatch')
const SUBS = path.join(HOME, '.dsh', 'shots', 'subs')
const ASR_PY = process.env.ASR_PYTHON || 'D:\\AIWork\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe'
const ASR_SCRIPT = path.join(HERE, '..', 'lib', 'asr-faster.py')
const ASR_MODEL = process.env.ASR_MODEL || 'D:\\AIWork\\faster-whisper-large-v3'
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
const bvid = positional[0]
if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('用法: node bili.mjs longwatch <BV> [--next|--seek N|--seg 300]'); process.exit(2) }

const SEG = Math.max(120, Number(opt.seg ?? 300))
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

fs.mkdirSync(ROOT, { recursive: true })
const videoFile = path.join(ROOT, `${bvid}.mp4`)
const stateFile = path.join(ROOT, `${bvid}.json`)

/** 只下视频流（取帧够用），下过一次就复用 */
async function ensureVideo() {
  if (fs.existsSync(videoFile) && fs.statSync(videoFile).size > 500000) return videoFile
  const h = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
  const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: h })).json()
  if (v.code !== 0) throw new Error('取视频信息失败 ' + v.code)
  const cid = v.data.pages?.[0]?.cid ?? v.data.cid
  const pu = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`, { headers: h })).json()
  const vids = (pu?.data?.dash?.video ?? []).filter((x) => x.height <= 720).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
  if (!vids.length) throw new Error('没有可用的视频流（可能需要登录）')
  const url = vids[0].baseUrl || vids[0].base_url
  console.log(`下载视频流 ${vids[0].height}P（一次性，之后复用）…`)
  const buf = Buffer.from(await (await fetch(url, { headers: h })).arrayBuffer())
  if (buf.length < 500000) throw new Error('视频下载太小，可能被拦')
  fs.writeFileSync(videoFile, buf)
  return videoFile
}

/** 音频流（视频流没有音轨！听写必须用它）—— 也只下一次 */
async function ensureAudio() {
  const audioFile = path.join(ROOT, bvid + '.m4a')
  if (fs.existsSync(audioFile) && fs.statSync(audioFile).size > 100000) return audioFile
  const h = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
  const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: h })).json()
  const cid = v.data.pages?.[0]?.cid ?? v.data.cid
  const pu = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`, { headers: h })).json()
  const audios = (pu?.data?.dash?.audio ?? []).sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
  if (!audios.length) throw new Error('没有音频流（可能需要登录）')
  const url = audios[0].baseUrl || audios[0].base_url
  const buf = Buffer.from(await (await fetch(url, { headers: h })).arrayBuffer())
  if (buf.length < 100000) throw new Error('音频下载太小')
  fs.writeFileSync(audioFile, buf)
  return audioFile
}

function durationOf(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  } catch { return 0 }
}

/** 字幕句子的边界（有就用它当分段候选点）；没有就现拉一份（有登录态时） */
function sentenceBounds() {
  try {
    const files = fs.existsSync(SUBS) ? fs.readdirSync(SUBS).filter((f) => f.startsWith(bvid) && f.endsWith('.json')) : []
    if (!files.length) return []
    const j = JSON.parse(fs.readFileSync(path.join(SUBS, files[0]), 'utf8'))
    return (j.body ?? []).map((x) => ({ from: Number(x.from), to: Number(x.to ?? x.from), text: String(x.content ?? '') }))
  } catch { return [] }
}

/** 分段：理想边界落在 SEG 的倍数上，吸附到最近的句子边界（±20% 段长内） */
function planSegments(dur, sentences) {
  const cuts = []
  for (let t = SEG; t < dur - SEG * 0.4; t += SEG) {
    const near = sentences.filter((s) => Math.abs((s.from + s.to) / 2 - t) <= SEG * 0.2)
    if (near.length) {
      const best = near.reduce((b, s) => (Math.abs((s.from + s.to) / 2 - t) < Math.abs((b.from + b.to) / 2 - t) ? s : b))
      cuts.push(best.from)
    } else cuts.push(t)
  }
  const bounds = [0, ...cuts.filter((c) => c > 1 && c < dur - 1), dur]
  const out = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const a = bounds[i], b = bounds[i + 1]
    if (b - a < 20) continue
    out.push({ no: out.length + 1, from: Number(a.toFixed(1)), to: Number(b.toFixed(1)) })
  }
  return out
}

function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null } }
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 1), 'utf8') }

/** 一段的台词：优先 AI 字幕；没有就**听写**（faster-whisper，切片在静音中点） */
function segmentTranscript(video, seg, sentences, outDir) {
  const fromSubs = sentences.filter((s) => s.to > seg.from && s.from < seg.to)
  if (fromSubs.length) {
    return { source: 'AI 字幕', lines: fromSubs.map((s) => `[${fmt(s.from)}] ${s.text}`) }
  }
  // 没有字幕轨 → 抽这一段音频去听写（2026-11-18 补：以前这里就直接"只能看画面"了 ✗）
  try {
    const wav = path.join(outDir, `seg${String(seg.no).padStart(2, '0')}-audio.wav`)
    const audioSrc = fs.existsSync(path.join(ROOT, bvid + '.m4a')) ? path.join(ROOT, bvid + '.m4a') : video
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(seg.from), '-to', String(seg.to), '-i', audioSrc,
      '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: 'ignore' })
    const asr = transcribeChunked({ wav, python: ASR_PY, script: ASR_SCRIPT, model: ASR_MODEL, tmpDir: outDir })
    const lines = (asr.segments ?? [])
      .filter((s) => (s.text ?? '').replace(/[^一-龥a-zA-Z0-9]/g, '').length >= 2)
      .map((s) => `[${fmt(s.start + seg.from)}] ${s.text}`)
    try { fs.unlinkSync(wav) } catch {}
    if (lines.length) return { source: `听写（faster-whisper，${asr.chunks ?? 1} 片）`, lines }
  } catch (e) {
    return { source: '无（听写失败）', lines: [], error: String(e.message).slice(0, 120) }
  }
  return { source: '无（这段没有语音内容）', lines: [] }
}

function subtitleTextIn(segs, a, b) {
  const lines = segs.filter((s) => s.to > a && s.from < b)
  return lines.map((s) => `[${fmt(s.from)}] ${s.text}`).join('\n')
}

/** 取一段的九宫格（3×3，编号烧在左上角） */
function renderSegment(video, seg, sentences) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(ROOT, bvid)
  const tmp = path.join(outDir, `.frames-${stamp}`)
  fs.mkdirSync(tmp, { recursive: true })
  const inRange = sentences.filter((s) => s.to > seg.from && s.from < seg.to)
  const N = 9
  let times
  if (inRange.length >= N) {
    times = Array.from({ length: N }, (_, i) => {
      const s = inRange[Math.round((i * (inRange.length - 1)) / (N - 1))]
      return (s.from + s.to) / 2
    })
  } else {
    times = Array.from({ length: N }, (_, i) => seg.from + ((i + 0.5) * (seg.to - seg.from)) / N)
  }
  // 2026-11-18：格子宽度按"预算/画幅"算 —— 竖屏视频用 355 会得到 1065×1893（2M 像素 ≈ 1000 token）
  let vidW = 1280, vidH = 720
  try {
    const wh = String(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video], { encoding: 'utf8' })).trim()
    const [w, h] = wh.split('x').map(Number)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) { vidW = w; vidH = h }
  } catch {}
  const BUDGET = Number(opt.budget ?? 640000)
  const cellW = Math.max(200, Math.min(480, Math.floor(Math.sqrt(BUDGET / (9 * (vidH / vidW))))))
  const frameFiles = []
  times.forEach((t, i) => {
    const out = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
    frameFiles.push(out)
    const label = `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='${i + 1}':x=8:y=6:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6`
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', Number(t).toFixed(2), '-i', video,
      '-vf', `scale=out_range=pc,${label}`, '-frames:v', '1', out], { stdio: 'ignore' })
  })
  const sheet = path.join(outDir, `${bvid}-seg${String(seg.no).padStart(2, '0')}-${stamp}-3x3.jpg`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `scale=${cellW}:-1,tile=3x3,scale=out_range=pc`, '-frames:v', '1', sheet], { stdio: 'ignore' })
  const sheetW = cellW * 3
  const sheetH = Math.round(cellW * (vidH / vidW)) * 3
  const tokens = Math.ceil(Math.ceil(sheetH / 14) / 3) * (Math.ceil(Math.ceil(sheetW / 14) / 3) + 1) + 2
  // 临时帧先留一会儿：听写要用它们做 OCR 校正，之后调用方负责删
  return { sheet, times, tokens, w: sheetW, h: sheetH, frames: frameFiles, tmp }
}

try {
  const video = await ensureVideo()
  const dur = durationOf(video)
  try { await ensureAudio() } catch (e) { console.log('（音频没下到，没字幕的段就没法听写：' + String(e.message).slice(0, 60) + '）') }
  let sentences = sentenceBounds()
  if (!sentences.length && bvid) {
    console.log('（还没有字幕，现拉一份…）')
    try {
      const script = path.join(HERE, 'subtitles.mjs')
      execFileSync(process.execPath, [script, bvid], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
      sentences = sentenceBounds()
      if (sentences.length) console.log(`  拿到 ${sentences.length} 句字幕`)
    } catch { console.log('  （拉不到字幕 —— 没登录或这视频没有 AI 字幕）') }
  }
  let st = loadState()
  if (!st) {
    st = { bvid, duration: dur, seg: SEG, segments: planSegments(dur, sentences), done: [], notes: {} }
    saveState(st)
  }
  const segs = st.segments
  const perSegTokens = 407 + Math.round(SEG / 60) * 350
  console.log(`《${st.bvid}》 时长 ${fmt(dur)} · 分 ${segs.length} 段（每段 ≤ ${Math.round(SEG / 60)} 分钟）· 已完成 ${st.done.length} 段`)
  if (!opt.next && !opt.seek) {
    console.log('\n分段计划（只扫描，不取帧）：')
    for (const s of segs) {
      const mark = st.done.includes(s.no) ? '✓' : ' '
      const sc = sentences.filter((x) => x.to > s.from && x.from < s.to).length
      console.log(`  ${mark} 第 ${String(s.no).padStart(2)} 段  ${fmt(s.from)}–${fmt(s.to)}  ${String(Math.round(s.to - s.from)).padStart(4)}s  字幕 ${sc} 句`)
    }
    console.log(`\n每段大约 ${perSegTokens} token（图 407 + 字幕）。看一段：\`node bili.mjs longwatch ${bvid} --next\``)
    console.log('（叙事片建议一次看一段；想跳着看：`--seek N`）')
    process.exit(0)
  }

  const target = opt.seek ? Number(opt.seek) : (segs.find((s) => !st.done.includes(s.no))?.no ?? null)
  if (!target) { console.log('全部看完了 ✓ 想重看某段：--seek N'); process.exit(0) }
  const seg = segs.find((s) => s.no === target)
  if (!seg) { console.error(`没有第 ${target} 段（共 ${segs.length} 段）`); process.exit(2) }

  console.log(`\n▶ 第 ${seg.no}/${segs.length} 段：${fmt(seg.from)}–${fmt(seg.to)}`)
  const { sheet, tokens, w: sw, h: sh, frames, times, tmp: tmpFrames } = renderSegment(video, seg, sentences)
  const outDirSeg = path.join(ROOT, bvid)
  const tr = segmentTranscript(video, seg, sentences, outDirSeg)
  // 2026-11-18：听写出来的字用**画面硬字幕**校一遍（借鉴 dsh-video-storyboard 的 ocr-subs）
  if (tr.source.startsWith('听写') && tr.lines.length && frames?.length) {
    try {
      const { ocrImages, cleanOcr } = await import('../lib/ocr.mjs')
      // 只读底部 22%：硬字幕在那里，上面的弹幕/水印不读（也更快）
      const bands = frames.map((f, i) => {
        const out = path.join(path.dirname(f), 'band' + String(i).padStart(2, '0') + '.jpg')
        try {
          execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', 'crop=iw:ih*0.30:0:ih*0.70', '-frames:v', '1', out], { stdio: 'ignore' })
          return out
        } catch { return f }
      })
      const res = ocrImages([...frames, ...bands])
      if (res.ok) {
        const rows = cleanOcr(res.items, { times, extraNoise: [] })
        const ocrLines = rows.map((r) => ({ text: String(r.text ?? ''), score: Number(r.score ?? 0) }))
        const segObjs = tr.lines.map((l) => ({ text: l.replace(/^\[[0-9:]+\]\s*/, ''), prefix: l.replace(/^(\[[0-9:]+\]\s*).*$/, '$1') }))
        const fix = correctLines(segObjs, ocrLines)
        if (fix.changed) {
          tr.lines = segObjs.map((s) => s.prefix + s.text)
          console.log(`\n（用画面硬字幕校正了 ${fix.changed} 句）`)
          for (const l of fix.log.slice(0, 5)) console.log('  ' + l)
        } else if (ocrLines.length) {
          console.log(`（画面读到 ${ocrLines.length} 行字，没有需要改的句子）`)
        }
      }
    } catch (e) { console.log('（OCR 校正跳过：' + String(e.message).slice(0, 80) + '）') }
  }
  const text = tr.lines.join('\n')
  console.log(`SHEET: ${sheet}`)
  console.log(`画布 ${sw}×${sh} ≈ ${tokens} token`)
  if (text) {
    console.log(`\n── 这一段说了什么（${tr.source}）──`)
    console.log(text.split('\n').slice(0, 60).join('\n'))
    if (text.split('\n').length > 60) console.log(`…（还有 ${text.split('\n').length - 60} 行，下一段接着）`)
  } else {
    console.log(`（这一段没有可读的台词：${tr.error ?? tr.source}。画面靠 SHEET，声音细节用 \`node bili.mjs hearing ${bvid}\`）`)
  }
  // 清理临时帧（OCR 校正之后才删）
  try { fs.rmSync(tmpFrames, { recursive: true, force: true }) } catch {}
  if (!st.done.includes(seg.no)) st.done.push(seg.no)
  st.done.sort((a, b) => a - b)
  saveState(st)
  const nextNo = segs.find((s) => !st.done.includes(s.no))?.no
  console.log(`\n进度：${st.done.length}/${segs.length} 段` + (nextNo ? ` · 下次：--next（第 ${nextNo} 段）` : ' · 全看完了 ✓'))
} catch (e) {
  console.error('✗ ' + String(e.message).slice(0, 240))
  process.exit(1)
}
