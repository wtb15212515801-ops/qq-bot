import test from 'node:test';
import assert from 'node:assert';
import { GroupState } from '../src/context.js';

test('lastSpokeAt 直接读写持久化记录', () => {
  const record = { lastSpokeAt: 123 };
  const s = new GroupState({ record });

  assert.equal(s.lastSpokeAt, 123);
  s.lastSpokeAt = 456;
  assert.equal(record.lastSpokeAt, 456, '写回记录，而不是只改内存副本');
});

test('重启后能从记录里恢复上次说话时间', () => {
  const record = { lastSpokeAt: 9_000_000 };
  const s = new GroupState({ record });
  assert.equal(s.lastSpokeAt, 9_000_000);
});

test('没有 record 时也不会崩', () => {
  const s = new GroupState();
  assert.equal(s.lastSpokeAt, 0);
  s.lastSpokeAt = 5;
  assert.equal(s.lastSpokeAt, 5);
});

test('消息超出上限会被裁剪，lastMessageAt 取最新', () => {
  const s = new GroupState({ maxMessages: 3, record: {} });
  for (let i = 0; i < 5; i += 1) {
    s.add({ id: i, userId: 'u1', nickname: '甲', receivedAt: 1000 + i });
  }
  assert.equal(s.messages.length, 3);
  assert.equal(s.lastMessageAt, 1004);
  assert.equal(s.nameOf('u1'), '甲');
});

test('findByMessageId 能找回被引用的消息', () => {
  const s = new GroupState({ record: {} });
  s.add({ id: 'm1', userId: 'u1', nickname: '甲', text: '早', receivedAt: 1 });
  assert.equal(s.findByMessageId('m1').text, '早');
  assert.equal(s.findByMessageId('nope'), null);
});
