// 依赖体检（2026-10-17 加）：装完之后让 agent 自己跑一次，确认"能不能用"
//
// 用法：
//   node deps.mjs            人读版（每项 ✓/✗ + 怎么修）
//   node deps.mjs --json     机器读版（agent 判断用）
//
// 退出码：0 = 全可用；3 = 有缺的（缺的那项会写明补救办法）
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegInfo } from '../lib/ffmpeg.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const cred = path.join(HOME, '.bili-ai', 'credentials.json')
const asJson = process.argv.includes('--json')

const items = []

// ① 凭据（cookie）：**真去请求一次 nav** —— 只查"字段齐不齐"是不够的（cookie 会过期 ✗）
// ② 2026-10-19 补：SESSDATA 里那个时间戳（`<sid>,<exp>,<sig>…` 的第 2 段）只是**上限**，
//    服务端随时能提前作废（被踢设备 / 改密码 / 浏览器退出登录 / 风控）——
//    实测见过"还剩 179 天"却 `code=-101 账号未登录` 的 cookie ✗
//    所以这里既报上限，也报**真实可用性**，并在失效时指明最短重登路径（login import）✓
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sessExp = (s) => {
  try { const n = Number(decodeURIComponent(String(s || '')).split(',')[1]); return n > 1e9 ? n : null } catch { return null }
}
let credOk = false, credNote = ''
let c = null
// 2026-10-20：读文件和问 nav **分开 catch** —— 以前一个 catch 包住两件事，
//   网络抖一下就会显示"没有或读不了凭据文件"（把人往错方向带 ✗）
try { c = JSON.parse(fs.readFileSync(cred, 'utf8')) } catch { c = null }
if (!c) credNote = `没有或读不了凭据文件（${cred}）`
else {
  const miss = ['sessdata', 'bili_jct'].filter((k) => !c[k] || !String(c[k]).trim())
  if (miss.length) { credNote = `缺字段：${miss.join(', ')}` }
  else {
    let nav = null
    try {
      nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}` },
      })).json()
    } catch (e) {
      credNote = `凭据读到了，但问 nav 失败（网络/风控，不是 cookie 的问题）：${String(e.message).slice(0, 100)}`
    }
    if (nav) {
      const exp = sessExp(c.sessdata)
      const days = exp ? Math.round((exp * 1000 - Date.now()) / 86400000) : null
      const tail = exp ? `\n  SESSDATA 上限 ${new Date(exp * 1000).toLocaleDateString('sv-SE')}（剩 ~${days} 天，只是上限）` : ''
      credOk = nav.code === 0 && !!nav.data?.isLogin
      credNote = credOk
        ? `已登录：${nav.data.uname}（mid ${nav.data.mid}）${tail}`
        : `cookie 无效：code=${nav.code} ${nav.message ?? ''}${tail}\n  —— 服务端已登出（≠ 抄错：被踢设备 / 改密码 / 浏览器退出登录 / 风控都会这样）；重登：node bili.mjs login import`
    }
  }
}
items.push({
  name: 'B站 cookie',
  ok: credOk,
  detail: credNote,
  fix: '最省事的重登：浏览器登录后整段复制 cookie → `node bili.mjs login import`（自动抠字段 + 真验一次 + 写凭据）；也可以回设置页手填三段。SESSDATA 会被服务端提前作废，别把它当长期令牌',
})

// ② ffmpeg（抽帧看画面）
const ff = ffmpegInfo()
items.push({
  name: 'ffmpeg（抽帧看画面）',
  ok: ff.ok,
  detail: ff.ok ? `${ff.version}\n  路径：${ff.path}` : (ff.path ? `找到了但跑不起来：${ff.version ?? ff.error}` : '没找到'),
  fix: '① winget install ffmpeg  ② 或设环境变量 FFMPEG=路径  ③ 或放进 <仓库>/bin/ 或 ~/.dsh/bili-whale/bin/',
})

// ③ Node 版本（要 18+ 才有稳定 fetch）
const major = Number(process.versions.node.split('.')[0])
items.push({
  name: 'Node.js',
  ok: major >= 18,
  detail: `v${process.versions.node}`,
  fix: '升级到 Node 18 或更高（fetch / Blob 之类要用）',
})

// ④ 可写的家目录（放 cookie/配额/日记）
let dirOk = false
try {
  const d = path.join(HOME, '.bili-ai')
  fs.mkdirSync(d, { recursive: true })
  const probe = path.join(d, '.write-probe')
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe)
  dirOk = true
} catch {}
items.push({ name: '数据目录可写', ok: dirOk, detail: path.join(HOME, '.bili-ai'), fix: '检查该目录权限' })

const bad = items.filter((i) => !i.ok)

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, node: process.versions.node, items }, null, 2))
} else {
  console.log('== 依赖体检 ==')
  for (const i of items) {
    console.log(`${i.ok ? '✓' : '✗'} ${i.name}  ${i.detail ? '— ' + i.detail : ''}`)
    if (!i.ok) console.log(`    修：${i.fix}`)
  }
  console.log(bad.length ? `\n✗ ${bad.length} 项不可用 —— 先用上面的"修"处理，再重跑一次。` : '\n✓ 全部可用')
}
// ⚠️ 不用 process.exit()：nav 那次 fetch 的 keep-alive socket 还在关闭中，
//   Windows 上会触发 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）
//   → 进程在 stdout 刷完前就 abort，插件那边可能拿到空/半截 JSON ✗（2026-10-20 实测）
process.exitCode = bad.length ? 3 : 0
