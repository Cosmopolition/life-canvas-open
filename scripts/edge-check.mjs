#!/usr/bin/env node
//
// edge-check.mjs — 用 CDP 驱动本机 Chromium，验证「连线（关系）」的增删改。
//
// 为什么要有这个：这套交互**全是静默失败**的活儿 ——
//   · 删除按钮 opacity:0 → 看不见（不是不能用，是找不到）
//   · window.confirm 在原生壳里永远返回"取消" → 点了没反应
//   · 平行线叠在一起 → 看着只有一条，也点不中具体那条
// 光看代码和截图都发现不了，得真的点一遍。
//
// 用法：
//   node scripts/edge-check.mjs [url] [outDir]

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:4173/';
const OUT = process.argv[3] || 'shots/edge';
const PORT = 9800 + (process.pid % 300);

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
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  `--user-data-dir=/tmp/edge-check-profile-${PORT}`,
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

const shot = async (name) => {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  📷', name);
};

const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await S('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  await sleep(260);
};

/* ---------- 断言 ---------- */
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---------- 场景 ---------- */
console.log('⇒', URL_, '→', OUT);

{
  const p = new Promise(r => { loadWaiter = r; });
  await S('Page.navigate', { url: URL_ });
  await p;
}
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(700);

// 跨过首启门禁 + 引导
await evalJs(`(function(){var g=document.getElementById('gate');
  if(g&&!g.hidden){var n=document.getElementById('gateNoCrypto'); if(n)n.click();}return 1;})()`);
await sleep(1400);
await evalJs(`(function(){var o=document.getElementById('onboard');
  if(o&&!o.hidden) document.getElementById('onboardSkip').click(); return 1;})()`);
await sleep(1200);

// 切到画布 + 载入示例空间
await evalJs(`(function(){var b=document.querySelector('#seg button[data-v="canvas"]'); if(b)b.click(); return 1;})()`);
await sleep(800);
await evalJs(`(function(){var b=document.getElementById('esLoad'); if(b)b.click(); return 1;})()`);
await sleep(2600);

const edges = await evalJs(`window.__lcEdges ? window.__lcEdges() : []`);
check('示例空间有关系数据', edges.length > 0, `${edges.length} 条`);
if (!edges.length) { console.log('✗ 没有数据，后面测不了'); process.exit(1); }

// ── 1. 检视面板：关系行的删除按钮**看得见** ──────────────────────
const nodeWithEdges = await evalJs(`(function(){
  var es = window.__lcEdges();
  var counts = {};
  es.forEach(function(e){ counts[e.fromId]=(counts[e.fromId]||0)+1; counts[e.toId]=(counts[e.toId]||0)+1; });
  var ids = Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];});
  if(!ids.length) return null;
  window.__lcSelect(ids[0]);
  return ids[0];
})()`);
await sleep(700);

const relInfo = await evalJs(`(function(){
  var rows = document.querySelectorAll('.rel-i');
  var del = document.querySelector('.rel-del');
  var tag = document.querySelector('.rel-tag');
  return {
    rows: rows.length,
    delOpacity: del ? parseFloat(getComputedStyle(del).opacity) : -1,
    delVisible: del ? !!del.offsetParent : false,
    tagIsButton: tag ? tag.tagName : '?',
    actCount: document.querySelectorAll('.rel-act').length,
  };
})()`);
console.log('  · 检视面板关系行:', JSON.stringify(relInfo));
check('关系行渲染出来了', relInfo.rows > 0, `${relInfo.rows} 行`);
check('删除按钮**看得见**（以前 opacity:0 = 找不到）', relInfo.delVisible && relInfo.delOpacity > 0.2, `opacity=${relInfo.delOpacity}`);
check('有编辑按钮（改类型 / 改备注）', relInfo.actCount > 0, `${relInfo.actCount} 个`);
check('类型徽标可点（是 button）', relInfo.tagIsButton === 'BUTTON', relInfo.tagIsButton);
await shot('01-inspector-relations');

