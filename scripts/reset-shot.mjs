#!/usr/bin/env node
//
// reset-shot.mjs — 给「重置」按钮截几张图，确认它在真实界面里长什么样。
//
// 为什么要截图：代码写对了不等于界面好看。
// 按钮挤在缩放条里，宽度够不够、分隔线会不会打架、深浅色下看不看得清 ——
// 这些只能看图。
//
// 用法：
//   node scripts/reset-shot.mjs http://127.0.0.1:4177/ shots/reset

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:4177/';
const OUT = process.argv[3] || 'shots/reset';
const PORT = 9455;

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
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到 Chromium');
}

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

const chrome = findChrome();
mkdirSync(OUT, { recursive: true });

const proc = spawn(chrome, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  `--user-data-dir=/tmp/lc-reset-shot-${PORT}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
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

let loadWaiter = null;
browser.on('Page.loadEventFired', () => { if (loadWaiter) { loadWaiter(); loadWaiter = null; } });

const evalJs = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const shot = async (name, clip) => {
  const p = { format: 'png' };
  if (clip) { p.clip = { ...clip, scale: 2 }; p.captureBeyondViewport = false; }
  const { data } = await S('Page.captureScreenshot', p);
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  ✓', name);
};
const viewport = async (w, h) => {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await sleep(200);
};

console.log('⇒', URL_, '→', OUT);
const p = new Promise((r) => { loadWaiter = r; });
await S('Page.navigate', { url: URL_ });
await p;
await sleep(800);
await viewport(1440, 900);

await evalJs(`(function(){ var g=document.getElementById('gate'); if(g&&!g.hidden){var n=document.getElementById('gateNoCrypto'); if(n)n.click();} return 1;})()`);
await sleep(1500);
await evalJs(`(function(){ var o=document.getElementById('onboard'); if(o&&!o.hidden) document.getElementById('onboardSkip').click(); return 1;})()`);
await sleep(1200);
await evalJs(`(function(){ var b=document.querySelector('#seg button[data-v="canvas"]'); if(b) b.click(); return 1;})()`);
await sleep(900);
await evalJs(`(function(){ var b=document.getElementById('esLoad'); if(b) b.click(); return 1;})()`);
await sleep(2400);
await evalJs(`(function(){ var b=document.querySelector('#seg button[data-v="canvas"]'); if(b) b.click(); return 1;})()`);
await sleep(1200);

// ① 缩放条特写（深色）
const zb = await evalJs(`(function(){
  var z=document.getElementById('zReset');
  var r=z.getBoundingClientRect();
  return {x:r.x,y:r.y,w:r.width,h:r.height};
})()`);
console.log('  重置按钮尺寸:', JSON.stringify(zb));
await shot('01-zbar-dark', { x: zb.x - 170, y: zb.y - 16, width: 300, height: 48 });

// ② 弄脏之后（焦点 + 搜索），看重置按钮还在
await evalJs(`(function(){
  var t=document.querySelector('#treeTheme .tnode'); if(t) t.click();
  var q=document.getElementById('q'); q.value='工作'; q.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;})()`);
await sleep(1000);
await shot('02-dirty-canvas');

// ③ 点重置后的全景
await evalJs(`(function(){ document.getElementById('zReset').click(); return 1;})()`);
await sleep(1500);
await shot('03-after-reset');

// ④ 浅色
await evalJs(`document.documentElement.dataset.theme='light'`);
await sleep(700);
await shot('04-zbar-light', { x: zb.x - 170, y: zb.y - 16, width: 300, height: 48 });

// ⑤ 原生模式（顶栏隐藏 —— 这正是重置按钮要放在画布里的理由）
await evalJs(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.nativeShell='1'`);
await sleep(800);
await shot('05-native-mode');
await shot('06-native-zbar', { x: zb.x - 170, y: zb.y - 16, width: 300, height: 48 });

// ⑥ 窄屏
await evalJs(`document.documentElement.dataset.nativeShell=''; delete document.documentElement.dataset.nativeShell;`);
await viewport(420, 780);
await sleep(800);
await shot('07-narrow');

console.log('完成');
cleanup();
process.exit(0);
