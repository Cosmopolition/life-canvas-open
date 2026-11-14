/**
 * 找一个能用的 Chromium + playwright。
 *
 * ⚠️ 为什么要有这个文件：
 *   e2e.cjs / stress.cjs 原来是给一台 Linux 容器写的，里面写死了
 *   `/usr/local/lib/node_modules/playwright` 和 `/root/.cache/ms-playwright/...`。
 *   拿到别人的 Mac 上跑 —— **在第一行就炸**，而且报错信息是
 *   "Cannot find module '/usr/local/...'"，看不出是路径写死了。
 *
 *   开源之后，贡献者拿到的第一份说明就是「怎么跑起来」——
 *   这类"只在作者机器上能跑"的脚本是最劝退的一种。
 *
 * 查找顺序（先到先用）：
 *   ① 环境变量 PLAYWRIGHT_MODULE —— 指到 playwright 模块（文件或目录）
 *   ② 本仓库 node_modules 里的 playwright
 *   ③ 全局安装的 playwright（npm root -g）
 *
 * 浏览器二进制：
 *   找 ms-playwright 缓存里的 Chromium；找不到就不传 executablePath ——
 *   让 playwright 用它自己下载的那份（那才是它预期的用法）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

/** 加载 playwright 模块。找不到就抛一个**看得懂**的错。 */
function loadPlaywright() {
  const tries = [];

  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright');

  // 全局安装目录（npm root -g）
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) tries.push(path.join(root, 'playwright'));
  } catch {
    /* 没装 npm 或拿不到全局根目录：跳过这一项 */
  }

  const tried = [];
  for (const t of tries) {
    try {
      const mod = require(t);
      if (mod && mod.chromium) {
        if (tried.length) console.log(`  · playwright 用的是：${t}`);
        return mod;
      }
    } catch (e) {
      tried.push(`${t}（${e.code || e.message}）`);
    }
  }

  throw new Error(
    '找不到 playwright。装一个就行：\n' +
      '  npm i -D playwright && npx playwright install chromium\n' +
      '或者指定一个已有的：\n' +
      '  PLAYWRIGHT_MODULE=/path/to/playwright node e2e.cjs\n' +
      '试过这些位置：\n' +
      tried.map((t) => '  · ' + t).join('\n'),
  );
}

/**
 * 找一个 Chromium 二进制。找不到返回 undefined ——
 * 让 playwright 用它自己下载的那份（这才是它预期的用法）。
 */
function findChrome() {
  const cands = [];
  const caches = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'), // macOS
    path.join(os.homedir(), '.cache/ms-playwright'), // Linux
    path.join(os.homedir(), 'AppData/Local/ms-playwright'), // Windows
  ];
  for (const r of caches) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r)) {
      // playwright 的目录名形如 chromium-1243 / chromium_headless_shell-1243
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-win/chrome.exe',
      ]) {
        cands.push(path.join(r, d, rel));
      }
    }
  }
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  cands.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  cands.push('/usr/bin/google-chrome');
  cands.push('/usr/bin/chromium');
  cands.push('/usr/bin/chromium-browser');

  for (const c of cands) if (fs.existsSync(c)) return c;
  return undefined;
}

/**
 * 起一个浏览器。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noSandbox] 容器里跑（root）时需要
 */
async function launch(opts = {}) {
  const { chromium } = loadPlaywright();
  const executablePath = findChrome();
  const args = [];
  if (opts.noSandbox) args.push('--no-sandbox');
  if (executablePath) {
    console.log(`  · 浏览器：${executablePath}`);
  } else {
    console.log('  · 浏览器：用 playwright 自带的那份');
  }
  return chromium.launch(executablePath ? { executablePath, args } : { args });
}

module.exports = { loadPlaywright, findChrome, launch };
