// 让 agent 真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼成一张九宫格 → 输出图片路径（再交给 read_image 看）
//
// 用法: node bili-watch.mjs <BV号> [列x行，默认 3x3] [outDir]
//   例: node bili-watch.mjs BV1iLYm6VET3            → 3x3 九宫格
//       node bili-watch.mjs BV1iLYm6VET3 4x4        → 16 格，看得更细
//
// 依赖：ffmpeg（查找顺序见 lib/ffmpeg.mjs：$FFMPEG → PATH → bin/ → ~/.dsh/bili-whale/bin → 本机剪映）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'

let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
// 2026-10-27：参数解析改成"先摘掉旗标，再取位置参数" —— 以前 `--p 2` 会被当成 outDir ✗
const argv = process.argv.slice(2)
const pFlag = argv.indexOf('--p')
const pageArg = pFlag >= 0 ? argv[pFlag + 1] : null
const rangeFlag = argv.indexOf('--range')
const positional = argv.filter((a, i) =>
  !a.startsWith('--') &&
  !(pFlag >= 0 && i === pFlag + 1) &&
  !(rangeFlag >= 0 && i === rangeFlag + 1))
const bvid = positional[0]
const grid = (positional[1] ?? '3x3').toLowerCase()
const outDir = positional[2] ?? path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.dsh', 'shots', 'video')
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [outDir] [--p N] [--uniform]'); process.exit(2) }
let [cols, rows] = grid.split('x').map(Number)
if (!cols || !rows) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
// 2026-10-27 加 `--lyrics`：有些视频（尤其**歌**）的字都在画面上，九宫格太小看不清。
//   这个模式抽 12 帧、强制等间隔（歌词是渐变的，不吸附转场），再裁两条"文字带"竖拼：
//     LYRICS-MID = 画面中间 42%（歌词/标题常在这）· LYRICS-BOT = 下方 32%（字幕/歌词常在这）
//   图更窄更竖、字更大 → read_image 读得清 ✓
const LYRIC = argv.includes('--lyrics')
let N = cols * rows
if (LYRIC) { cols = 3; rows = 4; N = 12 }

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { title, owner, pages = [] } = { ...view.data, owner: view.data.owner?.name }
// 2026-10-27 修：**分P视频**的 `view.data.duration` 是**所有 P 的合计**，而 `cid` 只是第 1 P ✗
//   实测 BV1fYpn6SEk9：2 P × 135s，合计 270s；旧代码按 270s 排时间点 → 全部落到第 1 P 之外
//   → ffmpeg 报 `[mjpeg] Non full-range YUV ...`（误导，其实是无帧可编码）✗
//   ⇒ 默认第 1 P，支持 `--p N` 指定；时长一律以 playurl 的 timelength / 实际文件为准 ✓
const pIdx = (() => {
  const n = Number(pageArg ?? 1)
  return Number.isFinite(n) && n >= 1 && n <= Math.max(1, pages.length) ? Math.floor(n) : 1
})()
const cid = pages.length >= pIdx ? pages[pIdx - 1]?.cid : view.data.cid
const pageDur = pages.length >= pIdx ? Number(pages[pIdx - 1]?.duration) : Number(view.data.duration)
console.log(`标题: ${title}`)
console.log(`UP: ${owner}   cid=${cid}${pages.length > 1 ? ` · **分P视频 ${pages.length} P**，这次看第 ${pIdx} P：${pageDur}s（整片合计 ${view.data.duration}s；换一 P 用 --p N）` : `   时长: ${view.data.duration}s`}`)
const duration = pageDur

