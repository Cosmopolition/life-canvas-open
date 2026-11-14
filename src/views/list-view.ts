/** 列表视图（视图三）+ 检视面板 */
import {
  EDGE_TYPE_COLOR, edgeTypeLabel, GOAL_STATUS, NODE_TYPE_COLOR,
  nodeTypeLabel, STATUS_COLOR, statusLabel, tagLabel,
  type Library, type LifeNode, type NodeType,
} from '../model/types';
import {
  adjacencyOf, focusPath, inStage, inTheme, milestoneDisplay, milestonesOf,
  MILESTONE_COLOR, milestoneLabel, todayKey,
  themePath,
} from '../model/selectors';
import { describe as describeFilter, emptyFilter, isFilterActive, passes, type FilterState } from '../model/filters';
import { el, modal, toast } from '../ui/dom';
import { t } from '../i18n';

/* ---------------- 列表 ---------------- */

export interface ListHost {
  lib: Library;
  /** @deprecated 旧单焦点；过渡期由 app 层用 focusThemeId 兜底 */
  areaId: string | null;
  /** 主题焦点：与 focusStageId 一起构成多维过滤（可都空/单设/都设=交集） */
  focusThemeId: string | null;
  /** 阶段焦点：显式 stageIds ∪ 时基命中 */
  focusStageId: string | null;
  nodeTypes: ReadonlySet<NodeTypeLike> | null;
  filter?: FilterState;
  theme: 'dark' | 'light';
  onPick(id: string): void;
  onDelete(id: string): void;
  /** 列表行内 action 的 done 一键勾选（走 store.done，不入版本历史） */
  onToggleDone(id: string, done: boolean): void;
}
type NodeTypeLike = keyof typeof NODE_TYPE_COLOR;

