import test from 'node:test';
import assert from 'node:assert';
import { LLM } from '../src/llm.js';

const cfg = {
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'k',
  model: 'm',
  timeoutMs: 1000,
  temperature: 1,
  maxTokens: 50,
};
const silent = { info() {}, warn() {}, debug() {}, error() {} };

function stub(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = orig;
  };
}

test('网络错误会重试一次', async () => {
  let calls = 0;
  const restore = stub(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '好耶' } }] }) };
  });
  try {
    const llm = new LLM(cfg, silent);
    const out = await llm.chat({ system: 's', user: 'u' });
    assert.equal(out, '好耶');
    assert.equal(calls, 2, '应该重试一次');
  } finally {
    restore();
  }
});

test('429 会重试，401 不重试', async () => {
  let calls = 0;
  let restore = stub(async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => 'slow down' };
  });
  try {
    const llm = new LLM(cfg, silent);
    await assert.rejects(() => llm.chat({ system: 's', user: 'u' }));
    assert.equal(calls, 2);
  } finally {
    restore();
  }

  calls = 0;
  restore = stub(async () => {
    calls += 1;
    return { ok: false, status: 401, text: async () => 'bad key' };
  });
  try {
    const llm = new LLM(cfg, silent);
    await assert.rejects(() => llm.chat({ system: 's', user: 'u' }), /401/);
    assert.equal(calls, 1, '4xx 不该重试');
  } finally {
    restore();
  }
});

test('空回复会重试', async () => {
  let calls = 0;
  const restore = stub(async () => {
    calls += 1;
    if (calls === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '有内容了' } }] }) };
  });
  try {
    const llm = new LLM(cfg, silent);
    assert.equal(await llm.chat({ system: 's', user: 'u' }), '有内容了');
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('mock 模式不联网', async () => {
  const restore = stub(async () => {
    throw new Error('不该发请求');
  });
  try {
    const llm = new LLM({ ...cfg, provider: 'mock' }, silent);
    const a = await llm.chat({ system: 's', user: 'u' });
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    const b = await llm.chatWithTools({ system: 's', user: 'u', tools: [] });
    assert.equal(typeof b, 'string');
  } finally {
    restore();
  }
});

test('工具调用会执行并把结果回灌给模型', async () => {
  let round = 0;
  const restore = stub(async (url, opt) => {
    round += 1;
    const body = JSON.parse(opt.body);
    if (round === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } },
                ],
              },
            },
          ],
        }),
      };
    }
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `结果是 ${toolMsg ? toolMsg.content : '没拿到'}` } }],
      }),
    };
  });
  try {
    const llm = new LLM(cfg, silent);
    const out = await llm.chatWithTools({ system: 's', user: 'u', tools: [{ type: 'function', function: { name: 'calculate' } }] });
    assert.match(out, /2/);
  } finally {
    restore();
  }
});
