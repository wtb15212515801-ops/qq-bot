/**
 * 事件归一化：把 OneBot 的原始事件变成内部统一的 event 对象。
 *
 * 单独抽出来是为了能脱离 Pipeline（不需要网络、模型、存储）直接测。
 */

import { flattenSegments } from './message.js';
import { isQuestion } from './decision.js';

/** 会话键：群 g<群号>，私聊 p<QQ号> */
export function chatKey(raw) {
  return raw?.message_type === 'group' ? `g${raw.group_id}` : `p${raw?.user_id}`;
}

/**
 * @returns {null | { isGroup:boolean, key:string, event:object, flat:object }}
 *   null 表示这条事件不该处理（不是消息 / 是自己发的）
 */
export function normalizeEvent(raw, { selfId = 0, now = Date.now(), resolveName, findByMessageId } = {}) {
  if (!raw || raw.post_type !== 'message') return null;

  const self = Number(selfId) || 0;
  if (self && Number(raw.user_id) === self) return null; // 自己发的不重复处理

  const isGroup = raw.message_type === 'group';
  const flat = flattenSegments(raw.message, { selfId: self, resolveName });
  const sender = raw.sender ?? {};

  const event = {
    id: raw.message_id,
    groupId: isGroup ? String(raw.group_id) : null,
    userId: String(raw.user_id),
    nickname: sender.card || sender.nickname || String(raw.user_id),
    role: sender.role || 'member',
    time: (Number(raw.time) || Math.floor(now / 1000)) * 1000,
    receivedAt: now,
    text: flat.text,
    atSelf: flat.atSelf,
    replyToSelf: false,
    replyTo: null,
    isQuestion: isQuestion(flat.text),
    isPrivate: !isGroup,
    selfId: self,
  };

  if (flat.replyId && typeof findByMessageId === 'function') {
    const target = findByMessageId(flat.replyId);
    if (target) {
      event.replyTo = { userId: target.userId, text: target.text };
      event.replyToSelf = String(target.userId) === String(self);
    }
  }

  return { isGroup, key: chatKey(raw), event, flat };
}