// ── 2. 删除：走确认框 → 真删掉 ───────────────────────────────
const before = (await evalJs(`window.__lcEdges().length`));
await evalJs(`(function(){var b=document.querySelector('.rel-del'); if(b)b.click(); return 1;})()`);
await sleep(400);
const modalTitle = await evalJs(`(function(){
  var m=document.getElementById('modal');
  if(!m||m.hidden) return null;
  var h=m.querySelector('h3'); return h?h.textContent:null;})()`);
check('删除前弹了确认框', modalTitle === '删除关系', String(modalTitle));
await shot('02-delete-confirm');
await evalJs(`(function(){var b=document.querySelector('#modal .btn.acc'); if(b)b.click(); return 1;})()`);
await sleep(800);
const after = (await evalJs(`window.__lcEdges().length`));
check('关系真的删掉了', after === before - 1, `${before} → ${after}`);

// ── 3. 改类型：编辑面板 → 换类型 → 保存 ──────────────────────
const target = await evalJs(`(function(){
  var es = window.__lcEdges();
  return es.length ? es[0] : null;})()`);
if (target) {
  await evalJs(`(function(){var b=document.querySelector('.rel-tag'); if(b)b.click(); return 1;})()`);
  await sleep(500);
  const edTitle = await evalJs(`(function(){
    var m=document.getElementById('modal');
    if(!m||m.hidden) return null;
    var h=m.querySelector('h3'); return h?h.textContent:null;})()`);
  check('打开了「编辑关系」面板', edTitle === '编辑关系', String(edTitle));
  const chips = await evalJs(`(function(){
    var all=[].slice.call(document.querySelectorAll('.edge-ed-type'));
    return { total: all.length, off: all.filter(function(b){return b.disabled;}).length,
             on: (document.querySelector('.edge-ed-type.on')||{}).textContent || null };})()`);
  console.log('  · 类型筹码:', JSON.stringify(chips));
  check('类型可选（且标出了不可用的）', chips.total > 0 && chips.off >= 0, `${chips.total} 个，${chips.off} 个不可用`);
  await shot('03-edge-editor');
  const newType = await evalJs(`(function(){
    var all=[].slice.call(document.querySelectorAll('.edge-ed-type'));
    var cur=document.querySelector('.edge-ed-type.on');
    var pick=all.filter(function(b){return !b.disabled && b!==cur;})[0];
    if(!pick) return null;
    var t=pick.textContent; pick.click(); return t;})()`);
  await evalJs(`(function(){var b=document.querySelector('#modal .btn.acc'); if(b)b.click(); return 1;})()`);
  await sleep(800);
  const nowType = await evalJs(`(function(){
    var es=window.__lcEdges();
    var id=${JSON.stringify(target.id)};
    var e=es.filter(function(x){return x.id===id;})[0];
    return e?e.type:null;})()`);
  check('关系类型改掉了', !!nowType && nowType !== target.type, `${target.type} → ${nowType}（选了「${newType}」）`);
}

// ── 4. 画布上：点一条线 = 选中（不是删），边上浮出操作条 ────────
await evalJs(`(function(){var b=document.querySelector('#seg button[data-v="canvas"]'); if(b)b.click(); return 1;})()`);
await sleep(900);
const eid = await evalJs(`(function(){var es=window.__lcEdges(); return es.length?es[0].id:null;})()`);
const pt = await evalJs(`window.__lcEdgePoint(${JSON.stringify(eid)})`);
if (pt && pt.x > 0 && pt.y > 0) {
  await clickAt(pt.x, pt.y);
  const bar = await evalJs(`(function(){
    var b=document.querySelector('.edge-bar');
    if(!b) return null;
    var cs=getComputedStyle(b);
    return { hidden: b.hidden, display: cs.display,
             type: (b.querySelector('.edge-bar-type')||{}).textContent || null,
             del: !!b.querySelector('.edge-bar-del') };})()`);
  console.log('  · 边上操作条:', JSON.stringify(bar));
  check('点线 → 浮出操作条（不是直接删）', bar && !bar.hidden && bar.display !== 'none', JSON.stringify(bar));
  check('操作条上有类型和删除', !!bar && !!bar.type && bar.del);
  await shot('04-canvas-edge-selected');
} else {
  check('拿到边的屏幕坐标', false, JSON.stringify(pt));
}

