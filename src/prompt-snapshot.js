/**
 * Prompt 快照：每次回复前把真正发给模型的内容落一份到 data/last-prompt.json，
 * 界面「看这次发给模型的」就是读它。
 */

import fs from 'node:fs';
import path from 'node:path';

export function dumpPrompt({ dir = 'data', key, event, system, user, facts, speaker, cognition, log }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'last-prompt.json'),
      JSON.stringify({
        at: Date.now(),
        chat: key,
        from: event.nickname,
        text: event.text,
        facts: facts || [],
        topics: cognition?.topics || [],
        openQuestion: cognition?.openQuestion || null,
        speaker: speaker?.text || '',
        system,
        user,
      }, null, 2),
      'utf8'
    );
  } catch (e) {
    log?.debug(`prompt 快照写入失败：${e.message}`);
  }
}
