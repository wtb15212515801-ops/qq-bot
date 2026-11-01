/**
 * 安全 / 风控过滤。
 * 封号的主因通常不是「协议不对」，而是「内容违规」和「行为异常」。
 */

function parseClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function inQuietHours(date, quietHours) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const from = parseClock(quietHours[0]);
  const to = parseClock(quietHours[1]);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function checkInput({ event, cfg, now = Date.now() }) {
  const safety = cfg.safety || {};

  // 有的调用方只给 groupId，没给 isPrivate，这里兜一下
  const isPrivate = event.isPrivate ?? !event.groupId;
  if (isPrivate && cfg.behavior.privateReply === false) return '私聊已关闭';

  const groupId = event.groupId ? String(event.groupId) : null;

  if (groupId && (safety.denyGroups || []).map(String).includes(groupId)) {
    return '群在黑名单';
  }
  if (
    groupId &&
    (safety.allowGroups || []).length > 0 &&
    !safety.allowGroups.map(String).includes(groupId)
  ) {
    return '群不在白名单';
  }

  if ((safety.blockedUsers || []).map(String).includes(String(event.userId))) {
    return '用户在黑名单';
  }

  if (!event.text) return '空消息';

  const quiet = inQuietHours(new Date(now), cfg.behavior.quietHours);
  if (quiet) {
    const allowed = cfg.behavior.replyInQuietHoursWhenAt && (event.atSelf || !event.groupId);
    if (!allowed) return '免打扰时段';
  }

  for (const word of safety.blockedWords || []) {
    if (word && event.text.includes(word)) return `命中屏蔽词:${word}`;
  }

  return null;
}

const AI_TELLS = [
  /作为(一个)?(AI|人工智能|语言模型|助手|机器人)/u,
  /我(只|就|可)?是(一个)?(AI|人工智能|语言模型|程序|机器人)/u,
  /(很|非常)?(高兴|荣幸)(能)?(为你|为您)(提供)?(帮助|服务)/u,
  /希望(对你|对您)(有所|有)?帮助/u,
  /我(无法|不能)(回答|提供|满足)/u,
  /(让我|我来)(帮|为)你/u,
];

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 输出侧兜底：模型万一真的吐出了屏蔽词，这条就不发了 */
export function isOutputBlocked(text, cfg) {
  const words = cfg?.safety?.blockedWords || [];
  if (words.some((w) => w && text.includes(w))) return true;

  // 不允许它输出可执行的危险指令
  const DANGEROUS =
    /(cmd\.exe|powershell|reg\s+add|regedit|format\s+[a-z]:|del\s+\/|rd\s+\/s|shutdown\s+\/|taskkill\s+\/)/i;
  return DANGEROUS.test(text);
}

export function filterOutput(text, { botName = '' } = {}) {
  let out = String(text ?? '')
    .replace(/^["'「『]+|["'」』]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 去掉模型可能自带的「小满：」前缀
  if (botName) {
    out = out.replace(new RegExp(`^${escapeRegExp(botName)}\\s*[：:]\\s*`), '');
  }

  out = out.replace(/[*_`#>]/g, '').trim();

  // 出现「AI 腔」就整条丢掉，不要把残句发出去
  if (!out) return '';
  for (const re of AI_TELLS) {
    re.lastIndex = 0;
    if (re.test(out)) return '';
  }

  // 去掉开场废话和首尾标点
  out = out
    .replace(/^(好的|当然|没问题)[，,。!！\s]*/u, '')
    .replace(/^[，,。.!！?？、；;：:\s]+/u, '')
    .replace(/[，,、；;：:\s]+$/u, '')
    .trim();

  if (out.length > 120) out = out.slice(0, 120).trim();

  return out;
}
