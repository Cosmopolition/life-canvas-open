/**
 * 主题（深 / 浅）的取值规则。
 *
 * 单独成文件，是为了能脱离 DOM 和 IndexedDB 测 ——
 * 主题的取值只有两步决策，纯函数最好测。
 *
 *   偏好 pref  = 用户选了什么：auto（跟随系统）/ dark / light
 *   系统 system = 系统当前外观：dark / light
 *   实际       = 这一屏真正用哪个：dark / light
 */

/** 主题偏好。auto = 跟随系统（桌面版原生外壳的唯一事实来源）。 */
export type Theme = 'auto' | 'dark' | 'light';
/** 解析后的实际主题。 */
export type ResolvedTheme = 'dark' | 'light';

/** 偏好 + 系统外观 → 实际主题。 */
export function resolveTheme(pref: Theme, system: ResolvedTheme): ResolvedTheme {
  return pref === 'auto' ? system : pref;
}

/**
 * 旧版本（只存 dark/light）迁移到新版本（auto/dark/light）。
 *
 * 旧版只有两个值，而且 dark 就是默认值 —— 分不清"用户特意选的"和"根本没动过"。
 * 原生外壳的设计是「系统外观是单一事实来源」，
 * 所以第一次升级时统一落到 auto；想锁定的话，设置里现在有明确的「暗色 / 亮色」两项。
 *
 * **只迁一次**：alreadyV2 为真时一律保留原值。
 * 否则用户在新设置里选了暗色，下次启动又被迁回 auto —— 选了等于没选。
 */
export function migrateTheme(stored: string | undefined, alreadyV2: boolean): Theme {
  if (alreadyV2) {
    if (stored === 'dark' || stored === 'light' || stored === 'auto') return stored;
    return 'auto';
  }
  return 'auto';
}
