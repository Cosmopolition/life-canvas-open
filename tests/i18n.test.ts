/**
 * 文案层体检。
 *
 * 四块：
 *   ① 表的完整性 —— 键齐不齐、占位符对不对得上（scripts/i18n-check.ts）
 *   ② t() 的行为 —— 中文 / 英文 / 查不到退回 / 插值
 *   ③ 语言的切换与偏好
 *   ④ **数据契约** —— 落库的值不翻译，但显示名要跟着语言走
 */
import { describe, expect, it } from 'vitest';
import { check } from '../scripts/i18n-check';
import {
  detectLocale, fmtMonthDay, fmtYearMonth, loadLocalePref,
  monthLabel, onLocaleChange, resolveLocale, saveLocalePref, setLocale, t,
  LOCALES, LOCALE_NAME,
} from '../src/i18n';
import { STRINGS } from '../src/i18n/strings';
import {
  EDGE_TYPE_KEY, MILESTONE_KEY, NODE_TYPE_KEY, STATUS_KEY, TAG_KEY, WEEKDAY_KEY,
} from '../src/i18n/contracts';
import { edgeTypeLabel, nodeTypeLabel, statusLabel, tagLabel } from '../src/model/types';
import { milestoneLabel } from '../src/model/selectors';

describe('文案表体检', () => {
  const report = check();

  it('没有用到的键不在表里（漏翻）', () => {
    expect(report.missing).toEqual([]);
  });

  it('没有键还是中文原文（迁移做干净了）', () => {
    expect(report.chineseKey).toEqual([]);
  });

  it('中英文的占位符对得上', () => {
    expect(report.placeholderMismatch).toEqual([]);
  });

  it('英文值里不夹着中文', () => {
    expect(report.halfDone).toEqual([]);
  });

  it('表里没有没人用的键', () => {
    expect(report.unused).toEqual([]);
  });

  it('表不是空的', () => {
    expect(report.total).toBeGreaterThan(100);
  });
});

describe('t()', () => {
  it('中文环境返回表里的中文', () => {
    setLocale('zh-CN');
    expect(t('action.cancel')).toBe('取消');
    expect(t('reason.whyRequiredParen')).toBe('为什么改？（以后搜得到，这一条不能省）');
  });

  it('英文环境查表', () => {
    setLocale('en-US');
    expect(t('action.cancel')).toBe('Cancel');
    expect(t('action.save')).toBe('Save');
  });

  it('英文环境查不到就退回键名（不露空白）', () => {
    setLocale('en-US');
    // 运行时才知道的键（index.html 的 data-i18n）可能不在表里
    expect(t('error.generic' as never)).toBeDefined();
    expect(t('this.key.does.not.exist' as never)).toBe('this.key.does.not.exist');
  });

  it('插值替换 {param}', () => {
    setLocale('en-US');
    expect(t('week.numberLabel', { n: 45 })).toBe('Week 45');
    setLocale('zh-CN');
    expect(t('week.numberLabel', { n: 45 })).toBe('第 45 周');
  });

  it('没给的参数原样留着，不吞成空串', () => {
    setLocale('en-US');
    expect(t('week.numberLabel')).toBe('Week {n}');
  });

  it('切换语言后缓存会失效', () => {
    setLocale('zh-CN');
    expect(t('action.cancel')).toBe('取消');
    setLocale('en-US');
    expect(t('action.cancel')).toBe('Cancel');
    setLocale('zh-CN');
    expect(t('action.cancel')).toBe('取消');
  });
});

