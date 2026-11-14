/**
 * App 版本号。
 *
 * ★ 真源 = macos/LifeCanvas/Info.plist。
 *   跟 Finder「关于本机」看到的、App Store Connect 上架填的，是同一个值。
 *   仓库里另有一处 package.json 的 version 字段 —— 它**不参与**版本判断
 *   （npm 包名是 private 的，没人发布它），只是顺手同步了一下，免得看着误导。
 *
 * 两条来源，**运行期优先**：
 *   ① 构建期：vite.config.ts 读 Info.plist 注进来（浏览器 / dev 态用这个）
 *   ② 运行期：原生外壳启动后把 Bundle 里的版本报过来（桌面版最准 ——
 *      它报的是「正在跑的这个包」的版本，不是源码树里的版本）
 *
 * 为什么非得原生报一次：
 *   开发期跑的是 `macos/.build/LifeCanvas-dev`（裸二进制，没有 Info.plist），
 *   而发布版跑的是 bundle 里的 LifeCanvas。同一份源码打出来的两个包，
 *   版本号可能不同 —— 设置里显示的那个必须是**正在跑的那个**的版本。
 */

/** vite define 注入的两个常量。没被注入时下面用 typeof 兜住（不会 ReferenceError）。 */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;

/** 构建期读到的版本（从 Info.plist 注进来）。 */
function buildTimeVersion(): { version: string; build: string } {
  // typeof 写法是故意的：没被 vite 替换时 typeof 未声明变量返回 "undefined"，
  // 不会抛错 —— 这样这个模块在裸 ts / 单测环境里也能安全 import。
  const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  const b = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : '';
  return { version: v.trim(), build: b.trim() };
}

/** 原生报来的版本。空字符串 = 还没收到。 */
let nativeVersion = '';
let nativeBuild = '';

/**
 * 原生外壳报来的版本。
 *
 * 收到后覆盖构建期的值 —— 跑着的包说了算。
 * 空字符串一律当"没报"，不覆盖（原生读不到 Bundle 版本时是空串）。
 */
export function setNativeVersion(version: string, build: string): void {
  const v = (version ?? '').trim();
  const b = (build ?? '').trim();
  if (!v) return;
  nativeVersion = v;
  nativeBuild = b;
}

/** 用户可见的版本号（1.0.0 这种）。 */
export function appVersion(): string {
  if (nativeVersion) return nativeVersion;
  return buildTimeVersion().version;
}

/** 构建号（1 这种）。没有就空串。 */
export function appBuild(): string {
  if (nativeVersion) return nativeBuild;
  return buildTimeVersion().build;
}

/**
 * 设置面板里显示的那一行。
 *
 * 有构建号就写成 "1.0.0 (1)"，没有就只写 "1.0.0"。
 */
export function versionLabel(): string {
  const v = appVersion();
  const b = appBuild();
  if (!v) return '—';
  return b ? `${v} (${b})` : v;
}
