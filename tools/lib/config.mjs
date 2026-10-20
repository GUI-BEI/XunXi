// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
//
// 为什么要有它（2026-10-14 外部评审指出的最大架构缺口）：
//   在此之前，"个人化的东西"散在四处、形态还不一样 ——
//     ① `~/.bili-ai/quota.json`（额度/白名单，独立文件）
//     ② `~/.dsh/whale-night.config.json`（作息，独立文件）
//     ③ `whale-diary.md` 的叙事段落（偏好被 feed.mjs 解析 Markdown 提取 ✗ 脆弱）
//     ④ 代码里硬编码（历史昵称 SELF_NAMES ✗）
//   使用者的体验是"我得读源码才知道要改哪" ✗ —— 这不是模板，是作者的自用件。
//   现在：**填一个 `bili-whale.config.json` 就完成自定义** ✓，其余全是中性默认值。
//
// 查找顺序：$BILI_WHALE_CONFIG → ~/.dsh/bili-whale.config.json → 内置默认值（中性）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const configPath = process.env.BILI_WHALE_CONFIG || path.join(HOME, '.dsh', 'bili-whale.config.json')

/** 中性默认值：不含任何作者的个人信息，换个人也能跑。 */
export const DEFAULTS = {
  persona: {
    name: '<角色名>',
    ownerTitle: '你',      // 助手怎么称呼使用者
    selfClaim: '我',       // 助手怎么自称
    diaryTitle: '今日摘要', // diary show 的标题（想用自己的口吻就改这里）
  },
  preferences: {
    like: ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '' },   // none | desktop | webhook | command（见 commands/notify.mjs）
  aliases: [],                  // 历史昵称（兜底用；当前昵称仍从 nav 动态读）
  // 使用者本人（分享型评论要 @ 的人）：mid 用于白名单/查询，name 用于正文里的 @昵称
  // （acc/info 查询会风控，所以 name 缓存一份；改过就用 thread 的 `@到:` 验一下）
  owner: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  // 「标尺」（2026-10-18 加）—— 2026-10-20 主人定：**降级成建议** ✓
  //   评论是她的自由：minScore 只是"她打分时的一个参考线"，代码不再拿它拦任何东西
  //   （防封号的硬限制只剩额度那两条：≤3/天 · 同一视频同渠道 7 天一次）
  // 2026-10-20 主人定：「评论 / 私信二选一」拆成两个**权限**开关 —— canComment / canDm 只表示"她能不能做"，
  //   **做不做、用哪种、要不要两个都做，由她自己决定** ✓（家长式：你设边界，她做选择）
  // 2026-10-20 主人定：沉默衰减放缓 —— **7 天开始掉、14 天归零**（原来 3/7 太急）
  //   而且"主人发私信给我"也算表态（quota react --auto 会查私信会话 ✓）
  share: { canComment: true, canDm: true, minScore: 13, silentAfterDays: 7, silentStopDays: 14, decayPerDay: 1 },
  // 倾听（2026-10-18 补默认值，与设置页对齐）：评论区 + 直播间
  listen: { comment: true, commentIntervalSec: 300, dmIntervalSec: 60, scope: 'both', oncePerPerson: false, allDay: false, dm: false, live: false, liveRoom: '', liveScope: 'owner' },
  // 作息：windows[] = 每天允许醒来的时段（每个窗口 = 一次机会）；maxWakesPerDay 缺省 = 窗口数（硬上限 3）
  // 2026-10-20：去掉 skipChance —— **看不看由她自己定**，不再掷骰子 ✓
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], maxVideos: 5 },
}

/** 2026-10-20 迁移：旧版 share.via（二选一）/ share.enabled（总开关）→ 两个权限开关 */
function migrateShare(cfg, user) {
  const s = cfg.share ?? (cfg.share = {})
  const u = user?.share ?? {}
  const fresh = u.canComment === undefined && u.canDm === undefined
  if (fresh) {
    if (u.via === 'dm') { s.canComment = false; s.canDm = true }          // 旧设置：只私信
    else if (u.via === 'comment') { s.canComment = true; s.canDm = false } // 旧设置：只评论
  }
  if (u.enabled === false) { s.canComment = false; s.canDm = false }      // 旧设置：分享总开关关掉
  if (cfg.night && 'skipChance' in cfg.night && !user?.night?.skipChance) delete cfg.night.skipChance
  return cfg
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

let cache = null
/** 读取合并后的配置（带缓存）。 */
export function config() {
  if (cache) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配置就用默认 */ }
  cache = migrateShare(merge(DEFAULTS, user), user)
  cache.__hasUserFile = Object.keys(user).length > 0
  return cache
}