describe('语言偏好', () => {
  it('默认是「跟随系统」', () => {
    // Node 里没有 localStorage —— 存不下时按跟随系统处理
    expect(loadLocalePref()).toBe('auto');
  });

  it('resolveLocale 认得两种语言', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en-US');
  });

  it('切换语言会通知订阅者，退订之后不再通知', () => {
    setLocale('zh-CN');
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale('en-US');
    setLocale('zh-CN');
    off();
    setLocale('en-US');
    expect(seen).toEqual(['en-US', 'zh-CN']);
    setLocale('zh-CN');
  });

  it('语言表本身是自洽的', () => {
    expect([...LOCALES]).toEqual(['zh-CN', 'en-US']);
    expect(LOCALE_NAME['zh-CN']).toBe('简体中文');
    expect(LOCALE_NAME['en-US']).toBe('English');
    // 探测函数永远得给出两种语言之一
    expect(LOCALES).toContain(detectLocale());
  });

  it('保存偏好不会炸（没有 localStorage 也不炸）', () => {
    expect(() => saveLocalePref('en-US')).not.toThrow();
    expect(() => saveLocalePref('auto')).not.toThrow();
    expect(() => saveLocalePref('zh-CN')).not.toThrow();
  });
});

describe('日期格式', () => {
  it('中文环境是「11月5日」这种写法', () => {
    setLocale('zh-CN');
    expect(fmtMonthDay(new Date(2026, 10, 5))).toBe('11月5日');
    expect(fmtYearMonth(2026, 10)).toBe('2026年11月');
    expect(monthLabel(10)).toBe('11月');
  });

  it('英文环境跟着语言走', () => {
    setLocale('en-US');
    expect(fmtMonthDay(new Date(2026, 10, 5))).toBe('Nov 5');
    expect(fmtYearMonth(2026, 10)).toBe('November 2026');
    expect(monthLabel(10)).toBe('Nov');
    setLocale('zh-CN');
  });
});

describe('文案表本身', () => {
  it('每条都有非空的中英文', () => {
    for (const [k, v] of Object.entries(STRINGS)) {
      expect(v.zh.length, `键 ${k} 的中文是空的`).toBeGreaterThan(0);
      expect(v.en.length, `键 ${k} 的英文是空的`).toBeGreaterThan(0);
    }
  });

  it('键是英文 slug，不含汉字', () => {
    for (const k of Object.keys(STRINGS)) {
      expect(k, `键 ${k} 不该含汉字`).not.toMatch(/[一-鿿]/);
      expect(k, `键 ${k} 的格式不对`).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/);
    }
  });

  it('插值占位符两边对得上', () => {
    for (const [k, v] of Object.entries(STRINGS)) {
      const zh = new Set([...v.zh.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      const en = new Set([...v.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      expect([...en].sort(), `键 ${k} 的占位符对不上`).toEqual([...zh].sort());
    }
  });
});

describe('数据契约：落库的值不翻译，显示名才翻译', () => {
  it('状态：库里存中文，显示跟着界面语言', () => {
    setLocale('zh-CN');
    expect(statusLabel('进行中')).toBe('进行中');
    setLocale('en-US');
    expect(statusLabel('进行中')).toBe('In progress');
  });

  it('自定义状态原样显示（没有对照表就不翻译）', () => {
    setLocale('en-US');
    expect(statusLabel('在憋大招')).toBe('在憋大招');
  });

  it('系统标签翻译，普通标签不翻译', () => {
    setLocale('en-US');
    expect(tagLabel('周复盘')).toBe('Weekly review');
    expect(tagLabel('我的标签')).toBe('我的标签');
  });

  it('点类型与线类型的显示名跟着语言走', () => {
    setLocale('en-US');
    expect(nodeTypeLabel('goal')).toBe('Goal');
    expect(edgeTypeLabel('belong')).toBe('Belongs to');
    setLocale('zh-CN');
    expect(nodeTypeLabel('goal')).toBe('目标');
    expect(edgeTypeLabel('belong')).toBe('属于');
  });

  it('里程碑与星期也有对照表', () => {
    setLocale('en-US');
    expect(milestoneLabel('completed-early')).toBe('Completed early');
    expect(WEEKDAY_KEY['周一']).toBe('weekday.mon');
  });

  it('契约表里的每个键都在文案表里', () => {
    for (const map of [NODE_TYPE_KEY, EDGE_TYPE_KEY, STATUS_KEY, TAG_KEY, WEEKDAY_KEY, MILESTONE_KEY]) {
      for (const [value, slug] of Object.entries(map)) {
        expect(STRINGS[slug], `契约表指向了不存在的键 ${slug}`).toBeDefined();
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
