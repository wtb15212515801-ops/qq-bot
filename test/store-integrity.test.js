import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/memory.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('记忆文件损坏时先备份再重置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-bad-'));
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');

  const store = new Store(file, silent).load();

  assert.deepEqual(store.data.groups, {});
  assert.equal(fs.existsSync(`${file}.corrupt`), true);
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{ 这不是合法 JSON');
});
