// 人格卡版本化（2026-10-22 主人选「乙档」）
//
// 背景：她自己的会话工作区就是家目录，所以 `~/AGENTS.md` 在**她的可写范围**里 —— 她能改自己的人格卡。
//   我们不想切断这个能力（她该能自己长），但也不能让"人设被悄悄改掉、一周后才发现" ✗
//   → 三条约定（都不影响她正常写日记/干活）：
//     ① 她改自己之前跑一次 `persona backup`（旧版留一份）✓
//     ② 改完跑 `persona commit`（进 git，可 diff、可回滚）✓
//     ③ 插件每天自动 commit 一次兜底（见 lib/scheduler.js 的 archiveTick）✓
//
// 用法:
//   node bili.mjs persona backup     备份 ~/AGENTS.md → ~/.dsh/persona-backups/AGENTS-<时间>.md
//   node bili.mjs persona commit     把 AGENTS.md / 配置 / 两本日记 提交到 ~ 的 git 仓库
//   node bili.mjs persona log        最近备份 10 条 + 最近提交 5 条
//   node bili.mjs persona diff       人格卡相对上次提交的改动
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { config } from '../lib/config.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
// 2026-10-23：人格卡在工作区里（可能被搬到 D:\XunXi）—— 优先用配置里的 workspace ✓
const WS = (() => { try { const w = String(config().workspace ?? '').trim(); return w && fs.existsSync(w) ? w : HOME } catch { return HOME } })()
const AGENTS = path.join(WS, 'AGENTS.md')
const BACKUP_DIR = path.join(HOME, '.dsh', 'persona-backups')
const LOG = path.join(HOME, '.dsh', 'whale-log.jsonl')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'log'
const keep = Math.max(5, Number(argv[argv.indexOf('--keep') + 1]) || 50)

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const logEvent = (kind, note) => {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, target: null, note }) + '\n')
  } catch {}
}
/** 在 ~ 里跑 git（stdio: inherit —— 沙箱里捕获式子进程会 EPERM ✓） */
const git = (args) => spawnSync('git', ['-C', WS, ...args], { stdio: 'inherit', windowsHide: true })

if (cmd === 'backup') {
  if (!fs.existsSync(AGENTS)) { console.error(`✗ 没有人格卡：${AGENTS}`); process.exit(2) }
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const dst = path.join(BACKUP_DIR, `AGENTS-${stamp()}.md`)
  fs.copyFileSync(AGENTS, dst)
  logEvent('persona-backup', `人格卡备份：${path.basename(dst)}`)
  // 只留最近 keep 份，别把家目录养大
  try {
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^AGENTS-\d{8}-\d{6}\.md$/.test(f)).sort()
    for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f))
  } catch {}
  console.log(`✓ 已备份：${dst}`)
  console.log('  改完记得：`node bili.mjs persona commit`（进 git，可 diff/回滚）')
  process.exitCode = 0
} else if (cmd === 'commit') {
  // 2026-10-23：她的家搬到了 D:\XunXi，但**日记的版本历史还在家目录那个仓库** ✓
  //   所以手动 commit 也要两个仓库都盖（不然 persona commit 只提 AGENTS.md，日记那边断档 ✗）
  const repos = [...new Set([WS, HOME])]
  let committed = 0
  let failed = 0
  for (const dir of repos) {
    const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8', windowsHide: true })
    const sandboxed = !!probe.error && /EPERM|EACCES|spawn .*EPERM/.test(String(probe.error.message))
    if (probe.status !== 0 && !sandboxed) { console.log(`（跳过 ${dir}：不是 git 仓库）`); continue }
    const add = spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'inherit', windowsHide: true })
    if (add.status !== 0) { failed += 1; continue }
    const msg = `persona: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} 人格卡/日记快照`
    const r = spawnSync('git', ['-C', dir, 'commit', '-m', msg], { stdio: 'inherit', windowsHide: true })
    if (r.status === 0) { committed += 1; logEvent('persona-commit', `${dir} :: ${msg}`) }
    else if (r.status !== 1) failed += 1     // 1 = 没改动，不算失败 ✓
  }
  if (failed) { console.error(`✗ ${failed} 个仓库提交失败（看上面的输出）`); process.exitCode = 3 }
  else { console.log(committed ? `✓ 已提交 ${committed} 个仓库` : '（没有改动，不用提交 ✓）'); process.exitCode = 0 }
} else if (cmd === 'log') {
  let backups = []
  try { backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.md')).sort().reverse() } catch {}
  console.log(`== 人格卡备份（${BACKUP_DIR}）==`)
  if (!backups.length) console.log('  （还没有备份 —— 她/你改之前先跑 `persona backup`）')
  for (const f of backups.slice(0, 10)) {
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, f))
      console.log(`  ${f}  ${(st.size / 1024).toFixed(1)}KB  ${st.mtime.toLocaleString('zh-CN', { hour12: false })}`)
    } catch {}
  }
  // 2026-10-23：两个仓库都看 —— 人格卡在 WS，日记的版本历史在 HOME ✓
  for (const [label, dir] of [['人格卡/工作区', WS], ['日记/配置（家目录）', HOME]]) {
    console.log(`\n== 最近的提交（${label} · ${dir}）==`)
    const g = spawnSync('git', ['-C', dir, 'log', '--oneline', '-5'], { encoding: 'utf8', windowsHide: true })
    if (g.error) console.log('（读不到 git 输出 —— 换普通终端跑 `git -C ' + dir + ' log --oneline`）')
    else if (g.status === 0) console.log(String(g.stdout || '').trim() || '（还没有提交）')
    else console.log(`（${dir} 不是 git 仓库）`)
  }
  process.exitCode = 0
} else if (cmd === 'diff') {
  console.log(`== 人格卡相对上次提交的改动（${AGENTS}）==`)
  const r = spawnSync('git', ['-C', WS, 'diff', '--', 'AGENTS.md'], { stdio: 'inherit', windowsHide: true })
  if (r.status !== 0) { console.error('（git diff 失败：工作区可能不是仓库）'); process.exitCode = 3 }
  else process.exitCode = 0
} else {
  console.error('用法: node bili.mjs persona backup | commit | log | diff')
  process.exitCode = 2
}
