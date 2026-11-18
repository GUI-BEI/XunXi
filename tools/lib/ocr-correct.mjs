// 用画面硬字幕校正听写（2026-11-18）——借鉴自 dsh-video-storyboard 的 ocr-subs.js
//
// 为什么需要：ASR 会把同音字听错（"老实挣 TOKEN" → "老师正偷偷看 TOKEN"），而画面上
// 就是原文。但**不能见到 OCR 就当对的** —— 实测踩过的坑：OCR 把"这是一句话"读成
// "这是一旬话"，13 字对 13 字、cover 0.92，照换就把一条正确的台词改错了。
//
// 所以三条都成立才替换：① OCR 置信度 ≥0.65 ② 长度差不多（gap ≤0.5）
// ③ 相似度落在区间内（单句 ≥0.6 / 多分句 ≥0.7）。其余一律保留 ASR 原文。
// ——宁可留一个已知的错字，也不要引入一个来源不明的句子。

const clean = (x) => String(x ?? '').replace(/[\s，。、！？；：""''（）()…—]/g, '').toLowerCase()

/** 最长公共子序列长度 */
function lcsLength(a, b) {
  const A = String(a), B = String(b)
  if (!A.length || !B.length) return 0
  let prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0)
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[B.length]
}

/** LCS 区间的起止（用来剪掉字幕带里带进来的邻句） */
function lcsMatch(a, b) {
  const A = String(a), B = String(b)
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
  for (let i = 1; i <= A.length; i += 1) {
    for (let j = 1; j <= B.length; j += 1) {
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  let i = A.length, j = B.length
  let hi = -1, lo = -1
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) { if (hi < 0) hi = j - 1; lo = j - 1; i -= 1; j -= 1 }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i -= 1
    else j -= 1
  }
  return { lo: Math.max(0, lo), hi: hi < 0 ? B.length - 1 : hi }
}

/** 按标点把 ASR 的长段切成"分句" */
export function splitClauses(asr) {
  const text = String(asr ?? '')
  const out = []
  const re = /[，。、！？；：,.!?;:]/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ start: last, end: m.index, text: text.slice(last, m.index) })
    last = m.index + 1
  }
  if (last < text.length) out.push({ start: last, end: text.length, text: text.slice(last) })
  return out.filter((c) => clean(c.text).length >= 2)
}

/**
 * 这一句听写该不该被 OCR 覆盖？
 * @returns {{replace:boolean, reason:string, text?:string, cover?:number}}
 */
export function shouldReplace({ asr, ocr, conf }) {
  const A = clean(asr)
  const B = clean(ocr)
  if (B.length < 2) return { replace: false, reason: 'empty-ocr' }
  if (!(conf >= 0.65)) return { replace: false, reason: 'low-conf' }
  if (A.length === 0) return { replace: true, reason: 'asr-empty', text: String(ocr).trim() }

  // 一条字幕带里常常留着上下两句 → 先切碎再挑最吻合的那块
  const pieces = String(ocr).split(/[，。、！？；,;!?\n]/).map((x) => clean(x)).filter((x) => x.length >= 2)
  const candidates = pieces.length ? pieces : [B]

  const clauses = splitClauses(asr)
  const units = clauses.length ? clauses : [{ start: 0, end: String(asr ?? '').length, text: String(asr ?? '') }]
  let best = null
  for (const clause of units) {
    const clauseClean = clean(clause.text)
    if (!clauseClean.length) continue
    for (const piece of candidates) {
      const cover = lcsLength(clauseClean, piece) / clauseClean.length
      const gap = Math.abs(clauseClean.length - piece.length) / Math.max(clauseClean.length, piece.length)
      if (!best || cover > best.cover + 1e-9 || (Math.abs(cover - best.cover) <= 1e-9 && gap < best.gap - 1e-9)) {
        best = { cover, gap, clause, clauseClean, piece }
      }
    }
  }
  if (!best) return { replace: false, reason: 'unrelated', cover: 0 }

  const { cover } = best
  // 先问"是不是同一句"，再问"长度像不像"
  if (cover > 0.98 && best.piece.length <= best.clauseClean.length) return { replace: false, reason: 'agree' }
  // 长度完全相同、只差一个字 → 不换。
  // 分不清是 ASR 同音错还是 OCR 形近错，而代价不对称：不换最多留一个已知的错字，
  // 换了可能亲手把对的字改错（原项目曾因此把 13 字的正确台词改错）。
  // 比原项目更保守：不管 cover 多少，只要"同长度且只差 1 个字"就不动。
  if (best.piece.length === best.clauseClean.length) {
    let diff = 0
    for (let i = 0; i < best.piece.length; i += 1) if (best.piece[i] !== best.clauseClean[i]) diff += 1
    if (diff <= 1) return { replace: false, reason: 'agree-near', cover: +cover.toFixed(2) }
  }
  if (cover >= 0.88 && best.piece.length === best.clauseClean.length) {
    return { replace: false, reason: 'agree-near', cover: +cover.toFixed(2) }
  }
  const minCover = units.length > 1 ? 0.7 : 0.6
  if (cover < minCover) return { replace: false, reason: 'unrelated', cover: +cover.toFixed(2) }
  if (best.gap > 0.5) return { replace: false, reason: 'length-gap', cover: +cover.toFixed(2) }

  // 多出来的字明显多于这一分句 → 带子把邻句也截进来了，按匹配区间剪
  const match = lcsMatch(best.clauseClean, best.piece)
  const replacement = best.piece.length - best.clauseClean.length > 2
    ? best.piece.slice(Math.max(0, match.lo - 1), Math.min(best.piece.length, match.hi + 2))
    : best.piece

  if (units.length <= 1) return { replace: true, reason: 'ocr-covers-asr', cover: +cover.toFixed(2), text: replacement }
  const original = String(asr ?? '')
  const text = original.slice(0, best.clause.start) + replacement + original.slice(best.clause.end)
  if (text === original) return { replace: false, reason: 'agree' }
  return { replace: true, reason: 'ocr-covers-asr', cover: +cover.toFixed(2), text }
}

/**
 * 对一批听写行做 OCR 校正。
 * @param {Array<{text:string}>} lines ASR 段（会被就地更新 text）
 * @param {Array<{text:string, score:number}>} ocrLines 这一段的画面硬字幕候选
 * @returns {{changed:number, log:string[]}}
 */
export function correctLines(lines, ocrLines) {
  const log = []
  let changed = 0
  if (!ocrLines.length) return { changed, log }
  for (const seg of lines) {
    let best = null
    for (const cand of ocrLines) {
      const r = shouldReplace({ asr: seg.text, ocr: cand.text, conf: cand.score })
      if (r.replace && (!best || (r.cover ?? 0) > (best.cover ?? 0))) best = { ...r, from: cand.text }
    }
    if (best?.text && best.text !== seg.text) {
      log.push(`改：「${seg.text.slice(0, 24)}」→「${best.text.slice(0, 24)}」（cover ${best.cover}）`)
      seg.text = best.text
      changed += 1
    }
  }
  return { changed, log }
}
