import test from 'node:test';
import assert from 'node:assert';
import { inActiveHours, runMaintenance, runConsolidate } from '../src/tasks.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const HOUR = 3600 * 1000;

function fakePipeline(over = {}) {
  const pl = {
    cfg: { proactive: { activeHours: ['09:00', '23:30'] }, memory: {} },
    brain: {
      forget: () => ({ facts: 0, users: 0, summaries: 0 }),
      tidy: () => ({ junk: 0, dup: 0, trimmed: 0, groups: 0 }),
      consolidate: async () => true,
    },
    states: new Map(),
    lastJudgeAt: new Map(),
    limiter: { prune: () => 0 },
    privateLimiter: { prune: () => 0 },
    store: { save() {}, dirty() {}, data: { groups: {} }, group: () => ({}) },
    log: silent,
    ...over,
  };
  return pl;
}

const at = (h, m) => new Date(2026, 0, 1, h, m).getTime();

test('白天时段判断', () => {
  const pl = fakePipeline();
  assert.equal(inActiveHours(pl, at(10, 0)), true);
  assert.equal(inActiveHours(pl, at(9, 0)), true);
  assert.equal(inActiveHours(pl, at(8, 59)), false);
  assert.equal(inActiveHours(pl, at(23, 30)), false);
});

test('跨零点时段判断', () => {
  const pl = fakePipeline();
  pl.cfg.proactive.activeHours = ['23:30', '08:00'];
  assert.equal(inActiveHours(pl, at(23, 45)), true);
  assert.equal(inActiveHours(pl, at(3, 0)), true);
  assert.equal(inActiveHours(pl, at(7, 59)), true);
  assert.equal(inActiveHours(pl, at(8, 0)), false);
  assert.equal(inActiveHours(pl, at(12, 0)), false);
});

test('维护会清掉长时间没动静的会话', () => {
  const now = at(12, 0);
  const pl = fakePipeline();
  pl.states.set('g1', { lastMessageAt: now - 7 * HOUR });
  pl.states.set('g2', { lastMessageAt: now - 1 * HOUR });

  runMaintenance(pl, now);
  assert.equal(pl.states.has('g1'), false, '超过 6 小时应该被清掉');
  assert.equal(pl.states.has('g2'), true);
});

test('维护会把会话数压到 60 以内', () => {
  const now = at(12, 0);
  const pl = fakePipeline();
  for (let i = 0; i < 80; i += 1) {
    pl.states.set('g' + i, { lastMessageAt: now - 1000 + i });
  }
  runMaintenance(pl, now);
  assert.equal(pl.states.size, 60);
  assert.equal(pl.states.has('g0'), false, '最久没动静的先走');
  assert.equal(pl.states.has('g79'), true, '最新的留下');
});

test('维护会清掉过期的判定缓存', () => {
  const now = at(12, 0);
  const pl = fakePipeline();
  pl.lastJudgeAt.set('g1', now - 7 * HOUR);
  pl.lastJudgeAt.set('g2', now - 1000);

  runMaintenance(pl, now);
  assert.equal(pl.lastJudgeAt.has('g1'), false);
  assert.equal(pl.lastJudgeAt.has('g2'), true);
});

test('维护会调用限流器的清理', () => {
  const now = at(12, 0);
  let called = 0;
  const pl = fakePipeline();
  pl.limiter = { prune: () => { called += 1; return 0; } };
  pl.privateLimiter = { prune: () => { called += 1; return 0; } };

  runMaintenance(pl, now);
  assert.equal(called, 2);
});

test('维护失败不抛错（brain 炸了也照常跑）', () => {
  const pl = fakePipeline({
    brain: {
      forget() { throw new Error('坏掉了'); },
      tidy() { return { junk: 0, dup: 0, trimmed: 0, groups: 0 }; },
    },
  });
  assert.doesNotThrow(() => runMaintenance(pl, at(12, 0)));
});

test('压缩只挑事实够多且够久没压过的群', async () => {
  const now = Date.now();
  const pl = fakePipeline();
  pl.store.data.groups = {
    g1: { facts: [1, 2, 3, 4, 5], consolidatedAt: 0 },
    g2: { facts: [1, 2], consolidatedAt: 0 },
    g3: { facts: [1, 2, 3, 4, 5], consolidatedAt: now - 1000 },
  };
  const n = await runConsolidate(pl, 3);
  assert.equal(n, 1, '只有 g1 符合条件');
  assert.ok(pl.store.data.groups.g1.consolidatedAt > 0);
});

test('压缩失败不影响其它群', async () => {
  const pl = fakePipeline({
    brain: {
      async consolidate(key) {
        if (key === 'g1') throw new Error('模型挂了');
        return true;
      },
    },
  });
  pl.store.data.groups = {
    g1: { facts: [1, 2, 3, 4, 5], consolidatedAt: 0 },
    g2: { facts: [1, 2, 3, 4, 5], consolidatedAt: 0 },
  };
  const n = await runConsolidate(pl, 3);
  assert.equal(n, 2);
});
