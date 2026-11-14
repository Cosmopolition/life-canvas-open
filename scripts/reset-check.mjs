#!/usr/bin/env node
//
// reset-check.mjs — 验证「画布重置」这个动作真的把状态清干净了，而且没碰数据。
//
// 为什么要用真浏览器而不是单测：
//   这个功能的失败方式全是"静默失效" —— 状态清了但界面还亮着、
//   搜索框空了但 query 还在、图例高亮没灭 ——
//   这些只有把页面真跑起来、读真实 DOM 才抓得到。
//
// 走法：制造一堆脏状态（焦点 / 筛选 / 搜索 / 选中 / 点类型 / 缩放）→
//       点重置 → 逐条断言。
//
// 用法：
//   node scripts/reset-check.mjs http://127.0.0.1:4177/

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:4177/';
const PORT = 9411;

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
const proc = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  `--user-data-dir=/tmp/lc-reset-profile-${PORT}`,
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

let loadWaiter = null;
browser.on('Page.loadEventFired', () => { if (loadWaiter) { loadWaiter(); loadWaiter = null; } });

const evalJs = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
};

async function nav(url) {
  const p = new Promise((r) => { loadWaiter = r; });
  await S('Page.navigate', { url });
  await p;
  await sleep(600);
}

// ── 断言 ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  →  ' + detail : ''}`); }
};

// ── 场景 ───────────────────────────────────────────────────────────────
console.log('⇒', URL_);

await nav(URL_);
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 1) 跨过门禁与引导
await evalJs(`(function(){
  var g=document.getElementById('gate');
  if(g&&!g.hidden){var n=document.getElementById('gateNoCrypto'); if(n)n.click();}
  return 1;})()`);
await sleep(1500);
await evalJs(`(function(){
  var o=document.getElementById('onboard');
  if(o&&!o.hidden) document.getElementById('onboardSkip').click();
  return 1;})()`);
await sleep(1200);

// 2) 载入示例空间，让画布有内容
await evalJs(`(function(){
  var b=document.querySelector('#seg button[data-v="canvas"]'); if(b) b.click(); return 1;})()`);
await sleep(900);
const loaded = await evalJs(`(function(){
  var b=document.getElementById('esLoad');
  if(b){ b.click(); return 'clicked'; }
  return 'no-button';})()`);
if (loaded === 'clicked') await sleep(2400);
console.log('  示例空间:', loaded);

// 3) 制造脏状态：焦点 + 筛选 + 搜索 + 选中 + 点类型 + 缩放
console.log('\n▸ 制造脏状态');
const dirty = await evalJs(`(function(){
  // 点第一个主题 → 设主题焦点
  var theme = document.querySelector('#treeTheme .tnode');
  if(theme) theme.click();
  // 点一个点类型图例 → 设点类型筛选
  var lg = document.querySelector('#lgType .lg');
  if(lg) lg.click();
  // 缩放：把视口搅乱
  var cv = document.getElementById('cv');
  if(cv) cv.focus();
  return { theme: !!theme, legend: !!lg };
})()`);
await sleep(700);

// 筛选：走真正的筛选面板，选一个状态 + 一个标签，再应用
const filt = await evalJs(`(function(){
  document.getElementById('btnFilter').click();
  return 1;})()`);
await sleep(600);
const picked = await evalJs(`(function(){
  var chips = document.querySelectorAll('#modalCard .fchips .fchip');
  if(!chips.length) return { ok:false, reason:'没有可点的筛选项' };
  chips[0].click();
  // 时间范围：选第一个"不限"之外的下拉项比较脆，这里只测状态/标签
  var ok = document.querySelector('#modalCard .modal-acts .btn.acc');
  if(ok) ok.click();
  return { ok:true, picked: chips[0].textContent.trim() };})()`);
await sleep(800);
console.log('  筛选已施加:', JSON.stringify(picked));

