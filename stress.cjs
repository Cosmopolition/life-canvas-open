/**
 * 等「解锁门出现」或「直接进主界面」二者之一，返回 true 表示现在停在门上。
 * 两个坑：
 *  1) waitForFunction 返回的是 JSHandle，不是谓词的返回值 —— 不能直接比字符串
 *  2) 不能用 waitForSelector 等一个可能永远不出现的元素，那会白等满超时
 *  3) 主线程被批量加密占满时 rAF 轮询会饿死，必须指定 interval 轮询
 */
const atGate = async (page) => {
  await page.waitForFunction(() => {
    const g = document.getElementById('gate');
    const a = document.getElementById('app');
    return !!((g && !g.hidden) || (a && !a.hidden));
  }, null, { timeout: 90000, polling: 300 });
  return page.evaluate(() => !document.getElementById('gate').hidden);
};

const enter = async (page) => {
  if (await atGate(page)) { await page.click('#gateNoCrypto'); await atGate(page); }
};

/** 性能压测 —— 见 README 的「开发辅助」一节。 */
const path = require('path');
const { launch } = require('./scripts/browser.cjs');

const URL = process.env.APP_URL || 'http://127.0.0.1:5178/?stress=10000';

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // 界面语言锁成中文：脚本里认的是中文文案（"10000 点" / "每帧 N ms"），
  // 而应用默认跟随浏览器语言 —— 无头 Chromium 是 en-US，不锁就对不上。
  await page.addInitScript(() => { try { localStorage.setItem('lc.locale', 'zh-CN'); } catch {} });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  console.log('灌入 1 万节点压测库（首次，含建库写盘，不计入冷启动）…');
  const t0 = Date.now();
  await page.goto(URL);
  await enter(page);
  await page.waitForFunction(() => {
    const t = document.getElementById('perf')?.textContent || '';
    return /10000 点|9999 点/.test(t);
  }, null, { timeout: 180000, polling: 400 });
  console.log('  灌库耗时:', Date.now() - t0, 'ms');

  // 平移压测：连续 60 次拖动，统计每帧耗时
  const res = await page.evaluate(async () => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const send = (type, x, y, btn) => cv.dispatchEvent(new MouseEvent(type, {
      bubbles: true, clientX: x, clientY: y, button: btn ?? 0,
    }));
    const sendW = (type, x, y) => window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));

    const costs = [];
    const collect = async (frames) => {
      for (let i = 0; i < frames; i++) {
        await new Promise((res2) => requestAnimationFrame(res2));
        const m = (document.getElementById('perf')?.textContent || '').match(/每帧 ([\d.]+) ms/);
        if (m) costs.push(Number(m[1]));
      }
    };

    // 拖动画布（平移）
    send('mousedown', r.width / 2, r.height / 2);
    const p = collect(30);
    for (let i = 0; i < 40; i++) {
      sendW('mousemove', r.width / 2 + i * 9, r.height / 2 + i * 5);
      await new Promise((res2) => requestAnimationFrame(res2));
    }
    sendW('mouseup', r.width / 2 + 360, r.height / 2 + 200);
    await p;

    // 滚轮缩放
    const p2 = collect(20);
    for (let i = 0; i < 12; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: i % 2 ? -120 : 120, clientX: 600, clientY: 400, cancelable: true }));
      await new Promise((res2) => requestAnimationFrame(res2));
    }
    await p2;

    // 丢掉预热帧：首批帧包含索引构建和首帧全量绘制，不代表稳态
    const warm = costs.slice(8);
    warm.sort((a, b) => a - b);
    const pct = (q) => warm[Math.min(warm.length - 1, Math.floor(warm.length * q))];
    return {
      samples: warm.length,
      median: pct(0.5), p90: pct(0.9), p95: pct(0.95), max: warm[warm.length - 1],
      zoom: document.getElementById('zv')?.textContent,
      perf: document.getElementById('perf')?.textContent,
    };
  });

  console.log('\n── 平移/缩放帧耗时 ──');
  console.log('  样本数:', res.samples);
  console.log('  中位数:', res.median?.toFixed(2), 'ms   ← 目标 < 8ms');
  console.log('  P90:', res.p90?.toFixed(2), 'ms');
  console.log('  P95:', res.p95?.toFixed(2), 'ms');
  console.log('  最大:', res.max?.toFixed(2), 'ms');
  console.log('  缩放:', res.zoom, '|', res.perf?.replace('\n', ' '));

  // 实际工作缩放：50% 时视口内约 1/20 的节点，这才是日常操作区间
  const real = await page.evaluate(async () => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const sendW = (t, x, y) => window.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }));
    const costs = [];
    // 先滚轮放大到 ~50%
    for (let i = 0; i < 14; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120, clientX: 400, clientY: 400, cancelable: true }));
      await new Promise((res) => requestAnimationFrame(res));
    }
    const zoom = document.getElementById('zv')?.textContent;
    cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.width / 2, clientY: r.height / 2 }));
    for (let i = 0; i < 40; i++) {
      sendW('mousemove', r.width / 2 + i * 11, r.height / 2 + i * 6);
      await new Promise((res) => requestAnimationFrame(res));
      const m = (document.getElementById('perf')?.textContent || '').match(/每帧 ([\d.]+) ms/);
      if (m) costs.push(Number(m[1]));
    }
    sendW('mouseup', r.width / 2, r.height / 2);
    const warm = costs.slice(8).sort((a, b) => a - b);
    const pct = (q) => warm[Math.min(warm.length - 1, Math.floor(warm.length * q))];
    return { zoom, n: warm.length, median: pct(0.5), p90: pct(0.9), max: warm[warm.length - 1] };
  });
  console.log('\n── 实际工作缩放 (' + real.zoom + ') 下的帧耗时 ──');
  console.log('  中位数:', real.median?.toFixed(2), 'ms  P90:', real.p90?.toFixed(2), 'ms  最大:', real.max?.toFixed(2), 'ms');

  // 等 Worker 把 1 万条索引吃完，再测稳态查询延迟
  await page.waitForTimeout(4000);

  // 搜索延迟
  const search = await page.evaluate(async () => {
    const inp = document.getElementById('q');
    const times = [];
    for (const q of ['阶段', '方向', '资源 12', '节奏']) {
      inp.value = q;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      times.push(q + ' → ' + (document.getElementById('qcnt')?.textContent || ''));
    }
    return times;
  });
  console.log('\n── 搜索延迟 ──');
  search.forEach((s) => console.log('  ', s));

  // 列表渲染
  const tl = Date.now();
  await page.click('[data-v="tl"]');
  await page.waitForTimeout(600);
  console.log('\n  时间轴切换:', Date.now() - tl, 'ms');
  await page.click('[data-v="lv"]');
  await page.waitForTimeout(600);
  const rows = await page.locator('#vLv tbody tr').count();
  console.log('  列表行数:', rows);
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR || path.join(__dirname, 'shots'), '13-stress-list.png') });

  // 真实冷启动：库里已有数据，只走读库路径（不要 sleep，把解锁等待算进去）
  await page.waitForTimeout(2500);
  const cold = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await page.reload();
    await enter(page);
    await page.waitForFunction(() => /10000 点/.test(document.getElementById('perf')?.textContent || ''), null, { timeout: 120000, polling: 500 });
    cold.push(Date.now() - t);
    await page.waitForTimeout(2200);
  }
  console.log('\n── 冷启动（纯读库，1 万节点）──');
  cold.forEach((v, i) => console.log('  第' + (i + 1) + '次:', v, 'ms'));
  console.log('  目标 < 1500ms');

  await browser.close();
  console.log(errs.length ? '\n⚠ ' + errs.join('\n') : '\n✓ 无 JS 报错');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
