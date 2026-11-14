import { describe, expect, it } from 'vitest';
import {
  decryptJSON, defaultConfig, deriveKey, encryptJSON,
  newSalt, setupPassword, verifyPassword,
} from '../src/persist/crypto';

/**
 * 加密层曾经有一个会毁数据的 bug：关闭加密时写入用了会话密钥（密文），
 * 读取时 key 为 null 又按明文解析 —— 首次能开，第二次加载数据已损坏。
 * 这组用例把"关闭就是关闭"这个约定钉死。
 */

const PASSWORD = 'correct horse battery staple';

describe('开启加密', () => {
  it('加解密往返一致', async () => {
    const { key } = await setupPassword(PASSWORD);
    const obj = { id: 'n1', title: '敏感内容', tags: ['隐私'] };
    const bytes = await encryptJSON(key, obj);
    expect(await decryptJSON(key, bytes)).toEqual(obj);
  });

  it('落盘字节里不含明文', async () => {
    const { key } = await setupPassword(PASSWORD);
    const bytes = await encryptJSON(key, { title: '绝密' });
    expect(new TextDecoder().decode(bytes)).not.toContain('绝密');
  });

  it('相同明文两次加密产出不同字节（IV 随机）', async () => {
    const { key } = await setupPassword(PASSWORD);
    const a = await encryptJSON(key, { x: 1 });
    const b = await encryptJSON(key, { x: 1 });
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });

  it('错误密钥解不出来', async () => {
    const a = await setupPassword(PASSWORD);
    const b = await setupPassword(PASSWORD);
    const bytes = await encryptJSON(a.key, { secret: 1 });
    await expect(decryptJSON(b.key, bytes)).rejects.toBeTruthy();
  });
});

describe('密码校验', () => {
  it('正确密码通过，错误密码拒绝', async () => {
    const { config, key } = await setupPassword(PASSWORD);
    const ok = await verifyPassword(PASSWORD, config);
    expect(ok).not.toBeNull();
    const bad = await verifyPassword('wrong', config);
    expect(bad).toBeNull();
    expect(key.extractable).toBe(false); // 密钥不可导出
  });

  it('配置不完整时安全返回 null，不抛异常', async () => {
    expect(await verifyPassword(PASSWORD, defaultConfig())).toBeNull();
  });

  it('salt 每次不同', () => {
    const a = newSalt(), b = newSalt();
    expect(new Uint8Array(a).length).toBe(16);
    expect(new Uint8Array(a).join()).not.toBe(new Uint8Array(b).join());
  });
});

describe('关闭加密的语义（曾出事的那个 bug）', () => {
  it('key 为 null 时写进去就是明文字节', async () => {
    const bytes = await encryptJSON(null, { title: '明文' });
    expect(new TextDecoder().decode(bytes)).toContain('明文');
    expect(await decryptJSON(null, bytes)).toEqual({ title: '明文' });
  });

  it('关闭态写出的数据，换一次读取仍然解得出来', async () => {
    // 旧实现：写用会话密钥（密文），读按明文解析 → 第二次必崩
    const written = await encryptJSON(null, { id: 'n1', title: 'x' });
    // 模拟"关掉页面再打开"：全新一次读取，没有内存里的任何残留
    const readBack = await decryptJSON(null, written);
    expect(readBack).toEqual({ id: 'n1', title: 'x' });
  });

  it('密文不能被当成明文解析', async () => {
    const { key } = await setupPassword(PASSWORD);
    const ct = await encryptJSON(key, { title: 'x' });
    expect(() => JSON.parse(new TextDecoder().decode(ct))).toThrow();
  });
});

describe('派生', () => {
  it('同参数派生的密钥能解开彼此的数据', async () => {
    const salt = newSalt();
    const k1 = await deriveKey(PASSWORD, salt, 1000);
    const k2 = await deriveKey(PASSWORD, salt, 1000);
    expect(await decryptJSON(k2, await encryptJSON(k1, { a: 1 }))).toEqual({ a: 1 });
  });

  it('不同 salt 派生的密钥不通用', async () => {
    const k1 = await deriveKey(PASSWORD, newSalt(), 1000);
    const k2 = await deriveKey(PASSWORD, newSalt(), 1000);
    await expect(decryptJSON(k2, await encryptJSON(k1, { a: 1 }))).rejects.toBeTruthy();
  });
});