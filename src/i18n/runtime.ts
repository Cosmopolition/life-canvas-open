/**
 * 语言运行时 —— 把「界面语言」这一件事的前后端串起来。
 *
 * 三条来源线：
 *   ① localStorage 里的偏好（用户在设置面板里显式选过的）
 *   ② 浏览器语言（navigator.language）
 *   ③ 原生外壳报来的系统语言
 *
 * ★ 谁说了算：**用户的显式偏好 > 原生报来的系统语言 > 浏览器语言**。
 *
 *   为什么原生那一条排在浏览器前面：macOS 有「每个 App 单独设语言」
 *   （系统设置 → 通用 → 语言与地区）。那个开关只对**原生进程**生效，
 *   浏览器那份 navigator.language 看不到它 —— 只有原生进程报得准。
 *
 *   为什么用户的显式偏好排在最前面：用户在设置面板里锁过语言，
 *   那就以他的选择为准，原生那边说什么都不算。
 *
 * 依赖方向：index.ts 是叶子（model 可以 import 它）；
 *   runtime.ts 额外依赖 platform/shell（也是叶子），所以整条链依然无环。
 */
import {
  applyLocaleToDom, getLocale, initLocale, loadLocalePref, onLocaleChange,
  resolveLocale, saveLocalePref, setLocale,
  type Locale, type LocalePref,
} from './index';
import { emit } from '../platform/shell';

/** 原生报来的系统语言。null = 还没收到。 */
let nativeHint: Locale | null = null;

/** 应用启动时定语言。必须在第一次渲染之前调。 */
export function bootLocale(): Locale {
  const pref = loadLocalePref();
  initLocale(resolveLocale(pref));
  applyLocaleToDom();
  // 语言变了：静态文案刷一遍，并把新语言报给原生（菜单栏 / 工具栏跟着换）。
  onLocaleChange((l) => {
    applyLocaleToDom();
    emit('localeChanged', { locale: l });
  });
  // ★ 启动时也要**报一次**给原生。
  //   原生那边启动时按系统语言摆好界面（zh-Hans-CN → 中文），
  //   而 web 这边可能定成英文（用户在设置里锁过 / 浏览器是英文）。
  //   两边各说各的 ⇒ 顶栏中文、界面英文，谁也不服谁。
  //   这里把 web 定好的语言报过去，原生那边就以 web 为准（web 是权威）。
  //
  //   ⚠️ 必须在 enableShell 之后才能报 —— emit 走的是原生消息通道，
  //     通道没建好之前发出去会静默丢掉。所以这件事交给 app.ts 在
  //   enableShell() 之后调 reportLocaleToNative()。
  return getLocale();
}

/**
 * 把当前语言报给原生（菜单栏 / 工具栏 / 窗口标题跟着换）。
 *
 * ★ 必须在 enableShell() **之后**调 —— 原生通道没建好之前发出去会静默丢掉。
 */
export function reportLocaleToNative(): void {
  emit('localeChanged', { locale: getLocale() });
}

/**
 * 原生报来的系统语言。
 *
 * 只在「跟随系统」时采纳 —— 用户显式选过语言的话不动。
 *
 * ⚠️ 采纳之后要把**最终语言**回报给原生：
 *   原生启动时按系统语言摆好界面，web 这边可能因为「用户锁过语言」
 *   定成另一种 —— 两边各说各的，顶栏和界面对不上。
 *   回报之后，原生那边以 web 为准（web 是权威）。
 */
export function applyNativeLocale(raw: string): void {
  const l: Locale | null = raw === 'zh-CN' ? 'zh-CN' : raw === 'en-US' ? 'en-US' : null;
  if (!l) return;
  nativeHint = l;
  if (loadLocalePref() === 'auto' && l !== getLocale()) {
    setLocale(l);   // 变了 → onLocaleChange 会把新语言报给原生
  } else {
    // 没变（或者用户锁过语言）：直接把当前语言报回去，让原生跟 web 对齐。
    reportLocaleToNative();
  }
}

/**
 * 设置面板里改语言。
 *
 * 'auto' = 跟随系统（原生报来的优先于浏览器语言）。
 */
export function setLocalePref(pref: LocalePref): void {
  saveLocalePref(pref);
  const next = pref === 'auto' ? (nativeHint ?? resolveLocale('auto')) : pref;
  if (next !== getLocale()) {
    setLocale(next);       // 变了 → 触发订阅者（应用整体重绘）
  } else {
    applyLocaleToDom();    // 没变（比如 'auto' 仍解析到同一个语言）→ 至少刷一次静态文案
  }
}

/** 当前语言（给设置面板显示用）。 */
export function currentLocale(): Locale {
  return getLocale();
}
