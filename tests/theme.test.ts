/**
 * 主题取值的回归测试。
 *
 * 背景：主题从「暗色/亮色」两态改成「跟随系统/暗色/亮色」三态之后，
 * 踩过一个很典型的坑：迁移逻辑写成"每次启动都把 dark/light 迁成 auto"，
 * 结果**用户在设置里选的暗色根本存不住** —— 选了像没选，
 * 下次启动又跟回系统。
 *
 * 这里把两条规则钉死：
 *   1. 取值：auto 跟系统，显式选择不听系统的
 *   2. 迁移：只迁一次，之后保留用户的选择
 */
import { describe, expect, it } from 'vitest';
import { migrateTheme, resolveTheme } from '../src/persist/theme';

describe('resolveTheme（偏好 + 系统 → 实际）', () => {
  it('跟随系统时用系统的外观', () => {
    expect(resolveTheme('auto', 'light')).toBe('light');
    expect(resolveTheme('auto', 'dark')).toBe('dark');
  });

  it('显式选了暗色时，系统变浅也不改', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark');
  });

  it('显式选了亮色时，系统变深也不改', () => {
    expect(resolveTheme('light', 'dark')).toBe('light');
  });
});

describe('migrateTheme（旧值迁移）', () => {
  it('第一次升级：旧的 dark / light 都落到 auto（跟随系统）', () => {
    // 旧版只有两个值，dark 还是默认值，分不清"特意选的"和"没动过"
    expect(migrateTheme('dark', false)).toBe('auto');
    expect(migrateTheme('light', false)).toBe('auto');
    expect(migrateTheme(undefined, false)).toBe('auto');
  });

  it('升级过一次之后：保留用户后来选的暗色/亮色', () => {
    // 这条是回归点：迁移如果每次都跑，用户的选择就存不住
    expect(migrateTheme('dark', true)).toBe('dark');
    expect(migrateTheme('light', true)).toBe('light');
    expect(migrateTheme('auto', true)).toBe('auto');
  });

  it('升级过一次之后遇到不认识的旧值，退回 auto 而不是崩', () => {
    expect(migrateTheme('sepia', true)).toBe('auto');
  });

  it('存着"暗色"、还没升级标记 → 升级成 auto；升级后再存"暗色" → 保持暗色', () => {
    const before = migrateTheme('dark', false);
    expect(before).toBe('auto');
    // 用户在新设置里选了暗色并存盘
    expect(migrateTheme('dark', true)).toBe('dark');
  });
});
