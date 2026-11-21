// 生活台账（2026-11-18）——她"正在过日子"的那一页
//
// 为什么要有它：现在她醒来面对的是**一张空白选项表**，只能临场决定做什么；
// 而人醒来时脑子里已经有事：读到一半的书、想看的东西、昨天没说完的话。
// 台账就是让"事"先存在，人再决定要不要做。
//
// 四条原则（阿墨定的）：
//   ① 心情由**她自己写**（脚本只给素材：睡了多久、有什么没做完），不算分、不推断
//   ② 念头**带过期**；没有念头、也没在做的事 → 今天不必叫醒她
//   ③ 心情 / 念头 / 计划 / 不想做的事 **全部可以为空**，空着不扣分、不补、不催
//   ④ 纪律只管事实（读了几块/看了哪条/发没发出去），感受、印象、梦一律不管
//
// 用法：
//   node bili.mjs life show
//   node bili.mjs life mood "说不上来，有点闷"
//   node bili.mjs life doing add "三体 第 9 块" --kind read
//   node bili.mjs life doing done all
//   node bili.mjs life plan add "睡前把那半块读完"
//   node bili.mjs life dont add "今晚不想刷视频"
//   node bili.mjs life think "罗布被退学那段，想跟阿墨说" --from "三体 第 6 块" --ttl 72
//   node bili.mjs life think list / drop <id> / used <id>
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = path.join(HOME, '.dsh', 'life.json')
const HISTORY = path.join(HOME, '.dsh', 'life-history.jsonl')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'show'
const rest = argv.slice(1)
const opt = {}
const words = []
const VALUED = new Set(['from', 'ttl', 'kind'])
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    if (VALUED.has(k) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) { opt[k] = rest[i + 1]; i += 1 }
    else opt[k] = true
  } else words.push(a)
}

const today = () => new Date().toLocaleDateString('sv-SE')   // YYYY-MM-DD（本地时区）
const nowIso = () => new Date().toISOString()
const uid = () => Math.random().toString(36).slice(2, 8)

const empty = () => ({ date: today(), mood: null, doing: [], plan: [], dontWant: [], thoughts: [], skips: 0 })

function load() {
  let s
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { s = empty() }
  s = { ...empty(), ...s }
  // 跨天：把昨天整段存进 history，然后清掉"今天"的东西（念头保留，它们有自己的过期时间）
  if (s.date !== today()) {
    try {
      fs.appendFileSync(HISTORY, JSON.stringify({
        date: s.date, mood: s.mood, doing: s.doing, plan: s.plan, dontWant: s.dontWant,
        thoughts: (s.thoughts ?? []).filter((t) => !t.usedAt), skips: s.skips ?? 0,
      }) + '\n', 'utf8')
    } catch {}
    s = { ...empty(), thoughts: s.thoughts ?? [] }
  }
  // 过期念头：自动清掉（"念头可以丢"——过期就是最自然的丢法）
  s.thoughts = (s.thoughts ?? []).filter((t) => !t.expiresAt || Date.parse(t.expiresAt) > Date.now() || t.usedAt)
  return s
}

function save(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 1) + '\n', 'utf8')
}

const text = (w) => w.join(' ').trim()
const line = (o) => JSON.stringify(o)

const s = load()

function show() {
  const mood = s.mood?.text ? s.mood.text : '（空着 —— 没写也行）'
  const doing = s.doing.length ? s.doing.map((d) => `  · ${d.text}${d.kind ? `（${d.kind}）` : ''}`).join('\n') : '  （没有正在做的事）'
  const plan = s.plan.length ? s.plan.map((p) => `  · ${p.text}`).join('\n') : '  （没有计划 —— 不写也行）'
  const dont = s.dontWant.length ? s.dontWant.map((d) => `  · ${d.text}`).join('\n') : '  （没有"不想做的事"）'
  const th = s.thoughts.filter((t) => !t.usedAt)
  const thoughts = th.length
    ? th.map((t) => `  · [${t.id}] ${t.text}${t.from ? `（来自 ${t.from}）` : ''} · ${t.expiresAt ? '到 ' + t.expiresAt.slice(5, 16) + ' 过期' : ''}`).join('\n')
    : '  （没有待用的念头 —— 空着就空着，今天不叫醒你也行）'
  console.log(`生活台账 · ${s.date}`)
  console.log(`\n心情：${mood}`)
  console.log(`\n正在做：\n${doing}`)
  console.log(`\n计划：\n${plan}`)
  console.log(`\n今天不想做的事：\n${dont}`)
  console.log(`\n待用的念头：\n${thoughts}`)
  if (s.skips) console.log(`\n（已连续 ${s.skips} 次因为"没事"没叫醒你）`)
  console.log('\n（都可以空着；想写就写，不想写就不写 ✓）')
}

