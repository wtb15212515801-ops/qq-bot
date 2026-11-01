/**
 * 回应频度档位。
 *
 * 原来「回不回」由一堆散参数决定（阈值、随机插话概率、限流、主动发言），
 * 想调活泼一点要同时改五六个地方，很容易调歪。
 * 现在收敛成四档，一个开关控制整套节奏。
 */

export const LEVELS = {
  quiet: {
    label: '冷淡',
    desc: '只接点名和明确的问话，基本不主动',
    behavior: {
      replyThreshold: 10.0,
      spontaneousChance: 0.01,
      spontaneousCooldownSec: 600,
      weakJudgeSeconds: 0,
      weakJudgeSample: 0.05,
    },
    limits: { minGapSeconds: 120, maxPerMinute: 1, maxPerHour: 5, privateMaxPerHour: 40 },
    proactive: { enabled: false },
  },
  normal: {
    label: '正常',
    desc: '该接的时候接，偶尔自己插一句',
    behavior: {
      replyThreshold: 4.5,
      spontaneousChance: 0.08,
      spontaneousCooldownSec: 180,
      weakJudgeSeconds: 180,
      weakJudgeSample: 0.18,
    },
    limits: { minGapSeconds: 5, maxPerMinute: 6, maxPerHour: 20, privateMaxPerHour: 120 },
    proactive: { enabled: true },
  },
  active: {
    label: '活跃',
    desc: '话多一点，接话更积极',
    behavior: {
      replyThreshold: 2.0,
      spontaneousChance: 0.22,
      spontaneousCooldownSec: 120,
      weakJudgeSeconds: 300,
      weakJudgeSample: 0.45,
    },
    limits: { minGapSeconds: 3, maxPerMinute: 8, maxPerHour: 35, privateMaxPerHour: 200 },
    proactive: { enabled: true },
  },
  chatty: {
    label: '话痨',
    desc: '几乎有问必答，冷场也自己找话题',
    behavior: {
      replyThreshold: 0.6,
      spontaneousChance: 0.45,
      spontaneousCooldownSec: 60,
      weakJudgeSeconds: 600,
      weakJudgeSample: 0.8,
    },
    limits: { minGapSeconds: 2, maxPerMinute: 12, maxPerHour: 60, privateMaxPerHour: 400 },
    proactive: { enabled: true },
  },
};

export const LEVEL_ORDER = ['quiet', 'normal', 'active', 'chatty'];

export const DEFAULT_LEVEL = 'normal';

export function isLevel(name) {
  return Object.prototype.hasOwnProperty.call(LEVELS, name);
}

export function normalizeLevel(name) {
  const v = String(name || '').trim().toLowerCase();
  return isLevel(v) ? v : DEFAULT_LEVEL;
}

/**
 * 把档位铺到默认配置上。
 * 只覆盖默认值，config.json 里写死的项仍然优先。
 */
export function applyLevel(base, level) {
  const name = normalizeLevel(level);
  const p = LEVELS[name];

  return {
    ...base,
    behavior: {
      ...base.behavior,
      ...p.behavior,
      replyLevel: name,
    },
    limits: {
      ...base.limits,
      ...p.limits,
    },
    proactive: {
      ...base.proactive,
      ...(p.proactive || {}),
      // 档位不接管具体时间参数，只决定开不开
      enabled: (p.proactive || {}).enabled ?? base.proactive.enabled,
    },
  };
}
