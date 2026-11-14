/**
 * 复盘卡片的预览面板 —— 挑点、排序、下载。
 *
 * ★ 卡片上的每一个字都是用户自己写的。这里只做「挑 / 排 / 渲染」，
 *   没有"自动总结""挑重点"这类逻辑 —— 软件不生成总结文字。
 *
 * 三件事：
 *   1. 挑：勾选这一周里的哪些点进卡片（画布上选好的会先勾上）
 *   2. 排：拖动改顺序（顺序由用户定，不自动排）
 *   3. 导：下载 PNG（1080×1440）
 */
import { nodeTypeLabel } from '../model/types';
import type { LifeNode } from '../model/types';
import { el, modal, toast } from '../ui/dom';
import { renderReviewCard, type CardTheme } from '../export/review-card';
import { t } from '../i18n';

export interface ReviewCardHost {
  /** 这一周的全部点（候选） */
  candidates: LifeNode[];
  /** 画布上已经选中的点 id（先勾上） */
  presetIds: string[];
  /** '第 45 周' */
  weekLabel: string;
  /** '11/02–11/08' */
  rangeText: string;
  /** 卡片配色 */
  theme: CardTheme;
  /** 落款那一行 */
  showFooter: boolean;
  /** 下载（文件名由 app 层决定 —— 它知道这是第几周） */
  onDownload: (canvas: HTMLCanvasElement) => void;
}

