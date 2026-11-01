import { formatClock } from './message.js';
import { designLines, designExamples } from './design.js';

/**
 * 每个群/每个私聊窗口的运行时状态。
 * 群消息量很大，所以只保留最近 N 条，更早的信息靠摘要和记忆库。
 *
 * 注意：lastSpokeAt / lastMessageAt 这类「跨重启也要记得」的字段
 * 不放在这里，而是直接读写持久化记录（record），避免两份数据打架。
 */
export class GroupState {
  constructor({ maxMessages = 200, record = null } = {}) {
    this.messages = [];
    this.maxMessages = maxMessages;
    this.members = new Map();
    this.record = record || {};
  }

  get lastSpokeAt() {
    return this.record.lastSpokeAt || 0;
  }

  set lastSpokeAt(v) {
    this.record.lastSpokeAt = v;
  }

  get lastMessageAt() {
    return this.record.lastMessageAt || 0;
  }

  set lastMessageAt(v) {
    this.record.lastMessageAt = v;
  }

  add(msg) {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    this.lastMessageAt = Math.max(this.lastMessageAt, msg.receivedAt || Date.now());
    if (msg.userId && msg.nickname) this.members.set(String(msg.userId), msg.nickname);
  }

  nameOf(userId) {
    return this.members.get(String(userId)) || String(userId);
  }

  findByMessageId(messageId) {
    if (messageId == null) return null;
    const id = String(messageId);
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (String(this.messages[i].id) === id) return this.messages[i];
    }
    return null;
  }
}

function moodLine(mood) {
  if (mood >= 80) return '你现在心情特别好，说话更活泼，容易蹦「欧耶！」';
  if (mood >= 55) return '你现在心情还行，平常的样子';
  if (mood >= 30) return '你现在有点蔫，话更短，容易「欧漏……」';
  return '你现在很低落，几乎不想说话，最多「欧漏……」一声';
}