// 搜索
await evalJs(`(function(){
  var q=document.getElementById('q');
  q.value='工作';
  q.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;})()`);
await sleep(900);

// 选中一个点 + 一条边
await evalJs(`(function(){
  var ids = window.__lcNodeIds ? window.__lcNodeIds() : [];
  if(ids.length) window.__lcSelect(ids[0]);
  var es = window.__lcEdges ? window.__lcEdges() : [];
  if(es.length) window.__lcSelectEdge(es[0].id);
  return 1;})()`);
await sleep(500);
// 缩放搅乱视口
await evalJs(`(function(){
  var cv=document.getElementById('cv');
  cv.focus();
  return 1;})()`);
for (const [k, code] of [['+', 187], ['+', 187], ['+', 187]]) {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Equal', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Equal', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await sleep(200);
}
await sleep(600);

const before = await evalJs(`(function(){
  return {
    view: window.__lcView(),
    state: window.__lcState(),
    q: document.getElementById('q').value,
    qcnt: document.getElementById('qcnt').textContent,
    legendOn: document.querySelectorAll('#lgType .lg.on').length,
    filterBadgeHidden: document.getElementById('filterBadge').hidden,
    scale: window.__lcVp(),
    nodes: window.__lcState().nodes,
    crumb: document.getElementById('crumb').textContent.trim(),
  };})()`);
console.log('  重置前 view:', JSON.stringify(before.view));
console.log('  重置前 界面:', JSON.stringify({
  q: before.q, legendOn: before.legendOn, filterBadgeHidden: before.filterBadgeHidden,
  crumb: before.crumb, scale: Math.round(before.scale * 100) + '%',
}));

// 4) 点重置
console.log('\n▸ 点重置');
await evalJs(`(function(){ document.getElementById('zReset').click(); return 1;})()`);
await sleep(1400);

const after = await evalJs(`(function(){
  return {
    view: window.__lcView(),
    state: window.__lcState(),
    q: document.getElementById('q').value,
    qcnt: document.getElementById('qcnt').textContent,
    legendOn: document.querySelectorAll('#lgType .lg.on').length,
    filterBadgeHidden: document.getElementById('filterBadge').hidden,
    scale: window.__lcVp(),
    nodes: window.__lcState().nodes,
    crumb: document.getElementById('crumb').textContent.trim(),
    treeOn: document.querySelectorAll('#treeTheme .tnode.on, #treeStage .tnode.on').length,
    zoomText: document.getElementById('zv').textContent,
  };})()`);
console.log('  重置后 view:', JSON.stringify(after.view));

console.log('\n▸ 断言');
check(after.view.themeId === null, '主题焦点已清空', `themeId=${after.view.themeId}`);
check(after.view.stageId === null, '阶段焦点已清空', `stageId=${after.view.stageId}`);
check(after.view.filterActive === false, '筛选已清空', `filterCount=${after.view.filterCount}`);
check(after.view.filterCount === 0, '筛选条目数归零', `filterCount=${after.view.filterCount}`);
check(after.view.query === '', '搜索词已清空', `query="${after.view.query}"`);
check(after.view.hits === 0, '搜索命中集已清空', `hits=${after.view.hits}`);
check(after.view.ctxSet === 0, '关系上下文集已清空', `ctxSet=${after.view.ctxSet}`);
check(after.view.selected === 0, '选中的点已清空', `selected=${after.view.selected}`);
check(after.view.selectedEdgeId === null, '选中的关系已清空', `edgeId=${after.view.selectedEdgeId}`);
check(after.view.nodeTypes.length === 0, '点类型筛选已清空', JSON.stringify(after.view.nodeTypes));
check(after.view.lens === after.state.nodes, '透镜覆盖全部点（渲染层正确）',
  `${after.view.lens} / ${after.state.nodes}`);

