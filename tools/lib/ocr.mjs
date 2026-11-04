// OCR 通道（2026-11-04 加）——让"画面上的字"变成可靠的文本，而不是靠模型眯着眼看图
//
// 为什么需要：九宫格里每帧只有 480px 宽，字幕/界面小字会糊；而她自己说过
//   「工具会错，眼睛一般不会」——那就把"眼睛"做成工具：原生分辨率 → OCR → 纯文本 ✓
//
// 依赖：python + rapidocr-onnxruntime（本地推理，不联网）
//   装法：pip install rapidocr-onnxruntime
//   自定义解释器：环境变量 OCR_PYTHON（或 PYTHON）指向 python.exe
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'ocr.py')
const PYTHON_CANDS = [process.env.OCR_PYTHON, process.env.PYTHON, 'python', 'python3'].filter(Boolean)

/** 找到一个真能 `import rapidocr_onnxruntime` 的解释器；找不到返回 null（静默降级） */
export function ocrPython() {
  for (const py of PYTHON_CANDS) {
    try {
      execFileSync(py, ['-c', 'import rapidocr_onnxruntime'], { stdio: 'ignore', timeout: 30_000 })
      return py
    } catch {
      // 试下一个
    }
  }
  return null
}

/**
 * 对一批图片做 OCR。
 *
 * @param {string[]} files - 图片路径（原生分辨率效果最好）。
 * @returns {{ ok: boolean, python?: string, items?: {file: string, lines: {text: string, score: number}[]}[], error?: string }}
 */
export function ocrImages(files) {
  if (!files.length) return { ok: true, items: [] }
  const py = ocrPython()
  if (!py) return { ok: false, error: '没有可用的 python + rapidocr-onnxruntime（pip install rapidocr-onnxruntime）' }
  try {
    const out = execFileSync(py, [SCRIPT, ...files], {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    const parsed = JSON.parse(out)
    if (parsed && !Array.isArray(parsed) && parsed.error) return { ok: false, python: py, error: String(parsed.error) }
    return { ok: true, python: py, items: Array.isArray(parsed) ? parsed : [] }
  } catch (e) {
    return { ok: false, python: py, error: String(e.message).slice(0, 200) }
  }
}

/** 常见噪声：UP 主名、平台水印、纯符号、纯数字时间轴 */
const NOISE = [
  /^bilibili$/i,
  /bilibili\.com/i,
  /^[-—_\s.·|/\\]+$/,
  /^(弹幕|关注|收藏|投币|点赞|分享|评论|发送|全屏|设置)$/,
]

export function isNoiseLine(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.length <= 1) return true
  if (NOISE.some((re) => re.test(t))) return true
  return false
}

/**
 * 过滤 + 去重 + 保持"哪一秒出现过什么字"。
 *
 * @param {{file: string, lines: {text: string, score: number}[]}[]} items OCR 结果。
 * @param {{ minScore?: number, minWidthRatio?: number, imgW?: number, imgH?: number, extraNoise?: (string|RegExp)[], times?: number[] }} options
 * @returns {{ at: number|null, text: string }[]}
 */
export function cleanOcr(items, options = {}) {
  const minScore = Number(options.minScore ?? 0.55)
  const imgW = Number(options.imgW ?? 0)
  const imgH = Number(options.imgH ?? 0)
  const minWidthRatio = Number(options.minWidthRatio ?? 0.12)
  const extra = (options.extraNoise ?? []).map((n) => (n instanceof RegExp ? n : new RegExp(escapeRe(String(n)), 'i')))
  const times = options.times ?? []
  const out = []
  items.forEach((item, idx) => {
    const seen = new Set()
    const texts = []
    for (const line of item.lines ?? []) {
      if (Number(line.score ?? 0) < minScore) continue
      if (isNoiseLine(line.text)) continue
      if (extra.some((re) => re.test(String(line.text)))) continue
      // 弹幕是这里最大的噪声：一堆 4–12 字的短句、挤在右上。
      // 判据是**形状**而不是长短：字幕/标题是"横贯画面的宽条"，弹幕是"小块"。
      if (line.box && imgW > 0) {
        const w = Number(line.box.x1) - Number(line.box.x0)
        const h = Math.max(1, Number(line.box.y1) - Number(line.box.y0))
        const wide = w / imgW >= minWidthRatio
        const lineLike = w / h >= 2.2          // 扁平 → 像一行字幕，不像一坨弹幕
        const lowEnough = imgH > 0 && Number(line.box.y0) / imgH >= 0.45   // 字幕通常在画面下半
        if (!(wide && lineLike) && !(lowEnough && lineLike)) continue
      }
      const t = String(line.text).replace(/\s+/g, ' ').trim()
      if (seen.has(t)) continue
      seen.add(t)
      texts.push({ t, score: Number(line.score ?? 0) })
    }
    if (texts.length) {
      // 每帧最多留 6 条，按置信度取，避免弹幕糊满
      const kept = texts.sort((a, b) => b.score - a.score).slice(0, 6).map((x) => x.t)
      out.push({ at: times[idx] ?? null, text: kept.join(' ｜ ') })
    }
  })
  return out
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 是否存在可用的 OCR 环境（给 deps / selftest 用） */
export function ocrInfo() {
  const py = ocrPython()
  return { ok: !!py, python: py, hint: py ? null : 'pip install rapidocr-onnxruntime（或设 OCR_PYTHON 指向 python.exe）' }
}

export { fs }
