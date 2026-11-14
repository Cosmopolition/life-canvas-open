/**
 * CJK 二元分词倒排索引（AD-03）。
 * 主流 JS 搜索引擎的默认分词器对中文支持很弱，引入分词库会让搜索
 * 从"确定性"变成"依赖外部词表"，所以自建 bigram。
 */

export interface IndexDoc {
  id: string;
  /**
   * 所属空间。查询按空间过滤 ——
   * 周画布里不该搜到主画布的东西，切空间也不必重建索引。
   */
  spaceId: string;
  title: string;
  content: string;
  tags: string[];
  /** 版本原因也进索引 —— 对应需求文档场景 F「以后搜得到」 */
  reasons: string[];
}

export interface Hit {
  id: string;
  score: number;
  field: 'title' | 'content' | 'tag' | 'reason';
}

const FIELD_WEIGHT = { title: 5, tag: 3, reason: 2, content: 1 } as const;

/** CJK 字符按 1 字宽计，ASCII 按 0.5；用于"是否需要截断"判断 */
export const isCJK = (ch: string): boolean => {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
};

/** 归一化：全角转半角、小写、去掉标点空白 */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 切成相邻二字组（bigram），并**同时保留单字**。
 *
 * 只存 bigram 的话，搜「存」这种单字查询永远命中不了
 * —— 因为长文本里根本没有独立的单字 token。
 * 单字 + bigram 一起存，索引体积约翻倍，但换来了单字可搜。
 */
export function grams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  if (s.length === 1) out.push(s);
  return out;
}

/** 归一化后同时产出 unigram 与 bigram；查询侧用同一套 tokenize，AND 交集因此仍成立 */
export function tokenize(s: string): string[] {
  const norm = normalize(s);
  if (!norm) return [];
  if (norm.length === 1) return [norm];
  const out: string[] = [];
  for (let i = 0; i < norm.length; i++) {
    out.push(norm[i]!);
    if (i < norm.length - 1) out.push(norm.slice(i, i + 2));
  }
  return out;
}

/** gram -> docId -> {field, count} */
type Posting = Map<string, Map<string, { field: keyof typeof FIELD_WEIGHT; n: number }>>;

export class BigramIndex {
  private postings: Posting = new Map();
  private docs = new Map<string, IndexDoc>();
  private lengths = new Map<string, number>();

  add(d: IndexDoc): void {
    this.remove(d.id);
    this.docs.set(d.id, d);
    const fields: [string, keyof typeof FIELD_WEIGHT][] = [
      [d.title, 'title'], [d.content, 'content'],
      [d.tags.join(''), 'tag'], [d.reasons.join(' '), 'reason'],
    ];
    let total = 0;
    for (const [raw, field] of fields) {
      const norm = normalize(raw);
      if (!norm) continue;
      total += norm.length;
      for (const g of tokenize(norm)) {
        let m = this.postings.get(g);
        if (!m) { m = new Map(); this.postings.set(g, m); }
        const cur = m.get(d.id);
        if (cur) {
          cur.n += 1;
          // 保留更高权重的字段
          if (FIELD_WEIGHT[field] > FIELD_WEIGHT[cur.field]) cur.field = field;
        } else {
          m.set(d.id, { field, n: 1 });
        }
      }
    }
    this.lengths.set(d.id, Math.max(1, total));
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return;
    for (const m of this.postings.values()) m.delete(id);
    this.docs.delete(id);
    this.lengths.delete(id);
  }

  clear(): void { this.postings.clear(); this.docs.clear(); this.lengths.clear(); }

  get size(): number { return this.docs.size; }

  /**
   * 查询：所有查询 gram 求交集，按 (字段权重 × 命中数) / 文档长度 排序。
   * 采用"必须包含全部 gram"的严格 AND —— 中文短查询下精度优先于召回。
   *
   * @param spaceId 只返回这个空间的命中。**过滤发生在排序和 limit 之前**，
   *   所以 limit 是"这个空间里的前 N 条"，不会被别的空间占掉。
   */
  search(q: string, limit = 200, spaceId?: string): Hit[] {
    const qs = tokenize(q);
    if (!qs.length) return [];
    const uniq = [...new Set(qs)];
    let cand: Map<string, { field: keyof typeof FIELD_WEIGHT; n: number }> | null = null;

    for (const g of uniq) {
      const m = this.postings.get(g);
      if (!m) return [];
      if (!cand) { cand = new Map(m); continue; }
      for (const id of [...cand.keys()]) {
        const p = m.get(id);
        if (!p) cand.delete(id);
        else {
          const c = cand.get(id)!;
          cand.set(id, {
            field: FIELD_WEIGHT[p.field] > FIELD_WEIGHT[c.field] ? p.field : c.field,
            n: c.n + p.n,
          });
        }
      }
      if (!cand.size) return [];
    }
    if (!cand) return [];

    const hits: Hit[] = [];
    for (const [id, p] of cand) {
      const raw = this.docs.get(id);
      if (!raw) continue;
      if (spaceId && raw.spaceId !== spaceId) continue;   // ★ 空间过滤
      // 覆盖率：查询的 token 全部命中即为 1（AND 已经保证）
      const cover = 1;
      const density = p.n / Math.max(1, uniq.length);
      const score = FIELD_WEIGHT[p.field] * 4 * cover + density * 3 - Math.log(this.lengths.get(id) ?? 1) * 0.05;
      hits.push({ id, score, field: p.field });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/** 命中片段提取：围绕首个命中位置截一段 */
export function snippet(text: string, q: string, span = 46): string {
  if (!text) return '';
  const nq = normalize(q);
  if (!nq) return text.slice(0, span);
  // 归一化会改变长度，这里按比例粗定位，允许偏差
  const probe = q.trim().slice(0, 2);
  let i = text.toLowerCase().indexOf(probe);
  if (i < 0) i = text.toLowerCase().indexOf(q.trim().slice(0, 1));
  if (i < 0) return text.slice(0, span);
  const start = Math.max(0, i - Math.floor(span / 3));
  const out = text.slice(start, start + span);
  return (start > 0 ? '…' : '') + out + (start + span < text.length ? '…' : '');
}
