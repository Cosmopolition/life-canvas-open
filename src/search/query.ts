/** 主线程侧的索引句柄 */
import type { IndexDoc } from './indexer';
import type { InMsg, OutMsg } from './indexer.worker';

export interface SearchHit { id: string; score: number; field: string }

export class SearchIndex {
  private worker: Worker;
  private seq = 0;
  private waiters = new Map<number, (hits: SearchHit[]) => void>();
  private inflight: AbortController | null = null;
  ready = false;

  constructor() {
    this.worker = new Worker(new URL('./indexer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<OutMsg>) => {
      const m = ev.data;
      if (m.t === 'result') {
        const w = this.waiters.get(m.seq);
        if (w) { this.waiters.delete(m.seq); w(m.hits); }
      } else if (m.t === 'ready' || m.t === 'added') {
        this.ready = true;
      } else if (m.t === 'cleared') {
        this.ready = false;
      }
    };
  }

  private send(m: InMsg): void { this.worker.postMessage(m); }

  addAll(docs: IndexDoc[]): void { this.send({ t: 'addAll', docs }); }
  /**
   * 单条更新先入缓冲，下一拍合并成一次 addAll。
   * 1 万条逐个 postMessage 会把 Worker 的任务队列塞满，后续查询全部排队。
   */
  add(doc: IndexDoc): void {
    this.buffer.push(doc);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushBuffer(), 0);
  }
  private buffer: IndexDoc[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushBuffer(): void {
    this.flushTimer = null;
    if (!this.buffer.length) return;
    const docs = this.buffer;
    this.buffer = [];
    if (docs.length > 8) this.send({ t: 'addAll', docs });
    else for (const d of docs) this.send({ t: 'add', doc: d });
  }
  remove(id: string): void { this.send({ t: 'remove', id }); }

  /** 锁定时销毁索引，不留明文（§7.1） */
  clear(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.buffer = [];
    this.waiters.forEach((w) => w([]));
    this.waiters.clear();
    this.inflight?.abort();
    this.send({ t: 'clear' });
  }

  dispose(): void { this.clear(); this.worker.terminate(); }

  /**
   * 上一条未完成的查询作废，避免旧结果覆盖新结果
   *
   * @param spaceId 只搜这个空间。索引是全库的 —— 空间过滤在 Worker 侧做，
   *   所以切空间不需要重建索引。
   */
  query(q: string, limit = 200, spaceId?: string): Promise<SearchHit[]> {
    this.inflight?.abort();
    this.inflight = new AbortController();
    const seq = ++this.seq;
    const trimmed = q.trim();
    if (!trimmed) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.waiters.set(seq, resolve);
      this.send({ t: 'query', q: trimmed, seq, limit, spaceId });
      // 上一条查询的结果直接丢弃
      for (const [k, w] of this.waiters) if (k !== seq) { this.waiters.delete(k); w([]); }
    });
  }
}