export function renderList(root: HTMLElement, host: ListHost): void {
  const lib = host.lib;
  const lv = host.theme === 'light'
    ? { statusFallback: '#8c8576', statusEmpty: '#a8967d' }
    : { statusFallback: '#626a79', statusEmpty: '#3a4250' };
  const f = host.filter ?? emptyFilter();
  // 兼容：旧 areaId 当作 focusThemeId 使用
  const themeId = host.focusThemeId ?? host.areaId;
  const stageId = host.focusStageId;
  const ns = lib.nodes.filter((n) => {
    if (host.nodeTypes && host.nodeTypes.size && !host.nodeTypes.has(n.type)) return false;
    if (themeId && !inTheme(lib, n, themeId)) return false;
    if (stageId && !inStage(lib, n, stageId)) return false;
    return passes(n, f);
  }).sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));

  root.innerHTML = '';
  const sub = el('div', { class: 'sub' }, t('onboard.hintThirdView'));
  if (isFilterActive(f)) {
    sub.append(el('br'), el('b', {}, t('filter.active', { list: describeFilter(f).join(' · ') })));
    sub.append(t('list.listingCount', { n: ns.length, total: lib.nodes.length }));
  } else if (ns.length !== lib.nodes.length) {
    sub.append(el('b', {}, t('list.rangeCount', { n: ns.length })));
  }
  root.append(el('div', { class: 'h1' }, t('list.titleWithPath', { path: focusPath(lib, themeId, stageId) })), sub);

  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [col, w] of [[t('field.type'), 88], [t('field.title'), ''], [t('field.status'), 92], [t('field.time'), 88], [t('field.tags'), 110], [t('detail.relations'), 64]] as [string, string][]) {
    const th = el('th', {}, col);
    if (w) th.style.width = `${w}px`;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');

  for (const n of ns) {
    const tr = el('tr');
    const chip = el('span', { class: 'chip' });
    const sw = el('span', { class: 'sw' });
    sw.style.background = NODE_TYPE_COLOR[n.type];
    chip.append(sw, document.createTextNode(nodeTypeLabel(n.type)));

    const rel = adjacencyOf(lib, n.id).all.length;
    // 状态列：goal 走 status；action 走 done（带 checkbox 一键勾选）；其他类型留 "—"
    let statusCell: HTMLElement;
    if (n.type === 'goal') {
      statusCell = el('td', { style: `color:${n.status ? STATUS_COLOR[n.status] ?? lv.statusFallback : lv.statusEmpty}` }, n.status ? statusLabel(n.status) : '—');
    } else if (n.type === 'action') {
      const wrap = el('label', { class: 'list-done', style: 'display:inline-flex;align-items:center;gap:6px;cursor:pointer' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = !!n.done;
      cb.onclick = (ev) => ev.stopPropagation();
      cb.onchange = () => host.onToggleDone(n.id, cb.checked);
      wrap.append(cb, document.createTextNode(n.done ? t('status.completed') : t('milestone.pending')));
      if (n.done) wrap.style.color = 'var(--ok)';
      statusCell = el('td', {}, wrap);
    } else {
      statusCell = el('td', { style: `color:${lv.statusEmpty}` }, '—');
    }
    tr.append(
      el('td', {}, chip),
      el('td', {}, n.title),
      statusCell,
      el('td', { class: 'mono muted' }, n.time || '—'),
      el('td', { class: 'muted' }, n.tags.map((x) => '#' + tagLabel(x)).join(' ') || '—'),
      el('td', { class: 'mono muted' }, String(rel)),
    );
    tr.onclick = () => host.onPick(n.id);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  root.append(table);
  root.append(el('div', { class: 'hint', style: 'margin-top:12px;color:var(--faint);font-size:12px' },
    t('list.totalHint', { n: ns.length })));
}

/* ---------------- 检视面板 ---------------- */

export interface InspectorHost {
  lib: Library;
  selectedId: string | null;
  onStatus(id: string, status: string, reason: string): void;
  onEditTitle(id: string, title: string, reason: string): void;
  onMarkMilestone(id: string, title: string, reason: string): void;
  onRestore(nodeId: string, versionId: string, reason: string): void;
  /** 切换 action 节点的 done 状态（持久化） */
  onToggleDone(id: string, done: boolean): void;
  /** 贴图 / 换图。imageData/width/height 都传，app 走 updateNode */
  onSetImage(id: string, data: string, w: number, h: number): void;
  /**
   * 选一张图（原生模式由原生弹面板并缩放；浏览器模式走 <input type=file>）。
   * 拿到的是 dataURL + 缩放后的尺寸。
   */
  onPickImage(cb: (data: string, w: number, h: number) => void): void;
  /** 贴 URL（不下载、零体积、换设备即丢） */
  onSetImageUrl(id: string, url: string): void;
  onRemoveImage(id: string): void;
  /** 贴 / 改 任意链接（label 可空） */
  onSetLink(id: string, url: string, label: string): void;
  onRemoveLink(id: string): void;
  onPick(id: string): void;
  onDelete(id: string): void;
  /** 删除一条边（节点检视面板的关系行 × 按钮）。确认由 app 层负责 */
  onRemoveEdge(edgeId: string): void;
  /** 打开「编辑关系」面板（改类型 / 改备注 / 删） */
  onEditEdge(edgeId: string): void;
  /** 内容编辑（content 走版本历史，需要 reason） */
  onEditContent(id: string, content: string, reason: string): void;
  /** 主题归属切换（轻量，不入版本历史） */
  onToggleTheme(id: string, themeId: string): void;
  /** 阶段归属切换（轻量，不入版本历史） */
  onToggleStage(id: string, stageId: string): void;
  /** 标签切换（轻量，不入版本历史） */
  onToggleTag(id: string, tag: string): void;
  /** 新增一个标签 */
  onAddTag(id: string, tag: string): void;
  /* 里程碑（仅 type === 'goal' 时用到）—— 不要求 reason（与 action.done 同档） */
  onCreateMilestone(goalId: string, title: string, targetDate: string): void;
  onUpdateMilestone(milestoneId: string, patch: { title?: string; targetDate?: string }): void;
  onDeleteMilestone(milestoneId: string): void;
  onToggleMilestoneDone(milestoneId: string, done: boolean, today: string): void;
  /**
   * 「回原文」—— 这个点是从别的点复制来的（周画布里引入的原数据副本），
   * 跳回源头。app 层负责切空间 + 聚焦。
   */
  onGoToSource(sourceId: string): void;
  /**
   * 查源节点。
   *
   * ⚠️ 必须由 app 层给：host.lib 是**当前空间**的视图（周画布里只有周空间的东西），
   *   而原件在主空间 —— 拿 host.lib 查会永远查不到，"回原文"就成了死按钮。
   */
  resolveSource(id: string): LifeNode | undefined;
}

export function renderInspector(root: HTMLElement, host: InspectorHost): void {
  root.innerHTML = '';
  if (!host.selectedId) {
    // 没选中时右侧就是一整列空面板。空状态要像"故意留的"，
    // 不像"还没加载出来" —— 所以给个图标，并且垂直居中，
    // 而不是把两行灰字贴在顶上。
    const wrap = el('div', { class: 'empty empty-fill' });
    wrap.append(
      el('div', {
        class: 'empty-ic',
        html: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">'
          + '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
      }),
      el('div', { class: 'empty-t' }, t('empty.selectNode')),
      // 句子刻意写短：中文没有空格，浏览器会在任意两字之间断行，
      // 句子一长就会断出"版本历 / 史"这种半个词。短句 + 关键术语不换行更稳。
      el('p', { html: t('onboard.hintDetail') }),
    );
    root.append(wrap);
    return;
  }
  const lib = host.lib;
  const n = lib.nodes.find((x) => x.id === host.selectedId);
  if (!n) { root.append(el('div', { class: 'empty' }, el('p', {}, t('error.nodeDeleted')))); return; }

  const chip = el('span', { class: 'chip' });
  const sw = el('span', { class: 'sw' });
  sw.style.background = NODE_TYPE_COLOR[n.type];
  chip.append(sw, document.createTextNode(nodeTypeLabel(n.type)));

  const hd = el('div', { class: 'insp-hd' });
  const topRow = el('div', { style: 'display:flex;align-items:center;gap:8px' });
  topRow.append(chip, el('span', { class: 'mono', style: 'font-size:10.5px;color:var(--faint);margin-left:auto' }, n.id));
  const tt = el('div', { class: 'tt', contenteditable: 'true' }, n.title);
  tt.onblur = async () => {
    const v = (tt.textContent ?? '').trim();
    if (!v || v === n.title) { tt.textContent = n.title; return; }
    const reason = await askReason(t('field.editTitle'), t('toast.titleChangedTo', { title: v.slice(0, 20) }));
    if (reason) host.onEditTitle(n.id, v, reason);
    else tt.textContent = n.title;
  };
  tt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); tt.blur(); } };
  hd.append(topRow, tt);

  if (n.type === 'goal') {
    const row = el('div', { class: 'st-row' });
    const customs = lib.customStatuses.map((c) => c.name);
    for (const s of [...GOAL_STATUS, ...customs.filter((c) => !(GOAL_STATUS as readonly string[]).includes(c))]) {
      const b = el('span', { class: 'st' + (n.status === s ? ' on' : '') }, statusLabel(s));
      b.onclick = async () => {
        const reason = await askReason(t('toast.statusChangedTo', { s: statusLabel(s) }), t('version.fromTo', { from: n.status ? statusLabel(n.status) : t('common.none'), to: statusLabel(s) }));
        if (reason) host.onStatus(n.id, s, reason);
      };
      row.append(b);
    }
    hd.append(row);
  } else if (n.type === 'action') {
    // 软安排 / 行动：单 checkbox（已完成）。不要求填原因 —— 这是状态不是修改。
    const row = el('label', { class: 'done-row' });
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = !!n.done;
    cb.onchange = () => host.onToggleDone(n.id, cb.checked);
    row.append(cb, document.createTextNode(n.done ? t('status.completed') : t('action.markAsCompleted')));
    hd.append(row);
  } else {
    hd.append(el('div', { style: 'margin-top:8px;font-size:11.5px;color:var(--faint)' },
      t('help.nonGoalRecord')));
  }
  root.append(hd);

  /* 「回原文」：这个副本是从哪儿复制来的 —— 副本改坏了还能回去看原件 */
  const srcRow = buildSourceRow(n, host);
  if (srcRow) root.append(srcRow);

  /* 里程碑（仅 goal —— 拆成时间点的检查单） */
  if (n.type === 'goal') {
    root.append(buildMilestoneSection(lib, n.id, host));
  }

  /* 封面图：贴图（持久化） / 贴 URL（不持久） / 换 / 移除 */
  const imgBox = el('div', { class: 'img-box' });
  if (n.imageData || n.imageUrl) {
    const previewSrc = n.imageData ?? n.imageUrl!;
    const preview = el('img', { class: 'img-prev', src: previewSrc, alt: n.title });
    imgBox.append(preview);
    const meta2 = el('div', { class: 'img-meta' },
      n.imageData
        ? t('image.sizeEncrypted', { w: n.imageW ?? '?', h: n.imageH ?? '?' })
        : t('image.externalUrlHint'));
    imgBox.append(meta2);
    const btnRow = el('div', { class: 'img-btns' });
    const rep = el('button', { class: 'mini' }, t('image.changeUpload'));
    rep.onclick = () => host.onPickImage((data, w, h) => host.onSetImage(n.id, data, w, h));
    const repUrl = el('button', { class: 'mini' }, t('image.changeUrlShort'));
    repUrl.onclick = () => askUrl(t('image.changeUrl'), n.imageUrl ?? '', (url) => host.onSetImageUrl(n.id, url));
    const rm = el('button', { class: 'mini danger' }, t('action.remove'));
    rm.onclick = () => host.onRemoveImage(n.id);
    btnRow.append(rep, repUrl, rm);
    imgBox.append(btnRow);
  } else {
    const btnRow = el('div', { class: 'img-btns' });
    const add = el('button', { class: 'mini' }, t('image.attachHint'));
    add.onclick = () => host.onPickImage((data, w, h) => host.onSetImage(n.id, data, w, h));
    const addUrl = el('button', { class: 'mini' }, t('image.attachUrlNoDownload'));
    addUrl.onclick = () => askUrl(t('image.urlTitle'), '', (url) => host.onSetImageUrl(n.id, url));
    btnRow.append(add, addUrl);
    imgBox.append(btnRow);
  }
  root.append(imgBox);

  /* 链接：任意 URL（网页/文档/PDF/Notion）。⌘+点击节点打开 */
  const linkBox = el('div', { class: 'link-box' });
  if (n.linkUrl) {
    const row = el('div', { class: 'link-row' });
    const ic = el('span', { class: 'link-ic', title: t('link.title') }, '🔗');
    const lab = el('span', { class: 'link-lab' }, n.linkLabel || n.linkUrl);
    lab.title = n.linkUrl;
    row.append(ic, lab);
    row.onclick = () => window.open(n.linkUrl!, '_blank', 'noopener');
    linkBox.append(row);
    const btnRow2 = el('div', { class: 'img-btns' });
    const ch = el('button', { class: 'mini' }, t('link.edit'));
    ch.onclick = () => askLink(t('link.edit'), n.linkUrl ?? '', n.linkLabel ?? '', (u, l) => host.onSetLink(n.id, u, l));
    const rm2 = el('button', { class: 'mini danger' }, t('action.remove'));
    rm2.onclick = () => host.onRemoveLink(n.id);
    btnRow2.append(ch, rm2);
    linkBox.append(btnRow2);
  } else {
    const add = el('button', { class: 'mini' }, t('link.attachHint'));
    add.onclick = () => askLink(t('link.attach'), '', '', (u, l) => host.onSetLink(n.id, u, l));
    linkBox.append(add);
  }
  root.append(linkBox);

  /* ---------- 内容（contenteditable：点开就能改） ---------- */
  const body = el('div', { class: 'body-txt' });
  body.contentEditable = 'true';
  body.spellcheck = false;
  body.textContent = n.content;
  if (!n.content) {
    body.classList.add('ph');
    body.setAttribute('data-ph', t('detail.noContentYet'));
  }
  // 编辑前把"未挂主题"等的提示灰字去掉，进入编辑态
  body.onfocus = () => { body.classList.remove('ph'); };
  body.onblur = async () => {
    const v = body.textContent ?? '';
    body.classList.toggle('ph', !v);
    if (v === n.content) return;
    const reason = await askReason(t('field.editContent'), t('version.contentChanged'));
    if (reason) host.onEditContent(n.id, v, reason);
    else body.textContent = n.content;
  };
  body.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); body.blur(); }
  };
  root.append(body);

  /* ---------- 主题 / 阶段 / 标签：chips 可点切换 ---------- */
  root.append(buildChipsBlock(lib, n, host));


  /* 关系 */
  const adj = adjacencyOf(lib, n.id);
  const rel = el('div', { class: 'rel' });
  const rt = el('div', { class: 'sec-t', style: 'margin-bottom:4px' }, t('detail.relations'))
  rt.append(el('span', { class: 'n' }, t('common.entryCount', { n: adj.all.length })));
  rel.append(rt);
  if (!adj.all.length) {
    rel.append(el('div', { class: 'hint', style: 'color:var(--faint);font-size:11.5px' }, t('empty.noRelations')));
  }
  // 同一个方向 + 同一个类型的重复关系：标出来，不然两行长得一模一样，分不清哪条是哪条
  const seen = new Map<string, number>();
  for (const e of adj.all) {
    const otherId = e.fromId === n.id ? e.toId : e.fromId;
    const other =
      lib.nodes.find((v) => v.id === otherId) ??
      lib.themes.find((v) => v.id === otherId) ??
      lib.stages.find((v) => v.id === otherId);
    const row = el('div', { class: 'rel-i' });
    const dir = e.fromId === n.id ? '→' : '←';
    // 类型徽标：**可以点**（点了就能改这条线的类型）
    const tag = el('button', {
      class: 'rel-tag',
      style: `color:${EDGE_TYPE_COLOR[e.type]};border-color:${EDGE_TYPE_COLOR[e.type]}44`,
      title: t('detail.changeRelationType'),
    }, `${dir} ${edgeTypeLabel(e.type)}`);
    tag.onclick = (ev) => { ev.stopPropagation(); host.onEditEdge(e.id); };
    const titleBox = el('span', { class: 'rel-t' });
    const b = el('b', {}, other ? ('title' in other ? other.title : other.name) : t('common.deletedAlt'));
    titleBox.append(b);
    // 副行：对方是什么 / 这条线的备注 / 是不是重复
    const sub: string[] = [];
    if (other) {
      if ('type' in other) {
        const nt = (other as { type: string }).type as NodeType;
        sub.push(nodeTypeLabel(nt) ?? nt);
        const time = (other as { time?: string }).time;
        if (time) sub.push(time);
      } else if (lib.themes.some((v) => v.id === otherId)) {
        sub.push(t('field.theme'));
      } else {
        sub.push(t('field.stage'));
      }
    }
    const key = `${dir}|${e.type}|${otherId}`;
    const dupCount = seen.get(key) ?? 0;
    seen.set(key, dupCount + 1);
    if (dupCount > 0) sub.push(t('error.duplicateRelation'));
    if (e.note) sub.push(e.note);
    if (sub.length) titleBox.append(el('span', {}, sub.join(' · ')));

    // 两个按钮**常驻可见** —— 以前 opacity:0 只在 hover 时出现，
    // 于是"看着没法删"（按钮根本看不见）。
    const edit = el('button', { class: 'rel-act', title: t('action.editThisRelation') }, '✎');
    edit.onclick = (ev) => { ev.stopPropagation(); host.onEditEdge(e.id); };
    const del = el('button', { class: 'rel-del', title: t('action.deleteThisRelation') }, '×');
    del.onclick = (ev) => { ev.stopPropagation(); host.onRemoveEdge(e.id); };
    row.append(tag, titleBox, edit, del);
    row.onclick = () => other && host.onPick(other.id);
    rel.append(row);
  }
  root.append(rel);

  /* 版本历史 */
  const versions = lib.versions.filter((v) => v.nodeId === n.id).sort((a, b) => a.changedAt - b.changedAt);
  const vt = el('div', { class: 'sec-t', style: 'padding:13px 15px 6px;margin:0' }, t('version.history'));
  vt.append(el('span', { class: 'n' }, String(versions.length)));
  const mile = el('button', { class: 'mini', style: 'margin-left:10px;width:auto' }, t('action.markMilestone'));
  mile.onclick = async () => {
    const mt = await askText(t('action.markMilestone'), t('milestone.titleField'), t('field.exampleTitle2'));
    if (!mt) return;
    const r = await askReason(t('milestone.reason'));
    if (r) host.onMarkMilestone(n.id, mt, r);
  };
  vt.append(mile);
  root.append(vt);

  const ver = el('div', { class: 'ver' });
  if (!versions.length) {
    ver.append(el('div', { style: 'font-size:11.5px;color:var(--faint);line-height:1.7' },
      t('empty.noVersions')));
  }
  versions.forEach((v, i) => {
    const cur = i === versions.length - 1;
    const item = el('div', { class: 'ver-i' + (cur ? ' cur' : '') });
    const d = new Date(v.changedAt);
    item.append(el('div', { class: 'ver-d' },
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` +
      (v.title ? ` · ★ ${v.title}` : '') + (cur ? t('version.currentTag') : '')));
    try {
      const snap = JSON.parse(v.snapshot) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof snap.title === 'string') parts.push(snap.title);
      if (typeof snap.content === 'string' && snap.content) parts.push(snap.content);
      if (snap.status) parts.push(t('field.statusValue', { s: statusLabel(String(snap.status)) }));
      item.append(el('div', { class: 'ver-c' }, parts.join(' — ') || t('version.noContentChange')));
    } catch { /* 快照损坏，跳过 */ }
    item.append(el('div', { class: 'ver-r' }, v.reason));
    if (!cur) {
      const back = el('button', { class: 'mini', style: 'width:auto;margin-top:8px' }, t('version.restoreThis'));
      back.onclick = async () => {
        const r = await askReason(t('version.restore'), t('version.restoredTo', { v: v.title || v.reason.slice(0, 14) }));
        if (r) host.onRestore(n.id, v.id, r);
      };
      item.append(back);
    }
    ver.append(item);
  });
  root.append(ver);

  const del = el('button', { class: 'mini', style: 'margin:0 15px 16px' }, t('action.deleteThisNode'));
  del.onclick = () => host.onDelete(n.id);
  root.append(del);
}

/* ---------------- 交互辅助 ---------------- */

let lastReasonValue = '';

/** 检视面板内里程碑区是否展开 —— 按 goal id 记忆，跨重渲染保持 */
const milestonesExpanded = new Set<string>();

export async function askReason(title: string, prefill?: string): Promise<string | null> {
  let input!: HTMLTextAreaElement;
  const r = await modal({
    title, okText: t('action.save'),
    body: (card) => {
      card.append(el('label', {}, t('field.reasonRequired')));
      input = el('textarea', { placeholder: t('reason.whyRequired') }) as HTMLTextAreaElement;
      if (prefill) input.value = prefill + t('version.pleaseAddReason');
      card.append(input);
    },
    onOk: (card) => {
      const v = (card.querySelector('textarea') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (!v) { lastReasonValue = ''; return false; }
      lastReasonValue = v;
      return true;
    },
  });
  return r === null || r === undefined ? null : lastReasonValue;
}

export async function askText(title: string, label: string, placeholder: string): Promise<string | null> {
  let input!: HTMLInputElement;
  const r = await modal({
    title, okText: t('onboard.next'),
    body: (card) => {
      card.append(el('label', {}, label));
      input = el('input', { placeholder }) as HTMLInputElement;
      card.append(input);
    },
    onOk: (card) => {
      const v = (card.querySelector('input') as HTMLInputElement)?.value.trim();
      if (!v) return false;
      lastReasonValue = v;
      return true;
    },
  });
  return r === null || r === undefined ? null : lastReasonValue;
}

/** 弹输入框收集 URL —— 简单校验 http(s)/data:image */
async function askUrl(title: string, prefill: string, cb: (url: string) => void): Promise<void> {
  let url = prefill;
  const r = await modal({
    title, okText: t('image.attach'),
    body: (card) => {
      card.append(el('label', {}, t('image.urlPlaceholder')));
      const inp = el('input', { placeholder: t('link.urlExample'), value: prefill }) as HTMLInputElement;
      inp.oninput = () => { url = inp.value; };
      card.append(inp);
    },
    onOk: (card) => {
      const v = (card.querySelector('input') as HTMLInputElement)?.value.trim() ?? '';
      if (!v) { alert(t('error.urlRequired')); return false; }
      if (!/^(https?:|data:image\/)/i.test(v)) { alert(t('error.unsupportedImageScheme')); return false; }
      url = v;
      return true;
    },
  });
  if (r) cb(url);
}

/** 弹输入框收集链接（url + label）。url 必填，label 可空（空则用 url 显示） */
async function askLink(title: string, preUrl: string, preLabel: string, cb: (url: string, label: string) => void): Promise<void> {
  let url = preUrl, label = preLabel;
  const r = await modal({
    title, okText: t('image.attach'),
    body: (card) => {
      card.append(el('label', {}, t('link.urlPlaceholder')));
      const iu = el('input', { placeholder: 'https://…', value: preUrl }) as HTMLInputElement;
      iu.oninput = () => { url = iu.value; };
      card.append(iu);
      card.append(el('label', {}, t('field.tagsOptional')));
      const il = el('input', { placeholder: t('field.exampleTag'), value: preLabel }) as HTMLInputElement;
      il.oninput = () => { label = il.value; };
      card.append(il);
    },
    onOk: (card) => {
      const v = (card.querySelectorAll('input')[0] as HTMLInputElement)?.value.trim() ?? '';
      if (!v) { alert(t('error.urlRequired')); return false; }
      if (!/^(https?:|mailto:|file:|ftp:)/i.test(v)) { alert(t('error.unsupportedLinkScheme')); return false; }
      url = v;
      label = (card.querySelectorAll('input')[1] as HTMLInputElement)?.value.trim() ?? '';
      return true;
    },
  });
  if (r) cb(url, label);
}

/* ---------------- 来源行：「回原文」 ---------------- */

/**
 * 这个点是从别的点复制来的（周画布里引入的原数据副本）→ 给一条回原头的路。
 *
 * 源节点被删了就不显示这一行 —— 副本照常用，只是没有"原文"可回。
 */
function buildSourceRow(n: LifeNode, host: InspectorHost): HTMLElement | null {
  if (!n.sourceId) return null;
  const src = host.resolveSource(n.sourceId);
  if (!src) return null;
  const row = el('div', { class: 'src-row' });
  row.append(el('span', { class: 'lb' }, t('week.source')));
  const btn = el('button', { class: 'src-go' }, `${src.title} ↗`);
  btn.onclick = () => host.onGoToSource(src.id);
  row.append(btn);
  return row;
}

/* ---------------- 里程碑（goal 的时间点位检查单） ---------------- */

/**
 * 把里程碑按 overdue / 待办 / 完成 分组显示。
 * 阈值：>= 4 项默认折叠（用户点过 ▶ 展开后记住），<= 3 项永远展开。
 */
function buildMilestoneSection(
  lib: Library,
  goalId: string,
  host: InspectorHost,
): HTMLElement {
  const ms = milestonesOf(lib, goalId);
  const today = todayKey();

  const sec = el('div', { class: 'mile-sec', style: 'padding:11px 15px 8px' });
  const hd = el('div', { class: 'sec-t', style: 'margin-bottom:6px' }, t('milestone.title'));
  const done = ms.filter((m) => !!m.completedAt).length;
  hd.append(el('span', { class: 'n' }, `${done}/${ms.length}`));
  const addBtn = el('button', { class: 'mini', style: 'margin-left:auto;width:auto' }, t('action.addMore'));
  addBtn.onclick = () => void addMilestonePrompt(goalId, host, today);
  hd.append(addBtn);
  sec.append(hd);

  if (!ms.length) {
    sec.append(el('div', { style: 'font-size:11.5px;color:var(--faint);line-height:1.7' },
      t('onboard.hintSoftPlan')));
    return sec;
  }

  const overdue = ms.filter((m) => !m.completedAt && m.targetDate < today).length;
  if (overdue > 0) {
    sec.append(el('div', {
      style: 'font-size:11.5px;color:var(--danger);margin-bottom:6px;display:flex;align-items:center;gap:4px',
    }, t('milestone.overdueCount', { n: overdue })));
  }

  // 默认：< 4 项展开；>= 4 项折叠（用户点开后 id 进 Set 记忆）
  let expanded = milestonesExpanded.has(goalId) || ms.length < 4;
  const list = el('div', { class: 'mile-list' });
  list.style.display = expanded ? '' : 'none';
  for (const m of ms) list.append(buildMilestoneRow(m, today, host, goalId));
  sec.append(list);

  if (ms.length >= 4) {
    const toggleBtn = el('button', {
      class: 'mini', style: 'margin-top:6px;width:auto',
    }, expanded ? t('action.collapse') : t('action.expandAll', { n: ms.length }));
    toggleBtn.onclick = () => {
      expanded = !expanded;
      if (expanded) milestonesExpanded.add(goalId); else milestonesExpanded.delete(goalId);
      list.style.display = expanded ? '' : 'none';
      toggleBtn.textContent = expanded ? t('action.collapse') : t('action.expandAll', { n: ms.length });
    };
    sec.append(toggleBtn);
  }

  return sec;
}

function buildMilestoneRow(
  m: import('../model/types').Milestone,
  today: string,
  host: InspectorHost,
  goalId: string,
): HTMLElement {
  const disp = milestoneDisplay(m, today);
  const color = MILESTONE_COLOR[disp];
  const isOverdue = disp === 'overdue';
  const isCompleted = !!m.completedAt;

  const row = el('div', {
    class: 'mile-i',
    style: 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12.5px;line-height:1.4',
  });

  // 状态点（点击切换完成）
  const circle = el('span', {
    class: 'mile-c',
    style: `color:${color};cursor:pointer;font-size:13px;width:18px;text-align:center;flex-shrink:0`,
    title: t('milestone.stateWithRest', { state: milestoneLabel(disp), rest: m.completedAt ? t('milestone.doneOnDate', { d: m.completedAt }) : '' }),
  }, m.completedAt ? '✓' : isOverdue ? '⚠' : '·');
  circle.onclick = () => host.onToggleMilestoneDone(m.id, !isCompleted, today);

  // 标题（已完成划掉；逾期不变色以保持可达）
  const titleText = el('span', {
    class: 'mile-t',
    style: isCompleted
      ? 'flex:1;text-decoration:line-through;color:var(--faint)'
      : 'flex:1',
  }, m.title);

  // 目标日期
  const dateEl = el('span', {
    class: 'mile-d mono',
    style: isOverdue
      ? 'font-size:11px;color:var(--danger);flex-shrink:0'
      : 'font-size:11px;color:var(--faint);flex-shrink:0',
    title: isOverdue ? t('milestone.overdueTargetDate', { d: m.targetDate }) : t('milestone.goalDate', { d: m.targetDate }),
  }, m.completedAt && m.completedAt !== m.targetDate
      ? `${m.targetDate} ✓ ${m.completedAt}`
      : m.targetDate);

  // 编辑 / 删除
  const editBtn = el('button', {
    class: 'mile-edit', title: t('action.editMilestone'),
    style: 'background:transparent;border:none;color:var(--faint);cursor:pointer;padding:0 4px;font-size:12px',
  }, '✎');
  editBtn.onclick = (ev) => { ev.stopPropagation(); void editMilestone(m, host); };

  const delBtn = el('button', {
    class: 'mile-del', title: t('action.deleteThisMilestone'),
    style: 'background:transparent;border:none;color:var(--faint);cursor:pointer;padding:0 4px;font-size:13px',
  }, '×');
  delBtn.onclick = (ev) => {
    ev.stopPropagation();
    // 确认由 app 层做（window.confirm 在原生壳里永远返回"取消"）
    host.onDeleteMilestone(m.id);
  };

  row.append(circle, titleText, dateEl, editBtn, delBtn);
  void goalId; // 行里不需要，签名留给将来 hover/jump-to
  return row;
}

async function addMilestonePrompt(
  goalId: string,
  host: InspectorHost,
  today: string,
): Promise<void> {
  let title = '';
  let targetDate = today;
  const r = await modal({
    title: t('action.addMilestone'), okText: t('action.add'),
    body: (card) => {
      card.append(el('label', {}, t('field.title')));
      const ti = el('input', { placeholder: t('field.exampleTitle') }) as HTMLInputElement;
      ti.oninput = () => { title = ti.value; };
      card.append(ti);
      card.append(el('label', {}, t('field.targetDate')));
      const di = el('input', { type: 'date', value: targetDate }) as HTMLInputElement;
      di.oninput = () => { targetDate = di.value; };
      card.append(di);
      setTimeout(() => ti.focus(), 20);
    },
    onOk: () => {
      const tv = title.trim();
      if (!tv) { toast(t('error.titleRequired')); return false; }
      if (!targetDate) { toast(t('error.dateRequired')); return false; }
      title = tv;
      return true;
    },
  });
  if (r) host.onCreateMilestone(goalId, title, targetDate);
}

async function editMilestone(
  m: import('../model/types').Milestone,
  host: InspectorHost,
): Promise<void> {
  let title = m.title;
  let targetDate = m.targetDate;
  const r = await modal({
    title: t('action.editMilestone'), okText: '保存',
    body: (card) => {
      card.append(el('label', {}, t('field.title')));
      const ti = el('input', { value: title }) as HTMLInputElement;
      ti.oninput = () => { title = ti.value; };
      card.append(ti);
      card.append(el('label', {}, t('field.targetDate')));
      const di = el('input', { type: 'date', value: targetDate }) as HTMLInputElement;
      di.oninput = () => { targetDate = di.value; };
      card.append(di);
      setTimeout(() => ti.focus(), 20);
    },
    onOk: () => {
      const tv = title.trim();
      if (!tv) { toast(t('error.titleRequired')); return false; }
      if (!targetDate) { toast(t('error.dateRequired')); return false; }
      title = tv;
      return true;
    },
  });
  if (r) host.onUpdateMilestone(m.id, { title, targetDate });
}

/* ---------------- chips 块（主题/阶段/标签） ---------------- */

type ChipNode = { id: string; label: string; on: boolean; color?: string };

function renderChipsRow(
  nodes: ChipNode[],
  onClick: (id: string) => void,
  emptyHint: string,
): HTMLElement {
  const row = el('div', { class: 'chips-row' });
  if (!nodes.length) {
    row.append(el('div', { class: 'hint' }, emptyHint));
    return row;
  }
  for (const c of nodes) {
    const chip = el('span', {
      class: 'chip' + (c.on ? ' on' : ''),
      style: c.color && c.on ? `--c:${c.color}` : '',
      title: c.on ? t('filter.selectedClickToClear') : t('action.clickToAdd'),
    }, c.label);
    chip.onclick = () => onClick(c.id);
    row.append(chip);
  }
  return row;
}

function buildChipsBlock(lib: Library, n: LifeNode, host: InspectorHost): HTMLElement {
  const blk = el('div', { class: 'insp-chips' });

  /* 主题 */
  const themeNodes: ChipNode[] = lib.themes.map((t) => ({
    id: t.id,
    label: themePath(lib, t.id) || t.name,
    on: n.themeIds.includes(t.id),
    color: t.color,
  }));
  blk.append(el('div', { class: 'chips-lb' }, t('field.themeAssignment')));
  blk.append(renderChipsRow(
    themeNodes,
    (id) => host.onToggleTheme(n.id, id),
    t('empty.noThemesCreateInSidebar'),
  ));

  /* 阶段 */
  const stageNodes: ChipNode[] = lib.stages.map((s) => {
    const span = s.start || s.end ? `（${s.start ?? '…'} → ${s.end ?? '…'}）` : '';
    return {
      id: s.id,
      label: `${s.name}${span}`,
      on: n.stageIds.includes(s.id),
      color: s.color,
    };
  });
  blk.append(el('div', { class: 'chips-lb', style: 'margin-top:10px' }, t('field.stageAssignment')));
  blk.append(renderChipsRow(
    stageNodes,
    (id) => host.onToggleStage(n.id, id),
    t('empty.noStages'),
  ));

  /* 标签：现有 + 输入框新增 */
  blk.append(el('div', { class: 'chips-lb', style: 'margin-top:10px' }, t('field.tags')));
  const tagRow = el('div', { class: 'chips-row' });
  for (const tag of n.tags) {
    const chip = el('span', { class: 'chip on tag' }, '#' + tagLabel(tag));
    chip.onclick = () => host.onToggleTag(n.id, tag);
    chip.title = t('action.clickToRemove');
    tagRow.append(chip);
  }
  const inp = el('input', {
    class: 'tag-inp', placeholder: t('action.addTag'), maxlength: '24', spellcheck: 'false',
  }) as HTMLInputElement;
  const submit = () => {
    const v = inp.value.trim().replace(/^#/, '').toLowerCase();
    if (!v) return;
    if (n.tags.includes(v)) { inp.value = ''; return; }
    host.onAddTag(n.id, v);
    inp.value = '';
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  };
  tagRow.append(inp);
  blk.append(tagRow);
  if (!n.tags.length && !lib.themes.length && !lib.stages.length) {
    blk.append(el('div', { class: 'hint', style: 'margin-top:6px' }, t('empty.nothingYet')));
  }

  return blk;
}
