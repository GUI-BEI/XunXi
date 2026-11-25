// 唤醒文案预览（2026-11-22）
//   node scripts/preview-wake.mjs            → 打几个整点的样子，检查"夜里/中午"有没有写错
import { lightWakeText, todWord } from '../lib/scheduler.js'

function clockAt(h) {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d
}

console.log('时段词：')
for (const h of [2, 6, 9, 12, 15, 18, 21, 23]) {
  console.log(`  ${String(h).padStart(2, '0')}:00 → ${todWord(clockAt(h))}`)
}

console.log('\n轻唤醒正文（三个时段各一份）：')
for (const h of [9, 15, 21]) {
  console.log(`\n──────── ${String(h).padStart(2, '0')}:00 ────────`)
  console.log(lightWakeText({ atText: `${String(h).padStart(2, '0')}:00` }, clockAt(h)).split('\n').slice(0, 3).join('\n'))
}