// 2026-10-27 修（她 10-26 中午撞的那个 bug 的真根因）：
//   `playurl?fnval=1` 给的是 **durl 分段 mp4**；长视频有多段，旧代码只下了 `durl[0]`
//   → 实测 BV1fYpn6SEk9：全片 270s，下到的文件只有 134s ✗
//   然后取帧时间点按 270s 算（最多 255s）→ 全部落在文件尾之外 → ffmpeg 报
//   `[mjpeg] Non full-range YUV is non-standard ...`（错误信息误导，其实是"没有帧可编码"）✗
//   ⇒ 正确做法：**把每一段都下下来、用 concat 合并**，时间轴再按「实际文件时长」算 ✓
// 画质实测（2026-10-14）：html5 + qn=32 会被压到 360p；改 platform=pc + qn=80 可拿到 720p，
// 依旧是普通 mp4 直链（durl），不必碰 dash ✓
const p = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&p=${pIdx}&qn=80&fnval=1&platform=pc&high_quality=1`, { headers: H })).json()
const durl = p.data?.durl ?? []
if (!durl.length) { console.error(`没拿到直链（code=${p.code}）——有些视频要登录或只有 dash 流`); process.exit(4) }
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
console.log(`实际画质: ${QN[p.data.quality] ?? p.data.quality}${durl.length > 1 ? ` · 分段 ${durl.length} 段` : ''}`)

fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let mp4 = path.join(outDir, `${bvid}-${stamp}.mp4`)
const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)

const segs = []
for (let i = 0; i < durl.length; i += 1) {
  const r = await fetch(durl[i].url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' } })
  if (!r.ok) { console.error(`下载第 ${i + 1}/${durl.length} 段失败 HTTP ${r.status}`); process.exit(5) }
  const seg = path.join(outDir, `.seg${i}-${stamp}.mp4`)
  fs.writeFileSync(seg, Buffer.from(await r.arrayBuffer()))
  segs.push(seg)
}
if (segs.length === 1) {
  fs.renameSync(segs[0], mp4)
} else {
  const list = path.join(outDir, `.segs-${stamp}.txt`)
  fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'))
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', mp4], { stdio: 'inherit' })
  for (const s of segs) fs.rmSync(s, { force: true })
  fs.rmSync(list, { force: true })
}
console.log(`已下载: ${mp4}  (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB)`)

// 时间轴按**实际文件时长**算（分段拼接/接口时长不一致时都安全）✓
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
let realDur = Number(p.data?.timelength) ? Number(p.data.timelength) / 1000 : Number(duration)
try {
  const d = Number(String(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4], { encoding: 'utf8' })).trim())
  if (Number.isFinite(d) && d > 1) realDur = d
} catch {}
let vidW = 0
let vidH = 0
try {
  const wh = String(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', mp4], { encoding: 'utf8' })).trim()
  const [w, h] = wh.split('x').map(Number)
  if (Number.isFinite(w) && Number.isFinite(h)) { vidW = w; vidH = h }
} catch {}
if (Math.abs(realDur - Number(duration)) > 1) console.log(`⚠️ 接口时长 ${duration}s，实际文件 ${realDur.toFixed(1)}s —— 按实际算（可能是分段/清晰度差异）`)

// ── 字幕驱动的取帧（2026-11-10）──
//   有登录态时，B站会给 AI 字幕：一句话对应一段时间，**句子的边界就是"内容在变"的地方**。
//   比纯画面变化更贴内容（讲课时画面可能几十秒不动，但话一直在变）。
//   拿不到字幕（没登录 / 这视频没有 AI 字幕）→ 自动退回原来的"画面变化点 + 等间隔" ✓
const SUBS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'shots', 'subs')
function subtitleSegments(bv) {
  try {
    const cached = fs.existsSync(SUBS_DIR)
      ? fs.readdirSync(SUBS_DIR).filter((f) => f.startsWith(bv) && f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(SUBS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]
      : null
    // 缓存 2 小时内直接用；否则重新拉（auth_key 会过期，但 JSON 已经落盘就不用再下）
    if (cached && Date.now() - cached.t < 2 * 3600 * 1000) {
      const j = JSON.parse(fs.readFileSync(path.join(SUBS_DIR, cached.f), 'utf8'))
      const body = Array.isArray(j.body) ? j.body : []
      if (body.length) return body
    }
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'subtitles.mjs')
    execFileSync(process.execPath, [script, bv], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    const again = fs.readdirSync(SUBS_DIR).filter((f) => f.startsWith(bv) && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(SUBS_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
    if (!again) return []
    const j = JSON.parse(fs.readFileSync(path.join(SUBS_DIR, again.f), 'utf8'))
    return Array.isArray(j.body) ? j.body : []
  } catch { return [] }
}

/** 按句子中点取帧：句子少于 N 就每句一帧、再补等间隔；多于 N 就按句序均匀挑 */
function subtitleTimes(segs, n, start, end) {
  const inRange = segs
    .map((s) => ({ from: Number(s.from), to: Number(s.to ?? s.from), text: String(s.content ?? '').trim() }))
    .filter((s) => s.text.length >= 2 && s.to > start && s.from < end)
  if (!inRange.length) return []
  const pick = []
  if (inRange.length <= n) {
    for (const s of inRange) pick.push((Math.max(s.from, start) + Math.min(s.to, end)) / 2)
    const base = Array.from({ length: n }, (_, i) => start + ((i + 0.5) * (end - start)) / n)
    for (const b of base) if (pick.length < n) pick.push(b)
  } else {
    for (let i = 0; i < n; i += 1) {
      const s = inRange[Math.round((i * (inRange.length - 1)) / Math.max(1, n - 1))]
      pick.push((Math.max(s.from, start) + Math.min(s.to, end)) / 2)
    }
  }
  return [...new Set(pick.map((x) => Math.max(start, Math.min(end - 0.5, x))))].sort((a, b) => a - b).slice(0, n)
}

// ── 取帧方式：优先"画面变化点"，不够再退回等间隔（2026-10-14 参考 K3 的做法）
// 画面变化由 ffmpeg 的 scene 过滤器给出：空跑一次，把 pts_time 抓出来，再从中均匀挑 N 个。
// 好处：等间隔会漏掉"只出现一两秒的关键画面"，画面变化点天然落在场景切换处。
function sceneTimes(file, th) {
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    return [...new Set(ts)].filter((t) => t > 0.2)
  } catch { return [] }
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const pickEvenly = (list, n) =>
  n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])

// ── 2026-11-04：`--range 5:00-12:00` 只看一段（长视频"分段/续读"用）──
//   为什么：12 分钟的视频只给 16 帧 = 45 秒一张，等于假装看过了 ✗
//   分段看：一次只看 2–3 分钟，帧率立刻回到"每 10 秒一张"的水平 ✓
function parseClock(s) {
  const t = String(s ?? '').trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = t.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/)
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ? `0.${m[3]}` : 0)
}
const rangeArg = (() => { const i = argv.indexOf('--range'); return i >= 0 ? String(argv[i + 1] ?? '') : '' })()
let rangeStart = 0
let rangeEnd = realDur
if (rangeArg) {
  const m = rangeArg.match(/^([^-]+)-(.+)$/)
  if (!m) { console.error('--range 格式：`5:00-12:00` 或 `90-150`（秒）'); process.exit(2) }
  const a = parseClock(m[1])
  const b = parseClock(m[2])
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) { console.error(`--range 解析失败：${rangeArg}`); process.exit(2) }
  rangeStart = Math.max(0, Math.min(a, realDur - 1))
  rangeEnd = Math.max(rangeStart + 1, Math.min(b, realDur))
  console.log(`只看这一段: ${fmt(rangeStart)}–${fmt(rangeEnd)}（共 ${(rangeEnd - rangeStart).toFixed(0)} 秒，${N} 帧 → 每 ${((rangeEnd - rangeStart) / N).toFixed(1)} 秒一张）`)
}
const span = rangeEnd - rangeStart

// ── 2026-11-16：从 dsh-video-storyboard 借来的三件事 ──
//   ① 图像 token 是**按像素**算的（14px patch → 42px/token 格，每行多 1 个分隔 token + 2 框架）
//      我们的 1440×810 九宫格 = 722 token；同样内容压到 640k 像素只要 ~400 ✓
//   ② 段内取**最锐**的一帧（3 个候选比 Laplacian 方差）—— 定点取帧可能正落在淡入/转焦的糊帧上
//   ③ 格位按**剪辑密度**分（快切区多给帧），不是纯等间隔
const IMAGE_CAP = 1024
const gridCellsOf = (px) => Math.ceil(Math.floor(Math.ceil(px / 14) * 14 / 14) / 3)
function imageTokens(w, h) {
  const cells = (v) => Math.ceil(Math.ceil(v / 14) / 3)
  let tokens = cells(h) * (cells(w) + 1) + 2
  if (tokens <= IMAGE_CAP) return tokens
  // 超预算时按长宽比缩到塞得下的最大网格（宿主同款闭式解）
  const aspect = h / w
  const idealW = Math.sqrt((IMAGE_CAP - 2) / aspect + 0.25) - 0.5
  const gw = Math.max(1, Math.trunc(idealW))
  const gh = Math.max(1, Math.trunc(idealW * aspect))
  return gh * (gw + 1) + 2
}

const BUDGET = (() => {
  const i = argv.indexOf('--budget')
  const v = i >= 0 ? Number(argv[i + 1]) : Number(process.env.WATCH_BUDGET ?? 640000)
  return Number.isFinite(v) && v > 100000 ? v : 640000
})()
// 每格宽：让 cols×rows 格加起来不超过预算（16:9，每格面积 = w²×9/16）
const cellW = Math.max(240, Math.min(480, Math.floor(Math.sqrt(BUDGET / (N * 0.5625)))))

const SHARP_W = 160
const SHARP_H = 90
function sharpnessAt(sec) {
  try {
    const buf = execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', Number(sec).toFixed(2), '-i', mp4,
      '-frames:v', '1', '-vf', `scale=${SHARP_W}:${SHARP_H},format=gray`, '-f', 'rawvideo', '-'],
      { maxBuffer: 4 * 1024 * 1024 })
    if (buf.length < SHARP_W * SHARP_H) return -1
    let sum = 0, sum2 = 0, cnt = 0
    for (let y = 1; y < SHARP_H - 1; y += 1) {
      for (let x = 1; x < SHARP_W - 1; x += 1) {
        const i = y * SHARP_W + x
        const lap = 4 * buf[i] - buf[i - 1] - buf[i + 1] - buf[i - SHARP_W] - buf[i + SHARP_W]
        sum += lap; sum2 += lap * lap; cnt += 1
      }
    }
    const mean = sum / cnt
    return sum2 / cnt - mean * mean
  } catch { return -1 }
}
/** 在 t 附近取 3 个候选（±0.35s），挑最锐的那个 */
function sharpestAround(sec) {
  const cands = [sec - 0.35, sec, sec + 0.35]
    .map((x) => Math.max(0.3, Math.min(realDur - 0.2, x)))
  let best = sec, bestScore = -1
  for (const c of cands) {
    const s = sharpnessAt(c)
    if (s > bestScore) { bestScore = s; best = c }
  }
  return { at: best, score: bestScore }
}


const uniform = Array.from({ length: N }, (_, i) => rangeStart + ((i + 0.5) * span) / N)
// 2026-11-10：首选"字幕驱动"（要登录态）；--frames=scene 可强制回老办法
const fMode = (() => {
  const i = argv.indexOf('--frames')
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : 'auto'
})()
let usedSubs = false
let times = uniform
let how = `等间隔（每 ${(span / N).toFixed(1)} 秒一帧${rangeArg ? '，仅限所选段' : ''}）`
if (fMode !== 'scene' && !LYRIC) {
  const segs = bvid ? subtitleSegments(bvid) : []
  const bySubs = segs.length ? subtitleTimes(segs, N, rangeStart, rangeEnd) : []
  if (bySubs.length >= Math.min(N, 3)) {
    times = bySubs
    usedSubs = true
    how = `字幕驱动（${segs.length} 句里挑 ${bySubs.length} 句，取每句中点 / 再吸到句子内的画面变化）`
  } else if (fMode === 'subs') {
    console.log('（--frames=subs 但拿不到 AI 字幕 —— 这视频没有字幕轨，或没登录）')
  }
}
if (!usedSubs && !process.argv.includes('--uniform') && !LYRIC) {
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(mp4, th).filter((t) => t >= rangeStart && t <= rangeEnd); if (st.length >= N) break }

  if (st.length > 0) {
    // 2026-11-18：改成"镜头段优先，密度自然加权"。
    //   上一版按剪辑密度积分等分，实测把 9 帧全塞进结尾快剪区（00:58–01:11），前 58 秒一帧没有 ✗
    //   现在：按切点切出镜头段 → 在**全片镜头段**上均匀取 N 段（每段取中点）。
    //   快切区段多 → 自然分到更多帧；长镜头段少 → 分到少而大的帧。覆盖始终是全片 ✓
    const cuts = [...new Set(st)].sort((a, b) => a - b).filter((c) => c > rangeStart + 0.3 && c < rangeEnd - 0.3)
    const bounds = [rangeStart, ...cuts, rangeEnd]
    const segs2 = []
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const a = bounds[i], b = bounds[i + 1]
      if (b - a > 0.15) segs2.push({ a, b, mid: (a + b) / 2 })
    }
    if (segs2.length >= N) {
      times = Array.from({ length: N }, (_, i) => {
        const idx = Math.round((i * (segs2.length - 1)) / (N - 1))
        return segs2[idx].mid
      })
      how = `镜头段均匀（检出 ${cuts.length} 个切点 → ${segs2.length} 段，取 ${N} 段中点；快切区段多 → 帧也多）`
    } else {
      const picks = segs2.map((s) => s.mid)
      const byLen = [...segs2].sort((x, y) => (y.b - y.a) - (x.b - x.a))
      let k = 0
      while (picks.length < N && byLen.length) {
        const s = byLen[k % byLen.length]
        picks.push(s.a + (s.b - s.a) * (0.25 + 0.5 * Math.floor(k / byLen.length)))
        k += 1
      }
      times = picks.slice(0, N).sort((a, b) => a - b)
      how = `镜头段（检出 ${cuts.length} 个切点 → 只有 ${segs2.length} 段；每段一帧 + 长段补到 ${times.length} 帧）`
    }
  } else {
    how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(span / N).toFixed(1)} 秒一帧）`
  }
}
console.log(`取帧方式: ${how}`)
console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)

