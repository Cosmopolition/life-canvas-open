/**
 * 文案表体检。
 *
 *   npm run i18n                → 打印报告，有问题就退出码 1
 *
 * 查六件事：
 *   ① 缺键：源码里用到的 slug，表里没有 → **错误**
 *   ② 键还是中文：t('删除主题') 这种没迁移干净的 → **错误**
 *   ③ 占位符对不上：中英文的 {param} 集合不一致 → **错误**
 *   ④ 半吊子：英文值里还夹着中文 → **错误**
 *   ⑤ 多余：表里有、但没人用 → 警告（顺手删掉，别留着烂在表里）
 *   ⑥ 串味：值里混进日文 / 韩文 → 警告
 *
 * ★ 现在键是**英文 slug**，所以「有没有用到」直接扫 t() 的字面量就行 ——
 *   不用再猜哪些中文字面量是"间接取的键"（那是旧设计才有的麻烦）。
 *
 * 只读文件，不改任何东西。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/i18n/strings';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const HTML_FILE = join(ROOT, 'index.html');
const CONTRACTS_FILE = join(SRC, 'i18n', 'contracts.ts');

/** 汉字 */
const CJK = /[一-鿿]/;
/** 日文假名 / 韩文谚文 —— 两种语言里都不该出现（不含汉字本身） */
const JP_KR = /[぀-ヿ㐀-䶿가-힯]/;

/** 扫源码目录（跳过文案表本身）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith(join('i18n', 'strings.ts'))) out.push(p);
  }
  return out;
}

/**
 * 去掉注释。
 *
 * 注释里也会出现 t('…') 的例子，那些不是"用到的键"，扫进去会让报告多出噪音。
 *
 * 只按行去掉 /* … *\/ 整块和 // 开头的整行 —— 不做真正的词法分析，
 * 因为字符串里带 "//"（'https://…'）的不少，真解析反而容易出错。
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

/** 源码里 t('…') 的键。 */
function collectTKeys(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\bt(?:Runtime)?\(\s*'((?:[^'\\\n]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add(m[1]!);
  return out;
}

/** index.html 里 data-i18n* 属性上的键。 */
function collectHtmlKeys(html: string): Set<string> {
  const out = new Set<string>();
  const re = /data-i18n(?:-html|-title|-placeholder|-aria-label)?="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.add(m[1]!);
  return out;
}

/** 契约表里的 slug（contracts.ts 里全是字面量 slug）。 */
function collectContractKeys(src: string): Set<string> {
  const out = new Set<string>();
  const re = /'([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add(m[1]!);
  return out;
}

/** {param} 的集合 */
function placeholders(s: string): Set<string> {
  return new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

export interface I18nReport {
  /** 用到了但表里没有 —— 英文环境会退回键名 */
  missing: string[];
  /** 键还是中文原文 —— 说明迁移没做干净 */
  chineseKey: string[];
  /** 中英文的占位符对不上 */
  placeholderMismatch: string[];
  /** 英文值里还夹着中文 */
  halfDone: string[];
  /** 表里有但没人用 —— 可以删 */
  unused: string[];
  /** 值里混进日文 / 韩文 */
  mixedScript: string[];
  total: number;
  used: number;
}

export function check(): I18nReport {
  const used = new Set<string>();

  for (const f of walk(SRC)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const k of collectTKeys(src)) used.add(k);
  }

  for (const k of collectHtmlKeys(readFileSync(HTML_FILE, 'utf8'))) used.add(k);

  for (const k of collectContractKeys(stripComments(readFileSync(CONTRACTS_FILE, 'utf8')))) {
    used.add(k);
  }

  const missing = [...used].filter((k) => !(k in STRINGS)).sort();
  const chineseKey = [...used].filter((k) => CJK.test(k)).sort();
  const unused = Object.keys(STRINGS).filter((k) => !used.has(k)).sort();

  const placeholderMismatch: string[] = [];
  const halfDone: string[] = [];
  const mixedScript: string[] = [];

  for (const [key, e] of Object.entries(STRINGS)) {
    const zhP = [...placeholders(e.zh)].sort();
    const enP = [...placeholders(e.en)].sort();
    if (zhP.join(',') !== enP.join(',')) {
      placeholderMismatch.push(`${key}  →  zh {${zhP.join('}, {')}}  vs  en {${enP.join('}, {')}}`);
    }
    if (CJK.test(e.en)) halfDone.push(`${key}  →  ${e.en}`);
    if (JP_KR.test(e.zh) || JP_KR.test(e.en)) {
      mixedScript.push(`${key}  →  ${e.zh} / ${e.en}`);
    }
  }

  return {
    missing,
    chineseKey,
    placeholderMismatch,
    halfDone,
    unused,
    mixedScript,
    total: Object.keys(STRINGS).length,
    used: used.size,
  };
}

function main(): void {
  const r = check();
  console.log(`文案表：${r.total} 条 · 源码里用到 ${r.used} 条`);

  if (r.missing.length) {
    console.log(`\n✗ 表里没有的键 ${r.missing.length} 条：`);
    for (const k of r.missing) console.log(`   ${k}`);
  }
  if (r.chineseKey.length) {
    console.log(`\n✗ 键还是中文原文 ${r.chineseKey.length} 条（迁移没做干净）：`);
    for (const k of r.chineseKey) console.log(`   ${k}`);
  }
  if (r.placeholderMismatch.length) {
    console.log(`\n✗ 中英文占位符对不上 ${r.placeholderMismatch.length} 条：`);
    for (const k of r.placeholderMismatch) console.log(`   ${k}`);
  }
  if (r.halfDone.length) {
    console.log(`\n✗ 英文值里还夹着中文 ${r.halfDone.length} 条：`);
    for (const k of r.halfDone) console.log(`   ${k}`);
  }
  if (r.unused.length) {
    console.log(`\n⚠ 表里有、源码里没人用 ${r.unused.length} 条（可以直接删）：`);
    for (const k of r.unused) console.log(`   ${k}`);
  }
  if (r.mixedScript.length) {
    console.log(`\n⚠ 值里混进了日文/韩文 ${r.mixedScript.length} 条：`);
    for (const k of r.mixedScript) console.log(`   ${k}`);
  }

  const bad = r.missing.length + r.chineseKey.length + r.placeholderMismatch.length + r.halfDone.length;
  if (!bad) console.log('\n✓ 文案表没问题');
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