switch (cmd) {
  case 'show':
    show()
    break

  case 'mood': {
    if (opt.clear) { s.mood = null; save(s); console.log('心情清空了（空着也行）'); break }
    const t = text(words)
    if (!t) { console.log(s.mood?.text ? `现在写着：${s.mood.text}` : '还没写心情（可以不写）'); break }
    s.mood = { text: t, at: nowIso() }
    save(s)
    console.log(`记下了：${t}`)
    break
  }

  case 'doing': {
    const sub = words[0]
    if (sub === 'add' || sub === 'start') {
      const t = text(words.slice(1))
      if (!t) { console.error('用法：life doing add "<在做什么>" [--kind read|watch|write|other]'); process.exit(2) }
      s.doing.push({ id: uid(), text: t, kind: typeof opt.kind === 'string' ? opt.kind : '', at: nowIso() })
      save(s); console.log(`在做了：${t}`)
    } else if (sub === 'done') {
      const which = words[1]
      if (!which || which === 'all') { s.doing = []; console.log('正在做的事清空了') }
      else { s.doing = s.doing.filter((d) => d.id !== which); console.log('去掉了那一条') }
      save(s)
    } else if (sub === 'clear') { s.doing = []; save(s); console.log('清空了') }
    else show()
    break
  }

  case 'plan': {
    const sub = words[0]
    if (sub === 'add') {
      const t = text(words.slice(1))
      if (!t) { console.error('用法：life plan add "<计划>"'); process.exit(2) }
      s.plan.push({ id: uid(), text: t }); save(s); console.log(`计划加了：${t}（不做也行 ✓）`)
    } else if (sub === 'rm' || sub === 'drop') {
      s.plan = s.plan.filter((p) => p.id !== words[1]); save(s); console.log('去掉了')
    } else if (sub === 'clear') { s.plan = []; save(s); console.log('计划清空了（空着也行）') }
    else show()
    break
  }

  case 'dont': {
    const sub = words[0]
    if (sub === 'add') {
      const t = text(words.slice(1))
      if (!t) { console.error('用法：life dont add "今晚不想刷视频"'); process.exit(2) }
      s.dontWant.push({ id: uid(), text: t }); save(s); console.log(`记下了：今天不安排「${t}」`)
    } else if (sub === 'rm' || sub === 'drop') {
      s.dontWant = s.dontWant.filter((d) => d.id !== words[1]); save(s); console.log('去掉了一条')
    } else if (sub === 'clear') { s.dontWant = []; save(s); console.log('清空了') }
    else show()
    break
  }

  case 'think': {
    // 允许省略 add：`life think "念头"` 和 `life think add "念头"` 等价
    const KNOWN = ['list', 'drop', 'used', 'add', 'new']
    const raw = words[0]
    const sub = !raw ? 'list' : (KNOWN.includes(raw) ? raw : 'add')
    const body = raw && KNOWN.includes(raw) ? words.slice(1) : words
    if (sub === 'list') {
      const th = s.thoughts.filter((t) => !t.usedAt)
      if (!th.length) console.log('（没有待用的念头）')
      for (const t of th) console.log(`[${t.id}] ${t.text}${t.from ? `（来自 ${t.from}）` : ''}${t.expiresAt ? ` · 到 ${t.expiresAt.slice(0, 16)} 过期` : ''}`)
      break
    }
    if (sub === 'drop') { s.thoughts = s.thoughts.filter((t) => t.id !== body[0]); save(s); console.log('丢了（念头可以丢 ✓）'); break }
    if (sub === 'used') { const t = s.thoughts.find((x) => x.id === body[0]); if (t) t.usedAt = nowIso(); save(s); console.log('标成用过了'); break }
    {
      const t = text(body)
      if (!t) { console.error('用法：life think "<念头>" [--from 来源] [--ttl 72]'); process.exit(2) }
      const ttl = Number(opt.ttl ?? 72)
      s.thoughts.push({ id: uid(), text: t, from: typeof opt.from === 'string' ? opt.from : '', at: nowIso(), expiresAt: new Date(Date.now() + ttl * 3600 * 1000).toISOString() })
      save(s); console.log(`记下念头：${t}（${ttl} 小时后自动过期；不想做就忘掉 ✓）`)
    }
    break
  }

  case 'skip': {   // 调度器用：记一次"因为没事，不叫醒"
    s.skips = Number(s.skips ?? 0) + 1
    save(s)
    break
  }

  case 'wake-ok': { s.skips = 0; save(s); break }

  case 'json': {
    console.log(JSON.stringify({
      date: s.date, mood: s.mood?.text ?? '', doing: s.doing.map((d) => d.text),
      plan: s.plan.map((p) => p.text), dontWant: s.dontWant.map((d) => d.text),
      thoughts: s.thoughts.filter((t) => !t.usedAt).map((t) => ({ id: t.id, text: t.text, from: t.from ?? '' })),
      skips: Number(s.skips ?? 0),
    }))
    break
  }

  default:
    console.error('用法: life show|mood|doing|plan|dont|think|json')
    process.exit(2)
}
