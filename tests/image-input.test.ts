/**
 * image-input 的纯逻辑测试：拒绝非图片、过大文件、读图失败。
 * 注：成功路径依赖 canvas.toDataURL，需要 jsdom canvas polyfill 或 happy-dom。
 * 这里只测"失败路径"——更稳。
 */
import { describe, expect, it } from 'vitest';
import { loadImageFile } from '../src/canvas/image-input';

class FakeFile {
  name: string;
  type: string;
  size: number;
  constructor(parts: BlobPart[], name: string, opts: { type?: string } = {}) {
    this.size = parts.reduce((s, p) => s + (typeof p === 'string' ? p.length : 0), 0);
    this.type = opts.type ?? 'application/octet-stream';
    this.name = name;
  }
}

describe('loadImageFile 拒绝路径', () => {
  it('非图片类型立即拒绝', async () => {
    const f = new FakeFile(['hello'], 'doc.pdf', { type: 'application/pdf' }) as unknown as File;
    const r = await loadImageFile(f);
    expect(r.error).toMatch(/图片/);
    expect(r.data).toBe('');
  });

  it('超 4MB 文件拒绝', async () => {
    const big = 'a'.repeat(5 * 1024 * 1024);
    const f = new FakeFile([big], 'big.jpg', { type: 'image/jpeg' }) as unknown as File;
    const r = await loadImageFile(f);
    expect(r.error).toMatch(/太大/);
  });
});