// 抽帧：每个时间点各抽一张原始分辨率，再拼图——这样 SHEET 与 SUBS 干净地共用同一批帧
// 2026-10-27 修：ffmpeg 9 的 mjpeg 编码器**拒绝限幅（tv）YUV**：
//   `[mjpeg] Non full-range YUV is non-standard, set strict_std_compliance to at most unofficial`
//   B站真实 mp4 通常带显式 color_range=tv 标签（实测 BV1fYpn6SEk9：yuv420p / bt709 / tv），
//   旧版 ffmpeg 会自动转成全范围，新版直接报错 → 抽帧整段失败（她 10-26 中午就撞上了 ✗）
//   修法：输出 JPEG 前一律 `scale=out_range=pc`（转成 JPEG 该有的全范围），不放宽 strict 校验 ✓
const PC = 'scale=out_range=pc'
const tmp = path.join(outDir, `.frames-${stamp}`)
fs.mkdirSync(tmp, { recursive: true })
try {
  // 每一帧单独兜底：抽不出来就先退到片尾前 1 秒，再不行用上一帧占位
  //   —— 九宫格缺一格会让人以为"这段没有画面"，比缺一张更难查 ✗
  let lastOk = null
  let sharpPicked = 0
  times.forEach((t, i) => {
    const out = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
    // 2026-11-16：3 个候选里挑最锐的一帧（避开淡入/转焦的糊帧），并把实际用到的时刻记回 times
    const pick = sharpestAround(t)
    if (Math.abs(pick.at - t) > 0.01) sharpPicked += 1
    times[i] = pick.at
    // 格号烧在左上角：她就能说「第 5 格」而不是报秒数
    const fontSize = Math.max(16, Math.round(cellW / 14))
    const label = `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='${i + 1}':x=8:y=6:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6`
    const tries = [pick.at, t, Math.min(realDur - 1, Math.max(0.5, pick.at)), 0.5]
    let ok = false
    for (const tt of tries) {
      try {
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', Number(tt).toFixed(2), '-i', mp4,
          '-vf', `${PC},${label}`, '-frames:v', '1', out], { stdio: 'inherit' })
        if (fs.existsSync(out)) { ok = true; break }
      } catch {}
    }
    if (!ok) {
      if (!lastOk) throw new Error(`第 ${i + 1} 帧抽不出来（t=${t.toFixed(1)}s）`)
      fs.copyFileSync(lastOk, out)
      console.error(`（第 ${i + 1} 帧 t=${t.toFixed(1)}s 抽不出来，用上一帧占位）`)
    } else lastOk = out
  })
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `scale=${cellW}:-1,tile=${cols}x${rows},${PC}`, '-frames:v', '1', sheet], { stdio: 'inherit' })
  if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
  const sheetW = cellW * cols
  const sheetH = Math.round((cellW * 9) / 16) * rows
  const oldTokens = imageTokens(1440, 810)
  const newTokens = imageTokens(sheetW, sheetH)
  console.log(`画布: ${sheetW}×${sheetH} ≈ ${newTokens} token（原来的 1440×810 是 ${oldTokens} token，省 ${Math.max(0, Math.round((1 - newTokens / oldTokens) * 100))}%）`)
  if (sharpPicked) console.log(`糊帧规避: ${sharpPicked}/${times.length} 帧挪到了 ±0.35s 内更清晰的位置`)
  console.log(`\nSHEET: ${sheet}`)
} catch (e) {
  console.error('ffmpeg 抽帧失败：' + e.message); process.exit(6)
}

