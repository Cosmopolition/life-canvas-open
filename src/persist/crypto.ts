/**
 * 加密层（AD-04 / AD-05）。
 * 按记录粒度 AES-GCM-256，密钥由主密码经 PBKDF2-SHA256 600k 迭代派生。
 * 已知泄漏：id / spaceId / updatedAt / 点类型 —— 需求文档要求在 UI 中告知用户。
 */

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

export interface CryptoConfig {
  enabled: boolean;
  salt: Uint8Array | null;
  iterations: number;
  /** 用于校验密码正确性：加密一个已知 token */
  verifier: Uint8Array | null;
}

export const VERIFY_TOKEN = 'life-canvas/v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const newSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(SALT_BYTES));

export const defaultConfig = (): CryptoConfig => ({
  enabled: false, salt: null, iterations: ITERATIONS, verifier: null,
});

/** 首次设置密码 */
export async function setupPassword(password: string): Promise<{ config: CryptoConfig; key: CryptoKey }> {
  const salt = newSalt();
  const key = await deriveKey(password, salt, ITERATIONS);
  const verifier = await encryptBytes(key, enc.encode(VERIFY_TOKEN));
  return { config: { enabled: true, salt, iterations: ITERATIONS, verifier }, key };
}

export async function deriveKey(password: string, salt: Uint8Array, iterations = ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false, // 不可导出，避免密钥泄漏到 JS 堆
    ['encrypt', 'decrypt'],
  );
}

/** 校验密码：能解开 verifier 即正确 */
export async function verifyPassword(password: string, config: CryptoConfig): Promise<CryptoKey | null> {
  if (!config.salt || !config.verifier) return null;
  const key = await deriveKey(password, config.salt, config.iterations);
  try {
    const plain = await decryptBytes(key, config.verifier);
    return dec.decode(plain) === VERIFY_TOKEN ? key : null;
  } catch {
    return null;
  }
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0); out.set(ct, IV_BYTES);
  return out;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length <= IV_BYTES) throw new Error('密文长度异常');
  const iv = data.subarray(0, IV_BYTES);
  const ct = data.subarray(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return new Uint8Array(plain);
}

/**
 * key === null 即"加密关闭"：原样存 UTF-8 明文字节。
 *
 * 这里曾经用"进程内会话密钥"给关闭态兜底，导致写的时候是密文、
 * 读的时候按明文解析 —— 首次能开，第二次加载必崩且数据已损坏。
 * 关闭就是关闭，不做任何隐式加密。
 */
export const encryptJSON = <T>(key: CryptoKey | null, obj: T): Promise<Uint8Array> => {
  const bytes = enc.encode(JSON.stringify(obj));
  return key ? encryptBytes(key, bytes) : Promise.resolve(bytes);
};

export const decryptJSON = async <T>(key: CryptoKey | null, data: Uint8Array): Promise<T> => {
  const bytes = key ? await decryptBytes(key, data) : data;
  return JSON.parse(dec.decode(bytes)) as T;
};

/** 是否处于加密模式（用于 UI 提示） */
export const isEncrypted = (key: CryptoKey | null): boolean => key !== null;
