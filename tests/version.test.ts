import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App 版本号。
 *
 * ★ 最要紧的一条：**版本号只有一个真源** —— macos/LifeCanvas/Info.plist。
 *   构建期由 vite.config.ts 读它注进来，运行时原生再把 Bundle 里的值报过来。
 *   所以这里直接读 Info.plist，跟 web 侧拿到的版本对账 ——
 *   两边对不上，就说明「设置里显示的版本」跟「正在打包的版本」脱节了。
 *
 * version.ts 有模块级状态（原生报来的版本会盖掉构建期的），
 * 每组用例前用 resetModules 重来一遍。
 */

function plistString(plist: string, key: string): string {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m?.[1]?.trim() ?? '';
}

const infoPlist = readFileSync(
  fileURLToPath(new URL('../macos/LifeCanvas/Info.plist', import.meta.url)),
  'utf8',
);
const PLIST_VERSION = plistString(infoPlist, 'CFBundleShortVersionString');
const PLIST_BUILD = plistString(infoPlist, 'CFBundleVersion');

async function loadVersion() {
  vi.resetModules();
  return import('../src/version');
}

beforeEach(() => {
  // 每个用例都要干净的模块状态（原生报来的版本是模块级的）
  void loadVersion();
});

describe('版本号的真源', () => {
  it('Info.plist 里读得到版本号和构建号', () => {
    expect(PLIST_VERSION).not.toBe('');
    expect(PLIST_BUILD).not.toBe('');
  });

  it('构建期注入的版本 == Info.plist 里的版本', async () => {
    const { appVersion, appBuild } = await loadVersion();
    expect(appVersion()).toBe(PLIST_VERSION);
    expect(appBuild()).toBe(PLIST_BUILD);
  });

  it('package.json 的 version 不参与版本判断（但别跟 Info.plist 差太远，免得看着误导）', async () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe(PLIST_VERSION);
  });
});

describe('原生报来的版本', () => {
  it('原生报了之后就盖掉构建期的值', async () => {
    const { setNativeVersion, appVersion, appBuild } = await loadVersion();
    setNativeVersion('9.9.9', '42');
    expect(appVersion()).toBe('9.9.9');
    expect(appBuild()).toBe('42');
  });

  it('原生报空串 = 没报，不覆盖构建期的值', async () => {
    const { setNativeVersion, appVersion } = await loadVersion();
    // 裸二进制（开发期免打包那个）没有 Info.plist，读出来就是空串
    setNativeVersion('', '');
    expect(appVersion()).toBe(PLIST_VERSION);
  });

  it('空白串也当没报', async () => {
    const { setNativeVersion, appVersion } = await loadVersion();
    setNativeVersion('   ', '  ');
    expect(appVersion()).toBe(PLIST_VERSION);
  });

  it('只报版本号、不报构建号时，构建号留空（不显示成 0）', async () => {
    const { setNativeVersion, appBuild, versionLabel } = await loadVersion();
    setNativeVersion('2.0.0', '');
    expect(appBuild()).toBe('');
    expect(versionLabel()).toBe('2.0.0');
  });
});

describe('显示格式', () => {
  it('有构建号时写成 "1.0.0 (1)"', async () => {
    const { setNativeVersion, versionLabel } = await loadVersion();
    setNativeVersion('1.0.0', '1');
    expect(versionLabel()).toBe('1.0.0 (1)');
  });

  it('构建期状态下也是 "版本 (构建号)"', async () => {
    const { versionLabel } = await loadVersion();
    expect(versionLabel()).toBe(`${PLIST_VERSION} (${PLIST_BUILD})`);
  });
});
