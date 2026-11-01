/**
 * 通知事件：入群、退群、撤回、戳一戳。
 *
 * 从 pipeline.js 抽出来，只依赖传进来的 pipeline 实例（pl）。
 * 这些事件不是聊天消息，但处理好了会很像一个真人在群里。
 */

function cooldown(pl, tag, ms) {
  const now = Date.now();
  const last = pl.noticeAt.get(tag) || 0;
  if (now - last < ms) return false;
  pl.noticeAt.set(tag, now);
  return true;
}

export async function handleNotice(pl, raw) {
  if (!raw || raw.post_type !== 'notice') return;

  const n = pl.cfg.notices || {};
  const groupId = raw.group_id ? String(raw.group_id) : null;
  const key = groupId ? `g${groupId}` : `p${raw.user_id}`;

  try {
    // 有人撤回：从上下文里删掉，不然它会对着空气接话
    if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
      if (n.recallCleanup === false) return;
      forgetMessage(pl, key, raw.message_id);
      return;
    }

    if (raw.notice_type === 'group_increase') {
      if (n.welcome === false || !groupId) return;
      await welcome(pl, raw, key, groupId);
      return;
    }

    if (raw.notice_type === 'group_decrease') {
      if (n.farewell === false || !groupId) return;
      await farewell(pl, raw, key, groupId);
      return;
    }

    if (raw.notice_type === 'notify' && raw.sub_type === 'poke') {
      if (n.poke === false) return;
      await onPoke(pl, raw, groupId);
    }
  } catch (e) {
    pl.log.warn(`通知事件处理失败：${e.message}`);
  }
}

/** 把某条消息从上下文里移除（撤回时用） */
export function forgetMessage(pl, key, messageId) {
  if (messageId == null) return false;
  const state = pl.states.get(key);
  if (!state) return false;
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => String(m.id) !== String(messageId));
  const removed = before - state.messages.length;
  if (removed) pl.log.debug(`撤回：从上下文移除 ${removed} 条`);
  return removed > 0;
}

function chatName(pl, groupId) {
  const g = pl.cfg.groups?.[groupId];
  return g?.name ? `群 · ${g.name}` : `群 · ${groupId}`;
}

/** 入群欢迎：同群 30 秒内只欢迎一次，防止批量进群刷屏 */
async function welcome(pl, raw, key, groupId) {
  if (!cooldown(pl, `welcome:${groupId}`, 30_000)) return;

  const qq = String(raw.user_id);
  let name = qq;
  try {
    const info = await pl.client.call('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(raw.user_id),
    });
    if (info?.card || info?.nickname) name = info.card || info.nickname;
  } catch {
    /* 拿不到就用 QQ 号 */
  }

  const lines = [`欢迎${name}！`, `欢迎 ${name} 来玩呀`, '来新人啦，欢迎欢迎', '欢迎欢迎，随便坐'];
  const text = lines[Math.floor(Math.random() * lines.length)];

  await pl.client.sendGroupSegments(groupId, [
    { type: 'at', data: { qq } },
    { type: 'text', data: { text: ' ' + text } },
  ]);

  pl.log.info(`入群欢迎：${name}（群 ${groupId}）`);
  pl.ui?.emit({
    chatId: key,
    chatName: chatName(pl, groupId),
    kind: 'out',
    who: pl.persona.name,
    text: `[欢迎] ${text}`,
  });
}

/** 有人退群：轻描淡写说一句，不追问 */
async function farewell(pl, raw, key, groupId) {
  if (!cooldown(pl, `bye:${groupId}`, 60_000)) return;

  const text = raw.sub_type === 'kick' ? '唔…有人被踢出去了' : '诶 走了一个人';
  await pl.client.sendGroupMsg(groupId, text);

  pl.log.info(`退群提示（${raw.sub_type}）：群 ${groupId}`);
  pl.ui?.emit({
    chatId: key,
    chatName: chatName(pl, groupId),
    kind: 'out',
    who: pl.persona.name,
    text,
  });
}

/** 被戳：戳回去，协议端不支持就退化成文字 */
async function onPoke(pl, raw, groupId) {
  const target = raw.target_id != null ? String(raw.target_id) : '';
  if (target !== String(pl.selfId)) return; // 不是戳我
  if (!cooldown(pl, `poke:${groupId || raw.user_id}`, 20_000)) return;

  try {
    await pl.client.call('send_poke', {
      user_id: Number(raw.user_id),
      ...(groupId ? { group_id: Number(groupId) } : {}),
    });
    pl.log.info(`被戳回去：${raw.user_id}`);
  } catch {
    try {
      if (groupId) await pl.client.sendGroupMsg(groupId, '戳我干嘛');
      else await pl.client.sendPrivateMsg(String(raw.user_id), '唔…你戳我');
    } catch {
      /* 连文字都发不出去就算了 */
    }
  }
}
