#!/usr/bin/env node
//
// uishot.mjs — 用 CDP 驱动本机 Chromium，把人生画布的各个界面截下来。
//
// 为什么不直接 screencapture：那条路要「屏幕录制」权限，在自动化环境里拿不到。
// CDP 走浏览器内部接口，不需要任何系统权限，还能精确控制视口、深浅色、
// 有没有数据、有没有跨过首启门禁 —— 正好是审 UI 需要的那几个自由度。
//
// 用法：
//   node scripts/uishot.mjs [url] [outDir] [locale] [theme]
//   node scripts/uishot.mjs http://127.0.0.1:4173/ shots/ui
//   node scripts/uishot.mjs http://127.0.0.1:4173/ shots/ui-en en-US
//   node scripts/uishot.mjs http://127.0.0.1:4173/ shots/ui-dark '' dark
//
// 产物：outDir/<name>.png（deviceScaleFactor=2，Retina 清晰度）

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:4173/';
const OUT = process.argv[3] || 'shots/ui';
// 界面语言（可选）：zh-CN / en-US。不给就跟随浏览器（无头 Chromium 是 en-US）。
const LOCALE = process.argv[4] || '';
// 主题（可选）：dark / light。默认 dark。
//
// ★ 为什么默认是 dark，而不是「跟随系统」：
//   应用的主题跟着 prefers-color-scheme 走（src/persist/db.ts 的 systemTheme），
//   而**无头 Chromium 默认是 light** —— 产物深浅色取决于跑截图那台机器的
//   系统外观，不是脚本决定的。已经踩过：同一个脚本在两台机器上跑出来
//   一套深一套浅，README 里的图就对不上了。
//   而且脚本末尾本来就有专门拍浅色主题的场景（light-canvas / light-list），
//   说明「默认深色、浅色单独拍」本来就是设计意图。
//   → 显式指定，产物才可复现。
const THEME = (process.argv[5] || 'dark').toLowerCase();
const PORT = 9333 + (process.pid % 400);

// ── 找 Chromium ─────────────────────────────────────────────────────────
function findChrome() {
  const cands = [];
  for (const r of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r)) {
      cands.push(join(r, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
      cands.push(join(r, d, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
    }
  }
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  cands.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到 Chromium');
}

// ── 极简 CDP 客户端 ────────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.method + ' ' + JSON.stringify(msg.error))) : p.res(msg.result);
      } else {
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, fn) { this.handlers.set(method, fn); }
}

// ── 启动 ───────────────────────────────────────────────────────────────
const chrome = findChrome();
mkdirSync(OUT, { recursive: true });

const proc = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  `--user-data-dir=/tmp/uishot-profile-${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('DevTools 没起来');
}

const ver = await waitForDevtools();
const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => browser.send(m, p, sessionId);

await S('Page.enable');
await S('Runtime.enable');
// ★ 语言要在**页面任何脚本之前**定下来：应用 boot 时读的就是这个偏好。
//   走的是"用户显式偏好"那条路径，优先级最高，原生报来的系统语言也盖不过它。
if (LOCALE) {
  await S('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('lc.locale', ${JSON.stringify(LOCALE)}); } catch (e) {}`,
  });
}

// ★ 主题同理，要在 boot 之前定下来。
//   应用的深浅色跟着 prefers-color-scheme 走（默认设置是 auto）。
//   模拟成 dark 之后，matchMedia('(prefers-color-scheme: light)') 不再命中，
//   应用 boot 起来就是深色 —— 不用等 change 事件回流。
if (THEME === 'dark' || THEME === 'light') {
  await S('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value: THEME }],
  });
}

let loadWaiter = null;
browser.on('Page.loadEventFired', () => { if (loadWaiter) { loadWaiter(); loadWaiter = null; } });

const evalJs = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
};

const viewport = async (w, h) => {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await sleep(150);
};

const shot = async (name) => {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  ✓', name);
};

async function nav(url) {
  const p = new Promise(r => { loadWaiter = r; });
  await S('Page.navigate', { url });
  await p;
  await sleep(500);
}

