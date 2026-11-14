/**
 * 编辑关系 —— 一条线（edge）的改 / 删。
 *
 * 画布和检视面板共用这一个面板：用户不该因为"从哪儿点进来的"
 * 而拿到两套不一样的功能。
 *
 * 面板里能做的三件事：
 *   1. 改类型（带约束：不合法的类型直接不可点，并说清楚为什么）
 *   2. 改备注（写清楚这条线为什么存在 —— 这是它跟"有向无标签的图"的区别）
 *   3. 删掉它
 */
import {
  EDGE_TYPES, EDGE_TYPE_COLOR, edgeTypeLabel,
  canConnect, type EdgeType, type Library, type LifeEdge, type NodeType,
} from '../model/types';
import { el, modal } from '../ui/dom';
import { t } from '../i18n';

export interface EdgeEditorHost {
  lib: Library;
  /** 改一条边的类型 / 备注 */
  onUpdate(edgeId: string, patch: { type?: EdgeType; note?: string }): void;
}

/** 这条边的起点是什么（约束判定要用到点的类型） */
function fromNodeType(lib: Library, e: LifeEdge): NodeType | undefined {
  return lib.nodes.find((n) => n.id === e.fromId)?.type;
}

/** 某一端是不是"点"（不是主题/阶段） */
function isNode(lib: Library, id: string): boolean {
  return lib.nodes.some((n) => n.id === id);
}

/**
 * 这个类型对这条边**合不合法**。
 *
 * 约束来自 types.ts 的 EDGE_CONSTRAINTS —— 比如「取代」只能从目标出发，
 * 「属于」不是手工连线（归属由主题/阶段字段持有）。
 */
export function edgeTypeAllowed(
  lib: Library, e: LifeEdge, type: EdgeType,
): { ok: boolean; why?: string } {
  if (type === 'belong') return { ok: false, why: t('hint.belongingIsAutomatic') };
  const fromType = fromNodeType(lib, e);
  const fromKind = isNode(lib, e.fromId) ? 'node' : (lib.themes.some((th) => th.id === e.fromId) ? 'theme' : 'stage');
  const toKind = isNode(lib, e.toId) ? 'node' : (lib.themes.some((th) => th.id === e.toId) ? 'theme' : 'stage');
  if (!canConnect(type, { kind: fromKind as never, type: fromType }, toKind as never)) {
    if (type === 'replace') return { ok: false, why: t('error.replacesFromGoalOnly') };
    if (fromKind === 'node' && toKind !== 'node') return { ok: false, why: t('error.relationNodesOnly') };
    if (fromKind !== 'node') return { ok: false, why: t('error.themeStageOnly') };
    return { ok: false, why: t('error.cannotConnectThese') };
  }
  return { ok: true };
}

/** 面板里的一句话摘要：谁 → 谁 */
export function edgeSummary(lib: Library, e: LifeEdge): string {
  const nameOf = (id: string): string => {
    const n = lib.nodes.find((x) => x.id === id);
    if (n) return n.title;
    const th = lib.themes.find((x) => x.id === id);
    if (th) return th.name;
    const s = lib.stages.find((x) => x.id === id);
    if (s) return s.name;
    return t('common.deleted');
  };
  return `${nameOf(e.fromId)} → ${nameOf(e.toId)}`;
}

/**
 * 打开「编辑关系」面板。
 *
 * @returns 用户做了什么（用于调用方决定要不要刷新画布）
 */
export async function openEdgeEditor(host: EdgeEditorHost, edge: LifeEdge): Promise<'updated' | 'removed' | null> {
  let type = edge.type;
  let note = edge.note ?? '';

  const r = await modal({
    title: t('action.editRelation'),
    okText: t('action.save'),
    body: (card, done) => {
      // 摘要：谁 → 谁
      card.append(el('p', { class: 'edge-ed-sum' }, edgeSummary(host.lib, edge)));

      // 类型
      card.append(el('label', {}, t('detail.whatRelation')));
      const row = el('div', { class: 'edge-ed-types' });
      const why = el('p', { class: 'edge-ed-why' });
      for (const et of EDGE_TYPES) {
        if (et === 'belong') continue;
        const allow = edgeTypeAllowed(host.lib, edge, et);
        const b = el('button', {
          class: 'edge-ed-type' + (et === type ? ' on' : ''),
          title: allow.ok ? edgeTypeLabel(et) : (allow.why ?? t('error.cannotConnectThese')),
          'data-type': et,
        }, edgeTypeLabel(et));
        if (!allow.ok) {
          // 不可用的类型：不可点，但鼠标移上去要说清楚为什么
          b.classList.add('off');
          b.disabled = true;
          b.onmouseenter = () => { why.textContent = allow.why ?? ''; };
          b.onmouseleave = () => { why.textContent = ''; };
        } else {
          b.style.setProperty('--c', EDGE_TYPE_COLOR[et]);
          b.onclick = () => {
            type = et;
            row.querySelectorAll('.edge-ed-type').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
          };
        }
        row.append(b);
      }
      card.append(row, why);

      // 备注
      card.append(el('label', {}, t('field.edgeNote')));
      const ta = el('textarea', { placeholder: t('field.exampleContent') });
      ta.value = note;
      card.append(ta);

      // 删除
      //
      // ⚠️ 这里**只把面板关掉**，不直接删 —— 真正的确认由 app 层做。
      //    原因是确认框和这个面板共用同一个 #modalCard：
      //    面板还开着的时候弹确认，确认框会把面板的内容冲掉。
      //    关掉面板再确认，两件事不会打架。
      const del = el('button', { class: 'btn edge-ed-del' }, t('action.deleteThisRelation'));
      del.onclick = () => done('removed');
      card.append(del);
    },
    onOk: () => {
      const patch: { type?: EdgeType; note?: string } = {};
      if (type !== edge.type) patch.type = type;
      const trimmed = note.trim();
      if (trimmed !== (edge.note ?? '').trim()) patch.note = trimmed;
      if (patch.type !== undefined || patch.note !== undefined) host.onUpdate(edge.id, patch);
      return true;
    },
  });

  if (r === 'removed') return 'removed';
  return r === true ? 'updated' : null;
}
