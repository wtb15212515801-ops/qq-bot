import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const shim = fs.readFileSync(path.join(root, "web-shim.js"), "utf8");

const m = ui.match(/<body[^>]*>/i);
if (!m) throw new Error("ui/index.html 里找不到 <body>，构建中止");

// 适配层必须排在界面脚本前面，否则界面第一次拉 /api/state 会走网络
const at = m.index + m[0].length;
const banner = "\n<!-- 由 tools/build-web.mjs 生成：界面来自 ui/index.html，数据层由 web-shim.js 顶替 -->\n";
const out = ui.slice(0, at) + banner + "<script>\n" + shim + "\n</script>\n" + ui.slice(at);

fs.writeFileSync(path.join(root, "index.html"), out, "utf8");
console.log("生成 index.html：" + (out.length / 1024).toFixed(1) + " KB（界面 " +
  (ui.length / 1024).toFixed(1) + " + 适配层 " + (shim.length / 1024).toFixed(1) + "）");
