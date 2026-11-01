import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const COLOR = Boolean(process.stdout.isTTY);

const pad = (n) => String(n).padStart(2, '0');

function stamp(full) {
  const d = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (!full) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger({ level = 'info', file = null } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let written = 0;
  const MAX_BYTES = 5 * 1024 * 1024;
  let abs = null;

  if (file) {
    abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    // 启动时先轮转一次
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).size > MAX_BYTES) {
        try {
          fs.rmSync(abs + '.1', { force: true });
        } catch {
          /* ignore */
        }
        fs.renameSync(abs, abs + '.1');
      }
    } catch {
      /* ignore */
    }

    stream = fs.createWriteStream(abs, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });

    // 续写已有文件时要把已有大小算进去，否则重启后要再写满 5MB 才轮转
    try {
      written = fs.statSync(abs).size;
    } catch {
      written = 0;
    }
  }

  // 运行中超过 5MB 就轮转，避免长时间运行把磁盘写满
  function rotate() {
    if (!abs) return;
    try {
      stream?.end();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(abs + '.1', { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.renameSync(abs, abs + '.1');
    } catch {
      /* ignore */
    }
    try {
      stream = fs.createWriteStream(abs, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
    written = 0;
  }

  function write(lvl, scope, args) {
    if ((LEVELS[lvl] ?? 0) < min) return;

    const body = [scope ? `(${scope})` : '', ...args.map(fmt)].filter(Boolean).join(' ');

    // 控制台：短时间戳 + 颜色
    const head = COLOR
      ? `${COLORS[lvl] || ''}${stamp(false)} ${lvl.toUpperCase().padEnd(5)}${RESET}`
      : `${stamp(false)} ${lvl.toUpperCase().padEnd(5)}`;
    const line = `${head} ${body}`;

    if (lvl === 'error') console.error(line);
    else console.log(line);

    // 文件：完整时间戳，不带颜色
    try {
      const line2 = `[${stamp(true)}] ${lvl.toUpperCase().padEnd(5)} ${body}\n`;
      stream?.write(line2);
      written += Buffer.byteLength(line2);
      if (written > MAX_BYTES) rotate();
    } catch {
      /* ignore */
    }
  }

  function make(scope) {
    return {
      debug: (...a) => write('debug', scope, a),
      info: (...a) => write('info', scope, a),
      warn: (...a) => write('warn', scope, a),
      error: (...a) => write('error', scope, a),
      child: (s) => make(s),
    };
  }

  return make('');
}
