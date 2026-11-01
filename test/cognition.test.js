import test from 'node:test';
import assert from 'node:assert';

import {
  tokens,
  topKeywords,
  relevance,
  pickRelevantFacts,
  analyzeConversation,
  looksQuestion,
} from '../src/cognition.js';

test('tokens 过滤口水词，保留有信息量的二元组', () => {
  const t = tokens('今天原神抽卡，原神太好玩了');
  assert.ok(t.has('原神'));

  const empty = tokens('这个那个就是好的');
  assert.equal([...empty].some((w) => ['这个', '那个', '就是', '好的'].includes(w)), false);
});

test('topKeywords 抓重复出现的话题词', () => {
  const now = 1_000_000;
  const messages = [
    { text: '原神更新了', receivedAt: now - 120_000 },
    { text: '原神这次卡池不错', receivedAt: now - 60_000 },
    { text: '我今天吃了面', receivedAt: now - 30_000 },
  ];
  const keywords = topKeywords(messages, { now });
  assert.ok(keywords.includes('原神'), keywords.join(','));
  assert.equal(keywords.includes('吃面'), false);
});

test('relevance 衡量一句话贴不贴当前话题', () => {
  const keywords = ['原神', '抽卡', '卡池'];
  assert.ok(relevance('原神又抽卡了', keywords) > 0.6);
  assert.equal(relevance('今天要下雨', keywords), 0);
  assert.equal(relevance('随便说说', []), 0);
});

test('pickRelevantFacts 优先留下和当前对话相关的事实', () => {
  const facts = ['张三在准备考公', '李四的猫叫团子', '周五要交高数作业'];
  const picked = pickRelevantFacts(facts, '考公复习得怎么样了', 1);
  assert.deepEqual(picked, ['张三在准备考公']);
});

test('pickRelevantFacts 全都不相关时返回空，不硬塞旧记忆', () => {
  const facts = ['事实一的内容', '事实二的内容', '事实三的内容'];
  assert.deepEqual(pickRelevantFacts(facts, '完全无关的话', 2), []);
});

test('looksQuestion 判断问句', () => {
  assert.equal(looksQuestion('明天谁去'), true);
  assert.equal(looksQuestion('好的'), false);
  assert.equal(looksQuestion('啊'.repeat(200)), false);
});

test('analyzeConversation 发现没人接的问题', () => {
  const now = 2_000_000;
  const messages = [
    { userId: 'u1', nickname: '甲', text: '今天谁去食堂啊', isQuestion: true, receivedAt: now - 40_000 },
  ];
  const c = analyzeConversation({ messages, botId: 'bot', botAliases: ['小满'], now });
  assert.ok(c.openQuestion);
  assert.equal(c.openQuestion.from, '甲');
});

test('analyzeConversation 机器人回过就不算挂着', () => {
  const now = 2_000_000;
  const messages = [
    { userId: 'u1', nickname: '甲', text: '今天谁去食堂啊', isQuestion: true, receivedAt: now - 40_000 },
    { userId: 'bot', nickname: '小满', text: '我我我', receivedAt: now - 30_000 },
  ];
  const c = analyzeConversation({ messages, botId: 'bot', botAliases: ['小满'], now });
  assert.equal(c.openQuestion, null);
});

test('analyzeConversation 分得清在跟谁说话', () => {
  const now = 3_000_000;
  const toOther = analyzeConversation({
    messages: [{ userId: 'u1', nickname: '甲', text: '@张三 你去不去', receivedAt: now - 5_000 }],
    botId: 'bot',
    botAliases: ['小满'],
    now,
  });
  assert.equal(toOther.directedElsewhere, true);

  const toBot = analyzeConversation({
    messages: [{ userId: 'u1', nickname: '甲', text: '@小满 你去不去', receivedAt: now - 5_000 }],
    botId: 'bot',
    botAliases: ['小满'],
    now,
  });
  assert.equal(toBot.directedElsewhere, false);
});

test('analyzeConversation 统计同一个人连续发言', () => {
  const now = 4_000_000;
  const messages = [
    { userId: 'u1', nickname: '甲', text: '一', receivedAt: now - 30_000 },
    { userId: 'bot', nickname: '小满', text: '嗯', receivedAt: now - 20_000 },
    { userId: 'u1', nickname: '甲', text: '二', receivedAt: now - 10_000 },
    { userId: 'u1', nickname: '甲', text: '三', receivedAt: now - 5_000 },
  ];
  const c = analyzeConversation({ messages, botId: 'bot', botAliases: ['小满'], now });
  assert.equal(c.speakerStreak, 3);
});

test('analyzeConversation 没消息时不炸', () => {
  const c = analyzeConversation({ messages: [], now: 1, botId: 0 });
  assert.deepEqual(c.topics, []);
  assert.equal(c.openQuestion, null);
  assert.equal(c.directedElsewhere, false);
});

test('当前这句话不会把自己算成话题', () => {
  const now = 5_000_000;
  const c = analyzeConversation({
    messages: [{ userId: 'u1', nickname: '甲', text: '今天好热啊', receivedAt: now - 1_000 }],
    botId: 'bot',
    botAliases: ['小满'],
    now,
  });
  assert.deepEqual(c.topics, []);
});