// ── 5. 平行边分道：同一对端点的两条线，画出来不重合 ────────────
const lanes = await evalJs(`(function(){
  var es=window.__lcEdges();
  var groups={};
  es.forEach(function(e){
    var k=[e.fromId,e.toId].sort().join('|');
    (groups[k]=groups[k]||[]).push(e);
  });
  var pair=null;
  for(var k in groups){ if(groups[k].length>1){ pair=groups[k]; break; } }
  if(!pair) return { hasPair:false };
  var pts=pair.map(function(e){ return window.__lcEdgePoint(e.id); });
  return { hasPair:true, n:pair.length, pts:pts };})()`);
if (lanes.hasPair) {
  const p0 = lanes.pts[0], p1 = lanes.pts[1];
  const d = Math.abs(p0.y - p1.y);
  check('同一对端点的多条线**分道**（不叠在一起）', d > 4, `纵向间距 ${d.toFixed(1)}px`);
} else {
  console.log('  · 示例空间里没有平行边，跳过分道检查');
}

// ── 6. 增：从手柄拖一条线出来；重复的线要被拦住 ────────────────
// 找一对**屏幕上挨得近**、且还没连过的点
// （太远的话缩放到 100% 后另一个点就跑出画布了，拖不到）
const pair = await evalJs(`(function(){
  var es = window.__lcEdges();
  var ids = window.__lcNodeIds();
  function has(a,b){ return es.some(function(e){ return (e.fromId===a&&e.toId===b)||(e.fromId===b&&e.toId===a); }); }
  var best=null, bestD=1e9;
  for (var i=0;i<ids.length;i++){
    var p1=window.__lcNodePoint(ids[i],'center'); if(!p1) continue;
    for (var j=0;j<ids.length;j++){
      if(i===j) continue;
      if(has(ids[i],ids[j])) continue;
      var p2=window.__lcNodePoint(ids[j],'center'); if(!p2) continue;
      var d=Math.hypot(p1.x-p2.x,p1.y-p2.y);
      if(d<bestD){ bestD=d; best={a:ids[i],b:ids[j]}; }
    }
  }
  return best;})()`);

