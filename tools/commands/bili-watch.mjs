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
const positional = argv.filter((a, i) => !a.startsWith('--') && !(pFlag >= 0 && i === pFlag + 1))
const bvid = positional[0]
const grid = (positional[1] ?? '3x3').toLowerCase()
const outDir = positional[2] ?? path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.dsh', 'shots', 'video')
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [outDir] [--p N] [--uniform]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
if (!cols || !rows) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
const N = cols * rows

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
if (Math.abs(realDur - Number(duration)) > 1) console.log(`⚠️ 接口时长 ${duration}s，实际文件 ${realDur.toFixed(1)}s —— 按实际算（可能是分段/清晰度差异）`)

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

const uniform = Array.from({ length: N }, (_, i) => ((i + 0.5) * realDur) / N)
let times = uniform
let how = `等间隔（每 ${(realDur / N).toFixed(1)} 秒一帧）`
if (!process.argv.includes('--uniform')) {
  // 阈值阶梯：录屏/讲解类画面变化平缓，0.3 常只检出几处 → 逐级放宽
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(mp4, th); if (st.length >= N) break }

  if (st.length > 0) {
    // 关键设计（2026-10-14 踩过两次才定）：
    //   ① 只按"变化点里均匀挑"会出事——转场全挤在开头，中段 50 秒一帧没有，叙事线直接断
    //   ② 只按等间隔会漏掉"只闪一两秒的关键画面"
    //   ⇒ 用**等间隔当骨架保证覆盖**，再把每帧**吸附到 ±半格内最近的变化点**（吸不到就保持等间隔）
    const half = realDur / N / 2
    let snapped = 0
    times = uniform.map((u) => {
      const near = st.filter((s) => Math.abs(s - u) <= half)
      if (!near.length) return u
      snapped += 1
      return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
    })
    how = `等间隔骨架（保覆盖）+ 吸附画面变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了变化点）`
  } else {
    how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(realDur / N).toFixed(1)} 秒一帧）`
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
  times.forEach((t, i) => {
    const out = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
    const tries = [t, Math.min(realDur - 1, Math.max(0.5, t)), 0.5]
    let ok = false
    for (const tt of tries) {
      try {
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', Number(tt).toFixed(2), '-i', mp4,
          '-vf', PC, '-frames:v', '1', out], { stdio: 'inherit' })
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
    `scale=480:-1,tile=${cols}x${rows},${PC}`, '-frames:v', '1', sheet], { stdio: 'inherit' })
  if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
  console.log(`\nSHEET: ${sheet}`)
} catch (e) {
  console.error('ffmpeg 抽帧失败：' + e.message); process.exit(6)
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
