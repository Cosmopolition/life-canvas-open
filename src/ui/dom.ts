/** UI 小工具。不引入框架（§3） */
import { t } from '../i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('data-')) e.setAttribute(k, v);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) e.append(c);
  return e;
}

export const $ = <T extends Element = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const SVGNS = 'http://www.w3.org/2000/svg';

export function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

let toastTimer: number | undefined;
export function toast(msg: string, ms = 1900): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------- 弹窗 ---------- */

export interface ModalOpts {
  title: string;
  body: (card: HTMLElement, done: (v?: unknown) => void) => void;
  okText?: string;
  cancelText?: string;
  onOk?: (card: HTMLElement) => boolean | void;
  /** 宽版弹窗（设置面板这类内容多的用） */
  wide?: boolean;
  /** 只留一个按钮（内容全部即时生效时用，不要让用户以为还有"保存"这回事） */
  hideCancel?: boolean;
}

export function modal(o: ModalOpts): Promise<unknown> {
  const root = document.getElementById('modal')!;
  const card = document.getElementById('modalCard')!;
  card.innerHTML = '';
  card.classList.toggle('wide', !!o.wide);
  card.append(el('h3', {}, o.title));
  // 内容单独一层：内容多的时候**它自己滚**，标题和按钮固定。
  // 之前是整张卡片滚 + 按钮行 sticky —— sticky 的按钮会盖住最后一行内容，
  // 滚到底也还是被遮着（设置面板内容多，必踩）。
  const body = el('div', { class: 'modal-body' });
  card.append(body);
  return new Promise((resolve) => {
    let val: unknown;
    // OK 时 body 可能没调过 done(val)，val 仍是 undefined；
    // 用 true 作成功哨兵，否则调用方分不清"确定但没返回值"和"取消"。
    const done = (v?: unknown) => {
      const r = v === undefined ? true : v;
      root.hidden = true; resolve(r);
    };
    o.body(body, done);
    const acts = el('div', { class: 'modal-acts' });
    if (!o.hideCancel) {
      const cancel = el('button', { class: 'btn' }, o.cancelText ?? t('action.cancel'));
      cancel.onclick = () => done(null);
      acts.append(cancel);
    }
    const ok = el('button', { class: 'btn acc' }, o.okText ?? t('action.ok'));
    ok.onclick = () => { if (o.onOk?.(body) !== false) done(val); };
    acts.append(ok);
    card.append(acts);
    root.hidden = false;
    root.onclick = (e) => { if (e.target === root) done(null); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { done(null); document.removeEventListener('keydown', esc); }
    });
    setTimeout(() => (card.querySelector('input,textarea') as HTMLElement)?.focus(), 30);
  });
}

/** 带必填"原因"的输入框 —— 版本历史的核心（§8.1） */
export async function promptReason(opts: { title: string; prefill?: string; placeholder?: string }): Promise<string | null> {
  return modal({
    title: opts.title,
    okText: t('action.save'),
    body: (card, done) => {
      const ta = el('textarea', { placeholder: opts.placeholder ?? t('reason.whyRequiredParen') });
      if (opts.prefill) ta.value = opts.prefill;
      const lab = el('label', {}, t('field.reasonRequired'));
      card.append(lab, ta);
      card.dataset.value = '';
      card.addEventListener('input', () => { card.dataset.value = (ta as HTMLTextAreaElement).value; });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) done(ta.value.trim());
      });
    },
    onOk: (card) => {
      const v = (card.querySelector('textarea') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (!v) { toast(t('error.reasonRequired')); return false; }
      card.dataset.ok = v;
      return true;
    },
  }).then((r) => (typeof r === 'string' ? r : null)) as Promise<string | null>;
}

export async function confirmBox(title: string, message: string, okText = t('action.ok')): Promise<boolean> {
  const r = await modal({
    title, okText,
    body: (card) => { card.append(el('p', { style: 'font-size:13px;color:var(--dim);line-height:1.7' }, message)); },
  });
  return r === undefined || r === null ? false : true;
}
