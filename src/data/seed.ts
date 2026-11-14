/**
 * 内置示例空间（待决事项 #6：内置可直接删除的示例空间）。
 * 作用是解决需求文档里的可用性指标："首次 10 分钟内完成一次记录→整理→搜索"。
 * 空白画布会卡在"我不知道该记什么"，示例空间是那一步的答案。
 */
import { uid, type EdgeType, type Library, type LifeEdge, type LifeNode, type LifeStage, type LifeTheme } from '../model/types';

/**
 * 参考主题模板：六个领域型主题，纯骨架（无点、无边）。
 * 给空库用户一个起点去想"人生可以分哪几条线"，不要全留给他/她从零敲名字。
 * 用户可改名、改色、删除任何一个 —— 这是脚手架，不是答案。
 *
 * 排序有意为之：日常视野（健康/关系/事业/财务）放前面，
 * 长期投入（学习/娱乐）放后面 —— 冷暖色和重要度一起考虑。
 */
export function buildThemeTemplate(): Pick<LifeTheme, 'name' | 'color'>[] {
  return [
    { name: '身心健康',    color: '#6fae8f' },  // 绿
    { name: '关系',        color: '#c98a8a' },  // 粉
    { name: '事业（职业）', color: '#7f9bd4' },  // 蓝
    { name: '财务',        color: '#c9a55f' },  // 金
    { name: '学习成长',    color: '#9a7fcf' },  // 紫
    { name: '娱乐（休闲）', color: '#b8722e' },  // 暖橙
  ];
}

/**
 * 兼容：旧 buildAreaTemplate 调用点（app.ts 的 esTemplate 按钮 + 旧单测）。
 * 行为：返回 6 个主题（type='theme'），让旧的拆解逻辑仍可走通。
 */
export function buildAreaTemplate(): Array<{ name: string; type: string; color: string }> {
  return buildThemeTemplate().map((t) => ({ name: t.name, type: 'theme', color: t.color }));
}

export const SAMPLE_SPACE = 'sample';
const P = { pal: '#e0a458', work: '#7f9bd4', body: '#6fae8f', make: '#c98a8a' };