if (!pair) {
  console.log('  · 找不到可以连的点对，跳过');
} else {
  let hp = await evalJs(`window.__lcNodePoint(${JSON.stringify(pair.a)}, 'handle')`);
  let tp = await evalJs(`window.__lcNodePoint(${JSON.stringify(pair.b)}, 'center')`);
  const rect = await evalJs(`(function(){var r=document.getElementById('cv').getBoundingClientRect();
    return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  console.log('  · 手柄:', JSON.stringify(hp), '目标:', JSON.stringify(tp), '画布:', JSON.stringify(rect));
  // 手柄只在放大（scale > 0.4）时才画、才能拖 —— 先把源点摆到画面中间并放大
  await evalJs(`(function(){window.__lcCenterOn(${JSON.stringify(pair.a)}, 1); return 1;})()`);
  await sleep(800);
  const hp2 = await evalJs(`window.__lcNodePoint(${JSON.stringify(pair.a)}, 'handle')`);
  const tp2 = await evalJs(`window.__lcNodePoint(${JSON.stringify(pair.b)}, 'center')`);
  console.log('  · 放大后 手柄:', JSON.stringify(hp2), '目标:', JSON.stringify(tp2));
  if (!hp2 || !tp2) { console.log('  · 坐标拿不到，跳过'); }
  const n0 = await evalJs(`window.__lcEdges().length`);
  hp = hp2; tp = tp2;

  // 按下手柄
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  // 拖到目标
  for (let i = 1; i <= 6; i++) {
    await S('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: hp.x + (tp.x - hp.x) * i / 6, y: hp.y + (tp.y - hp.y) * i / 6,
    });
    await sleep(60);
  }
  const badge = await evalJs(`(function(){
    var b=document.querySelector('.link-badge');
    if(!b) return null;
    var cs=getComputedStyle(b);
    return { hidden:b.hidden, display:cs.display, text:b.textContent };})()`);
  check('拖线时跟着光标的类型徽标', !!badge && !badge.hidden && badge.display !== 'none', JSON.stringify(badge));
  await shot('05-link-badge');
  // 松手
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  const n1 = await evalJs(`window.__lcEdges().length`);
  check('拖出一条新关系', n1 === n0 + 1, `${n0} → ${n1}`);

  // 再拖一次同样的 → 应该被拦住
  await evalJs(`(function(){var t=document.getElementById('toast'); if(t){t.textContent='';t.classList.remove('on');} return 1;})()`);
  const hp3 = await evalJs(`window.__lcNodePoint(${JSON.stringify(pair.a)}, 'handle')`);
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: hp3.x, y: hp3.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= 6; i++) {
    await S('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: hp3.x + (tp.x - hp3.x) * i / 6, y: hp3.y + (tp.y - hp3.y) * i / 6,
    });
    await sleep(60);
  }
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  const n2 = await evalJs(`window.__lcEdges().length`);
  const toastTxt = await evalJs(`(function(){var t=document.getElementById('toast');return t?t.textContent:'';})()`);
  check('重复的关系被拦住了（不会连出第二条一模一样的）', n2 === n1, `${n1} → ${n2}`);
  check('并给出了提示', /已经有了/.test(toastTxt), toastTxt);
}

// ── 7. 详情页的「关联节点」也要能改 / 删 ──────────────────────
const goalId = await evalJs(`(function(){
  var ids = window.__lcNodeIds();
  var es = window.__lcEdges();
  var withEdge = {};
  es.forEach(function(e){ withEdge[e.fromId]=1; withEdge[e.toId]=1; });
  for (var i=0;i<ids.length;i++) if (withEdge[ids[i]]) return ids[i];
  return null;})()`);
if (goalId) {
  const opened = await evalJs(`(function(){ try { return window.__lcOpenDetail(${JSON.stringify(goalId)}); } catch(e){ return 'err:'+e.message; } })()`);
  await sleep(1200);
  const detail = await evalJs(`(function(){
    var cards = document.querySelectorAll('.detail-rel-i');
    var tag = document.querySelector('.detail-rel-tag');
    return {
      cards: cards.length,
      tagIsButton: tag ? tag.tagName : '?',
      act: document.querySelectorAll('.detail-rel-i .rel-act').length,
      del: document.querySelectorAll('.detail-rel-i .rel-del').length,
      delOpacity: (function(){var d=document.querySelector('.detail-rel-i .rel-del');
        return d?parseFloat(getComputedStyle(d).opacity):-1;})(),
    };})()`);
  console.log('  · 详情页关联节点:', JSON.stringify(detail), 'opened=', opened);
  check('详情页关联节点有编辑入口', detail.act > 0, `${detail.act} 个`);
  check('详情页关联节点有删除入口（看得见）', detail.del > 0 && detail.delOpacity > 0.2, `opacity=${detail.delOpacity}`);
  await shot('06-detail-relations');
  await evalJs(`(function(){var b=document.querySelector('#seg button[data-v="canvas"]'); if(b)b.click(); return 1;})()`);
  await sleep(600);
}

console.log(failed ? `\n✗ ${failed} 项没通过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
