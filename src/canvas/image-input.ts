/**
 * 节点贴图工具：File → 缩放 → base64 dataURL。
 * 设计原则：
 * - 长边 ≤ 800px 缩放后入库，导出时不再二次处理
 * - 拒绝非图片、过大文件（> 4MB 原始 / > 1MB dataURL 后）
 * - 用 canvas 重绘而不是改 width/height 缩放，避免原始 EXIF 残留
 */

import { t } from '../i18n';

const MAX_DIM = 800;
const MAX_SRC_BYTES = 4 * 1024 * 1024;     // 4MB
const MAX_OUT_BYTES = 1024 * 1024;          // 1MB（base64 体积粗略估计）
const QUALITY = 0.85;

export interface LoadedImage {
  data: string;     // data:image/jpeg;base64,...
  w: number;        // 缩放后像素宽
  h: number;        // 缩放后像素高
  /** 失败原因（拒绝时填） */
  error?: string;
}

/** 不抛异常，失败时返回 { error } —— 让 UI 决定怎么提示 */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) {
    return { data: '', w: 0, h: 0, error: t('error.chooseImageFile') };
  }
  if (file.size > MAX_SRC_BYTES) {
    return { data: '', w: 0, h: 0, error: t('error.fileTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }) };
  }
  const dataUrl = await readAsDataURL(file);
  const img = await loadImg(dataUrl);
  let { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return { data: '', w: 0, h: 0, error: t('error.imageUnreadable') };

  // 长边缩到 MAX_DIM 内
  if (w > MAX_DIM || h > MAX_DIM) {
    if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
    else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
  }
  const data = drawToDataUrl(img, w, h);
  if (data.length > MAX_OUT_BYTES * 1.4 /* base64 膨胀 */) {
    return { data: '', w: 0, h: 0, error: t('error.imageStillTooLarge', { size: (data.length / 1024).toFixed(0) }) };
  }
  return { data, w, h };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result ?? ''));
    r.onerror = () => rej(new Error('读文件失败'));
    r.readAsDataURL(file);
  });
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图片解码失败'));
    img.src = src;
  });
}

function drawToDataUrl(img: HTMLImageElement, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  // jpeg 体积通常比 png 小 5-10 倍，封面图用 jpeg 合理
  return c.toDataURL('image/jpeg', QUALITY);
}