export function buildSampleLibrary(): Library {
  const now = Date.now();
  let k = 0;
  const id = (p: string) => `${p}-sample-${(k++).toString(36)}`;

  /* 主题（长线）—— 演示两级嵌套：学习成长 › 阅读思考 › {书籍阅读, 生活思考}；学习成长 › 写作 */
  const tWork  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '事业（职业）', parentId: null as string | null, color: P.work, createdAt: now, updatedAt: now };
  const tBody  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '身心健康',     parentId: null as string | null, color: P.body, createdAt: now, updatedAt: now };
  const tMake  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '想做的作品',   parentId: null as string | null, color: P.make, createdAt: now, updatedAt: now };
  const tLearn = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '学习成长',     parentId: null as string | null, color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tRead  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '阅读思考',     parentId: tLearn.id,             color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tBooks = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '书籍阅读',     parentId: tRead.id,              color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tLife  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '生活思考',     parentId: tRead.id,              color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tWrite = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE, name: '写作',         parentId: tLearn.id,             color: '#9a7fcf', createdAt: now, updatedAt: now };
  const themes: LifeTheme[] = [tWork, tBody, tMake, tLearn, tRead, tBooks, tLife, tWrite];
  const [T_WORK, T_BODY, T_MAKE] = themes;

  /* 阶段（时段，带起止） */
  const stages: LifeStage[] = [
    { id: id('s'), kind: 'stage', spaceId: SAMPLE_SPACE, name: '2023–2025 星河', color: P.work, start: '2023-01', end: '2025-12', createdAt: now, updatedAt: now },
    { id: id('s'), kind: 'stage', spaceId: SAMPLE_SPACE, name: '2026 过渡期', color: P.pal, start: '2026-01', end: '2026-12', createdAt: now, updatedAt: now },
  ];
  const [S_OLD, S_STAGE] = stages;

  const A_STAGE = S_STAGE!.id, A_OLD = S_OLD!.id, A_WORK = T_WORK!.id, A_BODY = T_BODY!.id, A_MAKE = T_MAKE!.id;

  const nodes: LifeNode[] = [];
  const N = (p: Partial<LifeNode> & { type: LifeNode['type']; title: string; themeIds?: string[]; stageIds?: string[] }): LifeNode => {
    const n: LifeNode = {
      id: p.id ?? id('n'), kind: 'node', spaceId: SAMPLE_SPACE,
      content: '', status: undefined, time: undefined, tags: [],
      themeIds: p.themeIds ?? [], stageIds: p.stageIds ?? [],
      x: 0, y: 0, w: 240, h: 78, ...p,
      createdAt: now, updatedAt: now,
    } as LifeNode;
    nodes.push(n);
    return n;
  };

  const g7 = N({ type: 'goal', title: '两年内做到技术负责人', status: '已取代', time: '2023-06', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 150, w: 250, h: 88, content: '当时觉得这是唯一的目标。年底评估后确认：头衔拿到了，但能力没跟上。' });
  const e3 = N({ type: 'event', title: '第一次挂掉的负责人任命', time: '2024-01', stageIds: [A_OLD], themeIds: [A_WORK], x: 360, y: 150, w: 250, h: 88, content: '宣布后一个月，因为跨组资源协调不下去，被撤了。' });
  const rf1 = N({ type: 'reflect', title: '把职级当成了能力', time: '2024-02', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 280, w: 250, h: 88, content: '真正稀缺的是判断力，不是头衔。这句话后来改了我两次方向。' });
  const g3 = N({ type: 'goal', title: '去一家节奏更快的公司证明自己', status: '已取代', time: '2025-07', stageIds: [A_OLD], themeIds: [A_WORK], x: 360, y: 290, w: 250, h: 96, content: '想换个环境，逼自己加速。前提是：问题出在公司，不在我。' });
  const p1 = N({ type: 'person', title: '老陈 · 前 leader', time: '2023-09', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 430, w: 200, h: 78, content: '一直不放人，也确实带过我。冲突最多的一个人。' });
  const w1 = N({ type: 'work', title: '给团队做的发布工具', time: '2024-08', stageIds: [A_OLD], themeIds: [A_WORK], x: 300, y: 470, w: 250, h: 88, content: '第一个真正被别人用起来的东西。也是那次任命唯一的证据。' });
  const p3 = N({ type: 'person', title: '阿哲 · 一直劝我别急着走', time: '2024-05', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 570, w: 210, h: 78, content: '每次我提离职他都说再等等。事后看他是对的。' });

  const p2 = N({ type: 'person', title: '小林 · 现在的 mentor', time: '2025-06', themeIds: [A_WORK], x: 70, y: 720, w: 210, h: 78, content: '内推了我。离职那天最后一条消息是「别把这里当终点」。' });
  const r2 = N({ type: 'resource', title: '前同事 20+ 的行业人脉', time: '2025-12', themeIds: [A_WORK], x: 320, y: 720, w: 230, h: 78, content: '这三年攒下的最实的东西。' });
  const e2 = N({ type: 'event', title: '拿到 offer', time: '2025-06', themeIds: [A_WORK], x: 70, y: 860, w: 210, h: 78, content: '比预期早了两周。当时觉得终于可以喘口气了。' });
  const m2 = N({ type: 'emotion', title: '那种「终于被认可」的兴奋', time: '2025-06', themeIds: [A_WORK], x: 320, y: 860, w: 230, h: 78, content: '持续了大概一周。' });

  const g1 = N({ type: 'goal', title: '35 岁前成为能独立带项目的人', status: '进行中', time: '2026-01', tags: ['长期方向'], stageIds: [A_STAGE], themeIds: [A_WORK], x: 860, y: 150, w: 290, h: 88, content: '判断近期决定的标准不是「好不好」，而是「会不会让我离这个更近」。' });
  const g2 = N({ type: 'goal', title: '2026 完成一次真正的转型', status: '进行中', time: '2026-04', tags: ['长期方向'], stageIds: [A_STAGE], themeIds: [A_WORK], x: 860, y: 300, w: 250, h: 96, content: '不预设形式。可以是换公司、可以是自己做、也可以是换赛道。' });
  const e1 = N({ type: 'event', title: '提离职，交接了 1 个月', time: '2026-03', stageIds: [A_STAGE], x: 860, y: 450, w: 210, h: 78, content: '走的那天没觉得轻松。' });
  const m1 = N({ type: 'emotion', title: '离职后第一周的空', time: '2026-03', tags: ['转折'], stageIds: [A_STAGE], x: 860, y: 570, w: 210, h: 78, content: '不是开心也不是难过，是没有着落。' });
  const i1 = N({ type: 'idea', title: '我可能不是想换工作，是想换一个自己的定义', time: '2026-04', tags: ['转折', '认知'], stageIds: [A_STAGE], x: 860, y: 700, w: 250, h: 88, content: '换工作这个动作本身不解决问题。真正想换的是「我是谁」这个设定。' });
  const e4 = N({ type: 'event', title: '开始投简历', time: '2026-07', stageIds: [A_STAGE], x: 1160, y: 450, w: 210, h: 78, content: '投了 14 家，面试 5 家，2 个 offer。都不太心动。' });
  const m3 = N({ type: 'emotion', title: '面试被拒后的自我怀疑', time: '2026-04', tags: ['转折'], stageIds: [A_STAGE], x: 1160, y: 570, w: 210, h: 78, content: '连着拒了三个之后冒出来的。' });
  const a1 = N({ type: 'action', title: '每周投 3 家公司', time: '2026-07', stageIds: [A_STAGE], x: 1160, y: 700, w: 200, h: 78, content: '只记录做过的事。没有进度条，也不该有。' });
  const r1 = N({ type: 'resource', title: '存款 = 4.2 个月生活费', time: '2026-08', stageIds: [A_STAGE], x: 1160, y: 840, w: 230, h: 78, content: '决定我可以慢一点找。' });
  const g6 = N({ type: 'goal', title: '存够 6 个月生活费', status: '进行中', time: '2025-09', stageIds: [A_STAGE], x: 1160, y: 970, w: 230, h: 78, content: '给自己买的一个缓冲。' });

  const g4 = N({ type: 'goal', title: '把身体练回来，能跑完半马', status: '进行中', time: '2025-11', themeIds: [A_BODY], x: 1700, y: 150, w: 250, h: 88, content: '体检之后定的。不是为了好看。' });
  const a2 = N({ type: 'action', title: '每周跑 3 次', time: '2025-12', themeIds: [A_BODY], x: 1700, y: 290, w: 200, h: 78, content: '断了两次了。第三次重新开始。' });
  const pc1 = N({ type: 'place', title: '深圳 · 南山', time: '2026-06', themeIds: [A_BODY], x: 1700, y: 420, w: 200, h: 78, content: '现在每天通勤 1.5 小时。这是我还没解决的问题之一。' });

  const g5 = N({ type: 'goal', title: '写完那本关于工具的书', status: '探索中', time: '2026-05', themeIds: [A_MAKE], x: 1700, y: 720, w: 250, h: 88, content: '写了 3 万字，卡在结构上。' });
  const i2 = N({ type: 'idea', title: '工具的价值在于删掉步骤，不在于功能多', time: '2026-05', tags: ['认知'], themeIds: [A_MAKE], x: 1700, y: 860, w: 250, h: 88, content: '这个想法最早是从那个发布工具上冒出来的。' });

  /* 嵌套主题下的节点（演示父主题焦点会包含子主题） */
  const i3 = N({ type: 'idea', title: '重读《人月神话》：软件工程的真正问题是沟通', time: '2026-09', tags: ['认知'], themeIds: [tBooks.id, tRead.id, tLearn.id], x: 2150, y: 150, w: 250, h: 96, content: '第一次读是工作第一年，只看懂了"加人不能加速"。这次看的是"为什么 Brooks 三十年前就放弃说服管理者"——他不是写给程序员的，是写给程序员的老板的。' });
  const i4 = N({ type: 'idea', title: '通勤 1.5 小时是阅读时间还是浪费', time: '2026-06', themeIds: [tLife.id, tRead.id, tLearn.id], x: 2150, y: 290, w: 230, h: 88, content: '通勤有三种状态：放空、刷信息、阅读。阅读的那 20 分钟是我一周里少数完全属于自己的时段。' });
  const i5 = N({ type: 'idea', title: '把读后感写下来才算读完', time: '2026-07', themeIds: [tWrite.id, tLearn.id], x: 2150, y: 430, w: 230, h: 88, content: '写下来的过程会逼自己组织语言，组织语言的过程会逼自己想清楚。' });

  const E = (from: LifeNode, to: LifeNode, type: EdgeType, note?: string): LifeEdge => ({
    id: id('e'), kind: 'edge', spaceId: SAMPLE_SPACE, fromId: from.id, fromKind: 'node',
    toId: to.id, toKind: 'node', type, note, createdAt: now, updatedAt: now,
  });

  const edges: LifeEdge[] = [
    E(g7, g3, 'replace', '第一次调整：头衔路线走不通'),
    E(g3, g2, 'replace', '想清楚以后发现：不是环境问题，是节奏问题'),
    E(e3, g7, 'sequence'),
    E(e3, rf1, 'cause', '任命失败是反思的直接来源'),
    E(rf1, g3, 'inspire'),
    E(rf1, w1, 'reference', '那也是唯一能证明能力的东西'),
    E(p1, g7, 'block', '不放人，卡了半年'),
    E(p3, g3, 'block', '「再等等，你还没准备好」'),
    E(w1, p1, 'support', '靠他给的资源才做出来'),
    E(p2, e2, 'support', '内推'),
    E(e2, m2, 'cause'),
    E(m2, g3, 'cause', '信心是被 offer 给的'),
    E(g6, r1, 'cause', '存款就是这条目标的结果'),
    E(r1, e4, 'support', '有钱可以不慌，可以挑'),
    E(g1, g2, 'support', '长期方向是判断近期决定的标准'),
    E(e1, m1, 'cause'),
    E(m1, i1, 'cause', '空下来的那两周'),
    E(i1, g2, 'inspire', '想清楚了才动'),
    E(e4, m3, 'cause'),
    E(a1, g2, 'support', '但后来发现数量在逃避判断'),
    E(g2, g3, 'replace'),
    E(g4, a2, 'cause', '目标是跑步的原因，不是跑步的目标'),
    E(a2, g4, 'sequence'),
    E(i2, g5, 'inspire'),
    E(w1, i2, 'inspire'),
    E(pc1, g2, 'block', '通勤吃掉的时间本可以做作品'),
    E(r2, e4, 'support'),
    E(i3, i2, 'inspire', '重读后改变了「工具该多什么」的想法'),
    E(i4, i5, 'inspire', '通勤是阅读时段 → 那读后感在通勤里写出来'),
  ];

  const versions = [
    { nodeId: g7.id, title: undefined as string | undefined, reason: '初始设定', t: '2023-06-02', c: '设定目标：两年内做到技术负责人。' },
    { nodeId: g7.id, title: undefined, reason: '年度复盘后降级', t: '2024-02-11', c: '年末评估：头衔拿到了，但带人、带项目的能力明显不够。' },
    { nodeId: g7.id, title: undefined, reason: '被「去一家节奏更快的公司证明自己」取代', t: '2025-07-12', c: '这个目标没有兑现。真正想要的是能独立判断和推进一件事。', s: '已取代' },
    { nodeId: g3.id, title: undefined, reason: '被上上一个目标逼出来的', t: '2025-07-12', c: '设定目标：去一家节奏更快的公司证明自己。' },
    { nodeId: g3.id, title: undefined, reason: '调整节奏，避免裸辞', t: '2025-11-03', c: '犹豫：要不要直接跳竞对？先看内部有没有机会。' },
    { nodeId: g3.id, title: undefined, reason: '被「2026 完成一次真正的转型」取代', t: '2026-04-18', c: '想清楚以后发现：不是环境问题，是节奏问题。', s: '已取代' },
    { nodeId: g2.id, title: undefined, reason: '想清楚「不是环境问题，是节奏问题」之后重设', t: '2026-04-18', c: '新目标：2026 完成一次真正的转型。' },
    { nodeId: g2.id, title: '里程碑 · 换成深度访谈', reason: '发现自己在用数量逃避判断', t: '2026-07-20', c: '把「投 3 家/周」降级，改为先做一次深度访谈再决定方向。' },
  ].map((v) => ({
    id: uid('v-'), nodeId: v.nodeId,
    snapshot: JSON.stringify({ status: v.s ?? null }),
    title: v.title, reason: v.reason,
    changedAt: new Date(v.t + 'T00:00:00').getTime(),
    changedFields: ['status'],
  }));

  return { themes, stages, nodes, edges, milestones: [], versions, customStatuses: [] };
}