const key = async (k, code, keyCode) => {
  for (const type of ['keyDown', 'keyUp']) {
    await S('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
  await sleep(320);
};

// ── 场景 ───────────────────────────────────────────────────────────────
console.log('⇒', URL_, '→', OUT);
await nav(URL_);
await viewport(1440, 900);

// 1) 跨过首启：关加密 → 跳过引导
await evalJs(`(function(){
  var g=document.getElementById('gate');
  if(g&&!g.hidden){var n=document.getElementById('gateNoCrypto'); if(n)n.click();}
  return 1;})()`);
await sleep(1400);
await evalJs(`(function(){
  var o=document.getElementById('onboard');
  if(o&&!o.hidden) document.getElementById('onboardSkip').click();
  return 1;})()`);
await sleep(1500);

const view = (v) => evalJs(`(function(){
  var b=document.querySelector('#seg button[data-v="${v}"]'); if(b) b.click(); return 1;})()`);

// 2) 载入示例空间 —— 空库看不清 UI 的真实密度。
//    #esLive 那组按钮是画布空状态里生成的，默认视图是「今日」，
//    那时 DOM 里还没有它 → 必须先切到画布再点。
await view('canvas');
await sleep(900);
const loaded = await evalJs(`(function(){
  var b=document.getElementById('esLoad');
  if(b){ b.click(); return 'clicked'; }
  return 'no-button';})()`);
if (loaded === 'clicked') { await sleep(2400); }
console.log('  示例空间:', loaded);

// 3) 选中一个点，让右侧检视面板有内容
await view('canvas');
await sleep(900);
await evalJs(`document.getElementById('cv').focus()`);
await key('ArrowRight', 'ArrowRight', 39);
await key('ArrowRight', 'ArrowRight', 39);
await key('ArrowDown', 'ArrowDown', 40);
await sleep(500);

// 3.5) 周历要有密度才看得出真实的样子。
//      示例空间的节点多是月粒度（'2026-03'），周历的日格子会是全空的 ——
//      造几条日粒度记录，再给其中一周开一个复盘空间（有 ✓ 和计数）。
//      这些都在浏览器内的临时库里，不影响用户数据。
await view('canvas');
await sleep(400);
const seeded = await evalJs(`(function(){
  var mk = window.__lcMakeNode;
  if (!mk) return 'no-api';
  var days = ['2026-10-27','2026-10-28','2026-10-30','2026-11-02','2026-11-03','2026-11-05'];
  for (var i = 0; i < days.length; i++) mk('周历示例记录 ' + days[i].slice(5), 'default', days[i]);
  // 给第 45 周（11-02 起）开一个复盘空间，并写一条周复盘
  // （reflect + #周复盘 标记，周历才会认它、显示「✓ 复盘」）
  mk('第 45 周的复盘', 'week:2026-11-02', '2026-11-02', 'reflect', ['周复盘']);
  mk('这一周的随手记', 'week:2026-11-02', '2026-11-04');
  return 'ok';
})()`);
console.log('  周历示例数据:', seeded);

// 3.6) 周画布（阶段三）：空间条 / 引入面板 / 空间下拉 / 回原文行
//      走**真路径**：周历里点那一行 → 进那一周的复盘画布。
await view('wk');
await sleep(800);
const entered = await evalJs(`(function(){
  var row = document.querySelector('#vWk .wk-row[data-monday="2026-11-02"]');
  if (row) { row.click(); return 'clicked'; }
  return 'no-row';
})()`);
console.log('  进第 45 周:', entered);
await sleep(1500);
await shot('week-canvas');

await evalJs(`document.getElementById('spaceSwitch').click()`);
await sleep(500);
await shot('week-space-menu');
await evalJs(`document.getElementById('spaceMenu').hidden=true`);

await evalJs(`document.getElementById('wkImport').click()`);
await sleep(700);
await shot('week-import-modal');
// 真的点「引入」—— 走 UI 那条路，不是调内部接口
const imported = await evalJs(`(function(){
  var ok = document.querySelector('#modal .modal-acts .btn.acc');
  if (ok) { ok.click(); return 'clicked'; }
  return 'no-ok';
})()`);
console.log('  引入原数据:', imported);
await sleep(1500);
await shot('week-imported');

await evalJs(`(function(){
  var ns = window.__lcSpaceNodes();
  for (var i = 0; i < ns.length; i++) if (ns[i].sourceId) { window.__lcSelect(ns[i].id); break; }
  return 1;
})()`);
await sleep(900);
await shot('week-source-row');

// 3.7) 复盘卡片预览面板（阶段五）
//      走真路径：点空间条上的「生成复盘卡片」。
await evalJs(`document.getElementById('wkCard').click()`);
await sleep(2200);
await shot('week-review-card');
// ★ 必须点「完成」正常关闭 —— 直接 hidden=true 的话 modal 的 promise 永不 resolve，
//   面板加在 #modalCard 上的 rc-modal（加宽）就摘不掉，后面的弹窗会全被撑宽。
await evalJs(`(function(){
  var b = document.querySelector('#modal .modal-acts .btn:not(.acc)');
  if (b) { b.click(); return 'closed'; }
  return 'no-btn';
})()`);
await sleep(600);

// 回到主画布 —— 后面的场景都该是主画布的
await evalJs(`window.__lcSetSpace('default')`);
await sleep(600);

const scenes = [
  ['today', 1440, 900, () => view('today')],
  ['canvas', 1440, 900, () => view('canvas')],
  ['canvas-selected', 1440, 900, async () => {}],
  ['timeline', 1440, 900, () => view('tl')],
  ['list', 1440, 900, () => view('lv')],
  ['week-calendar', 1440, 900, () => view('wk')],
  ['today-mac', 1280, 840, async () => { await view('today'); }],
];

for (const [name, w, h, act] of scenes) {
  await viewport(w, h);
  await act();
  await sleep(900);
  await shot(name);
}

// 4) 原生外壳模式（macOS app 里 header 是隐藏的，web 顶栏让位给原生工具栏）
await evalJs(`document.documentElement.dataset.nativeShell='1'`);
await view('canvas');
await viewport(1280, 840);
await sleep(900);
await shot('native-canvas');
await view('today');
await sleep(800);
await shot('native-today');

// 5) 浅色主题
await evalJs(`document.documentElement.dataset.nativeShell='';delete document.documentElement.dataset.nativeShell;
             document.documentElement.dataset.theme='light'`);
await view('canvas');
await viewport(1440, 900);
await sleep(900);
await shot('light-canvas');
await view('lv');
await sleep(800);
await shot('light-list');

// 6) 窄屏断点
await evalJs(`delete document.documentElement.dataset.theme`);
await view('canvas');
for (const [w, h] of [[1100, 860], [900, 860], [700, 860]]) {
  await viewport(w, h);
  await sleep(700);
  await shot(`canvas-${w}`);
}

// 7) 弹层：筛选 / 设置 / 快捷键
await viewport(1440, 900);
await view('canvas');
await sleep(500);
await evalJs(`document.getElementById('btnFilter').click()`);
await sleep(700);
await shot('modal-filter');
await evalJs(`document.getElementById('modal').hidden=true`);
await evalJs(`document.getElementById('btnSettings').click()`);
await sleep(700);
await shot('modal-settings');
await evalJs(`document.getElementById('modal').hidden=true`);
await evalJs(`document.getElementById('btnKeys').click()`);
await sleep(700);
await shot('modal-keys');

// 8) 阶段四：图卡（作品 + 图 ⇒ 图片铺满整块）+ 缩放手柄
//
//    ★ 必须先清焦点：焦点落在某个主题上时，不属于它的点**根本不画**
//      （visibleNodesByFocus 过滤）—— 不清焦点拍出来会是"图卡没渲染"的假象。
//    ★ 必须等图解开：图是异步 decode 的，没解开时画布上只有一块占位色。
await evalJs(`document.getElementById('modal').hidden=true`);
await view('canvas');
await sleep(600);
await evalJs(`window.__lcSetFocus(null, null)`);
await sleep(900);

const cardImage = await evalJs(`(function(){
  var c = document.createElement('canvas'); c.width = 800; c.height = 600;
  var g = c.getContext('2d');
  var grd = g.createLinearGradient(0, 0, 800, 600);
  grd.addColorStop(0, '#2f5d8a'); grd.addColorStop(0.55, '#4d7fa8'); grd.addColorStop(1, '#e0a458');
  g.fillStyle = grd; g.fillRect(0, 0, 800, 600);
  g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '600 72px sans-serif';
  g.fillText('作品', 44, 150);
  g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(430, 340, 120, 0, Math.PI*2); g.fill();
  g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.arc(430, 340, 120, 0, Math.PI*2); g.fill();
  return c.toDataURL('image/jpeg', 0.85);
})()`);
const cardId = await evalJs(
  `window.__lcMakeImageCard('我的第一件作品', ${JSON.stringify(cardImage)}, {x: 1600, y: 900, w: 320, h: 220})`
);
await sleep(600);
// 等图解开再拍
let imgReady = false;
for (let i = 0; i < 40; i++) {
  imgReady = await evalJs(`window.__lcImageReady(${JSON.stringify(cardId)})`);
  if (imgReady) break;
  await sleep(150);
}
console.log('  图卡解码完成:', imgReady);
await evalJs(`window.__lcCenterOn(${JSON.stringify(cardId)}, 1)`);
await sleep(600);
await evalJs(`window.__lcSelect(${JSON.stringify(cardId)})`);
await sleep(900);
await shot('image-card');
// 放大一张 —— 缩放手柄和标题压边要看清楚
await evalJs(`window.__lcCenterOn(${JSON.stringify(cardId)}, 2)`);
await sleep(800);
await shot('image-card-zoom');
// 缩远一张 —— 图卡在低缩放下**也要有图**（只有标题让位给 LOD）
await evalJs(`window.__lcCenterOn(${JSON.stringify(cardId)}, 0.3)`);
await sleep(800);
await shot('image-card-far');

console.log('完成');
cleanup();
process.exit(0);
