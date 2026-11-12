/*
 * 从桌面版的数据生成网页版种子：data/chats.json + data/ui.log + data/memory.json
 * 用法： node tools/make-seed.mjs [消息条数]
 *
 * 说明：data/ 在 .gitignore 里（私密），所以种子要在这里抽出来，
 * 生成 web-seed.json 跟着网页一起发布。不想公开就改这个文件的过滤规则。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const limit = Number(process.argv[2] || 200);

const read = (p) => {
  try { return fs.readFileSync(path.join(root, p), "utf8"); } catch { return null; }
};
const readJson = (p, fallback) => {
  const t = read(p);
  if (!t) return fallback;
  try { return JSON.parse(t); } catch { return fallback; }
};

const chatNames = readJson("data/chats.json", {});
const memory = readJson("data/memory.json", { groups: {} });
const logLines = (read("data/ui.log") || "").split(/\r?\n/).filter(Boolean);

// 每行格式： 时间 \t 会话key \t 会话名 \t 方向 \t 谁 \t 内容
const lines = logLines
  .map((l) => {
    const p = l.split("\t");
    return { t: p[0] || "", key: p[1] || "", kind: p[3] || "in", who: p[4] || "", text: p.slice(5).join("\t") };
  })
  .filter((x) => x.key && x.text)
  .slice(-limit);

const chats = Object.keys(chatNames).map((k) => ({
  key: k,
  name: chatNames[k],
  count: lines.filter((l) => l.key === k).length
}));

const mem = {};
for (const [k, v] of Object.entries(memory.groups || {})) {
  mem[k] = {
    summary: v.summary || "",
    // frozen：这些是抓下来的历史事实，网页版不按 14 天遗忘规则清掉
    facts: (v.facts || []).map((f) => ({
      text: f.text,
      at: f.at || 0,
      pinned: !!f.pinned,
      frozen: true
    })),
    events: (v.events || []).slice(-8).map((e) => ({ text: e.text || String(e), at: e.at || 0 })),
    mood: typeof v.mood === "number" ? v.mood : 60,
    count: v.messageCount || 0
  };
}

fs.writeFileSync(
  path.join(root, "web-seed.json"),
  JSON.stringify({ chats, lines, mem }, null, 1),
  "utf8"
);

console.log(
  "web-seed.json：" + chats.length + " 个会话，" + lines.length + " 条消息，" +
  Object.keys(mem).length + " 份记忆"
);
