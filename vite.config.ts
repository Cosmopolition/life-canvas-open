import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * 从 Info.plist 里读一个 <key>…</key><string>…</string> 的值。
 *
 * 不用 plutil —— 输出格式（xml / json）会变，正则更稳。
 */
function plistString(plist: string, key: string): string {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m?.[1]?.trim() ?? '';
}

/**
 * ★ 版本号的真源 = macos/LifeCanvas/Info.plist。
 *
 *   为什么不是 package.json：App Store 上架、Finder「关于本机」、
 *   release.sh 的自检读的都是 Info.plist。版本号只有这一处定义 ——
 *   构建时读它注入 web，运行时原生再把 Bundle 里的版本报回来。
 */
const infoPlist = readFileSync(
  fileURLToPath(new URL('./macos/LifeCanvas/Info.plist', import.meta.url)),
  'utf8',
);
const appVersion = plistString(infoPlist, 'CFBundleShortVersionString');
const appBuild = plistString(infoPlist, 'CFBundleVersion');

if (!appVersion) {
  // 静默出错最难查：版本号变成空串，界面上显示 "—"，没人知道为什么。
  throw new Error('Info.plist 里读不到 CFBundleShortVersionString');
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // 零外部运行时依赖：字体全部走系统栈，不引入任何 CDN
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD__: JSON.stringify(appBuild),
  },
});
