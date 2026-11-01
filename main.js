import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolvePath, validateConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { OneBotClient } from './src/onebot.js';
import { LLM } from './src/llm.js';
import { Store } from './src/memory.js';
import { Stats } from './src/stats.js';
import { Control } from './src/control.js';
import { Outbox } from './src/outbox.js';
import { Pipeline } from './src/pipeline.js';
import { UiFeed } from './src/ui.js';
import { bootstrap } from './src/bootstrap.js';

const configFile = process.argv[2] || process.env.QQBOT_CONFIG || 'config.json';

function loadPersona(cfg) {
  const file = resolvePath(cfg, cfg.persona.file || 'persona.md');
  if (!fs.existsSync(file)) {
    throw new Error(`找不到人设文件：${file}\n把 persona.example.md 复制成 persona.md 再改。`);
  }
  return {
    name: cfg.persona.name,
    aliases: cfg.persona.aliases?.length ? cfg.persona.aliases : [cfg.persona.name],
    interests: cfg.persona.interests || [],
    text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(),
  };
}

async function main() {
  // 第一次拿到这个项目的人：把 config / persona / 记忆库补齐，缺文件也能直接跑起来
  const boot = bootstrap({ quiet: true });
  if (boot.created.length > 0) {
    console.log(`首次运行，已准备好：${boot.created.join('、')}`);
    console.log('接着请打开 config.json 填 llm.apiKey，并在 persona.md 里改人设。');
  }

  const cfg = loadConfig(configFile);

  const errors = validateConfig(cfg);
  if (errors.length) {
    console.error('配置还没填完：\n  - ' + errors.join('\n  - '));
    if (!boot.apiKeyConfigured) {
      console.error('\n打开 config.json，把 llm.apiKey 换成你自己的大模型 Key（DeepSeek 或任意 OpenAI 兼容接口）。');
      console.error('不填 Key 也能先看效果：node tools/dryrun.js');
    }
    process.exit(1);
  }

  const dataDir = resolvePath(cfg, cfg.storage?.dir || 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 记录 PID，方便一键停止找到自己
  const pidFile = path.join(dataDir, 'bot.pid');

  // 单实例保护：上次的进程还活着就不要再起一个，否则同一条消息会被回复两次
  try {
    if (fs.existsSync(pidFile)) {
      const oldPid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
      if (oldPid && oldPid !== process.pid) {
        let alive = false;
        try {
          process.kill(oldPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          console.error(`已经有一个机器人在运行（PID ${oldPid}），不要重复启动。`);
          console.error('如果确认它已经卡死，结束那个进程或删除 data/bot.pid 后再试。');
          process.exit(1);
        }
      }
    }
  } catch {
    /* ignore */
  }

  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch { /* ignore */ }

  const logger = createLogger({
    level: cfg.log?.level || 'info',
    file: path.join(dataDir, 'bot.log'),
  });
  const log = logger.child('main');

  const persona = loadPersona(cfg);
  log.info(`人设：${persona.name}（别名 ${persona.aliases.join('/')}）`);

  // 兜底：偶发的异常不该让机器人直接死掉
  process.on('unhandledRejection', (e) => {
    log.error(`未处理的异步异常：${e?.stack || e}`);
  });
  process.on('uncaughtException', (e) => {
    log.error(`未捕获异常：${e?.stack || e}`);
  });

  const store = new Store(path.join(dataDir, 'memory.json'), logger.child('store')).load();
  const stats = new Stats({ file: path.join(dataDir, 'stats.json'), logger: logger.child('stats') }).load();
  const ui = new UiFeed({ file: path.join(dataDir, 'ui.log'), logger: logger.child('ui') });

  const llm = new LLM(cfg.llm, logger.child('llm'));
  if (llm.isMock) log.warn('当前是 mock 模型，只会返回固定句子；正式使用请改 config.json 的 llm.provider');

  const client = new OneBotClient(cfg.onebot, logger.child('onebot'));
  const pipeline = new Pipeline({
    cfg,
    persona,
    llm,
    client,
    store,
    stats,
    ui,
    logger: logger.child('pipeline'),
  });

  client.on('ready', async () => {
    try {
      const info = await client.getLoginInfo();
      if (info?.user_id) {
        pipeline.setSelfId(info.user_id);
        log.info(`登录账号：${info.user_id}（${info.nickname ?? ''}）`);
      } else if (cfg.onebot.selfId) {
        pipeline.setSelfId(cfg.onebot.selfId);
      }
    } catch (e) {
      log.warn(`拿不到登录信息：${e.message}（可忽略，用 config 里的 selfId）`);
      if (cfg.onebot.selfId) pipeline.setSelfId(cfg.onebot.selfId);
    }
  });

  client.on('disconnected', () => log.warn('与 NapCat 断开，等待重连…'));

  client.on('event', (ev) => {
    if (ev.post_type === 'meta_event') {
      if (ev.self_id) pipeline.setSelfId(ev.self_id);
      return;
    }
    if (ev.post_type === 'notice') {
      pipeline.handleNotice(ev).catch((e) => log.error(`通知处理异常：${e.stack || e.message}`));
      return;
    }
    pipeline.handle(ev).catch((e) => log.error(`事件处理异常：${e.stack || e.message}`));
  });

  const shutdown = () => {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    log.info('正在退出…');
    try { pipeline.dispose(); } catch { /* ignore */ }
    try { outbox.stop(); } catch { /* ignore */ }
    try { control.stop(); } catch { /* ignore */ }
    try { stats.save(); } catch { /* ignore */ }
    try { ui.flush(); } catch { /* ignore */ }
    store.save();
    client.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`连接 OneBot：${cfg.onebot.url}`);
  client.connect();
  pipeline.startProactive();
  pipeline.startMaintenance();

  // 界面「自己发一句」用的单向队列
  const outbox = new Outbox({
    file: path.join(dataDir, 'outbox.jsonl'),
    logger: logger.child('outbox'),
    onSend: (entry) => pipeline.sendManual(entry.chat, entry.text),
  });
  outbox.start();

  const control = new Control({
    file: path.join(dataDir, 'control.jsonl'),
    logger: logger.child('control'),
    onCommand: (cmd) => pipeline.applyCommand(cmd),
  });
  control.start();

  // 人设文件改了也热重载，不用重启机器人
  try {
    const personaFile = resolvePath(cfg, cfg.persona.file || 'persona.md');
    let personaTimer = null;
    fs.watch(personaFile, { persistent: false }, () => {
      clearTimeout(personaTimer);
      personaTimer = setTimeout(() => {
        try {
          const text = fs.readFileSync(personaFile, 'utf8').replace(/^\uFEFF/, '').trim();
          if (text) {
            pipeline.persona.text = text;
            log.info('人设已重载');
          }
        } catch (e) {
          log.warn(`人设重载失败：${e.message}`);
        }
      }, 300);
      personaTimer.unref?.();
    });
  } catch (e) {
    log.warn(`监听人设文件失败，改完需重启：${e.message}`);
  }

  // 配置文件一改就热重载：切档位不用重启机器人
  let reloadTimer = null;
  try {
    fs.watch(cfg.configFile, { persistent: false }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        try {
          pipeline.reload(loadConfig(configFile));
        } catch (e) {
          log.warn(`配置热重载失败（保持原样继续跑）：${e.message}`);
        }
      }, 400);
      reloadTimer.unref?.();
    });
  } catch (e) {
    log.warn(`监听配置文件失败，改配置后需手动重启：${e.message}`);
  }

  // 定时落盘，防止异常退出丢记忆
  setInterval(() => store.save(), 60_000).unref();
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