// 界面同步（状态清了，界面也得跟着清）
check(after.q === '', 'web 搜索框已清空', `value="${after.q}"`);
check(after.qcnt === '', '搜索命中计数已清空', `"${after.qcnt}"`);
check(after.legendOn === 0, '点类型图例高亮已灭', `还有 ${after.legendOn} 个亮着`);
check(after.filterBadgeHidden === true, '筛选角标已隐藏');
check(after.treeOn === 0, '左栏焦点行不再高亮', `还有 ${after.treeOn} 行高亮`);
check(after.crumb.includes('全部'), '面包屑回到"全部"', after.crumb);
check(after.state.focusNodes === after.state.nodes, '画布显示全部点',
  `${after.state.focusNodes} / ${after.state.nodes}`);

// 数据不动 —— 这是重置的硬要求
check(after.nodes === before.nodes, '数据一个都没少', `${before.nodes} → ${after.nodes}`);

// 视口回到全局：缩放应接近"装下全库"的比例，而不是被搅乱的放大值
check(after.scale < before.scale, '视口缩放已回到全局', `${before.scale} → ${after.scale}`);
check(Math.abs(after.zoomText.replace('%','') - Math.round(after.scale*100)) <= 1,
  '缩放读数与实际一致', `读数 ${after.zoomText} vs 实际 ${Math.round(after.scale*100)}%`);
// 「已定位」标记：重置自己定位成功了，标记就该归位 ——
// 不然用户之后再切视图会被 positionCanvasOnce 重新拽回去。
check(after.view.positioned === true, '「已定位」标记已归位', `positioned=${after.view.positioned}`);

// 5) 重置后再搜一次，确认搜索还能正常工作（没被重置搞坏）
console.log('\n▸ 重置后搜索仍可用');
await evalJs(`(function(){
  var q=document.getElementById('q');
  q.value='工作';
  q.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;})()`);
await sleep(900);
const afterSearch = await evalJs(`(function(){
  return { qcnt: document.getElementById('qcnt').textContent, q: document.getElementById('q').value };})()`);
check(afterSearch.q === '工作', '重置后能重新输入搜索词', `value="${afterSearch.q}"`);
check(/^\d/.test(afterSearch.qcnt), '重置后搜索能出结果', `"${afterSearch.qcnt}"`);

// 6) 快捷键 R 也能触发
console.log('\n▸ 快捷键 R');
await evalJs(`(function(){
  var q=document.getElementById('q'); q.value='x'; q.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;})()`);
await sleep(700);
await evalJs(`(function(){
  var t=document.querySelector('#treeTheme .tnode'); if(t) t.click(); return 1;})()`);
await sleep(600);
await evalJs(`document.getElementById('cv').focus()`);
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
await sleep(1400);
const afterR = await evalJs(`(function(){
  return { view: window.__lcView(), q: document.getElementById('q').value };})()`);
check(afterR.view.themeId === null && afterR.view.stageId === null, 'R 键清掉了焦点');
check(afterR.view.query === '' && afterR.q === '', 'R 键清掉了搜索词', `value="${afterR.q}"`);

// 7) 重置后筛选面板仍能用（没被重置搞坏）
console.log('\n▸ 重置后筛选仍可用');
await evalJs(`(function(){ document.getElementById('btnFilter').click(); return 1;})()`);
await sleep(600);
const canFilter = await evalJs(`(function(){
  var chips = document.querySelectorAll('#modalCard .fchips .fchip');
  if(!chips.length) return { ok:false };
  chips[0].click();
  var ok = document.querySelector('#modalCard .modal-acts .btn.acc');
  if(ok) ok.click();
  return { ok:true };})()`);
await sleep(800);
const afterFilter = await evalJs(`(function(){ return window.__lcView(); })()`);
check(canFilter.ok === true, '重置后筛选面板能打开并选项');
check(afterFilter.filterActive === true, '重置后筛选能真正生效',
  `filterCount=${afterFilter.filterCount}`);