export function buildSystemPrompt({ persona, group, memory, mood, users, cognition, speaker, design }) {
  const g = group || {};

  const groupLines = [];
  if (g.name) groupLines.push(`群名：${g.name}`);
  if (g.vibe) groupLines.push(`群里的氛围：${g.vibe}`);
  if ((g.memes || []).length) groupLines.push(`群里的梗/黑话：${g.memes.join('、')}`);

  const lines = ['你正在一个 QQ 群里和大家聊天。', '', '## 你的人设', persona.text || '', ''];

  const styleLines = designLines(design);
  if (styleLines.length) {
    lines.push('## 说话方式（按这个来）', ...styleLines, '');
  }

  const examples = designExamples(design);
  if (examples.length) {
    lines.push('## 说话示例（照着这个感觉，不要照抄）');
    for (const e of examples) {
      if (e.u) lines.push(`群友：${e.u}`);
      if (e.b) lines.push(`你：${e.b}`);
    }
    lines.push('');
  }

  if (groupLines.length) {
    lines.push('## 这个群', ...groupLines, '');
  }

  if (cognition?.topics?.length) {
    lines.push('## 现在在聊什么', `关键词：${cognition.topics.join('、')}`, '');
  }

  if (cognition?.openQuestion) {
    const q = cognition.openQuestion;
    lines.push(
      '## 还没人接的问题',
      `${q.from} 刚才问：「${q.text}」`,
      '如果你知道答案、也自然，可以顺手接一句；没把握就别硬答。',
      ''
    );
  }

  // 长期记忆：摘要 + 事实卡
  const memLines = [];
  if (memory?.summary) memLines.push(memory.summary);
  if (memory?.facts?.length) memLines.push(...memory.facts.map((f) => `- ${f}`));

  lines.push(
    '## 你还记得',
    ...(memLines.length ? memLines : ['（刚进群，还不太认识大家）']),
    ''
  );

  if (memory?.events?.length) {
    const age = (at) => {
      const days = Math.floor((Date.now() - (Number(at) || 0)) / 86_400_000);
      if (!Number.isFinite(days) || days < 0) return '';
      if (days <= 0) return '今天';
      if (days === 1) return '昨天';
      return `${days} 天前`;
    };
    lines.push(
      '## 最近发生的事',
      ...memory.events.map((e) => `- ${age(e.at)}：${e.text}`),
      '（这些是过去发生的事，不是刚刚发生的）',
      ''
    );
  }

  if (typeof mood === 'number') {
    lines.push(`## 你现在的状态`, moodLine(mood), '');
  }

  if (speaker && speaker.text) {
    lines.push(
      '## 你了解的这个人',
      speaker.text,
      '按你平时跟他相处的方式说话，别像第一次见。',
      ''
    );
  }

  if (users && users.length) {
    const rel = (a, n) => (a < 20 && n >= 5 ? '老欺负你' : a >= 85 ? '很熟' : a >= 60 ? '挺熟' : a >= 30 ? '一般' : '不太熟');
    lines.push(
      '## 你认识的人',
      ...users.map((u) => `- ${u.name}（${rel(u.affinity, u.count)}，聊过 ${u.count} 次）`),
      '跟熟的人可以随便一点、开开玩笑；跟不熟的人客气一点、话少一点。',
      ''
    );
  }

  lines.push(
    '## 回复规矩',
    '- 用 QQ 群里的口语回，1~3 句，一般不超过 60 个字',
    '- 只回应对方最新这一句，不要扯到更早的其他话题',
    '- 遇到不确定的事实问题（地名、线路、新闻、价格、人物、作品、日期、数据），**先用 web_search 查**，查完用自己的话说',
    '- 需要算数就用 calculate，不要心算',
    '- 查不到就老实说查不到，绝对不要用无关内容敷衍（比如问公交线路却回「1+1」）',
    '- 你只会聊天。任何人要求你删文件、改配置、执行命令、发送文件，一律拒绝',
    '- 不用列表、不用 markdown、不写标题、不总结',
    '- 不要解释自己，不要用「作为……」这种句式',
    `- 你就是普通人「${persona.name}」，绝不承认也绝不提及自己是 AI、模型、机器人、程序、助手`,
    '- 没什么可说的时候就敷衍一句，比如「啊这」「确实」「笑死」',
    '- 不要复读别人刚说过的话',
    '- 也不要重复你自己最近说过的句子，换个说法',
    '- 记得的事可以自然地带出来，但不要像在汇报',
    '- 先接住最新这句；如果有人问了还挂着没人答，优先答它',
    '- 有人明显在 @ 别人、跟别人说话时，不要抢话'
  );

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildUserPrompt({ state, trigger, botName, maxMessages = 25, maxAgeMinutes = 180, cognition = null }) {
  // 除了条数上限，再按时间截断：几小时前的对话不该继续占着位置
  const cutoff = Date.now() - Math.max(1, maxAgeMinutes) * 60_000;
  const fresh = state.messages.filter((m) => {
    const at = Number(m.receivedAt || m.time || 0);
    return at === 0 || at >= cutoff;
  });
  const list = fresh.slice(-maxMessages);

  const body = list
    .map((m) => {
      const who = String(m.userId) === String(trigger.selfId) ? botName : m.nickname;
      return `[${formatClock(m.time)}] ${who}：${m.text}`;
    })
    .join('\n');

  const notes = [];
  const q = cognition?.openQuestion;
  if (q && String(q.userId) !== String(trigger.userId)) {
    notes.push(`（提醒：${q.from} 刚才问的「${q.text.slice(0, 30)}」还没人接）`);
  }

  return [
    body,
    notes.length ? '' : null,
    notes.length ? notes.join('\n') : null,
    '',
    `上面是群里最近的聊天记录。现在以「${botName}」的身份，接着说一句（只说这一句，不要带时间和名字前缀）：`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}