export async function openReviewCard(host: ReviewCardHost): Promise<void> {
  // 画布上选中的先勾上；一个都没选就把这一周的都放上（用户自己删）
  const preset = new Set(host.presetIds);
  let picked: LifeNode[] = host.candidates.filter((n) => preset.has(n.id));
  if (!picked.length) picked = host.candidates.slice();
  let showFooter = host.showFooter;
  /** 正在被拖动的那一行 */
  let dragId: string | null = null;

  /* ---------- 面板里的元素（onOk 里也要用到，先建好） ---------- */
  let previewBox!: HTMLElement;
  let note!: HTMLElement;

  const paint = async (): Promise<void> => {
    const res = await renderReviewCard({
      nodes: picked,
      weekLabel: host.weekLabel,
      rangeText: host.rangeText,
      theme: host.theme,
      showFooter,
    });
    previewBox.innerHTML = '';
    const c = res.canvas;
    c.className = 'rc-img';
    previewBox.append(c);
    const bits: string[] = [];
    if (res.clipped) bits.push(t('card.overflowHint'));
    if (res.skippedImages) bits.push(t('export.imagesMissing', { n: res.skippedImages }));
    note.textContent = bits.join(' · ');
    note.classList.toggle('warn', bits.length > 0);
  };

  // 下载：调完**不关**面板 —— 还能调了再下
  const downloadNow = async (): Promise<void> => {
    const res = await renderReviewCard({
      nodes: picked,
      weekLabel: host.weekLabel,
      rangeText: host.rangeText,
      theme: host.theme,
      showFooter,
    });
    host.onDownload(res.canvas);
    if (res.clipped) toast(t('card.overflow'));
  };

  /* ---------- 打开弹窗 ---------- */
  // 这个面板比一般弹窗宽（左边要放得下 3:4 的卡片预览）——
  // 宽度挂在 #modalCard 上，面板关掉后必须摘掉，否则下一个弹窗会跟着变宽。
  const mcard = document.getElementById('modalCard');
  mcard?.classList.add('rc-modal');

  try {
    await modal({
      title: t('card.title'),
      okText: t('action.downloadPng'),
      cancelText: t('common.done'),
      wide: true,
      body: (body) => {
        const wrap = el('div', { class: 'rc-wrap' });
        const left = el('div', { class: 'rc-left' });
        const right = el('div', { class: 'rc-right' });
        wrap.append(left, right);
        body.append(wrap);

        previewBox = el('div', { class: 'rc-preview' });
        note = el('div', { class: 'rc-note' });
        left.append(previewBox, note);

        const list = el('div', { class: 'rc-list' });
        right.append(el('div', { class: 'rc-sec' }, t('card.inCard')), list);

        const footRow = el('label', { class: 'rc-foot' });
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = showFooter;
        cb.onchange = () => { showFooter = cb.checked; void paint(); };
        footRow.append(cb, document.createTextNode(t('card.withFooter')));
        right.append(footRow);

        const addWrap = el('div', { class: 'rc-add' });
        right.append(addWrap);

        /* ---------- 重画预览 ---------- */
        let raf = 0;
        const redraw = (): void => {
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => { raf = 0; void paint(); });
        };

        /* ---------- 列表 ---------- */
        const renderList = (): void => {
          list.innerHTML = '';
          if (!picked.length) {
            list.append(el('div', { class: 'rc-empty' }, t('card.nothingPicked')));
          }
          for (const n of picked) {
            const row = el('div', { class: 'rc-row', draggable: 'true' });
            row.append(el('span', { class: 'rc-grip', title: t('action.dragToReorder') }, '⠿'));
            const rbody = el('div', { class: 'rc-rbody' });
            rbody.append(el('div', { class: 'rc-rt' }, n.title || t('common.noTitle')));
            const meta = [nodeTypeLabel(n.type), n.time].filter(Boolean).join(' · ');
            rbody.append(el('div', { class: 'rc-rm' }, meta + (n.imageData ? t('node.hasImage') : '')));
            row.append(rbody);
            const rm = el('button', { class: 'rc-x', title: t('card.notInCard') }, '✕');
            rm.onclick = () => {
              picked = picked.filter((x) => x.id !== n.id);
              renderList();
              renderAdd();
              redraw();
            };
            row.append(rm);

            row.ondragstart = (e) => {
              dragId = n.id;
              e.dataTransfer?.setData('text/plain', n.id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            };
            row.ondragover = (e) => { e.preventDefault(); row.classList.add('over'); };
            row.ondragleave = () => row.classList.remove('over');
            row.ondrop = (e) => {
              e.preventDefault();
              row.classList.remove('over');
              const from = dragId;
              dragId = null;
              if (!from || from === n.id) return;
              const a = picked.findIndex((x) => x.id === from);
              const b = picked.findIndex((x) => x.id === n.id);
              if (a < 0 || b < 0) return;
              const moved = picked.splice(a, 1)[0]!;
              picked.splice(b, 0, moved);
              renderList();
              redraw();
            };
            list.append(row);
          }
        };

        /* ---------- 还能加哪些 ---------- */
        const renderAdd = (): void => {
          addWrap.innerHTML = '';
          const rest = host.candidates.filter((n) => !picked.some((p) => p.id === n.id));
          if (!rest.length) return;
          addWrap.append(el('div', { class: 'rc-sec' }, t('week.moreFromThisWeek')));
          for (const n of rest) {
            const row = el('button', { class: 'rc-addrow' });
            row.append(el('span', { class: 'rc-rt' }, n.title || t('common.noTitle')));
            const meta = [nodeTypeLabel(n.type), n.time].filter(Boolean).join(' · ');
            row.append(el('span', { class: 'rc-rm' }, meta + (n.imageData ? t('node.hasImage') : '')));
            row.onclick = () => {
              picked = picked.concat([n]);
              renderList();
              renderAdd();
              redraw();
            };
            addWrap.append(row);
          }
        };

        renderList();
        renderAdd();
        void paint();
      },
      onOk: () => {
        // ★ 必须**同步**返回 false，不能把 promise 返回出去：
        //   modal() 判的是 `onOk?.(body) !== false`，返回 promise 会被当成"不是 false" ⇒ 直接关面板。
        void downloadNow();
        return false;
      },
    });
  } finally {
    mcard?.classList.remove('rc-modal');
  }
}
