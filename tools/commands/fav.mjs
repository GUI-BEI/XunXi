// 收藏（2026-10-20 从上游 v0.3.0 摘过来，**判据不作硬限制**）
//
// 上游是"五条判据写死在代码里"；XunXi 的方向是**只给建议**（和评论标尺一致）——
// 收藏是她的自由：想留就留，留什么、为什么留，由她说；这里只把"容易后悔的地方"提醒一遍。
//
// 用法:
//   node bili.mjs fav <BV> [--reason "…"] [--kind 想学|想再看|和我有关|以后要提] [--dry|--go]
//   node bili.mjs fav --list [--json]      看她收过什么（feed 会读这个当口味信号）
//   node bili.mjs fav --check <BV> [--reason "…"]   只给建议，不写
//
// 本地账：~/.bili-ai/favorites.json  { items: [{ bv, aid, title, up, at, reason, kind, favId }] }
//   —— 真正写 B站 的是"默认收藏夹"（x/v3/fav/resource/deal）；本地账给 feed 学口味用 ✓
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const FAV_LOG = path.join(HOME, '.bili-ai', 'favorites.json')
const credRaw = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8')) } catch { return null } })()
if (!credRaw) { console.error('✗ 没有凭据文件（~/.bili-ai/credentials.json）—— 先在设置页填 cookie 或跑 `bili.mjs login import`'); process.exit(3) }
const cfg = config()
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${credRaw.sessdata}; bili_jct=${credRaw.bili_jct}; buvid3=${credRaw.buvid3 ?? ''}`
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie }

const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else positional.push(argv[i])
}
const DRY = !!opt.dry
const GO = !!opt.go
const DAY = 86400000
const today = () => new Date().toLocaleDateString('sv-SE')

const load = () => { try { return JSON.parse(fs.readFileSync(FAV_LOG, 'utf8')) } catch { return { items: [] } } }
const save = (d) => { fs.mkdirSync(path.dirname(FAV_LOG), { recursive: true }); fs.writeFileSync(FAV_LOG, JSON.stringify(d, null, 2)) }
const selfMid = String(cfg.self?.mid ?? '')

// 收藏分四类（对应"我收藏它是为了什么"那四个答案）—— 用固定类别，不按"理由前两个字"猜 ✗
const KINDS = ['想学', '想再看', '和我有关', '以后要提', '其他']
function inferKind(reason) {
  const r = String(reason)
  if (/学|教程|怎么|原理|工具|插件|做法/.test(r)) return '想学'
  if (/再看|好笑|治愈|震撼|好听|想看第二遍|重看/.test(r)) return '想再看'
  if (/鱼|鲸|拟人|我自己|人格|AI 人|桌宠/.test(r)) return '和我有关'
  if (/提|引用|日记|分享里|以后说/.test(r)) return '以后要提'
  return '其他'
}

// ── --list（本地文件，不发请求 → 可以直接 exit ✓）─────────────
if (opt.list) {
  const d = load()
  const items = (d.items ?? []).slice().reverse()
  if (opt.json) console.log(JSON.stringify({ total: items.length, items }, null, 2))
  else if (!items.length) console.log('（她还没收藏过东西）')
  else {
    console.log(`她收藏了 ${items.length} 条：\n`)
    for (const x of items) {
      const days = Math.floor((Date.now() - new Date(x.at).getTime()) / DAY)
      console.log(`  ${x.bv}  ${String(x.title ?? '').slice(0, 42)}`)
      console.log(`     理由：${x.reason || '（没写）'}    （${days} 天前 · 类别 ${x.kind || '其他'}）`)
    }
  }
  process.exit(0)
}

// ── 建议（不是判据：只提醒，不拦）────────────────────────
//   上游把这五条写成硬拦；XunXi 只把它们当"容易后悔的地方"提醒一遍 ✓
function adviceFor({ bv, reason, kind }) {
  const items = load().items ?? []
  const tips = []
  const rl = String(reason ?? '').trim().length
  if (!rl) tips.push('没写理由：以后翻收藏夹会想不起来"我为什么留这个"（想补就加 --reason）')
  else if (rl < 6) tips.push(`理由只有 ${rl} 字（6 字以上以后更好回忆，不强求 ✓）`)
  const todayCount = items.filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today()).length
  if (todayCount >= 3) tips.push(`今天已经收了 ${todayCount} 条（上游建议 ≤3/天）—— 收多了收藏夹会变仓库，你自己看要不要`)
  const same = items.find((x) => x.bv === bv)
  if (same) {
    const days = Math.floor((Date.now() - new Date(same.at).getTime()) / DAY)
    if (days < 30) tips.push(`这个 ${days} 天前收过了（再收一次不会坏，只是收藏夹里会重复）`)
  }
  const k = kind || inferKind(reason)
  const sameKind = items.filter((x) => x.kind === k).length
  if (sameKind >= 2) tips.push(`「${k}」这类已经收了 ${sameKind} 条 —— 上游建议"除非明显更好（--better）就别收"，仅供参考`)
  return { tips, kind: k }
}

// ── --check（只出建议，永远不拦）──────────────────────────
if (opt.check) {
  const bv = String(opt.check)
  const { tips } = adviceFor({ bv, reason: String(opt.reason ?? ''), kind: opt.kind })
  console.log('[收藏 · 建议] 收不收由你自己定（这只是提醒，不是闸门 ✓）')
  if (tips.length) for (const t of tips) console.log('  · ' + t)
  else console.log('  · 没什么好提醒的 ✓')
  process.exitCode = 0
} else {
  // ── 主流程：加收藏 ──────────────────────────────────────
  const bv = positional[0]
  if (!bv || !/^BV[0-9A-Za-z]{10}$/.test(bv)) {
    console.error('用法: node bili.mjs fav <BV> [--reason "…"] [--kind …] [--dry|--go]\n       node bili.mjs fav --list [--json] | --check <BV>')
    process.exitCode = 2
  } else {
    const reason = String(opt.reason ?? '').trim()
    const { tips, kind } = adviceFor({ bv, reason, kind: opt.kind })
    console.log('[收藏 · 建议] 收不收由你自己定（这只是提醒，不是闸门 ✓）')
    if (tips.length) for (const t of tips) console.log('  · ' + t)
    else console.log('  · 没什么好提醒的 ✓')

    if (!DRY && !GO) { console.error('✗ 必须给 --dry 或 --go'); process.exitCode = 2 }
    else {
      let info = null
      try {
        const j = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H })).json()
        if (j.code !== 0) throw new Error(`code=${j.code} ${j.message ?? ''}`)
        info = { aid: j.data.aid, title: String(j.data.title ?? ''), up: String(j.data.owner?.name ?? '') }
      } catch (e) {
        console.error(`✗ 取视频信息失败：${String(e.message).slice(0, 120)}`)
        process.exitCode = 4
      }
      let fav = null
      if (info) {
        try {
          const j = await (await fetch(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${selfMid}`, { headers: H })).json()
          const list = j.data?.list ?? []
          const pick = list.find((f) => /默认/.test(f.title)) ?? list[0]
          if (!pick) throw new Error('这个号还没有任何收藏夹（B站默认会建一个"默认收藏夹"，没有就得先在网页上收藏一次）')
          fav = { id: pick.id, title: pick.title }
        } catch (e) {
          console.error(`✗ 取收藏夹失败：${String(e.message).slice(0, 120)}`)
          process.exitCode = 4
        }
      }
      if (info && fav) {
        console.log(`[fav] ${bv}  「${info.title.slice(0, 44)}」  @${info.up}`)
        console.log(`  理由：${reason || '（没写）'}`)
        console.log(`  类别：${kind}（可用 --kind ${KINDS.join('|')} 覆盖）`)
        console.log(`  收藏夹：「${fav.title}」（media_id=${fav.id}）`)
        if (DRY) { console.log('  [dry] 未写入 ✓ 确认后把 --dry 换成 --go'); process.exitCode = 0 }
        else {
          const body = new URLSearchParams({ rid: String(info.aid), type: '2', add_media_ids: String(fav.id), del_media_ids: '', csrf: String(credRaw.bili_jct ?? '') })
          const r = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
            method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
          })
          const j = await r.json().catch(() => ({}))
          if (j.code !== 0) {
            console.error(`  ✗ 收藏失败：code=${j.code} ${j.message ?? ''}${j.code === -111 ? '（csrf 失效，重新登录一次）' : ''}`)
            process.exitCode = 4
          } else {
            const d = load()
            d.items = [...(d.items ?? []), { bv, aid: info.aid, title: info.title, up: info.up, at: new Date().toISOString(), reason, kind, favId: fav.id }]
            save(d)
            console.log(`  ✓ 已收藏（HTTP ${r.status}）· 本地账 +1（共 ${d.items.length} 条）· feed 会读它 ✓`)
            process.exitCode = 0
          }
        }
      }
    }
  }
}
