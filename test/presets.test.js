import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { LEVELS, LEVEL_ORDER, normalizeLevel, applyLevel } from '../src/presets.js';
import { DEFAULTS } from '../src/config.js';

function withConfig(patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(patch, null, 2), 'utf8');
  const cfg = loadConfig(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return cfg;
}

test('四个档位的阈值递减', () => {
  const values = LEVEL_ORDER.map((k) => LEVELS[k].behavior.replyThreshold);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] < values[i - 1], `${LEVEL_ORDER[i]} 应该比上一档更容易接话`);
  }
});

test('四个档位的限流递增', () => {
  const values = LEVEL_ORDER.map((k) => LEVELS[k].limits.maxPerMinute);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `${LEVEL_ORDER[i]} 每分钟应该能多说`);
  }
});

test('只有冷淡档关闭主动发言', () => {
  for (const k of LEVEL_ORDER) {
    const enabled = (LEVELS[k].proactive || {}).enabled;
    if (k === 'quiet') assert.equal(enabled, false);
    else assert.notEqual(enabled, false, `${k} 不该关掉主动发言`);
  }
});

test('config 里指定档位会生效', () => {
  const cfg = withConfig({ behavior: { replyLevel: 'chatty' } });
  assert.equal(cfg.behavior.replyLevel, 'chatty');
  assert.equal(cfg.behavior.replyThreshold, LEVELS.chatty.behavior.replyThreshold);
  assert.equal(cfg.limits.maxPerMinute, LEVELS.chatty.limits.maxPerMinute);
});

test('非法档位回落到 normal', () => {
  assert.equal(normalizeLevel('不存在的'), 'normal');
  assert.equal(normalizeLevel(''), 'normal');
  assert.equal(normalizeLevel(null), 'normal');
  const cfg = withConfig({ behavior: { replyLevel: '乱写' } });
  assert.equal(cfg.behavior.replyLevel, 'normal');
});

test('冷淡档即使配置里不写 enabled 也不主动发言', () => {
  const cfg = withConfig({ behavior: { replyLevel: 'quiet' } });
  assert.equal(cfg.proactive.enabled, false);
});

test('config 里显式写的阈值优先于档位', () => {
  const cfg = withConfig({
    behavior: { replyLevel: 'quiet', replyThreshold: 3 },
  });
  assert.equal(cfg.behavior.replyThreshold, 3, '用户手写的值应该赢');
  assert.equal(cfg.behavior.replyLevel, 'quiet');
});

test('applyLevel 不改动原对象', () => {
  const before = JSON.parse(JSON.stringify(DEFAULTS));
  applyLevel(DEFAULTS, 'chatty');
  assert.deepEqual(DEFAULTS, before, 'DEFAULTS 被改脏了');
});

test('缺省配置默认是 normal', () => {
  const cfg = withConfig({});
  assert.equal(cfg.behavior.replyLevel, 'normal');
  assert.equal(cfg.behavior.replyThreshold, LEVELS.normal.behavior.replyThreshold);
});