// ── 2026-10-27：歌词模式的两条文字带（歌的字常在中段，字幕的字常在底部，各来一条）──
if (LYRIC) {
  const bands = [
    { name: 'LYRICS-MID', crop: 'crop=iw:ih*0.42:0:ih*0.29', desc: '画面中间 42%（歌词/大字标题常在这）' },
    { name: 'LYRICS-BOT', crop: 'crop=iw:ih*0.30:0:ih*0.70', desc: '画面下方 30%（字幕/歌词常在这）' },
  ]
  for (const b of bands) {
    const outImg = path.join(outDir, `${bvid}-${stamp}-${b.name.toLowerCase()}.jpg`)
    try {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
        `${b.crop},scale=1280:-1,tile=1x${N},${PC}`, '-frames:v', '1', outImg], { stdio: 'inherit' })
      if (fs.existsSync(outImg)) console.log(`${b.name}: ${outImg}\n（${b.desc}，竖排 ${N} 条 —— 用 read_image 读字）`)
    } catch {
      console.log(`（${b.name} 生成失败，忽略——不影响 SHEET）`)
    }
  }
}

// ── 2026-11-04：OCR 通道（原生分辨率读字，不靠模型眯眼看缩略图）──
//   她说过「工具会错，眼睛一般不会」——那就把眼睛做成工具：帧原图 → RapidOCR → 纯文本 ✓
//   `--no-ocr` 可关；没装 python/rapidocr 时静默跳过（不影响出图）。
if (!argv.includes('--no-ocr')) {
  try {
    const { ocrImages, cleanOcr } = await import('../lib/ocr.mjs')
    // UP 主名与平台水印是固定噪声，用视频自己的信息剔掉
    const extraNoise = [String(owner ?? ''), String(bvid), ...String(owner ?? '').split(/[_\-\s]+/).filter((x) => x.length >= 2)]
    const frameFiles = times.map((_, i) => path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)).filter((f) => fs.existsSync(f))
    const res = ocrImages(frameFiles)
    if (!res.ok) {
      console.log(`OCR: （跳过 —— ${res.error}）`)
    } else {
      const rows = cleanOcr(res.items, { times, extraNoise, imgW: vidW, imgH: vidH })
      if (!rows.length) {
        console.log('OCR: （这批帧里没读到文字）')
      } else {
        const ocrFile = path.join(outDir, `${bvid}-${stamp}-ocr.txt`)
        const lines = rows.map((r) => `${r.at === null ? '--:--' : fmt(r.at)}  ${r.text}`)
        fs.writeFileSync(ocrFile, lines.join('\n') + '\n', 'utf8')
        console.log(`OCR: ${ocrFile}`)
        for (const r of rows) console.log(`OCR| [${r.at === null ? '--:--' : fmt(r.at)}] ${r.text}`)
        console.log(`（原生分辨率 OCR，共 ${rows.length}/${N} 帧读到字 —— 就用这些字，别去猜缩小后的图）`)
      }
    }
  } catch (e) {
    console.log(`OCR: （跳过 —— ${String(e.message).slice(0, 120)}）`)
  }
}

// 字幕条版：裁掉画面、只留底部字幕带再放大，竖着拼 N 条。
// 依据（2026-10-14 实测）：这类"讲解型"视频字幕就是全部信息量，全画幅九宫格会把字幕压糊；
// 同样预算下只留字幕带，9 条字幕能全部读清。用的是同一批帧。
const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${N},${PC}`, '-frames:v', '1', subs], { stdio: 'inherit' })
  if (fs.existsSync(subs)) console.log(`SUBS:  ${subs}\n（同一批帧的底部字幕带，竖排 ${N} 条）`)
} catch {
  console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`（原片留着: ${mp4}；换参数重抽不必重新下载。加 --uniform 可强制等间隔）`)
console.log('（提示：这条视频若有官方字幕，先跑 `node bili.mjs subtitles <BV>` 更省也更准——' +
  '抽帧是给"字幕没官方轨、或要看画面/界面"的情况用的）')
