/*
 * 生成网页版：把种子数据内联进 web/app.html，输出根目录 index.html
 * 用法： node tools/build-web.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "web", "app.html");
const seedPath = path.join(root, "web-seed.json");
const outPath = path.join(root, "index.html");

const app = fs.readFileSync(appPath, "utf8");

let seed = "null";
try {
  seed = fs.readFileSync(seedPath, "utf8").trim() || "null";
} catch {
  console.warn("没有 web-seed.json，网页版会落到两份占位会话");
}

// 防止聊天内容里出现 </script> 把标签提前闭合
const safeSeed = seed.replace(/<\//g, "<\\/");

if (!app.includes("__SEED__")) {
  throw new Error("web/app.html 里没有 __SEED__ 占位符");
}

const out = app.replace("__SEED__", safeSeed);
fs.writeFileSync(outPath, out, "utf8");

const chats = seed === "null" ? 0 : (JSON.parse(seed).chats || []).length;
const lines = seed === "null" ? 0 : (JSON.parse(seed).lines || []).length;
console.log(
  "生成 index.html：" + (out.length / 1024).toFixed(1) + " KB（" +
  chats + " 个会话 / " + lines + " 条消息）"
);
