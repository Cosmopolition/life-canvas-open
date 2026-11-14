/**
 * 文案层（i18n）。
 *
 * 键 = **英文 slug**（`t('action.deleteTheme')`），中英文在 `strings.ts` 的同一行里。
 * 为什么不用中文原文当键，见 strings.ts 顶部的说明 —— 一句话：
 * 改中文措辞不该打断英文翻译。
 *
 * 查不到就退回中文（英文表没这一条时显示中文，好过显示空白）：
 *   `scripts/i18n-check.ts` 与 `tests/i18n.test.ts` 会把漏翻的键揪出来。
 *
 * 依赖方向：这是叶子模块，不 import 项目里任何东西（model 可以 import 它）。
 */
import { STRINGS, type StringKey } from './strings';

export type { StringKey };
export { STRINGS };

export type Locale = 'zh-CN' | 'en-US';
export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US'];

/** 语言名按惯例就用该语言自己写，不进翻译表 */
export const LOCALE_NAME: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

const STORAGE_KEY = 'lc.locale';
/** 'auto' = 跟随系统 / 浏览器 */
export type LocalePref = Locale | 'auto';

let current: Locale = 'zh-CN';
const listeners = new Set<(l: Locale) => void>();
/** 基础串缓存。参数插值不缓存（插值串很少，缓存反而占内存）。 */
let cache = new Map<string, string>();
/** 表里没有的键。测试和检查脚本读它。 */
const missing = new Set<string>();

export function getLocale(): Locale {
  return current;
}

/** 给 Intl / toLocale* 用的 BCP 47 标签 */
export function localeTag(): string {
  return current;
}

/** 探测系统 / 浏览器语言 */
export function detectLocale(): Locale {
  const nav = typeof navigator !== 'undefined' ? (navigator.language || '') : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function loadLocalePref(): LocalePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'zh-CN' || v === 'en-US' ? v : 'auto';
  } catch {
    return 'auto'; // 隐私模式 / 无 localStorage：按跟随系统处理
  }
}

export function saveLocalePref(p: LocalePref): void {
  try {
    if (p === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
  } catch {
    /* 存不下就算了，不影响本次会话 */
  }
}

/** 偏好 → 实际语言 */
export function resolveLocale(pref: LocalePref = loadLocalePref()): Locale {
  return pref === 'auto' ? detectLocale() : pref;
}

/** 切换语言。会通知所有订阅者（App 收到后整体重绘）。 */
export function setLocale(l: Locale): void {
  const changed = l !== current;
  current = l;
  cache = new Map();
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  if (changed) listeners.forEach((f) => f(l));
}

/** 首次进入应用时用：定语言但不触发"变了"的重绘 */
export function initLocale(pref: LocalePref = loadLocalePref()): Locale {
  const l = resolveLocale(pref);
  current = l;
  cache = new Map();
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  return l;
}

export function onLocaleChange(f: (l: Locale) => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/**
 * 取文案。
 *
 * @param key   英文 slug（写错会**编译不过** —— 类型就是表里的键）
 * @param params 插值参数
 */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  return interpolate(lookup(key), params);
}

/**
 * 取文案 —— 键在运行时才知道（index.html 的 data-i18n 属性）。
 *
 * 表里没有这个键时记进 missing 并退回 key 本身。
 */
export function tRuntime(key: string, params?: Record<string, string | number>): string {
  return interpolate(lookup(key), params);
}

function lookup(key: string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const entry = STRINGS[key];
  let s: string;
  if (!entry) {
    missing.add(key);
    s = key;
  } else {
    s = current === 'zh-CN' ? entry.zh : entry.en;
  }
  cache.set(key, s);
  return s;
}

function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** 表里没有的键（按字典序）。测试和检查脚本用。 */
export function missingTranslations(): string[] {
  return [...missing].sort();
}

/* ---------------- 静态 HTML ---------------- */

/**
 * 翻译 index.html 里写死的文案。
 *
 * 用 data-i18n 系列属性标出来（**值现在是 slug**）：
 *   data-i18n              → textContent
 *   data-i18n-html         → innerHTML（文案里带 <b> 这类标记时用）
 *   data-i18n-title        → title 属性
 *   data-i18n-placeholder  → placeholder 属性
 *   data-i18n-aria-label   → aria-label 属性
 */
export function applyStaticI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = tRuntime(el.getAttribute('data-i18n')!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    el.innerHTML = tRuntime(el.getAttribute('data-i18n-html')!);
  });
  const attrs: Array<[string, string]> = [
    ['title', 'data-i18n-title'],
    ['placeholder', 'data-i18n-placeholder'],
    ['aria-label', 'data-i18n-aria-label'],
  ];
  for (const [attr, marker] of attrs) {
    root.querySelectorAll<HTMLElement>(`[${marker}]`).forEach((el) => {
      el.setAttribute(attr, tRuntime(el.getAttribute(marker)!));
    });
  }
  // 页面标题也归文案层管（index.html 里写死的那一行）。
  if (typeof document !== 'undefined') document.title = t('app.name');
}

/**
 * 把整页静态文案刷成当前语言。
 *
 * 切语言之后要调它 —— 视图层那些动态文案由各自重绘负责，
 * index.html 里写死的那部分（顶栏、门禁、左栏说明）只在这里。
 */
export function applyLocaleToDom(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  // CSS 的 content 拿不到 CSS 变量以外的东西 —— 少数字面量（版本历史里的
  // "原因 · " 前缀）通过这个变量递给样式层。换语言时一起刷。
  document.documentElement.style.setProperty(
    '--i18n-reason-prefix', JSON.stringify(t('version.reasonPrefix')),
  );
  applyStaticI18n(document);
}

/* ---------------- 日期 / 数字 ---------------- */

/** 完整时间戳（导出用） */
export function fmtDateTime(d: Date): string {
  return d.toLocaleString(localeTag());
}

/** 月日（'11月5日' / 'Nov 5'） */
export function fmtMonthDay(d: Date): string {
  return current === 'zh-CN'
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** 月份刻度（'11月' / 'Nov'）—— 时间轴上那种只写月份的短标签 */
export function monthLabel(m0: number): string {
  return current === 'zh-CN'
    ? `${m0 + 1}月`
    : new Date(2000, m0, 1).toLocaleDateString('en-US', { month: 'short' });
}

/** 年月（'2026年11月' / 'November 2026'） */
export function fmtYearMonth(y: number, m0: number): string {
  return current === 'zh-CN'
    ? `${y}年${m0 + 1}月`
    : new Date(y, m0, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
