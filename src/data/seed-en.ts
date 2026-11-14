/**
 * 内置示例空间（英文版）。
 *
 * 和 src/data/seed.ts 是**平行的一份**：同一个故事、同一套结构、
 * 同一个位置与同一批 id —— 只是话说的是英语。
 *
 * 为什么单独写一份而不是"翻译字符串"：
 *   示例空间里的点标题、正文、关系备注、版本理由**全是用户数据**，
 *   不是界面文案 —— 它们不会走 t()，也就不会被翻译表管到。
 *   想让英文用户看到一份读得懂的示例，只能另写一份。
 *
 * ★ 状态值（'进行中' / '已取代' / '探索中'）保持中文原样 ——
 *   那是落库的数据契约，界面上由 statusLabel() 按当前语言显示。
 *   这里换了它们，导出的库就跟中文那份对不上了。
 */
import { uid, type EdgeType, type Library, type LifeEdge, type LifeNode, type LifeStage, type LifeTheme } from '../model/types';

/**
 * 参考主题模板（英文版）：六个领域型主题，纯骨架。
 * 和中文版一一对应，顺序也一样（日常视野在前，长期投入在后）。
 */
export function buildThemeTemplateEn(): Pick<LifeTheme, 'name' | 'color'>[] {
  return [
    { name: 'Health & Fitness', color: '#6fae8f' },   // green
    { name: 'Relationships',    color: '#c98a8a' },   // pink
    { name: 'Career (Work)',    color: '#7f9bd4' },   // blue
    { name: 'Money',            color: '#c9a55f' },   // gold
    { name: 'Learning & Growth', color: '#9a7fcf' },  // purple
    { name: 'Fun & Leisure',    color: '#b8722e' },   // warm orange
  ];
}

/** 兼容旧调用点（app.ts 的 esTemplate 按钮 + 旧单测）。 */
export function buildAreaTemplateEn(): Array<{ name: string; type: string; color: string }> {
  return buildThemeTemplateEn().map((t) => ({ name: t.name, type: 'theme', color: t.color }));
}

export const SAMPLE_SPACE_EN = 'sample';
const P = { pal: '#e0a458', work: '#7f9bd4', body: '#6fae8f', make: '#c98a8a' };

