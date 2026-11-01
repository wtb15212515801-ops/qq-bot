import test from 'node:test';
import assert from 'node:assert';
import { inQuietHours, checkInput, filterOutput, isOutputBlocked } from '../src/safety.js';

test('免打扰时段判断（跨零点）', () => {
  const q = ['23:30', '08:00'];
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  assert.equal(inQuietHours(at(23, 45), q), true);
  assert.equal(inQuietHours(at(3, 0), q), true);
  assert.equal(inQuietHours(at(7, 59), q), true);
  assert.equal(inQuietHours(at(8, 0), q), false);
  assert.equal(inQuietHours(at(12, 0), q), false);
});

test('同时段视为不启用', () => {
  assert.equal(inQuietHours(new Date(2026, 0, 1, 12, 0), ['08:00', '08:00']), false);
});

const cfg = (over = {}) => ({
  safety: {},
  behavior: { quietHours: ['00:00', '00:00'], privateReply: true, ...over },
});

const ev = (over = {}) => ({
  userId: '1',
  groupId: '100',
  text: '在吗',
  atSelf: false,
  ...over,
});

test('黑名单群被拦', () => {
  const c = cfg();
  c.safety.denyGroups = ['100'];
  assert.equal(checkInput({ event: ev(), cfg: c, now: Date.now() }), '群在黑名单');
});

test('白名单模式只放行名单内的群', () => {
  const c = cfg();
  c.safety.allowGroups = ['999'];
  assert.equal(checkInput({ event: ev(), cfg: c, now: Date.now() }), '群不在白名单');
  assert.equal(checkInput({ event: ev({ groupId: '999' }), cfg: c, now: Date.now() }), null);
});

test('空消息不处理', () => {
  assert.equal(checkInput({ event: ev({ text: '' }), cfg: cfg(), now: Date.now() }), '空消息');
});

test('私聊开关起作用', () => {
  const c = cfg({ privateReply: false });
  assert.equal(
    checkInput({ event: ev({ groupId: null }), cfg: c, now: Date.now() }),
    '私聊已关闭'
  );
});

test('filterOutput 去掉 AI 腔', () => {
  assert.equal(filterOutput('作为一个AI，我觉得今天很热', {}), '');
  assert.equal(filterOutput('希望对你有所帮助', {}), '');
  assert.equal(filterOutput('我是机器人', {}), '');
});

test('filterOutput 去掉名字前缀和标记符号', () => {
  assert.equal(filterOutput('小满：吃薯片啦', { botName: '小满' }), '吃薯片啦');
  assert.equal(filterOutput('**好耶**', { botName: '小满' }), '好耶');
});

test('isOutputBlocked 拦危险指令', () => {
  assert.equal(isOutputBlocked('运行 cmd.exe /c del /q', {}), true);
  assert.equal(isOutputBlocked('吃薯片啦', {}), false);
});
