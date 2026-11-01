// 首次运行初始化：把 config / persona / data 补齐。
// 放在 src/ 下，是为了随分发包一起走（dist 里没有 tools/ 目录）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（src/ 的上一级）。 */
export const projectRoot = path.resolve(here, '..');

const MEMORY_SKELETON = {
  version: 1,
  groups: {},
  stats: { replied: 0, dropped: 0 },
};

/** 读 config.json；文件不存在或不是合法 JSON 时返回 null。 */
export function readConfigFile(base = projectRoot) {
  try {
    const abs = path.join(base, 'config.json');
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 补齐首次运行需要的文件；已存在的文件不覆盖，可以反复调用。
 * @param {{ root?: string }} [options]
 * @returns {{ created: string[], skipped: string[], apiKeyConfigured: boolean }}
 */
export function bootstrap(options = {}) {
  const base = options.root ? path.resolve(options.root) : projectRoot;
  const created = [];
  const skipped = [];

  const ensureFile = (rel, content) => {
    const abs = path.join(base, rel);
    if (fs.existsSync(abs)) {
      skipped.push(rel);
      return false;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    created.push(rel);
    return true;
  };

  const ensureDir = (rel) => {
    const abs = path.join(base, rel);
    if (fs.existsSync(abs)) return false;
    fs.mkdirSync(abs, { recursive: true });
    created.push(`${rel}/`);
    return true;
  };

  const copyExample = (from, to) => {
    const source = path.join(base, from);
    if (!fs.existsSync(source)) return false;
    ensureFile(to, fs.readFileSync(source, 'utf8'));
    return true;
  };

  // 1. 运行数据目录（记忆、日志、统计都写在这里）
  ensureDir('data');

  // 2. 配置与人设（从 .example 复制，绝不覆盖已有文件）
  copyExample('config.example.json', 'config.json');
  copyExample('persona.example.md', 'persona.md');

  // 3. 空的记忆库，让第一次启动就能正常读写
  ensureFile(
    path.join('data', 'memory.json'),
    `${JSON.stringify(MEMORY_SKELETON, null, 2)}\n`,
  );

  const cfg = readConfigFile(base);
  const apiKeyConfigured = typeof cfg?.llm?.apiKey === 'string' && cfg.llm.apiKey.trim() !== '';

  return { created, skipped, apiKeyConfigured };
}

/** 打印一份人类可读的初始化报告。 */
export function printReport(base = projectRoot, result = bootstrap({ root: base })) {
  const cfg = readConfigFile(base);
  const provider = cfg?.llm?.provider || 'openai';
  const personaOk = fs.existsSync(path.join(base, 'persona.md'));
  const memoryOk = fs.existsSync(path.join(base, 'data', 'memory.json'));

  if (result.created.length > 0) {
    console.log('已生成：');
    for (const item of result.created) console.log(`  + ${item}`);
  }
  if (result.skipped.length > 0) {
    console.log('已存在（未改动）：');
    for (const item of result.skipped) console.log(`  = ${item}`);
  }
  if (result.created.length === 0 && result.skipped.length === 0) {
    console.log('没有需要创建的文件（缺少 config.example.json / persona.example.md？）');
  }

  console.log('');
  console.log('自检：');
  console.log(`  ${personaOk ? '✔' : '✘'} 人设 persona.md`);
  console.log(`  ${result.apiKeyConfigured ? '✔' : '✘'} 大模型 Key（config.json → llm.apiKey，provider=${provider}）`);
  console.log(`  ${memoryOk ? '✔' : '✘'} 记忆库 data/memory.json`);
  console.log('');

  if (!result.apiKeyConfigured) {
    console.log('下一步：');
    console.log('  1. 打开 config.json，把 llm.apiKey 换成你自己的 Key（默认接 DeepSeek，也可换任意 OpenAI 兼容接口）');
    console.log('  2. 打开 persona.md，把人设改成你想要的角色（现在是示例「小满」）');
    console.log('  3. 不填 Key 也能先看效果：node tools/dryrun.js');
    console.log('  4. 填好之后：node main.js（或在界面里点「启动」）');
  } else {
    console.log('可以直接启动了：node main.js');
  }
}

// 直接运行（npm run init / node src/bootstrap.js）时才打印报告；
// 被 main.js import 时只补齐文件，不输出。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  printReport(projectRoot, bootstrap({ root: projectRoot }));
}
