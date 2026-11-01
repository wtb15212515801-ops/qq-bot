/**
 * 大模型调用（OpenAI 兼容接口）。
 * DeepSeek / OpenAI / 通义 / 本地 vLLM / Ollama 都走这套。
 */

import { runTool } from './tools.js';

const MOCK_LINES = [
  '欧耶！要的',
  '欧漏……',
  '唔 不懂诶',
  '嗯 想趴在凉席上',
  '诶嘿',
  '香香的 好吃',
];

/** 这个错误值不值得再试一次 */
function retryable(e) {
  if (e?.retryable === true) return true;
  if (e?.name === 'TimeoutError') return true;
  if (e?.name === 'TypeError') return true; // fetch 连不上
  return /fetch failed|network|ECONN|socket hang up/i.test(String(e?.message || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LLM {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.mockCount = 0;
  }

  get isMock() {
    return this.cfg.provider === 'mock';
  }

  async chat({ system, user, temperature, maxTokens }) {
    if (this.isMock) return this._mock();

    const url = `${String(this.cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temperature ?? this.cfg.temperature ?? 1.0,
      max_tokens: maxTokens ?? this.cfg.maxTokens ?? 120,
      stream: false,
    };

    const timeout = this.cfg.timeoutMs ?? 30000;
    let lastErr;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
          err.retryable = res.status === 429 || res.status >= 500;
          throw err;
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          const err = new Error('LLM 返回空内容');
          err.retryable = true;
          throw err;
        }
        return String(content).trim();
      } catch (e) {
        lastErr = e;
        if (!retryable(e)) break;
        if (attempt === 0) await sleep(800);
      }
    }

    throw lastErr ?? new Error('LLM 调用失败');
  }


  async _rawChat({ messages, tools }) {
    const url = `${String(this.cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 1.0,
      max_tokens: this.cfg.maxTokens ?? 120,
      stream: false,
      // 反重复：不让它反复吐同一句
      frequency_penalty: this.cfg.frequencyPenalty ?? 0.6,
      presence_penalty: this.cfg.presencePenalty ?? 0.4,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
          // 429 / 5xx 值得重试一次，其它 4xx 直接失败
          err.retryable = res.status === 429 || res.status >= 500;
          throw err;
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (!retryable(e)) break;
        if (attempt === 0) await sleep(500);
      }
    }
    throw lastErr ?? new Error('LLM 调用失败');
  }

  async chatWithTools({ system, user, tools }) {
    if (this.isMock) return this._mock();
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    for (let round = 0; round < 4; round += 1) {
      const data = await this._rawChat({ messages, tools });
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error('LLM 返回空消息');
      const calls = msg.tool_calls ?? [];
      if (calls.length) {
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
        for (const call of calls) {
          const result = await runTool(call.function?.name, call.function?.arguments);
          this.log?.info(`[工具] ${call.function?.name}(${String(call.function?.arguments).slice(0, 80)}) → ${String(result).slice(0, 60)}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        continue;
      }
      return String(msg.content ?? '').trim();
    }
    const last = await this._rawChat({ messages });
    return String(last?.choices?.[0]?.message?.content ?? '').trim();
  }
  _mock() {
    // 交替返回短句和长句，用来测试拆分逻辑
    const line = MOCK_LINES[this.mockCount % MOCK_LINES.length];
    this.mockCount += 1;
    return this.mockCount % 4 === 0 ? `${line} 不过要稠稠的那种才好吃` : line;
  }
}
