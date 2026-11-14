/**
 * 今日视图（视图四）。
 *
 * 设计：零增数据字段。
 * - 日记 = type='reflect' 且 time=YYYY-MM-DD 的节点；content 用 `### 意图\n…\n\n### 复盘\n…` 分块
 * - 软安排 = type='action' 且 time=YYYY-MM-DD 的节点列表
 *
 * 视图层不直接改 store —— 一切通过 host 回调上交给 App。
 */
import type { Library } from '../model/types';
import { todayNodes } from '../model/selectors';
import { esc } from '../ui/dom';
import { fmtMonthDay, t } from '../i18n';
import { WEEKDAY_KEY } from '../i18n/contracts';

export interface TodayHost {
  lib: Library;
  /** 当前浏览的日期，YYYY-MM-DD */
  date: string;
  theme: 'dark' | 'light';
  /** 保存早间/晚间。空字符串表示该段被清空 */
  onSaveDiary: (intent: string, review: string) => void;
  /** 新增一条软安排（type=action，time=date） */
  onAddSoft: (title: string) => void;
  /** 点软安排行 → 进入编辑态 */
  onEditSoft: (id: string) => void;
  /** 编辑态 Esc/点外 → 取消编辑 */
  onCancelEditSoft: () => void;
  /** 编辑态 ✓ / 回车 → 保存新标题 */
  onUpdateSoft: (id: string, title: string) => void;
  /** 勾选 / 取消勾选软安排（持久化到 store.done，不入版本历史） */
  onToggleSoft: (id: string, done: boolean) => void;
  /** 删除一条软安排（app 内部 confirmBox 走 async） */
  onDeleteSoft: (id: string) => void;
  /** 当前正在编辑的软安排 id，非 null 时该行渲染为编辑态 */
  editingSoftId: string | null;
  /** 点节点跳画布聚焦 */
  onPick: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

/** 把 reflect.content 拆成早间/晚间两段。无标记时整段当 intent（兼容旧节点） */
export function parseDiary(content: string): { intent: string; review: string } {
  const m = content.match(/### 意图\n([\s\S]*?)(?:\n\n### 复盘\n([\s\S]*))?$/);
  if (!m) return { intent: content, review: '' };
  return { intent: (m[1] ?? '').trim(), review: (m[2] ?? '').trim() };
}

/** 本地时区的今天 YYYY-MM-DD */
export function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** YYYY-MM-DD + delta 天 → YYYY-MM-DD。用中午 12 点锚定避开夏令时边界 */
export function dayShift(date: string, delta: number): string {
  const d = new Date(date + 'T12:00');
  d.setDate(d.getDate() + delta);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 星期几 → 文案键（落库的值是中文，翻译只发生在显示层） */
const WK_KEY = WK.map((w) => WEEKDAY_KEY[w]!);

const IC = {
  morning: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  leaf:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 20A7 7 0 0 1 4 13c0-2 .5-4 3-7 4-4 9-3 13-3-1 5 0 11-4 14a7 7 0 0 1-5 3z"/><path d="M3 21c0-3 2-6 5-7"/></svg>',
  moon:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  prev:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>',
  next:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>',
};

function headerHtml(isToday: boolean, dStr: string, wk: string): string {
  const todayBtn = isToday
    ? `<button class="btn ghost" id="tToday" disabled>${t('view.today')}</button>`
    : `<button class="btn ghost" id="tToday">${t('week.backToToday')}</button>`;
  return `<div class="today-hd">
    <button class="btn ghost" id="tPrev" title="${esc(t('action.prevDay'))}">${IC.prev}</button>
    <div class="d">${dStr}</div>
    <div class="w">${t(wk)}</div>
    <div class="spacer"></div>
    ${todayBtn}
    <button class="btn ghost" id="tNext" title="${esc(t('action.nextDay'))}">${IC.next}</button>
  </div>`;
}

function diaryCombinedHtml(intent: string, review: string, hasDiary: boolean): string {
  return `<div class="day-blk diary">
    <div class="day-hd">
      <div class="ic sun">${IC.morning}</div>
      <div class="lb">${hasDiary ? t('today.diaryExists') : t('today.diaryEmpty')}</div>
    </div>
    <div class="day-bd">
      <label class="dl">${t('today.morningIntent')}</label>
      <textarea id="tIntent" class="ta-intent" placeholder="${esc(t('today.intentPrompt'))}" spellcheck="false">${esc(intent)}</textarea>
      <label class="dl">${t('today.eveningReview')}</label>
      <textarea id="tReview" class="ta-review" placeholder="${esc(t('today.reviewPrompt'))}" spellcheck="false">${esc(review)}</textarea>
      <div class="diary-foot">
        <span class="hint-sm">${hasDiary ? t('toast.saved') : t('version.notSaved')}</span>
        <button class="btn save" id="tSave">${t('action.saveToCanvas')} · <kbd>⌘⏎</kbd></button>
      </div>
    </div>
  </div>`;
}

function softBlockHtml(
  soft: ReadonlyArray<{ id: string; title: string; content: string }>,
  done: Record<string, boolean>,
  editingId: string | null,
): string {
  const rows = soft.length
    ? soft.map((n) => {
        const ck = done[n.id] ? 'checked' : '';
        const isEdit = editingId === n.id;
        const body = isEdit
          ? `<input class="edit-input" id="edit-${n.id}" value="${esc(n.title)}" maxlength="80">`
          : `<div class="ttl" data-act="edit">${esc(n.title)}${n.content ? `<div class="nt">${esc(n.content.slice(0, 80))}${n.content.length > 80 ? '…' : ''}</div>` : ''}</div>`;
        const actions = isEdit
          ? `<button class="a-save" data-act="save" title="${esc(t('action.saveEnter'))}">✓</button><button class="a-cancel" data-act="cancel" title="${esc(t('action.cancelEsc'))}">×</button>`
          : `<button class="a-del" data-act="del" title="${esc(t('action.delete'))}">×</button>`;
        return `<div class="act-row ${ck ? 'done' : ''} ${isEdit ? 'editing' : ''}" data-id="${n.id}">
          <input type="checkbox" ${isEdit ? 'disabled ' : ''}${ck}>
          ${body}
          <div class="act-actions">${actions}</div>
        </div>`;
      }).join('')
    : '';
  return `<div class="day-blk soft">
    <div class="day-hd">
      <div class="ic leaf">${IC.leaf}</div>
      <div class="lb">${t('softPlan.title')}</div>
    </div>
    <div class="day-bd">
      <div class="sch">${rows || `<div class="empty-sm">${t('empty.noSoftPlans')}</div>`}</div>
      <div class="soft-add">
        <input id="softInput" placeholder="${esc(t('softPlan.add'))}" maxlength="80" spellcheck="false">
        <button class="btn acc" id="softAddBtn">${t('action.join')}</button>
      </div>
    </div>
  </div>`;
}

export function renderToday(root: HTMLElement, host: TodayHost): void {
  const day = todayNodes(host.lib, host.date);
  const parsed = day.diary ? parseDiary(day.diary.content) : { intent: '', review: '' };
  const d = new Date(host.date + 'T12:00');
  const dStr = fmtMonthDay(d);
  const wk = WK_KEY[d.getDay()] ?? '';
  const isToday = host.date === todayKey();
  // done 状态直接从 store 节点读（持久化；之前是模块级 Map 刷新即丢）
  const doneMap: Record<string, boolean> = {};
  for (const s of day.soft) if (s.done) doneMap[s.id] = true;

  root.innerHTML = `<div class="today">
    ${headerHtml(isToday, dStr, wk)}
    ${diaryCombinedHtml(parsed.intent, parsed.review, !!day.diary)}
    ${softBlockHtml(day.soft, doneMap, host.editingSoftId)}
  </div>`;

  bind(root, host);
}

function bind(root: HTMLElement, host: TodayHost): void {
  root.querySelector('#tPrev')?.addEventListener('click', () => host.onPrev());
  root.querySelector('#tNext')?.addEventListener('click', () => host.onNext());
  root.querySelector('#tToday')?.addEventListener('click', () => host.onToday());

  const intentEl = root.querySelector<HTMLTextAreaElement>('#tIntent');
  const reviewEl = root.querySelector<HTMLTextAreaElement>('#tReview');
  const saveDiary = () => {
    const iv = intentEl?.value.trim() ?? '';
    const rv = reviewEl?.value.trim() ?? '';
    host.onSaveDiary(iv, rv);
  };
  root.querySelector('#tSave')?.addEventListener('click', saveDiary);
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveDiary();
    }
  };
  intentEl?.addEventListener('keydown', onKey);
  reviewEl?.addEventListener('keydown', onKey);

  const inputEl = root.querySelector<HTMLInputElement>('#softInput');
  const btnEl = root.querySelector('#softAddBtn');
  const submit = () => {
    if (!inputEl) return;
    const v = inputEl.value.trim();
    if (!v) { inputEl.focus(); return; }
    host.onAddSoft(v);
    inputEl.value = '';
    inputEl.focus();
  };
  btnEl?.addEventListener('click', submit);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  // 软安排行：勾选 / 编辑 / 保存 / 取消 / 删除
  root.querySelectorAll<HTMLElement>('.act-row').forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    const cb = row.querySelector<HTMLInputElement>('input[type=checkbox]');
    if (cb && !cb.disabled) {
      cb.addEventListener('change', () => {
        row.classList.toggle('done', cb.checked);
        host.onToggleSoft(id, cb.checked);
      });
    }
    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
      host.onEditSoft(id);
    });
    row.querySelector('[data-act="save"]')?.addEventListener('click', () => {
      const inp = row.querySelector<HTMLInputElement>('.edit-input');
      host.onUpdateSoft(id, inp?.value.trim() ?? '');
    });
    row.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      host.onCancelEditSoft();
    });
    row.querySelector('[data-act="del"]')?.addEventListener('click', () => {
      host.onDeleteSoft(id);
    });
    const editInput = row.querySelector<HTMLInputElement>('.edit-input');
    editInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        host.onUpdateSoft(id, editInput.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        host.onCancelEditSoft();
      }
    });
  });

  // 编辑态：点编辑行外面 → 取消编辑（但点内部 input/按钮不取消）
  if (host.editingSoftId) {
    // 自动 focus 并把光标移到末尾
    const inp = root.querySelector<HTMLInputElement>(`#edit-${host.editingSoftId}`);
    if (inp) {
      requestAnimationFrame(() => {
        inp.focus();
        const v = inp.value;
        inp.setSelectionRange(v.length, v.length);
      });
    }
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const editingRow = root.querySelector('.act-row.editing');
      if (editingRow && editingRow.contains(target)) return;
      host.onCancelEditSoft();
    };
    // 下一帧再挂，避免当次事件冒泡过来立刻被取消
    requestAnimationFrame(() => document.addEventListener('mousedown', onDoc, { once: true }));
  }
}

