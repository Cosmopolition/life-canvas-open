/**
 * 生成压力测试库（M1 的 DoD：一条命令行造出 1 万节点）。
 *
 *   npm run seed              → seed-10000.json（1 万节点 / 1 万边）
 *   npm run seed -- 50000     → seed-50000.json
 *   npm run seed -- 10000 --sample
 *
 * 产物是标准的导出包格式，在应用里用「导出 → 导入 JSON」就能灌进去。
 * 浏览器里的 IndexedDB 是 Node 访问不到的，所以这里只出文件。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSampleLibrary, buildStressLibrary } from '../src/data/seed';
import { toBundle } from '../src/persist/export';
import { expandOneHop } from '../src/model/selectors';
import { BigramIndex } from '../src/search/indexer';
import { wrapByWidth } from '../src/canvas/text-layout';

const argv = process.argv.slice(2);
const count = Number(argv.find((a) => /^\d+$/.test(a)) ?? 10000);
const useSample = argv.includes('--sample');

const t0 = Date.now();
const raw = useSample ? buildSampleLibrary() : buildStressLibrary(count);
const lib = {
  ...raw,
  nodes: raw.nodes.map((n) => ({ ...n, spaceId: 'default' })),
  edges: raw.edges.map((e) => ({ ...e, spaceId: 'default' })),
};

const bundle = toBundle(lib);
const file = resolve(process.cwd(), `seed-${useSample ? 'sample' : count}.json`);
writeFileSync(file, JSON.stringify(bundle), 'utf8');

/* ---- 顺带把建库成本和索引体积量出来，这些数字会写进技术文档 ---- */
const idx = new BigramIndex();
const reasons = new Map<string, string[]>();
for (const v of lib.versions) {
  const a = reasons.get(v.nodeId);
  if (a) a.push(v.reason); else reasons.set(v.nodeId, [v.reason]);
}
const i0 = Date.now();
for (const n of lib.nodes) {
  idx.add({ id: n.id, spaceId: n.spaceId, title: n.title, content: n.content, tags: n.tags, reasons: reasons.get(n.id) ?? [] });
}
const idxMs = Date.now() - i0;

const rawBytes = lib.nodes.reduce((s, n) => s + n.title.length + n.content.length, 0);
const t1 = Date.now();
for (const n of lib.nodes.slice(0, 200)) wrapByWidth(n.title, 13.5, 250, 2);
const wrapMs = (Date.now() - t1) / 200;

console.log(`\n已写出  ${file}`);
console.log(`        ${lib.nodes.length} 点 / ${lib.edges.length} 边`);
console.log(`        ${(JSON.stringify(bundle).length / 1024 / 1024).toFixed(1)} MB`);
// 挑一个真的有边的节点来量一跳扩展，否则量到 1 也没意义
const degree = new Map<string, number>();
for (const e of lib.edges) {
  degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
  degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
}
const hub = [...degree.entries()].sort((a, b) => b[1] - a[1])[0];
const hops = hub ? expandOneHop(lib, [hub[0]]).size : 0;

console.log('\n自检：');
console.log(`  建索引      ${idxMs} ms（${lib.nodes.length} 文档）`);
console.log(`  索引规模    ${idx.size} 文档 / 正文 ${(rawBytes / 1024).toFixed(0)} KB`);
console.log(`  查询「阶段」  ${idx.search('阶段').length} 命中（上限 200）`);
console.log(`  查询单字「段」 ${idx.search('段').length} 命中（验证单字召回）`);
console.log(`  一跳扩展    ${hub ? `度数最高的点 ${hub[1]} 度 → 带出 ${hops} 个` : '无边'}`);
console.log(`  标题换行    ${wrapMs.toFixed(3)} ms/条`);
console.log(`  总耗时      ${Date.now() - t0} ms`);
console.log(`\n导入方式：应用内「导出 → 导入 JSON」选择该文件\n`);