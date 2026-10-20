// 登录态（2026-10-19 加）：B站 cookie 会**静默失效**
//
// 为什么要有这个文件：
//   SESSDATA 里那个时间戳（解码后形如 `<sid>,<exp>,<sig>*<x>`，第 2 段是 unix 秒）只是**上限**，
//   服务端随时可以把它作废 —— 被踢设备 / 改密码 / 风控认证过期 / 浏览器退出登录，都会让
//   一个"看起来还有 179 天"的 cookie 立刻变成 `code=-101 账号未登录`。
//   所以"长期有效"实际要做的是三件事：
//     ① **能看见**：剩余天数 + 真去 nav 验一次（不是只看字段齐不齐）
//     ② **少出错**：整段粘贴自动解析（import）—— 不用再手抄三段、也不会抄漏 HttpOnly 的 SESSDATA
//     ③ **能兜底**：deps 体检 / 生物钟巡检都读这里的结果，失效了主动报给主人
//
// 用法：
//   node login.mjs                       人读：登录态 / 剩余天数 / 该怎么办
//   node login.mjs --json                agent 读
//   node login.mjs import [--from <文件>] [--dry] [--force]
//                                        从整段粘贴（Cookie 头 / JSON / URL query / DevTools 复制）里
//                                        抠出 SESSDATA / bili_jct / buvid3 → 真验一次 → 写 credentials.json
//
// 退出码：0 = 登录可用；3 = 不可用（要重新登录）；2 = 参数 / 解析错误
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CRED = path.join(HOME, '.bili-ai', 'credentials.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const cmd = args.find((a) => !a.startsWith('--')) ?? 'status'
const flag = (name) => args.includes(name)
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

/** 读凭据（读不到就 null；永不回显内容） */
function readCred() {
  try { return JSON.parse(fs.readFileSync(CRED, 'utf8')) } catch { return null }
}

/** SESSDATA 里的过期时间（unix 秒）—— 只是上限，不代表现在还有效 */
function sessExp(sessdata) {
  try {
    const raw = decodeURIComponent(String(sessdata || ''))
    const n = Number(raw.split(',')[1])
    return Number.isFinite(n) && n > 1e9 ? n : null
  } catch { return null }
}

const daysLeft = (exp) => (exp ? Math.round(((exp * 1000) - Date.now()) / 86400000) : null)

const cookieOf = (c) => `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}` + (c.buvid3 ? `; buvid3=${c.buvid3}` : '')

/** 拿这些 cookie 真去问一次 nav（这是唯一能判断"现在还能不能用"的办法） */
async function navCheck(c) {
  try {
    const r = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieOf(c) },
    })).json()
    return {
      ok: r.code === 0 && !!r.data?.isLogin,
      code: r.code,
      message: r.message ?? '',
      uname: r.data?.uname ?? null,
      mid: r.data?.mid ? String(r.data.mid) : null,
    }
  } catch (e) {
    return { ok: false, code: null, message: `请求失败：${String(e.message).slice(0, 120)}`, uname: null, mid: null }
  }
}

/** 失效原因 → 人话 + 下一步（agent 也靠它决定要不要惊动主人） */
function advice(n) {
  if (n.ok) {
    const d = n.daysLeft
    if (d !== null && d <= 7) return `还能用，但 SESSDATA 的**上限**只剩 ${d} 天 —— 趁现在重新登录一次（或至少别指望它过夜）`
    return '可用'
  }
  if (n.code === -101) return '服务端已登出（不是 cookie 抄错）：被踢设备 / 改过密码 / 浏览器退出登录 / 风控都会这样 —— 重新登录后跑 `node bili.mjs login import`'
  if (n.code === -352) return '风控（-352）：请求太密或指纹可疑 —— 隔一会儿再试，别连着重试'
  if (n.code === -400) return '请求参数/签名被拒（-400）：buvid3 之类可能缺了 —— 重新导入一次完整 cookie'
  if (n.code === null) return n.message
  return `code=${n.code} ${n.message} —— 重新登录后跑 \`node bili.mjs login import\``
}

/** 从一大段粘贴里抠字段：Cookie 头 / JSON / URL query / DevTools 表格都能吃 */
function extract(text) {
  const t = String(text || '')
  // 值里允许的字符：SESSDATA 含 %2C 与 *，还能容忍被解码后的英文逗号
  const grab = (name, allowComma) => {
    const cls = allowComma ? '[A-Za-z0-9%._*+/=,@~-]+' : '[A-Za-z0-9%._*+/=@~-]+'
    // ① key=value / "key":"value" / ?key=value  ② DevTools 表格那种「名字<TAB>值」
    for (const re of [
      new RegExp('\\b' + name + '\\s*"?\\s*[=:]\\s*"?\\s*(' + cls + ')', 'i'),
      new RegExp('\\b' + name + '[ \\t]+(' + cls + ')', 'i'),
    ]) {
      const m = t.match(re)
      if (m) return m[1]
    }
    return null
  }
  return {
    sessdata: grab('SESSDATA', true),
    bili_jct: grab('bili_jct', false),
    buvid3: grab('buvid3', false),
    dedeuserid: grab('DedeUserID', false),
  }
}

/** 从 DevTools 的表格里复制可能拿到**解码后**的逗号版本 → 统一成 Cookie 头里的编码形态 */
function normalizeSess(v) {
  if (!v) return v
  let s = String(v).trim().replace(/^"|"$/g, '')
  s = s.replace(/^SESSDATA=/, '')
  if (s.includes(',') && !s.includes('%2C')) s = s.replace(/,/g, '%2C')
  return s
}
const mask = (v) => (v ? `${String(v).slice(0, 4)}…（${String(v).length} 字符）` : '（空）')