/** 合成大规模测试库：M1 的性能 DoD 用它 */
export function buildStressLibrary(count: number, spaceId = 'stress'): Library {
  const now = Date.now();
  const themes: LifeTheme[] = ['职业', '健康', '关系', '财务', '学习', '娱乐'].map((name, i) => ({
    id: `t-${i}`, kind: 'theme' as const, spaceId, name,
    parentId: null, color: ['#e0a458', '#7f9bd4', '#6fae8f', '#c98a8a', '#c9a86a', '#b98ac9'][i] ?? '#7f9bd4',
    createdAt: now, updatedAt: now,
  }));
  const types = ['goal', 'event', 'emotion', 'idea', 'person', 'resource', 'action', 'reflect', 'place', 'work'] as const;
  const words = ['阶段', '方向', '阻碍', '资源', '转折', '代价', '收获', '判断', '节奏', '锚点', '复盘', '决策'];
  const nodes: LifeNode[] = [];
  for (let i = 0; i < count; i++) {
    const t = types[i % types.length]!;
    nodes.push({
      id: `n-${i}`, kind: 'node', spaceId, type: t,
      title: `${words[i % words.length]}${i} · ${t}`,
      content: `压测用内容 ${i}。`.repeat(4),
      status: t === 'goal' ? ['进行中', '探索中', '已完成'][i % 3] : undefined,
      time: `${2020 + (i % 6)}-${String((i % 12) + 1).padStart(2, '0')}`,
      tags: [words[i % words.length]!],
      themeIds: [themes[i % themes.length]!.id], stageIds: [],
      x: 120 + (i % 100) * 270,
      y: 120 + Math.floor(i / 100) * 130,
      w: 240, h: 78,
      createdAt: now, updatedAt: now,
    });
  }
  const edges: LifeEdge[] = [];
  /**
   * 聚簇式连边，而不是全局随机。
   * 真实的人生图谱是"同一件事的若干点聚在一起"，
   * 随机长边会让边的视口裁剪永远不命中，性能验证就失真了。
   */
  let eid = 0;
  const addEdge = (i: number, j: number, type: EdgeType) => {
    if (i === j) return;
    edges.push({
      id: `e-${eid++}`, kind: 'edge', spaceId, fromId: nodes[i]!.id, fromKind: 'node',
      toId: nodes[j]!.id, toKind: 'node', type, createdAt: now, updatedAt: now,
    });
  };
  const COLS = 100;
  for (let i = 0; i < count; i++) {
    const col = i % COLS, row = Math.floor(i / COLS);
    if (col < COLS - 1) addEdge(i, i + 1, 'cause');
    if (i + COLS < count && (i % 5 === 0)) addEdge(i, i + COLS, 'support');
    if (row > 0 && i % 3 === 0) addEdge(i, i - COLS, 'block');
    if (i % 17 === 0) addEdge(i, (i * 13 + 7) % count, 'reference');
    if (nodes[i]!.type === 'goal' && i % 7 === 0 && i + 5 < count) {
      nodes[i + 5]!.type = 'goal';
      nodes[i + 5]!.status = '已取代';
      addEdge(i, i + 5, 'replace');
    }
  }
  return { themes, milestones: [], stages: [], nodes, edges, versions: [], customStatuses: [] };
}
