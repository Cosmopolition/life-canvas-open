import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 原生外壳桥接。
 *
 * 这里最要紧的是**浏览器不回归**：没有桥的时候 enable() 必须返回 false，
 * 且绝不能给 <html> 挂上 data-native-shell —— 一挂上，CSS 就把 web 顶栏
 * display:none 掉，浏览器里会变成"没有工具栏的裸页面"。
 * 浏览器里 flag 的来源只有 bridge 的存在性，与 Settings 无关。
 *
 * 测试跑在 Node 里（项目没装 jsdom），所以这里手搓最小 DOM stub。
 */

interface Stub {
  postMessage: ReturnType<typeof vi.fn>;
  dataset: Record<string, string>;
  win: Record<string, unknown>;
}

function stubDOM(native: boolean): Stub {
  const postMessage = vi.fn();
  const dataset: Record<string, string> = {};
  const win: Record<string, unknown> = native
    ? { webkit: { messageHandlers: { shell: { postMessage } } } }
    : {};
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = { documentElement: { dataset } };
  return { postMessage, dataset, win };
}

// shell.ts 有模块级 commandHandler，每组用例前重置
async function loadShell() {
  vi.resetModules();
  return import('../src/platform/shell');
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe('浏览器里（没有原生桥）', () => {
  it('isNative 为 false，enable 也返回 false', async () => {
    stubDOM(false);
    const { enable, isNative } = await loadShell();
    expect(isNative()).toBe(false);
    expect(enable(() => {})).toBe(false);
  });

  it('绝不给 <html> 挂 data-native-shell —— 否则 web 顶栏会被藏掉', async () => {
    const { dataset } = stubDOM(false);
    const { enable } = await loadShell();
    enable(() => {});
    expect(dataset.nativeShell).toBeUndefined();
  });

  it('不装 window.__lcShell', async () => {
    const { win } = stubDOM(false);
    const { enable } = await loadShell();
    enable(() => {});
    expect(win.__lcShell).toBeUndefined();
  });

  it('emit 是空操作但不抛错', async () => {
    stubDOM(false);
    const { emit } = await loadShell();
    expect(() => emit('ready', { view: 'canvas' })).not.toThrow();
  });
});

describe('原生外壳里（有桥）', () => {
  it('isNative 为 true，enable 返回 true 并挂上 data-native-shell', async () => {
    const { dataset } = stubDOM(true);
    const { enable, isNative } = await loadShell();
    expect(isNative()).toBe(true);
    expect(enable(() => {})).toBe(true);
    expect(dataset.nativeShell).toBe('1');
  });

  it('emit 把 type 拍平进 payload 再 postMessage', async () => {
    const { postMessage } = stubDOM(true);
    const { emit } = await loadShell();
    emit('ready', { view: 'canvas' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready', view: 'canvas' });
  });

  it('emit 无 payload 时只发 type', async () => {
    const { postMessage } = stubDOM(true);
    const { emit } = await loadShell();
    emit('focusCanvas' as never);
    expect(postMessage).toHaveBeenCalledWith({ type: 'focusCanvas' });
  });

  it('enable 幂等：第二次调用不替换已注册的分发器', async () => {
    stubDOM(true);
    const { enable } = await loadShell();
    const first = vi.fn();
    const second = vi.fn();
    enable(first);
    enable(second);
    const cmd = (globalThis as Record<string, any>).window.__lcShell.cmd;
    cmd({ type: 'search', q: 'a' });
    expect(first).toHaveBeenCalledWith({ type: 'search', q: 'a' });
    expect(second).not.toHaveBeenCalled();
  });

  it('__lcShell.cmd 接受 JSON 字符串（原生侧就是这么发的）', async () => {
    stubDOM(true);
    const { enable } = await loadShell();
    const onCommand = vi.fn();
    enable(onCommand);
    const cmd = (globalThis as Record<string, any>).window.__lcShell.cmd;
    cmd(JSON.stringify({ type: 'view', view: 'tl' }));
    expect(onCommand).toHaveBeenCalledWith({ type: 'view', view: 'tl' });
  });

  it('cmd 收到空值 / 非法 JSON / 裸数字都不抛错', async () => {
    stubDOM(true);
    const { enable } = await loadShell();
    const onCommand = vi.fn();
    enable(onCommand);
    const cmd = (globalThis as Record<string, any>).window.__lcShell.cmd;
    for (const junk of [null, undefined, 0, '{不是json']) {
      expect(() => cmd(junk)).not.toThrow();
    }
    expect(onCommand).not.toHaveBeenCalled();
  });
});