/** 端到端回归 —— 见 README 的「开发辅助」一节。 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./scripts/browser.cjs');

// 截图目录：默认落在仓库的 shots/（已在 .gitignore 里）。
const OUT = process.env.SHOTS_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL || 'http://127.0.0.1:5178/';

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // 界面语言锁成中文：这个脚本的断言全是中文文案（"探索中" / "已取代" / "解锁"…），
  // 而应用默认跟随浏览器语言 —— 无头 Chromium 的 navigator.language 是 en-US，
  // 不锁的话界面变英文，断言全部对不上。
  // initScript 在页面任何脚本之前跑，正好赶在应用 boot 定语言之前把偏好写好。
  await ctx.addInitScript(() => { try { localStorage.setItem('lc.locale', 'zh-CN'); } catch {} });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  const shot = async n => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log('  ✓', n); };
  const step = (s) => console.log('\n▸ ' + s);

  step('打开（首次：设置密码）');
  await page.goto(URL);
  await page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  await shot('01-gate');
  await page.fill('#gatePw', 'life-canvas-test');
  await page.fill('#gatePw2', 'life-canvas-test');
  await page.click('#gateOk');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(2200);

  // M7 首次引导
  const ob = await page.waitForSelector('#onboard:not([hidden])', { timeout: 6000 }).catch(() => null);
  if (ob) {
    console.log('  ✓ 首次引导出现');
    await shot('02-onboard-1');
    await page.click('#onboardNext'); await page.waitForTimeout(350);
    await shot('02-onboard-2');
    await page.click('#onboardNext'); await page.waitForTimeout(350);
    await shot('02-onboard-3');
    await page.click('#onboardNext'); await page.waitForTimeout(450);
    const gone = await page.evaluate(() => document.getElementById('onboard').hidden);
    console.log('  引导结束:', gone ? '✓' : '✗');
  } else console.log('  ⚠ 首次引导未出现');
  await shot('02-onboard-end');

  // 切到画布视图。
  //
  // ⚠️ 应用默认进的是「今日」视图，而空库那张「还是空的」卡片只画在**画布**上
  //    （#canvasEmpty 在 render() 里判 this.view === 'canvas'）——
  //    不切过去就找不到「载入示例空间」按钮。
  await page.click('[data-v="canvas"]');
  await page.waitForTimeout(700);
  await shot('02-canvas');

  // 空库时画布上有一张「还是空的」卡片，里面有个「载入示例空间看看」按钮。
  //
  // ⚠️ 后面几步要选中示例里的一个目标（"2026 完成一次真正的转型"）——
  //    没有数据就什么都验不了（而且搜索、列表、时间轴的断言也全是空的）。
  //    这个脚本每次都是**全新的浏览器上下文**，所以库一定是空的 ——
  //    必须自己把示例空间载进来。
  const loadBtn = await page.$('#esLoad');
  if (loadBtn) {
    await loadBtn.click();
    await page.waitForTimeout(1500);
    console.log('  ✓ 已载入示例空间');
  } else {
    console.log('  ⚠ 没找到「载入示例空间」按钮 —— 后面几步可能验不到东西');
  }

  const counts = await page.evaluate(() => {
    const t = document.getElementById('perf')?.textContent || '';
    return t;
  });
  console.log('  perf:', JSON.stringify(counts));

  step('搜索「换工作」+ 关系上下文');
  await page.fill('#q', '换工作');
  await page.waitForTimeout(900);
  const qcnt = await page.textContent('#qcnt');
  console.log('  搜索结果:', qcnt);
  await shot('03-search');
  await page.click('#btnFocus');
  await page.waitForTimeout(900);
  await shot('04-focus');

  step('时间轴');
  await page.fill('#q', '');
  await page.click('[data-v="tl"]');
  await page.waitForTimeout(800);
  await shot('05-timeline');

  step('列表');
  // ⚠️ 必须先回画布、再点「↺ 重置」把焦点清掉。
  //    载入示例空间后，应用会默认聚焦到某个主题/阶段（例：「2023-2025 星河」），
  //    列表就被这个焦点筛过了 —— 14 行里根本没有「2026 完成一次真正的转型」，
  //    后面「选中一个目标 → 版本历史」那步就会点空。
  //    resetCanvasView() 会清掉 themeId/stageId/搜索词/选中态，但**不动数据**。
  // ⚠️ 「↺ 重置」住在画布视图的工具条里（#zReset 在 #vCanvas 内），
  //    切到列表/时间轴后它被 hidden ⇒ 必须先 click('[data-v="canvas"]') 再点它。
  await page.click('[data-v="canvas"]');
  await page.waitForTimeout(400);
  await page.click('#zReset');
  await page.waitForTimeout(500);
  await page.click('[data-v="lv"]');
  await page.waitForTimeout(600);
  await shot('06-list');
  const rows = await page.locator('#vLv tbody tr').count();
  console.log('  列表行数:', rows);

  step('选中一个目标 → 版本历史 + 改状态（必须填原因）');
  await page.click('#vLv tbody tr:has-text("2026 完成一次真正的转型")');
  await page.waitForTimeout(900);
  await shot('07-inspector');
  const verCount = await page.locator('#right .ver-i').count();
  console.log('  版本条数:', verCount);

  await page.click('#right .st:has-text("探索中")');
  await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
  await page.fill('#modalCard textarea', '想清楚了：节奏比环境重要');
  await shot('08-reason-required');
  await page.click('#modalCard .btn.acc');
  await page.waitForTimeout(900);
  const verCount2 = await page.locator('#right .ver-i').count();
  console.log('  改状态后版本条数:', verCount2, verCount2 > verCount ? '✓ 版本已追加' : '✗ 版本没追加');
  await shot('09-after-status');

  step('新建一个点');
  await page.click('[data-v="canvas"]');
  await page.waitForTimeout(500);
  await page.click('#btnNew');
  await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
  await page.click('#modalCard .opt:has-text("情绪")');
  await page.fill('#modalCard input', '重新有了节奏感');
  await page.click('#modalCard .btn.acc');
  await page.waitForTimeout(900);
  await shot('10-new-node');

  step('刷新 → 持久化验证');
  await page.reload();
  await page.waitForSelector('#gate:not([hidden])', { timeout: 15000 });
  const gateTitle = await page.textContent('#gateTitle');
  console.log('  刷新后进入:', gateTitle, gateTitle.includes('解锁') ? '✓ 已锁定' : '✗ 没锁定');
  await page.fill('#gatePw', 'life-canvas-test');
  await page.click('#gateOk');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(2200);
  const nodeCount = await page.evaluate(() => document.getElementById('perf')?.textContent || '');
  console.log('  解锁后:', JSON.stringify(nodeCount));
  const persisted = await page.evaluate(async () => {
    const m = await new Promise(res => { const r = indexedDB.open('life-canvas'); r.onsuccess = () => res(r.result); });
    return new Promise(res => { const tx = m.transaction('nodes', 'readonly'); const q = tx.objectStore('nodes').count(); q.onsuccess = () => res(q.result); });
  });
  console.log('  IndexedDB 中节点数:', persisted);
  await shot('11-after-reload');

  step('搜索新点的内容（验证索引重建）');
  await page.fill('#q', '节奏');
  await page.waitForTimeout(900);
  console.log('  搜「节奏」:', await page.textContent('#qcnt'));
  await shot('12-search-after-reload');

  /* ---------- M7 专项 ---------- */
  step('M7 · 键盘导航');
  await page.click('[data-v="canvas"]');
  await page.waitForTimeout(400);
  await page.focus('#cv');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(280); }
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(280);
  const selTitle = await page.evaluate(() => document.querySelector('#right .tt')?.textContent || '(无)');
  console.log('  方向键三次右 + 一次下 → 选中:', selTitle);
  await shot('18-keyboard-select');
  await page.keyboard.press('?'); await page.waitForTimeout(400);
  const keysShown = await page.evaluate(() => !!document.querySelector('.keys-grid'));
  console.log('  ? 快捷键面板:', keysShown ? '✓' : '✗');
  await shot('19-shortcuts');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  step('M7 · 高对比度 + 字体缩放');
  await page.click('#btnSettings'); await page.waitForTimeout(400);
  await page.click('.switch'); await page.waitForTimeout(300);
  // ⚠️ 设置面板里一共有 **4 个** .scale-pick（语言 / 主题 / 字号 / 自动锁屏），
  //    早先写 .scale-pick button:nth-child(2) 命中的是**第一个**（语言），
  //    字号其实一直没被改到（断言里 data-scale 是 undefined）。
  //    按出现顺序数：0=语言 1=主题 2=字号 3=锁屏；字号组里第 2 个按钮 = 大（lg）。
  await page.locator('#modalCard .scale-pick').nth(2).locator('button').nth(1).click();
  await page.waitForTimeout(300);
  await shot('20-a11y-settings');
  await page.click('#modalCard .btn.acc'); await page.waitForTimeout(700);
  const a11y = await page.evaluate(() => ({
    contrast: document.documentElement.dataset.contrast,
    scale: document.documentElement.dataset.scale,
  }));
  console.log('  应用后:', JSON.stringify(a11y), a11y.contrast === 'high' && a11y.scale === 'lg' ? '✓' : '✗');
  await shot('21-high-contrast');

  step('M7 · 搜索无结果 → 直接记一条');
  await page.fill('#q', '量子力学'); await page.waitForTimeout(800);
  const noHitShown = await page.evaluate(() => !document.getElementById('noHit').hidden);
  console.log('  无结果提示:', noHitShown ? '✓' : '✗');
  await shot('22-no-result');
  await page.fill('#q', ''); await page.waitForTimeout(400);

  // 还原对比度，避免污染后面的截图
  await page.click('#btnSettings'); await page.waitForTimeout(400);
  await page.click('.switch'); await page.waitForTimeout(200);
  // 字号那一组的第 1 个按钮 = 标准（md）—— applyA11y 在 md 时会删掉 data-scale。
  await page.locator('#modalCard .scale-pick').nth(2).locator('button').nth(0).click();
  await page.waitForTimeout(200);
  await page.click('#modalCard .btn.acc'); await page.waitForTimeout(500);

  step('筛选：状态 / 标签 / 时间');
  await page.click('#btnFilter'); await page.waitForSelector('#modalCard .btn.acc');
  await page.click('.fchips .fchip:has-text("已取代")');
  await page.click('#modalCard .btn.acc'); await page.waitForTimeout(800);
  const lens1 = await page.evaluate(() => document.getElementById('filterSummary').textContent);
  console.log('  状态=已取代 →', lens1.replace(/\s+/g, ' ').trim());
  await shot('26-filter-status');
  // 搜索要落在筛选内
  await page.fill('#q', '换工作'); await page.waitForTimeout(800);
  console.log('  筛选内搜「换工作」:', await page.textContent('#qcnt'));
  await page.fill('#q', ''); await page.waitForTimeout(300);
  await page.click('#btnFilter'); await page.waitForSelector('#modalCard .btn.acc');
  await page.click('.fgroup .clear'); await page.waitForTimeout(200);
  await page.click('#modalCard .btn.acc'); await page.waitForTimeout(600);
  console.log('  清空后:', (await page.evaluate(() => document.getElementById('filterSummary').textContent)).replace(/\s+/g, ' ').trim());

  step('M7 · 空状态');
  await page.click('#btnSettings'); await page.waitForTimeout(400);
  // ⚠️ 「清空全部数据」在设置面板的**危险操作区**里，选择器是 .set-danger .opt。
  //    （早先写的是 .opt[style*="danger"] —— 那是旧 DOM 的内联样式写法，
  //     设置面板重构后危险区改成了 .set-danger 容器，选择器就失配了。）
  await page.click('#modalCard .set-danger .opt'); await page.waitForTimeout(500);
  // 点完会先关掉设置面板，再弹一个二次确认框 —— 得等它出来再点确定。
  await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
  await page.click('#modalCard .btn.acc'); await page.waitForTimeout(1200);
  const emptyShown = await page.evaluate(() => !document.getElementById('canvasEmpty').hidden);
  console.log('  空状态:', emptyShown ? '✓' : '✗');
  await shot('23-empty-state');
  // 从空状态载入示例
  await page.click('#esLoad'); await page.waitForTimeout(2000);
  const back = await page.evaluate(() => document.getElementById('perf')?.textContent || '');
  console.log('  一键载入示例:', back.replace('\n', ' '));

  await browser.close();
  console.log(errs.length ? '\n⚠ 报错:\n' + errs.slice(0, 12).join('\n') : '\n✓ 无 JS 报错');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
