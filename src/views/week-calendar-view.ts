/**
 * 周历（视图五）—— 周画布的总入口。
 *
 * ★ 行 = 周。每行左边是周次和区间，中间是这一周的 7 天（周一→周日），
 *   右边是这一周的状态。点整行就进那一周的复盘画布。
 *
 * 为什么按周排而不是按天：入口是"周"，点哪儿都是一周。
 * 但保留"7 列 = 周一到周日"的日历结构 —— 那是人对日历的直觉，
 * 而且能一眼看出这周哪几天落了东西。
 *
 * 状态只有两种，都是**数出来的**，不是生成的：
 *   ✓  这一周写过周复盘
 *   N  这一周的复盘画布里有 N 个点
 */
import type { Library } from '../model/types';
import {
  currentMonth, dayCounts, isoWeekNumber, monthWeeks, rangeText, weekDays,
  weekSpaceStats,
} from '../model/space';
import { esc } from '../ui/dom';
import { getLocale, t } from '../i18n';
import { WEEKDAY_KEY } from '../i18n/contracts';

export interface WeekCalendarHost {
  /** 全库 —— 周历要看到**所有**周空间的状态 */
  lib: Library;
  /** 当前显示的月份，YYYY-MM */
  month: string;
  /** 点某一周 → 进那一周的复盘画布 */
  onEnterWeek: (monday: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onThisMonth: () => void;
}

/**
 * 周几表头。
 *
 * 中文那七个是「一」这样的单字（表头窄，放不下「周一」），英文用 Mon/Tue 这样的缩写。
 * 英文走 t() —— 键是「周一」这种整名。
 */
const WK_CN = ['一', '二', '三', '四', '五', '六', '日'];
const WK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function wkHeadLabels(): string[] {
  const zh = getLocale() === 'zh-CN';
  return WK_NAMES.map((w, i) => (zh ? WK_CN[i]! : t(WEEKDAY_KEY[w]!)));
}

function monthTitle(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return t('date.yearMonth', { y: m[1]!, m: Number(m[2]!) });
}

/** 该周 7 天各自的「主空间记录数」（周一 → 周日） */
function weekCounts(lib: Library, monday: string): number[] {
  const counts = dayCounts(lib);
  return weekDays(monday).map((d) => counts.get(d) ?? 0);
}

/** 一天的格子里显示几号 + 有没有记录 */
function dayCell(day: string, n: number, inMonth: boolean): string {
  const date = Number(day.slice(8, 10));
  const cls = ['wk-day'];
  if (n > 0) cls.push('has');
  if (!inMonth) cls.push('out');
  return `<span class="${cls.join(' ')}" title="${esc(t('list.dayCount', { day, n }))}">${date}</span>`;
}

export function renderWeekCalendar(root: HTMLElement, host: WeekCalendarHost): void {
  const weeks = monthWeeks(host.month);
  const stats = weekSpaceStats(host.lib);
  const thisMonday = weeks.length ? currentMonday() : '';
  const curMonth = host.month;

  const rows = weeks.map((monday) => {
    const sunday = weekDays(monday)[6]!;
    const wno = isoWeekNumber(monday);
    const counts = weekCounts(host.lib, monday);
    const st = stats.get('week:' + monday);
    const isCur = monday === thisMonday;

    const state = [
      // 有复盘 ⇒ 说清楚是"复盘"，别只丢一个 ✓ 让人猜
      st?.hasReview ? `<b class="ok" title="${esc(t('week.reviewWritten'))}">✓ ${esc(t('today.review'))}</b>` : '',
      // 节点数是"这一周的复盘画布里有几个点"
      st && st.count ? `<span class="n" title="${esc(t('week.reviewCanvasNodeCount', { n: st.count }))}">${esc(t('common.itemCount', { n: st.count }))}</span>` : '',
    ].join('');

    const days = weekDays(monday).map((d, i) =>
      dayCell(d, counts[i] ?? 0, d.slice(0, 7) === curMonth)).join('');

    return `<div class="wk-row${isCur ? ' cur' : ''}" data-monday="${monday}">
      <div class="wk-no">${wno}</div>
      <div class="wk-rg">${esc(rangeText(monday, sunday))}</div>
      <div class="wk-days">${days}</div>
      <div class="wk-state">${state}</div>
    </div>`;
  }).join('');

  const anyActivity = weeks.some((monday) => {
    const st = stats.get('week:' + monday);
    return (st && st.count > 0) || weekCounts(host.lib, monday).some((c) => c > 0);
  });

  root.innerHTML = `<div class="wkcal">
    <div class="wkcal-hd">
      <button class="btn ghost" id="wkPrev" title="${esc(t('action.prevMonth'))}">‹</button>
      <div class="d">${esc(monthTitle(curMonth))}</div>
      <div class="spacer"></div>
      <button class="btn ghost" id="wkThis"${curMonth === currentMonth() ? ' disabled' : ''}>${esc(t('week.backToThisMonth'))}</button>
      <button class="btn ghost" id="wkNext" title="${esc(t('action.nextMonth'))}">›</button>
    </div>
    <div class="wk-row wk-head">
      <div class="wk-no">${esc(t('week.number'))}</div>
      <div class="wk-rg">${esc(t('filter.range'))}</div>
      <div class="wk-days">${wkHeadLabels().map((w) => `<span class="wk-day hd">${esc(w)}</span>`).join('')}</div>
      <div class="wk-state">${esc(t('field.status'))}</div>
    </div>
    ${rows}
    ${anyActivity ? '' : `<div class="wk-empty">${esc(t('week.noRecordsThisMonth'))}</div>`}
  </div>`;

  bind(root, host);
}

/** 本周（周一日期）。周历高亮「当前这一周」。 */
function currentMonday(): string {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bind(root: HTMLElement, host: WeekCalendarHost): void {
  root.querySelector('#wkPrev')?.addEventListener('click', () => host.onPrevMonth());
  root.querySelector('#wkNext')?.addEventListener('click', () => host.onNextMonth());
  root.querySelector('#wkThis')?.addEventListener('click', () => host.onThisMonth());

  root.querySelectorAll<HTMLElement>('.wk-row[data-monday]').forEach((row) => {
    const monday = row.dataset.monday;
    if (!monday) return;
    row.addEventListener('click', () => host.onEnterWeek(monday));
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        host.onEnterWeek(monday);
      }
    });
  });
}
