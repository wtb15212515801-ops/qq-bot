import test from 'node:test';
import assert from 'node:assert';
import { normalizeEvent, chatKey } from '../src/events.js';

const SELF = 123456789;

function raw(over = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 578710075,
    user_id: 20001,
    message_id: 1001,
    time: 1_700_000_000,
    sender: { user_id: 20001, nickname: '张三', card: '小张', role: 'member' },
    message: [{ type: 'text', data: { text: '在吗' } }],
    ...over,
  };
}

test('非消息事件返回 null', () => {
  assert.equal(normalizeEvent({ post_type: 'meta_event' }), null);
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent(undefined), null);
});

test('自己发的消息返回 null', () => {
  assert.equal(normalizeEvent(raw({ user_id: SELF }), { selfId: SELF }), null);
});

test('群会话键与私聊键', () => {
  assert.equal(chatKey(raw()), 'g578710075');
  assert.equal(chatKey(raw({ message_type: 'private', group_id: undefined })), 'p20001');
});

test('群名片优先于昵称，其次用 QQ 号', () => {
  const a = normalizeEvent(raw(), { selfId: SELF });
  assert.equal(a.event.nickname, '小张');

  const b = normalizeEvent(raw({ sender: { nickname: '张三' } }), { selfId: SELF });
  assert.equal(b.event.nickname, '张三');

  const c = normalizeEvent(raw({ sender: {} }), { selfId: SELF });
  assert.equal(c.event.nickname, '20001');
});

test('群事件与私聊事件标记正确', () => {
  const g = normalizeEvent(raw(), { selfId: SELF });
  assert.equal(g.isGroup, true);
  assert.equal(g.event.isPrivate, false);
  assert.equal(g.event.groupId, '578710075');

  const p = normalizeEvent(raw({ message_type: 'private', group_id: undefined }), { selfId: SELF });
  assert.equal(p.isGroup, false);
  assert.equal(p.event.isPrivate, true);
  assert.equal(p.event.groupId, null);
});

test('@ 自己会被标记', () => {
  const r = normalizeEvent(
    raw({ message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' 在吗' } }] }),
    { selfId: SELF, resolveName: () => '小满' }
  );
  assert.equal(r.event.atSelf, true);
  assert.match(r.event.text, /@小满/);
});

test('引用自己的消息时标记 replyToSelf', () => {
  const find = (id) => (String(id) === '900' ? { userId: String(SELF), text: '我说的' } : null);
  const r = normalizeEvent(raw({ message: [{ type: 'reply', data: { id: 900 } }, { type: 'text', data: { text: '对' } }] }), {
    selfId: SELF,
    findByMessageId: find,
  });
  assert.equal(r.event.replyToSelf, true);
  assert.equal(r.event.replyTo.text, '我说的');
});

test('引用别人的消息不算引用自己', () => {
  const find = () => ({ userId: '20002', text: '别人说的' });
  const r = normalizeEvent(raw({ message: [{ type: 'reply', data: { id: 901 } }] }), {
    selfId: SELF,
    findByMessageId: find,
  });
  assert.equal(r.event.replyToSelf, false);
});

test('引用的消息找不到时不报错', () => {
  const r = normalizeEvent(raw({ message: [{ type: 'reply', data: { id: 999 } }] }), {
    selfId: SELF,
    findByMessageId: () => null,
  });
  assert.equal(r.event.replyTo, null);
  assert.equal(r.event.replyToSelf, false);
});

test('问句会自动判定', () => {
  const q = normalizeEvent(raw({ message: [{ type: 'text', data: { text: '明天去哪' } }] }), { selfId: SELF });
  assert.equal(q.event.isQuestion, true);
  const s = normalizeEvent(raw({ message: [{ type: 'text', data: { text: '好的' } }] }), { selfId: SELF });
  assert.equal(s.event.isQuestion, false);
});

test('缺少时间时用当前时间兜底', () => {
  const now = 1_700_000_000_000;
  const r = normalizeEvent(raw({ time: 0 }), { selfId: SELF, now });
  assert.equal(r.event.time, now);
});

test('selfId 为 0 时不会把自己当成别人', () => {
  const r = normalizeEvent(raw({ user_id: 0 }), { selfId: 0 });
  assert.ok(r, 'selfId 未知时应该照常处理');
  assert.equal(r.event.selfId, 0);
});
