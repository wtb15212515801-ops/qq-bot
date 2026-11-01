import fs from 'node:fs';
import path from 'node:path';
import { applyLevel, normalizeLevel, isLevel, LEVEL_ORDER } from './presets.js';

export const DEFAULTS = {
  onebot: {
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    selfId: 0,
    reconnectMs: 3000,
  },
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 1.0,
    maxTokens: 120,
    timeoutMs: 30000,
  },
  persona: {
    file: 'persona.md',
    name: '小满',
    aliases: [],
    interests: [],
  },
  behavior: {
    replyThreshold: 8.5,
    spontaneousChance: 0.015,
    spontaneousCooldownSec: 180,
    maxContextMessages: 25,
    contextMaxAgeMinutes: 180,
    expireSeconds: 45,
    quietHours: ['23:30', '08:00'],
    replyInQuietHoursWhenAt: false,
    privateReply: true,
  },
  timing: {
    scale: 1,
    readDelayMs: [600, 2500],
    typingMsPerChar: [220, 520],
    typingMaxMs: 8000,
    gapBetweenSegmentsMs: [500, 1500],
    maxSegments: 3,
    maxCharsPerSegment: 45,
  },
  limits: {
    minGapSeconds: 15,
    maxPerMinute: 3,
    maxPerHour: 12,
  },
  groups: {},
  memory: {
    enabled: true,
    summarizeEvery: 40,
    maxFacts: 12,
    forgetDays: 14,
    forgetEveryHours: 6,
    maxUsers: 200,
  },
  // 轻量理解层：话题跟踪、未接问题、说话对象。关掉就退回纯关键词决策。
  cognition: {
    enabled: true,
    windowMinutes: 6,
    topicCount: 5,
    factLimit: 6,
  },
  proactive: {
    enabled: true,
    checkEverySeconds: 60,
    idleMinutes: 45,
    minIntervalMinutes: 90,
    activeHours: ['09:00', '23:30'],
    chance: 0.4,
  },
  safety: {
    blockedWords: [],
    blockedUsers: [],
    allowGroups: [],
    denyGroups: [],
  },
  storage: { dir: 'data' },
  log: { level: 'info' },
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file = 'config.json') {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `找不到配置文件: ${abs}\n先执行：copy config.example.json config.json（Linux/macOS 用 cp）`
    );
  }

  let raw;
  try {
    const content = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''); // 兼容带 BOM 的文件
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${abs}\n${e.message}`);
  }

  // 先按「回应频度」档位铺一层默认值，再用 config.json 覆盖
  const rawLevel = raw?.behavior?.replyLevel;
  if (rawLevel && !isLevel(rawLevel)) {
    console.warn(
      `[配置] behavior.replyLevel「${rawLevel}」不认识，可选：${LEVEL_ORDER.join(' / ')}；已按 normal 处理`
    );
  }
  const level = normalizeLevel(rawLevel);
  const base = applyLevel(DEFAULTS, level);
  const cfg = deepMerge(base, raw);
  cfg.baseDir = path.dirname(abs);
  cfg.configFile = abs;
  cfg.behavior.replyLevel = level;

  if (!cfg.persona.aliases.length) cfg.persona.aliases = [cfg.persona.name];

  return cfg;
}

export function resolvePath(cfg, p) {
  return path.isAbsolute(p) ? p : path.resolve(cfg.baseDir, p);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.onebot?.url) errors.push('onebot.url 没填（NapCat 的 WebSocket 地址）');
  if (cfg.llm?.provider !== 'mock') {
    if (!cfg.llm?.baseUrl) errors.push('llm.baseUrl 没填');
    if (!cfg.llm?.apiKey) errors.push('llm.apiKey 没填（大模型 API Key）');
    if (!cfg.llm?.model) errors.push('llm.model 没填');
  }
  const t = cfg.timing || {};
  if (!Array.isArray(t.readDelayMs) || t.readDelayMs.length !== 2) {
    errors.push('timing.readDelayMs 必须是 [最小毫秒, 最大毫秒]');
  }

  const lv = cfg.behavior?.replyLevel;
  if (lv && !isLevel(lv)) {
    errors.push(`behavior.replyLevel 只能是 ${LEVEL_ORDER.join(' / ')}，现在是「${lv}」`);
  }

  return errors;
}
