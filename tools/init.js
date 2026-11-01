// 命令行入口：npm run init
// 逻辑在 src/bootstrap.js，分发包里也能直接复用。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, printReport, projectRoot } from '../src/bootstrap.js';

const root = process.argv[1]
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : projectRoot;

printReport(root, bootstrap({ root }));
