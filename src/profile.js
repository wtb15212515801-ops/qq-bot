/**
 * 每个人的「画像」：一个很小的在线学习器，不依赖任何库。
 *
 * 三件事：
 * 1. 说话风格（长度、表情、笑、问句）——指数滑动平均
 * 2. 最近在聊什么——带时间衰减的词权重（越久没提权重越低）
 * 3. 什么回复他会接——5 维逻辑回归，用「回完 90 秒内他有没有继续说话」当标签，在线 SGD
 *
 * 全部是可解释的小数字，存进 memory.json 的 users[id].profile 里。
 */

import { tokens as sharedTokens, similar as sharedSimilar } from './text.js';

const HALF_LIFE = 14 * 86_400_000;
const ALPHA = 0.12;
const LR = 0.15;

const LAUGH = /哈{2,}|笑死|笑嘻|233|hhh|草/u;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;
const LIKE = /我(?:最|很|超|特别|真的)?(喜欢|爱|讨厌|不喜欢|怕|害怕|想)([^，。！？,.!?\s]{1,12})/u;

/** 默认画像 */
export function emptyProfile() {
  return {
    v: 1,
    style: { len: 12, short: 0.4, laugh: 0.1, emoji: 0.15, question: 0.2 },
    kw: {},
    kwAt: 0,
    notes: [],
    model: { w: [0, 0, 0, 0, 0], n: 0 },
    updatedAt: 0,
  };
}

export function profileOf(user) {
  if (!user) return emptyProfile();
  if (!user.profile || user.profile.v !== 1) user.profile = emptyProfile();
  return user.profile;
}

function decayKeywords(profile, now) {
  const at = profile.kwAt || now;
  const age = Math.max(0, now - at);
  if (age < 60_000) return;
  const k = Math.pow(0.5, age / HALF_LIFE);
  for (const key of Object.keys(profile.kw)) {
    const next = profile.kw[key] * k;
    if (next < 0.08) delete profile.kw[key];
    else profile.kw[key] = next;
  }
  profile.kwAt = now;
}

function tokens(text) {
  return sharedTokens(text);
}

function similar(a, b) {
  return sharedSimilar(a, b);
}

/** 从「我喜欢喝美式」这类句子里抽一条关于这个人的笔记 */
export function notesFrom(text) {
  const m = LIKE.exec(String(text || ''));
  if (!m) return [];
  const verb = m[1];
  const obj = m[2].trim();
  if (!obj) return [];
  const like = verb === '喜欢' || verb === '爱' || verb === '想';
  return [{ kind: like ? 'like' : 'dislike', text: `${like ? '喜欢' : '不喜欢'}${obj}` }];
}

/** 每条消息更新一次画像（O(词数)，不调模型） */
export function observe(profile, { text = '', isQuestion = false, now = Date.now() } = {}) {
  const chars = String(text || '').length;
  const s = profile.style;

  s.len = s.len * (1 - ALPHA) + chars * ALPHA;
  s.short = s.short * (1 - ALPHA) + (chars <= 8 ? 1 : 0) * ALPHA;
  s.laugh = s.laugh * (1 - ALPHA) + (LAUGH.test(text) ? 1 : 0) * ALPHA;
  s.emoji = s.emoji * (1 - ALPHA) + (EMOJI.test(text) ? 1 : 0) * ALPHA;
  s.question = s.question * (1 - ALPHA) + (isQuestion ? 1 : 0) * ALPHA;

  decayKeywords(profile, now);
  for (const token of tokens(text)) {
    profile.kw[token] = Math.min(6, (profile.kw[token] || 0) + 1);
  }
  profile.kwAt = now;
  profile.updatedAt = now;

  for (const note of notesFrom(text)) {
    if (profile.notes.some((n) => similar(n.text, note.text))) continue;
    profile.notes.push({ ...note, at: now });
    if (profile.notes.length > 8) profile.notes = profile.notes.slice(-8);
  }

  return profile;
}

/** 最近常说的词，按权重排序 */
export function topKeywords(profile, limit = 4) {
  return Object.entries(profile.kw || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/** 特征：偏置 / 句子短 / 是问句 / 带笑 / 熟悉度 */
function features({ profile, affinity = 30, isQuestion = false, text = '' }) {
  return [
    1,
    profile.style.short,
    isQuestion ? 1 : 0,
    LAUGH.test(text) ? 1 : 0,
    Math.max(0, Math.min(1, (affinity || 30) / 100)),
  ];
}

/** 预测「回完这句，他还会不会接着说」 */
export function predictEngage(profile, input) {
  const w = profile.model.w;
  const x = features({ profile, ...input });
  let z = 0;
  for (let i = 0; i < w.length; i += 1) z += w[i] * x[i];
  return sigmoid(z);
}

/** 在线 SGD：label=1 表示他接着说了，0 表示没接 */
export function learn(profile, input, label) {
  const p = predictEngage(profile, input);
  const x = features({ profile, ...input });
  const w = profile.model.w;
  for (let i = 0; i < w.length; i += 1) {
    w[i] = Math.max(-3, Math.min(3, w[i] + LR * (label - p) * x[i]));
  }
  profile.model.n += 1;
  return p;
}

/** 给 prompt 用的一段话：这个人是什么样、最近在聊什么、他说什么话 */
export function describe(profile, { name = '', count = 0, affinity = 30 } = {}) {
  if (!profile || !profile.model) return '';
  const s = profile.style;
  const bits = [];
  if (s.short > 0.55 || s.len < 10) bits.push('说话很短，经常一句话就完事');
  else if (s.len > 30) bits.push('说话偏长，愿意展开讲');
  if (s.laugh > 0.25) bits.push('爱用「哈哈」「笑死」');
  if (s.emoji > 0.2) bits.push('爱发表情/emoji');
  if (s.question > 0.35) bits.push('经常提问');
  if (affinity < 20 && count >= 5) bits.push('对你有点冲');

  const kw = topKeywords(profile, 4);
  const notes = profile.notes.slice(-3).map((n) => n.text);

  const lines = [];
  if (name) lines.push(`- ${name}（聊过 ${count} 次）`);
  if (bits.length) lines.push(`- 说话习惯：${bits.join('；')}`);
  if (kw.length) lines.push(`- 最近常提：${kw.join('、')}`);
  if (notes.length) lines.push(`- 你记得他说过：${notes.join('；')}`);
  return lines.join('\n');
}