// 再重置一次，确认可重复
await evalJs(`(function(){ document.getElementById('zReset').click(); return 1;})()`);
await sleep(1400);
const afterReset2 = await evalJs(`(function(){ return window.__lcView(); })()`);
check(afterReset2.filterActive === false, '重置可重复执行（第二次也清干净了）',
  `filterCount=${afterReset2.filterCount}`);

// 8) 从**非画布视图**触发重置 —— 原生 ⌘⇧R 在列表视图下走的就是这条路。
//    这条路径比上面多一步 switchView('canvas')：画布刚显示时尺寸还没落定，
//    如果 fit 抢在布局前面跑，缩放会算成一个退化值（0 宽 → 极小的比例），
//    画面看着像"重置之后更糟了"。所以这里专门量一下。
console.log('\n▸ 非画布视图下重置');
const PX = `(function(){
  var cv=document.getElementById('cv');
  var c=cv.getContext('2d');
  var d=c.getImageData(0,0,cv.width,cv.height).data;
  var n=0; for(var i=3;i<d.length;i+=4){ if(d[i]>0) n++; }
  return n;})()`;

// 先回到画布，量一份"有内容"的像素数当基线
await evalJs(`(function(){ document.querySelector('#seg button[data-v="canvas"]').click(); return 1;})()`);
await sleep(900);
const pxBaseline = await evalJs(PX);

// 弄脏状态：焦点 + 搜索
await evalJs(`(function(){
  var t=document.querySelector('#treeTheme .tnode'); if(t) t.click();
  var q=document.getElementById('q'); q.value='工作'; q.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;})()`);
await sleep(800);

// 切到列表视图（画布隐藏，尺寸 0×0）
await evalJs(`(function(){ document.querySelector('#seg button[data-v="lv"]').click(); return 1;})()`);
await sleep(800);
const inList = await evalJs(`(function(){
  return { view: window.__lcState().view,
           cvW: Math.round(document.getElementById('cv').getBoundingClientRect().width) };})()`);
console.log('  列表视图:', JSON.stringify(inList));

// 在列表视图下点重置
await evalJs(`(function(){ document.getElementById('zReset').click(); return 1;})()`);
await sleep(1600);

const afterList = await evalJs(`(function(){
  return { view: window.__lcView(), state: window.__lcState(),
           scale: window.__lcVp(), zoomText: document.getElementById('zv').textContent,
           q: document.getElementById('q').value };})()`);
const pxAfter = await evalJs(PX);
console.log('  重置后 view:', JSON.stringify(afterList.view));

check(afterList.state.view === 'canvas', '非画布视图下重置会切回画布', `view=${afterList.state.view}`);
check(afterList.view.themeId === null && afterList.view.stageId === null, '非画布视图下重置清掉了焦点');
check(afterList.view.query === '' && afterList.q === '', '非画布视图下重置清掉了搜索词');
check(afterList.view.selected === 0, '非画布视图下重置清掉了选中');
check(afterList.view.lens === afterList.state.nodes, '非画布视图下重置后透镜覆盖全部点',
  `${afterList.view.lens} / ${afterList.state.nodes}`);
check(afterList.scale >= 0.05, '缩放不是退化值（画布尺寸已落定）', `scale=${afterList.scale}`);
check(Math.abs(afterList.zoomText.replace('%','') - Math.round(afterList.scale*100)) <= 1,
  '非画布视图重置后缩放读数与实际一致',
  `读数 ${afterList.zoomText} vs 实际 ${Math.round(afterList.scale*100)}%`);
check(pxAfter > pxBaseline * 0.5, '重置后画布有内容（不是空白）',
  `${pxAfter} / 基线 ${pxBaseline}`);
check(afterList.state.nodes === after.state.nodes, '非画布视图下重置也没动数据',
  `${after.state.nodes} → ${afterList.state.nodes}`);
check(afterList.view.positioned === true, '非画布视图下「已定位」标记已归位',
  `positioned=${afterList.view.positioned}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
cleanup();
process.exit(fail ? 1 : 0);
