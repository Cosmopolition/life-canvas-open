/// <reference lib="webworker" />
/**
 * 索引 Worker。锁定时必须能整体销毁（§7.1）：主线程发 clear，
 * Worker 清空索引并丢弃所有明文副本。
 */
import { BigramIndex, type IndexDoc } from './indexer';

export type InMsg =
  | { t: 'add'; doc: IndexDoc }
  | { t: 'addAll'; docs: IndexDoc[] }
  | { t: 'remove'; id: string }
  | { t: 'query'; q: string; seq: number; limit?: number; spaceId?: string }
  | { t: 'clear' };

export type OutMsg =
  | { t: 'ready'; size: number }
  | { t: 'added'; size: number }
  | { t: 'result'; seq: number; q: string; hits: { id: string; score: number; field: string }[] }
  | { t: 'cleared' };

const idx = new BigramIndex();
let latest = 0;

self.onmessage = (ev: MessageEvent<InMsg>): void => {
  const msg = ev.data;
  switch (msg.t) {
    case 'add': idx.add(msg.doc); post({ t: 'added', size: idx.size }); break;
    case 'addAll': for (const d of msg.docs) idx.add(d); post({ t: 'added', size: idx.size }); break;
    case 'remove': idx.remove(msg.id); post({ t: 'added', size: idx.size }); break;
    case 'query': {
      const seq = ++latest;
      const hits = idx.search(msg.q, msg.limit ?? 200, msg.spaceId);
      post({ t: 'result', seq, q: msg.q, hits: hits.map((h) => ({ ...h, field: String(h.field) })) });
      break;
    }
    case 'clear':
      idx.clear();
      post({ t: 'cleared' });
      break;
  }
};

function post(m: OutMsg): void { (self as unknown as Worker).postMessage(m); }
