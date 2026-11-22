// 加载自检（2026-11-22）
//
// 为什么要有它：我在 scheduler.js 顶层写了 `const LIFE_FILE = path.join(dshHome, ...)`，
//   而 dshHome 是 register(ctx) 的参数 → **import 时直接 ReferenceError**，
//   整个插件加载失败，她一整天都没被叫醒，而宿主日志里只有一行 "failed to import" ✗
//
// 以后改完 lib/ 里任何文件，先跑这个：
//   node scripts/check-load.mjs
//
//   lib/**、tools/lib/** → 真 import（能抓到"顶层引用未定义变量"这类错）
//   tools/commands/**    → 只做语法检查（它们 import 就会跑主逻辑）
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let bad = 0
let ok = 0

async function importDir(rel) {
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!/\.mjs$/.test(f)) continue
    const p = path.join(dir, f)
    try {
      await import(pathToFileURL(p).href)
      ok += 1
    } catch (e) {
      bad += 1
      console.error(`✗ ${path.relative(root, p)}  →  ${String(e?.message ?? e).split('\n')[0]}`)
    }
  }
}

function checkDir(rel) {
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!/\.mjs$/.test(f)) continue
    const p = path.join(dir, f)
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: ['ignore', 'pipe', 'pipe'] })
      ok += 1
    } catch (e) {
      bad += 1
      console.error(`✗ ${path.relative(root, p)}  →  语法错误：${String(e?.stderr ?? e).split('\n')[0]}`)
    }
  }
}

await importDir('lib')
await importDir('tools/lib')
checkDir('tools/commands')

console.log(`\n加载自检：${ok} 个正常 · ${bad} 个失败`)
if (bad) {
  console.error('\n⚠ 有失败项时，DSH 里的插件可能 import 不了（上次就是这样一整天没叫醒她）—— 修完再重启。')
  process.exit(1)
}
