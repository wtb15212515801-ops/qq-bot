/**
 * 列出机器人当前所在的群，直接拿到群号。
 * 不用去 QQ 里翻，也不用猜。
 *
 * 用法：node tools/groups.js
 * 前提：NapCat 已启动、QQ 已登录、WebSocket 服务器已开
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { OneBotClient } from '../src/onebot.js';
import { createLogger } from '../src/logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pick = (a, b) => (fs.existsSync(path.join(root, a)) ? a : b);

// 支持 node tools/groups.js 其他配置.json
const configFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, pick('config.json', 'config.example.json'));

const cfg = loadConfig(configFile);
const logger = createLogger({ level: 'warn' });

const client = new OneBotClient(cfg.onebot, logger);

const timer = setTimeout(() => {
  console.error(`
连不上 NapCat（${cfg.onebot.url}），检查这几项：
  1. NapCat 是否在运行，QQ 是否已登录
  2. WebUI 里「网络配置」的 WebSocket 服务器是否已启用
  3. config.json 的 onebot.url 端口对不对
  4. accessToken 是否两边一致
`);
  process.exit(1);
}, 15000);

client.on('ready', async () => {
  try {
    const list = await client.call('get_group_list', {});
    const groups = Array.isArray(list) ? list : [];

    if (!groups.length) {
      console.log('这个号还没加任何群。');
    } else {
      console.log(`\n共 ${groups.length} 个群：\n`);
      for (const g of groups) {
        console.log(`  群号 ${g.group_id}   ${g.group_name ?? ''}   ${g.member_count ?? '?'} 人`);
      }
      console.log('\n把要用的群号填进 config.json 的 groups，例如：');
      console.log(`  "groups": { "${groups[0].group_id}": { "name": "${groups[0].group_name ?? ''}" } }\n`);
    }
  } catch (e) {
    console.error(`拿群列表失败：${e.message}`);
  } finally {
    clearTimeout(timer);
    client.close();
    setTimeout(() => process.exit(0), 100).unref();
  }
});

client.connect();
