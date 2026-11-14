/**
 * 核对原生侧与 web 侧的文案表。
 *
 *   npm run i18n:native
 *
 * 为什么要有这个：
 *   原生菜单栏和网页界面是**两套代码**，但显示的是**同一批东西**。
 *   改了网页的「今日」忘了改菜单栏（或反过来），就会出现
 *   「菜单栏写 Today、窗口标题写 今日」这种不一致 —— 极难被察觉。
 *
 * 查四件事：
 *   ① 两边**共用**的 slug，中英文必须逐字一致
 *   ② 原生侧 t() 用到的 slug，表里都得有
 *   ③ 原生侧表里的每一条，占位符中英文要对得上
 *   ④ 原生侧不该再出现「中文当键」的调用
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { STRINGS } from '../src/i18n/strings';

const ROOT = join(import.meta.dirname, '..');
const SWIFT_DIR = join(ROOT, 'macos');
const L10N_FILE = join(SWIFT_DIR, 'LifeCanvas', 'L10n.swift');

const CJK = /[一-鿿]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.build') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.swift')) out.push(p);
  }
  return out;
}

const problems: string[] = [];

/* ---- 解析原生表：slug → (zh, en) ---- */
const l10nSrc = readFileSync(L10N_FILE, 'utf8');
const nativeTable = new Map<string, { zh: string; en: string }>();
const entryRe = /"([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)":\s*\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g;
let m: RegExpExecArray | null;
while ((m = entryRe.exec(l10nSrc))) {
  nativeTable.set(m[1]!, { zh: m[2]!, en: m[3]! });
}
if (!nativeTable.size) problems.push('原生表一条都没解析出来 —— L10n.swift 的格式变了？');

/* ---- ① 共用 slug 逐字一致 ---- */
for (const [slug, n] of nativeTable) {
  const w = STRINGS[slug];
  if (!w) continue; // 原生专属的 slug（native.*），web 侧没有，不比
  if (w.zh !== n.zh) {
    problems.push(`共用 slug ${slug} 的中文对不上：web ${JSON.stringify(w.zh)} vs 原生 ${JSON.stringify(n.zh)}`);
  }
  if (w.en !== n.en) {
    problems.push(`共用 slug ${slug} 的英文对不上：web ${JSON.stringify(w.en)} vs 原生 ${JSON.stringify(n.en)}`);
  }
}

/* ---- ② 原生 t() 用到的键，表里都得有 ---- */
for (const f of walk(SWIFT_DIR)) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  if (f === L10N_FILE) continue;
  for (const mm of src.matchAll(/L10n\.t\(\s*"([^"]+)"/g)) {
    const key = mm[1]!;
    if (CJK.test(key)) {
      problems.push(`还有中文当键：${rel} → L10n.t("${key}")`);
    } else if (!nativeTable.has(key)) {
      problems.push(`原生表里没有这个键：${rel} → L10n.t("${key}")`);
    }
  }
}

/* ---- ③ 占位符两边对得上 ---- */
const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!).sort().join(',');
for (const [slug, n] of nativeTable) {
  const zh = placeholders(n.zh);
  const en = placeholders(n.en);
  if (zh !== en) {
    problems.push(`原生 ${slug} 的占位符对不上：zh {${zh}} vs en {${en}}`);
  }
  if (CJK.test(n.en)) problems.push(`原生 ${slug} 的英文值里夹着中文：${n.en}`);
}

if (problems.length) {
  console.error(`✗ 原生 / web 文案表核对出 ${problems.length} 个问题：\n`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
const shared = [...nativeTable.keys()].filter((k) => k in STRINGS).length;
console.log(
  `✓ 原生表 ${nativeTable.size} 条（其中 ${shared} 条与 web 共用，逐字一致），无中文键残留`,
);