async function report() {
  const c = readCred()
  if (!c) {
    const out = { ok: false, code: null, reason: '没有凭据文件', cred: CRED, advice: '先在设置页填 cookie，或 `node bili.mjs login import`' }
    if (asJson) console.log(JSON.stringify(out, null, 2))
    else console.log(`✗ 没有凭据文件：${CRED}\n  修：设置页填 SESSDATA / bili_jct，或 \`node bili.mjs login import\``)
    process.exitCode = 3
    return
  }
  const n = await navCheck(c)
  const exp = sessExp(c.sessdata)
  const out = {
    ok: n.ok,
    code: n.code,
    message: n.message,
    uname: n.uname,
    mid: n.mid,
    sessdataExp: exp ? new Date(exp * 1000).toISOString() : null,
    daysLeft: daysLeft(exp),
    advice: advice({ ...n, daysLeft: daysLeft(exp) }),
  }
  if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exitCode = n.ok ? 0 : 3; return }
  console.log('== 登录态 ==')
  console.log(`${n.ok ? '✓' : '✗'} ${n.ok ? `已登录：${n.uname}（mid ${n.mid}）` : `不可用：code=${n.code ?? '?'} ${n.message}`}`)
  if (exp) console.log(`  SESSDATA 上限：${new Date(exp * 1000).toLocaleString('zh-CN')}（剩 ~${daysLeft(exp)} 天）—— 只是上限，服务端可提前作废`)
  console.log(`  ${out.advice}`)
  if (!n.ok) console.log('\n  重新登录最省事的路：浏览器登录 → F12 → Network/Cookies 整段复制 → `node bili.mjs login import`（自动抠字段 + 真验一次）')
  // ⚠️ 不用 process.exit()：undici 的 keep-alive socket 还在关闭中，Windows 上会触发 libuv 断言崩溃 ✗
  process.exitCode = n.ok ? 0 : 3
}

async function doImport() {
  let text = ''
  const from = val('--from')
  try {
    if (from) text = fs.readFileSync(from, 'utf8')
    else if (!process.stdin.isTTY) text = await new Promise((resolve) => {
      let s = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d) => { s += d })
      process.stdin.on('end', () => resolve(s))
    })
  } catch (e) { console.error(`读输入失败：${e.message}`); process.exit(2) }

  if (!String(text).trim()) {
    console.error([
      '用法：node login.mjs import  （把整段 cookie 粘进来，然后 Ctrl+Z 回车 / Ctrl+D）',
      '  或：node login.mjs import --from cookie.txt',
      '能吃的格式：Cookie 头（SESSDATA=…; bili_jct=…）、JSON、URL query、DevTools 复制出来的表格。',
    ].join('\n'))
    process.exit(2)
  }

  const got = extract(text)
  const sessdata = normalizeSess(got.sessdata)
  const next = { sessdata, bili_jct: got.bili_jct, buvid3: got.buvid3 ?? '' , dedeuserid: got.dedeuserid ?? '' }
  const missing = ['sessdata', 'bili_jct'].filter((k) => !next[k])
  if (missing.length) {
    console.error(`✗ 没抠到：${missing.join(', ')} —— 确认复制的是完整 cookie（SESSDATA 是 HttpOnly，只能从 F12 的 Cookies 表或请求头里拿）`)
    process.exit(2)
  }

  console.log(`解析到：SESSDATA=${mask(next.sessdata)}  bili_jct=${mask(next.bili_jct)}  buvid3=${mask(next.buvid3)}`)
  const n = await navCheck(next)
  const exp = sessExp(next.sessdata)
  if (!n.ok && !flag('--force')) {
    console.error(`✗ 这些 cookie 现在也用不了：code=${n.code ?? '?'} ${n.message}`)
    console.error('  （-101 = 已经过期/被登出；-352 = 风控，隔几分钟再导入；确认无误还想写就加 --force）')
    process.exitCode = 3
    return
  }
  if (n.ok) console.log(`✓ 验证通过：${n.uname}（mid ${n.mid}）${exp ? ` · 上限 ${new Date(exp * 1000).toLocaleDateString('zh-CN')}（剩 ~${daysLeft(exp)} 天）` : ''}`)
  else console.log(`⚠️ 验证没通过（code=${n.code ?? '?'}）—— 因为带了 --force，照样往下走`)

  if (flag('--dry')) { console.log('（--dry：没有写盘）'); return }

  fs.mkdirSync(path.dirname(CRED), { recursive: true })
  if (fs.existsSync(CRED)) {
    const bak = CRED + '.bak'
    try { fs.copyFileSync(CRED, bak); console.log(`旧凭据备份：${bak}`) } catch {}
  }
  const body = { sessdata: next.sessdata, bili_jct: next.bili_jct, buvid3: next.buvid3 }
  if (next.dedeuserid) body.dedeuserid = next.dedeuserid
  fs.writeFileSync(CRED, JSON.stringify(body, null, 2) + '\n')
  try { fs.chmodSync(CRED, 0o600) } catch {}
  console.log(`✓ 已写入 ${CRED}（下次体检就是绿的）`)
}

if (cmd === 'import') await doImport()
else if (cmd === 'status' || cmd === 'check') await report()
else {
  console.error(`未知子命令：${cmd}\n用法：node login.mjs [status] | import [--from <文件>] [--dry] [--force]`)
  process.exit(2)
}