export function buildSampleLibraryEn(): Library {
  const now = Date.now();
  let k = 0;
  const id = (p: string) => `${p}-sample-${(k++).toString(36)}`;

  /* Themes (long arcs) — two levels of nesting, same shape as the Chinese sample:
     Learning & Growth › Reading & Thinking › {Books, Life & Reflection}; Learning & Growth › Writing */
  const tWork  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Career (Work)',       parentId: null as string | null, color: P.work, createdAt: now, updatedAt: now };
  const tBody  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Health & Fitness',    parentId: null as string | null, color: P.body, createdAt: now, updatedAt: now };
  const tMake  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Projects I Want to Make', parentId: null as string | null, color: P.make, createdAt: now, updatedAt: now };
  const tLearn = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Learning & Growth',   parentId: null as string | null, color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tRead  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Reading & Thinking', parentId: tLearn.id,           color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tBooks = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Books',               parentId: tRead.id,            color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tLife  = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Life & Reflection',  parentId: tRead.id,            color: '#9a7fcf', createdAt: now, updatedAt: now };
  const tWrite = { id: id('t'), kind: 'theme' as const, spaceId: SAMPLE_SPACE_EN, name: 'Writing',             parentId: tLearn.id,           color: '#9a7fcf', createdAt: now, updatedAt: now };
  const themes: LifeTheme[] = [tWork, tBody, tMake, tLearn, tRead, tBooks, tLife, tWrite];
  const [T_WORK, T_BODY, T_MAKE] = themes;

  /* Stages (periods, with a span) */
  const stages: LifeStage[] = [
    { id: id('s'), kind: 'stage', spaceId: SAMPLE_SPACE_EN, name: '2023–2025 Starlight', color: P.work, start: '2023-01', end: '2025-12', createdAt: now, updatedAt: now },
    { id: id('s'), kind: 'stage', spaceId: SAMPLE_SPACE_EN, name: '2026 Transition',    color: P.pal,  start: '2026-01', end: '2026-12', createdAt: now, updatedAt: now },
  ];
  const [S_OLD, S_STAGE] = stages;

  const A_STAGE = S_STAGE!.id, A_OLD = S_OLD!.id, A_WORK = T_WORK!.id, A_BODY = T_BODY!.id, A_MAKE = T_MAKE!.id;

  const nodes: LifeNode[] = [];
  const N = (p: Partial<LifeNode> & { type: LifeNode['type']; title: string; themeIds?: string[]; stageIds?: string[] }): LifeNode => {
    const n: LifeNode = {
      id: p.id ?? id('n'), kind: 'node', spaceId: SAMPLE_SPACE_EN,
      content: '', status: undefined, time: undefined, tags: [],
      themeIds: p.themeIds ?? [], stageIds: p.stageIds ?? [],
      x: 0, y: 0, w: 240, h: 78, ...p,
      createdAt: now, updatedAt: now,
    } as LifeNode;
    nodes.push(n);
    return n;
  };

  const g7 = N({ type: 'goal', title: 'Become a tech lead within two years', status: '已取代', time: '2023-06', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 150, w: 250, h: 88, content: 'At the time it felt like the only goal there was. The end-of-year review showed otherwise: I got the title, but the skill never caught up.' });
  const e3 = N({ type: 'event', title: 'My first promotion to lead — revoked', time: '2024-01', stageIds: [A_OLD], themeIds: [A_WORK], x: 360, y: 150, w: 250, h: 88, content: 'A month after the announcement it was pulled: coordination across teams never worked out.' });
  const rf1 = N({ type: 'reflect', title: 'Mistaking the title for the ability', time: '2024-02', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 280, w: 250, h: 88, content: 'What is actually scarce is judgement, not a title. That sentence changed my direction twice.' });
  const g3 = N({ type: 'goal', title: 'Prove myself at a faster-moving company', status: '已取代', time: '2025-07', stageIds: [A_OLD], themeIds: [A_WORK], x: 360, y: 290, w: 250, h: 96, content: 'Change the environment to force myself to speed up. The premise: the problem is the company, not me.' });

  const p1 = N({ type: 'person', title: 'Chen · my former lead', time: '2023-09', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 430, w: 200, h: 78, content: 'Never let anyone go, and he did mentor me. The person I clashed with the most.' });
  const w1 = N({ type: 'work', title: 'The release tool I built for the team', time: '2024-08', stageIds: [A_OLD], themeIds: [A_WORK], x: 300, y: 470, w: 250, h: 88, content: 'The first thing anyone else actually used. Also the only evidence that promotion left behind.' });
  const p3 = N({ type: 'person', title: 'Zhe · kept telling me to wait', time: '2024-05', stageIds: [A_OLD], themeIds: [A_WORK], x: 70, y: 570, w: 210, h: 78, content: 'Every time I mentioned resigning he said "not yet". In hindsight he was right.' });

  const p2 = N({ type: 'person', title: 'Lin · my current mentor', time: '2025-06', themeIds: [A_WORK], x: 70, y: 720, w: 210, h: 78, content: 'Referred me. Last message on my last day: "Don\'t treat this place as the finish line."' });
  const r2 = N({ type: 'resource', title: '20+ industry contacts from former colleagues', time: '2025-12', themeIds: [A_WORK], x: 320, y: 720, w: 230, h: 78, content: 'The most concrete thing those three years produced.' });
  const e2 = N({ type: 'event', title: 'Got the offer', time: '2025-06', themeIds: [A_WORK], x: 70, y: 860, w: 210, h: 78, content: 'Two weeks earlier than expected. At the time it felt like I could finally breathe.' });
  const m2 = N({ type: 'emotion', title: 'That rush of finally being recognised', time: '2025-06', themeIds: [A_WORK], x: 320, y: 860, w: 230, h: 78, content: 'Lasted about a week.' });

  const g1 = N({ type: 'goal', title: 'Lead a project on my own before 35', status: '进行中', time: '2026-01', tags: ['Long-term direction'], stageIds: [A_STAGE], themeIds: [A_WORK], x: 860, y: 150, w: 290, h: 88, content: 'The test for a near-term decision is not "is it good" but "does it take me closer to this".' });
  const g2 = N({ type: 'goal', title: 'Make one real transition in 2026', status: '进行中', time: '2026-04', tags: ['Long-term direction'], stageIds: [A_STAGE], themeIds: [A_WORK], x: 860, y: 300, w: 250, h: 96, content: 'No fixed form. Could be a new company, going independent, or a different field.' });
  const e1 = N({ type: 'event', title: 'Resigned, handed over for a month', time: '2026-03', stageIds: [A_STAGE], x: 860, y: 450, w: 210, h: 78, content: 'The day I left did not feel light.' });
  const m1 = N({ type: 'emotion', title: 'The emptiness of the first week after leaving', time: '2026-03', tags: ['Turning point'], stageIds: [A_STAGE], x: 860, y: 570, w: 210, h: 78, content: 'Not happy, not sad — just unmoored.' });
  const i1 = N({ type: 'idea', title: 'Maybe I don\'t want a new job, I want a new definition of myself', time: '2026-04', tags: ['Turning point', 'Insight'], stageIds: [A_STAGE], x: 860, y: 700, w: 250, h: 88, content: 'Switching jobs does not solve the problem. What I actually want to change is the setting "who I am".' });
  const e4 = N({ type: 'event', title: 'Started applying', time: '2026-07', stageIds: [A_STAGE], x: 1160, y: 450, w: 210, h: 78, content: '14 applications, 5 interviews, 2 offers. None of them excited me.' });
  const m3 = N({ type: 'emotion', title: 'Self-doubt after being rejected', time: '2026-04', tags: ['Turning point'], stageIds: [A_STAGE], x: 1160, y: 570, w: 210, h: 78, content: 'It showed up after the third rejection in a row.' });
  const a1 = N({ type: 'action', title: 'Apply to 3 companies a week', time: '2026-07', stageIds: [A_STAGE], x: 1160, y: 700, w: 200, h: 78, content: 'A record of what I did. No progress bar, and there should not be one.' });
  const r1 = N({ type: 'resource', title: 'Savings = 4.2 months of living costs', time: '2026-08', stageIds: [A_STAGE], x: 1160, y: 840, w: 230, h: 78, content: 'What lets me take my time looking.' });
  const g6 = N({ type: 'goal', title: 'Save six months of living costs', status: '进行中', time: '2025-09', stageIds: [A_STAGE], x: 1160, y: 970, w: 230, h: 78, content: 'A buffer I bought for myself.' });

  const g4 = N({ type: 'goal', title: 'Get fit enough to run a half marathon', status: '进行中', time: '2025-11', themeIds: [A_BODY], x: 1700, y: 150, w: 250, h: 88, content: 'Set after the health check. Not about how I look.' });
  const a2 = N({ type: 'action', title: 'Run 3 times a week', time: '2025-12', themeIds: [A_BODY], x: 1700, y: 290, w: 200, h: 78, content: 'Broke it twice. Starting over for the third time.' });
  const pc1 = N({ type: 'place', title: 'Shenzhen · Nanshan', time: '2026-06', themeIds: [A_BODY], x: 1700, y: 420, w: 200, h: 78, content: '1.5 hours of commuting every day. One of the things I have not solved.' });

  const g5 = N({ type: 'goal', title: 'Finish the book about tools', status: '探索中', time: '2026-05', themeIds: [A_MAKE], x: 1700, y: 720, w: 250, h: 88, content: '30,000 words in, stuck on the structure.' });
  const i2 = N({ type: 'idea', title: "A tool's value is in the steps it removes, not in its features", time: '2026-05', tags: ['Insight'], themeIds: [A_MAKE], x: 1700, y: 860, w: 250, h: 88, content: 'This idea first came out of that release tool.' });

  /* Nodes under nested themes (shows that focusing a parent theme includes its children) */
  const i3 = N({ type: 'idea', title: 'Rereading The Mythical Man-Month: the real problem in software is communication', time: '2026-09', tags: ['Insight'], themeIds: [tBooks.id, tRead.id, tLearn.id], x: 2150, y: 150, w: 250, h: 96, content: 'First read in my first year of work, when I only took away "adding people does not help". This time I read it as: why did Brooks give up on persuading managers thirty years ago? He was not writing for programmers — he was writing for their managers.' });
  const i4 = N({ type: 'idea', title: 'Is a 1.5-hour commute reading time or wasted time', time: '2026-06', themeIds: [tLife.id, tRead.id, tLearn.id], x: 2150, y: 290, w: 230, h: 88, content: 'The commute has three states: zoning out, scrolling, reading. The 20 minutes of reading are one of the few stretches of the week that belong entirely to me.' });
  const i5 = N({ type: 'idea', title: 'A book is not finished until you write down what you thought of it', time: '2026-07', themeIds: [tWrite.id, tLearn.id], x: 2150, y: 430, w: 230, h: 88, content: 'Writing it down forces you to organise your language, and organising your language forces you to think clearly.' });

  const E = (from: LifeNode, to: LifeNode, type: EdgeType, note?: string): LifeEdge => ({
    id: id('e'), kind: 'edge', spaceId: SAMPLE_SPACE_EN, fromId: from.id, fromKind: 'node',
    toId: to.id, toKind: 'node', type, note, createdAt: now, updatedAt: now,
  });

  const edges: LifeEdge[] = [
    E(g7, g3, 'replace', 'First adjustment: the title route does not work'),
    E(g3, g2, 'replace', 'Once it was clear: not the environment, the pace'),
    E(e3, g7, 'sequence'),
    E(e3, rf1, 'cause', 'The failed promotion is where the reflection came from'),
    E(rf1, g3, 'inspire'),
    E(rf1, w1, 'reference', 'Also the only thing that proved the ability'),
    E(p1, g7, 'block', 'Would not let anyone go — blocked things for half a year'),
    E(p3, g3, 'block', '"Wait a bit, you are not ready yet"'),
    E(w1, p1, 'support', 'Only possible because of the resources he gave me'),
    E(p2, e2, 'support', 'The referral'),
    E(e2, m2, 'cause'),
    E(m2, g3, 'cause', 'The confidence came with the offer'),
    E(g6, r1, 'cause', 'The savings are the result of this goal'),
    E(r1, e4, 'support', 'With savings I can afford to pick'),
    E(g1, g2, 'support', 'The long-term direction is the test for near-term decisions'),
    E(e1, m1, 'cause'),
    E(m1, i1, 'cause', 'The two empty weeks'),
    E(i1, g2, 'inspire', 'Nothing moves until it is clear'),
    E(e4, m3, 'cause'),
    E(a1, g2, 'support', 'Later I found the count was a way to avoid judgement'),
    E(g2, g3, 'replace'),
    E(g4, a2, 'cause', 'The goal is the reason for running, not the other way round'),
    E(a2, g4, 'sequence'),
    E(i2, g5, 'inspire'),
    E(w1, i2, 'inspire'),
    E(pc1, g2, 'block', 'The commute eats time that could go into the book'),
    E(r2, e4, 'support'),
    E(i3, i2, 'inspire', 'Rereading it changed what I thought a tool should have'),
    E(i4, i5, 'inspire', 'Commute = reading time → so write the notes on the commute'),
  ];

  const versions = [
    { nodeId: g7.id, title: undefined as string | undefined, reason: 'Initial goal', t: '2023-06-02', c: 'Set the goal: become a tech lead within two years.' },
    { nodeId: g7.id, title: undefined, reason: 'Downgraded after the year-end review', t: '2024-02-11', c: 'End-of-year review: I got the title, but leading people and projects clearly fell short.' },
    { nodeId: g7.id, title: undefined, reason: 'Replaced by "prove myself at a faster-moving company"', t: '2025-07-12', c: 'This goal was never delivered. What I really wanted was to be able to judge and drive a thing on my own.', s: '已取代' },
    { nodeId: g3.id, title: undefined, reason: 'Forced by the goal before it', t: '2025-07-12', c: 'Set the goal: prove myself at a faster-moving company.' },
    { nodeId: g3.id, title: undefined, reason: 'Slowed the pace to avoid quitting outright', t: '2025-11-03', c: 'Hesitation: go straight to a competitor, or look for something internal first?' },
    { nodeId: g3.id, title: undefined, reason: 'Replaced by "make one real transition in 2026"', t: '2026-04-18', c: 'Once it was clear: not the environment, the pace.', s: '已取代' },
    { nodeId: g2.id, title: undefined, reason: 'Reset after working out "not the environment, the pace"', t: '2026-04-18', c: 'New goal: make one real transition in 2026.' },
    { nodeId: g2.id, title: 'Milestone · switch to deep interviews', reason: 'Found myself using the count to avoid judgement', t: '2026-07-20', c: 'Downgraded "3 applications a week" — do one deep interview first, then decide the direction.' },
  ].map((v) => ({
    id: uid('v-'), nodeId: v.nodeId,
    snapshot: JSON.stringify({ status: v.s ?? null }),
    title: v.title, reason: v.reason,
    changedAt: new Date(v.t + 'T00:00:00').getTime(),
    changedFields: ['status'],
  }));

  return { themes, stages, nodes, edges, milestones: [], versions, customStatuses: [] };
}
