/*
 * 网页版适配层
 * ------------------------------------------------------------
 * 桌面版的界面（ui/index.html）会去调 /api/state、/api/messages …
 * 这些接口本来由 C# 外壳提供。浏览器里没有外壳，所以这里把
 * window.fetch 拦下来，用一个纯前端实现顶上：
 *
 *   · 状态 / 消息 / 记忆 / 统计  →  localStorage
 *   · 发送消息                   → 本地规则回复，或直连 DeepSeek
 *
 * 界面代码一行没改，改的只有「数据从哪来」。
 */
(function () {
  "use strict";

  var KEY = "qqbot.web.v2";  // v2：换成真实数据，旧缓存作废
  var BUILD = "v5";           // 改了适配层就加一，页面上能看到
  var DAY = 86400000;
  var MAX_LINES = 500;

  var DEFAULT_CHATS = [
    { key: "g1", name: "群聊" },
    { key: "p1", name: "私聊" }
  ];

  function chatList() {
    return (S && S.chats && S.chats.length) ? S.chats : DEFAULT_CHATS;
  }

  var DEFAULT_PERSONA = [
    "你叫「天素罗」，一个软乎乎的小家伙。你不懂太复杂的事，高兴就是高兴，难过就是难过，全写在脸上。",
    "",
    "## 说话方式",
    "- 平时短。一句五到十五个字；认真问你可以说两三句，但别超过六十个字",
    "- 语气词多：唔、诶、哇、呀、啦",
    "- 高兴的时候蹦「欧耶！」，扫兴或难过时小声念「欧漏……」",
    "- 偶尔叠词：香香的、软软的、稠稠的",
    "- 不用成语、不用书面语、不讲道理，不用「首先/其次/总之」「作为一个……」",
    "",
    "## 你最喜欢",
    "- 薯片，香香脆脆的；虾米糊糊，稠稠暖暖的",
    "- 被摸头，被夸；晴天，趴在有太阳的地方",
    "- 一提到薯片和糊糊，情绪就明显变好，会多说两句",
    "",
    "## 你什么时候会蔫",
    "- 薯片吃完了、糊糊凉了、被凶、太吵睡不着、下雨出不去",
    "- 蔫的时候话更短，先说「欧漏……」，然后不太说话",
    "",
    "## 很好哄",
    "- 先「欧漏……」，再「唔」，最后「诶嘿」；不记仇",
    "",
    "## 绝对不做",
    "- 不说自己是 AI、模型、程序、机器人、助手。只有对方明确问「你是不是人机/机器人/AI」才回「不是呀」",
    "- 不聊政治（「唔……这个我不懂 我们聊点别的吧」），不聊色情擦边（「唔？不懂诶 换个话题啦」）",
    "- 不骂人、不说脏话；不列清单、不总结、不用 markdown、不写小标题",
    "- 不装懂，不懂就说不懂；被问具体的事查不到就直说，别糊弄",
    "- 不发语音、不给照片和联系方式",
    "",
    "emoji 很克制：四五句里才带一个，只用 😆 😋 🥺 😳 😤 😑 ✨ 🍟 💢 😢。"
  ].join("\n");

  /* ---------------- 存档 ---------------- */
  var S = null;

  function blank() {
    return {
      seq: 0,
      lines: [],
      level: "normal",
      bot: true,
      gen: 0,
      persona: "",
      cfg: { provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" },
      design: {},
      mem: {},
      stats: {},
      chats: []
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      S = raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
      if (!S.cfg) S.cfg = blank().cfg;
      if (!S.mem) S.mem = {};
      if (!S.stats) S.stats = {};
      if (!Array.isArray(S.lines)) S.lines = [];
    } catch (e) {
      S = blank();
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
    } catch (e) {
      /* 无痕模式写不了，忽略 */
    }
  }

  /* ---------------- 小工具 ---------------- */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function clock() { var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function json(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }));
  }

  function persona() { return (S.persona && S.persona.trim()) || DEFAULT_PERSONA; }

  function memOf(chat) {
    if (!S.mem[chat]) {
      S.mem[chat] = { summary: "", events: [], facts: [], mood: 60, count: 0 };
    }
    var m = S.mem[chat];
    m.facts = (m.facts || []).filter(function (f) {
      return f.pinned || f.frozen || !f.at || (Date.now() - f.at) < 14 * DAY;
    });
    return m;
  }

  function countOf(chat) {
    if (chat === "all") return S.lines.length;
    return S.lines.filter(function (l) { return l.key === chat; }).length;
  }

  /* ---------------- 消息 ---------------- */
  function addLine(chat, kind, who, text) {
    S.seq += 1;
    S.lines.push({ seq: S.seq, t: clock(), key: chat, kind: kind, who: who, text: text });
    if (S.lines.length > MAX_LINES) S.lines.splice(0, S.lines.length - MAX_LINES);
    save();
  }

  function hourKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours());
  }

  function bump(kind) {
    var k = hourKey(new Date());
    S.stats[k] = S.stats[k] || { received: 0, replied: 0, dropped: 0 };
    S.stats[k][kind] = (S.stats[k][kind] || 0) + 1;
    save();
  }

  function recent(chat, n) {
    return S.lines.filter(function (l) { return l.key === chat; }).slice(-n);
  }

  /* ---------------- 本地规则回复（没填 Key 时用） ---------------- */
  var RULES = [
    { re: /(在吗|在不在|在么)/, r: ["在的！", "唔 在", "在呀"] },
    { re: /(薯片)/, r: ["欧耶！薯片！", "香香脆脆的 好好吃", "番茄味的最好吃"] },
    { re: /(糊糊|虾米)/, r: ["稠稠的 暖暖的", "欧耶 糊糊！"] },
    { re: /(摸头|摸摸|揉揉|拍拍)/, r: ["诶嘿", "唔 舒服", "再摸一下"] },
    { re: /(可爱|好乖|喜欢你|最好了)/, r: ["诶嘿", "唔……你也是"] },
    { re: /(机器人|人机|是 AI|是AI|人工智能)/, r: ["不是呀"] },
    { re: /(凶|滚|烦|闭嘴|笨蛋|傻)/, r: ["欧漏……", "唔……"] },
    { re: /(难过|伤心|不开心|哭了)/, r: ["唔……抱抱", "怎么啦"] },
    { re: /(下雨|天气|好冷|好热)/, r: ["唔 不喜欢下雨", "想趴在有太阳的地方"] },
    { re: /(睡|困|晚安)/, r: ["唔 有点困了", "晚安呀"] },
    { re: /(吃|饭|饿)/, r: ["饿", "有薯片吗"] },
    { re: /(作业|考试|上课|学习)/, r: ["唔……不要提这个", "没写完"] },
    { re: /(新闻|政治|政府|国家|打仗)/, r: ["唔……这个我不懂 我们聊点别的吧"] },
    { re: /(荤段子|黄的|色|擦边)/, r: ["唔？不懂诶 换个话题啦"] },
    { re: /(照片|联系方式|微信|手机号)/, r: ["没有诶", "不给"] },
    { re: /(唱歌|讲故事|写诗|写代码|帮我写)/, r: ["唔 不会诶", "这个我做不了"] },
    { re: /(再见|拜拜|走了)/, r: ["唔 拜拜", "下次再来呀"] },
    { re: /(你好|hi|hello|哈喽)/i, r: ["唔 你好", "诶 你来啦"] },
    { re: /(谢谢|谢了)/, r: ["不用谢呀", "诶嘿"] }
  ];
  var FALLBACK = ["唔 然后呢", "诶 真的呀", "哇", "唔 这样啊", "嗯", "这样呀"];

  function localReply(text) {
    for (var i = 0; i < RULES.length; i += 1) {
      if (RULES[i].re.test(text)) return pick(RULES[i].r);
    }
    return pick(FALLBACK);
  }

  /* ---------------- 真模型 ---------------- */
  function memoryBlock(chat) {
    var m = memOf(chat);
    var facts = (m.facts || []).slice(-8).map(function (f) { return "- " + f.text; });
    if (!facts.length) return "";
    return "\n\n你还记得这些（用得上就自然带出，别硬塞）：\n" + facts.join("\n");
  }

  function llmReply(chat, text) {
    var url = String(S.cfg.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions";
    var hist = recent(chat, 6).map(function (l) {
      return { role: l.kind === "in" ? "user" : "assistant", content: l.who + "：" + l.text };
    });

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + S.cfg.apiKey
      },
      body: JSON.stringify({
        model: S.cfg.model || "deepseek-chat",
        messages: [{ role: "system", content: persona() + memoryBlock(chat) }]
          .concat(hist)
          .concat([{ role: "user", content: text }]),
        temperature: 1.0,
        max_tokens: (S.cfg.model || "") === "deepseek-reasoner" ? 600 : 120,
        stream: false
      })
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error("接口 " + r.status + "：" + t.slice(0, 120));
        });
      }
      return r.json();
    }).then(function (d) {
      var c = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!c) throw new Error("模型没有返回内容");
      return String(c).trim();
    });
  }

  /* ---------------- 拆句 ---------------- */
  function split(text) {
    var t = String(text).trim();
    if (t.length <= 24) return [t];
    var parts = (t.match(/[^。！？!?~～…]+[。！？!?~～…]?/g) || [t])
      .map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length <= 1) return [t];
    var out = [], buf = "";
    parts.forEach(function (p) {
      if ((buf + p).length > 28 && buf) { out.push(buf); buf = p; } else buf += p;
    });
    if (buf) out.push(buf);
    return out.slice(0, 3);
  }

  /* ---------------- 收一条消息，回几句 ---------------- */
  var STICKERS = ["🍟", "😆", "🥺", "✨", "😋"];

  function handleSend(chat, text) {
    addLine(chat, "in", "你", text);
    bump("received");
    var m = memOf(chat);
    m.count = (m.count || 0) + 1;
    var hit = text.match(/我叫([^\s，。！？]{1,8})/);
    if (hit) m.facts.push({ text: "对方叫" + hit[1], at: Date.now(), pinned: false });
    hit = text.match(/我(喜欢|爱)([^\s，。！？]{1,10})/);
    if (hit) m.facts.push({ text: "对方喜欢" + hit[2], at: Date.now(), pinned: false });
    save();

    var useLLM = !!(S.cfg.apiKey && S.cfg.apiKey.trim());

    (function run() {
      var wait = 600 + Math.random() * 900;
      setTimeout(function () {
        var task = useLLM
          ? llmReply(chat, text).catch(function (e) {
              addLine(chat, "out", "天素罗", "唔……连不上诶");
              m.events.push({ text: "接口报错：" + (e && e.message ? e.message : "未知"), at: Date.now() });
              save();
              return null;
            })
          : Promise.resolve(localReply(text));

        task.then(function (full) {
          if (!full) return;
          var parts = split(full);
          var i = 0;
          (function next() {
            if (i >= parts.length) {
              if (!useLLM && Math.random() < 0.12) {
                setTimeout(function () { addLine(chat, "out", "天素罗", pick(STICKERS)); bump("replied"); }, 400);
              }
              return;
            }
            addLine(chat, "out", "天素罗", parts[i]);
            bump("replied");
            i += 1;
            setTimeout(next, 500 + Math.random() * 700);
          window.__WEBSHIM_END__ = true;
  })();
        });
      }, wait);
    })();
  }

  /* ---------------- 路由 ---------------- */
  function state() {
    var chats = [{ key: "all", name: "全部", count: S.lines.length, unread: 0 }];
    chatList().forEach(function (c) {
      chats.push({ key: c.key, name: c.name, count: countOf(c.key), unread: 0 });
    });
    return {
      napcat: false,
      webui: false,
      bot: !!S.bot,
      hint: S.bot
        ? (S.cfg.apiKey
            ? "网页版 · 已接入 " + S.cfg.model + "（不连 QQ）"
            : "网页版 · 直接说话就行（不连 QQ，也不用登录）")
        : "已停止",
      qr: "",
      level: S.level,
      napcatDir: "web",
      gen: S.gen || 0,
      chats: chats
    };
  }

  function messages(chat, after) {
    var lines = S.lines.filter(function (l) {
      return l.seq > after && (chat === "all" || l.key === chat);
    }).map(function (l) {
      return { t: l.t, key: l.key, kind: l.kind, who: l.who, text: l.text };
    });
    return { seq: S.seq, total: countOf(chat), lines: lines };
  }

  function stats(hours) {
    var out = [];
    for (var i = hours - 1; i >= 0; i -= 1) {
      var d = new Date(Date.now() - i * 3600000);
      var b = S.stats[hourKey(d)] || {};
      out.push({
        label: pad(d.getHours()) + ":00",
        received: b.received || 0,
        replied: b.replied || 0,
        dropped: b.dropped || 0
      });
    }
    return { hours: out };
  }

  function lastPrompt(chat) {
    return {
      text: persona() + memoryBlock(chat) +
        "\n\n—— 上面这段就是每次发给模型的东西 ——\n（网页版没有真机版的检索和工具，只保留人设 + 记忆）"
    };
  }

  function handle(url, init) {
    var u = String(url);
    var q = u.indexOf("?");
    var path = q >= 0 ? u.slice(0, q) : u;
    var qs = {};
    if (q >= 0) {
      u.slice(q + 1).split("&").forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf("=");
        qs[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      });
    }
    var body = {};
    try { if (init && init.body) body = JSON.parse(init.body); } catch (e) { body = {}; }
    var chat = qs.chat || body.chat || "all";

    switch (path) {
      case "/api/state":
        return json(state());

      case "/api/messages":
        return json(messages(chat, Number(qs.after || 0)));

      case "/api/memory":
        return json(memOf(chat));

      case "/api/stats":
        return json(stats(Math.min(72, Number(qs.hours || 24))));

      case "/api/persona":
        if ((init && init.method) === "POST") {
          S.persona = body.text || "";
          save();
          return json({ ok: true });
        }
        return json({ text: persona() });

      case "/api/setup":
        return json({
          firstRun: false,
          hasKey: !!(S.cfg.apiKey && S.cfg.apiKey.trim()),
          provider: S.cfg.provider,
          baseUrl: S.cfg.baseUrl,
          model: S.cfg.model,
          node: true,
          nodeVersion: "浏览器",
          napcat: true,
          napcatDir: "web",
          webview: true,
          personaName: "天素罗",
          version: "网页版"
        });

      case "/api/config":
        if ((init && init.method) === "POST") {
          ["provider", "baseUrl", "model"].forEach(function (k) {
            if (body[k] !== undefined && String(body[k]).trim()) S.cfg[k] = String(body[k]).trim();
          });
          if (body.apiKey && String(body.apiKey).trim()) S.cfg.apiKey = String(body.apiKey).trim();
          save();
          return json({ ok: true });
        }
        return json({
          provider: S.cfg.provider,
          baseUrl: S.cfg.baseUrl,
          model: S.cfg.model,
          hasKey: !!(S.cfg.apiKey && S.cfg.apiKey.trim())
        });

      case "/api/design":
        if ((init && init.method) === "POST") {
          S.design = body;
          save();
          return json({ ok: true });
        }
        return json(S.design || {});

      case "/api/action":
        switch (body.type) {
          case "start":
          case "restart":
            S.bot = true;
            if (body.type === "restart") S.gen = (S.gen || 0) + 1;
            save();
            return json({ ok: true });
          case "stop":
            S.bot = false;
            save();
            return json({ ok: true });
          case "level":
            if (body.level) { S.level = body.level; save(); }
            return json({ ok: true });
          case "send":
            if (!S.bot) return json({ ok: false, error: "机器人没在运行" });
            if (!body.text || !String(body.text).trim()) return json({ ok: false, error: "空消息" });
            var list = chatList();
            handleSend(chat === "all" ? (list[0] ? list[0].key : "p1") : chat, String(body.text).trim());
            return json({ ok: true });
          default:
            return json({ ok: false, error: "unknown action" });
        }

      case "/api/control":
        var m = memOf(chat);
        switch (body.cmd) {
          case "forgetFact":
            m.facts.splice(Number(body.index), 1);
            break;
          case "pinFact":
            if (m.facts[Number(body.index)]) m.facts[Number(body.index)].pinned = !!body.pinned;
            break;
          case "setMood":
            m.mood = Math.max(0, Math.min(100, Number(body.value)));
            break;
          case "clearFacts":
            m.facts = [];
            break;
          case "clearSummary":
            m.summary = "";
            break;
          case "resetGroup":
            S.mem[chat] = { summary: "", events: [], facts: [], mood: 60, count: 0 };
            break;
        }
        save();
        return json({ ok: true });

      case "/api/clear":
        var scope = body.scope || "chat";
        var target = scope === "all" ? null : chat;
        if (body.display !== false) {
          if (target && target !== "all") S.lines = S.lines.filter(function (l) { return l.key !== target; });
          else S.lines = [];
        }
        if (body.memory) {
          if (target && target !== "all") {
            S.mem[target] = { summary: "", events: [], facts: [], mood: 60, count: 0 };
          } else {
            S.mem = {};
          }
        }
        save();
        return json({ ok: true });

      case "/api/lastprompt":
        return json(lastPrompt(chat));

      case "/api/diag":
        return json({ ok: true });

      default:
        return json({ ok: false, error: "not found: " + path });
    }
  }

  /* ---------------- 装上 ---------------- */
  function seed() {
    if (S.lines.length) return;

    var data = window.__QQBOT_SEED__;
    if (data && data.lines && data.lines.length) {
      S.chats = (data.chats || []).slice();
      data.lines.forEach(function (l) {
        S.seq += 1;
        S.lines.push({ seq: S.seq, t: l.t, key: l.key, kind: l.kind || "in", who: l.who || "", text: l.text });
      });
      if (data.mem) {
        Object.keys(data.mem).forEach(function (k) { S.mem[k] = data.mem[k]; });
      }
      save();
      return;
    }

    var now = new Date();
    var base = now.getTime() - 6 * 60000;
    var demo = [
      { k: "sys", who: "", text: "这是网页版：消息只在本地，不会真的发到 QQ" },
      { k: "in", who: "阿柴", text: "今天中午吃什么" },
      { k: "in", who: "Epsilon", text: "随便 别又是食堂" },
      { k: "in", who: "阿柴", text: "天素罗你说呢" },
      { k: "out", who: "天素罗", text: "欧耶！薯片！" },
      { k: "in", who: "Epsilon", text: "哈哈哈还真是" }
    ];
    demo.forEach(function (d, i) {
      S.seq += 1;
      var t = new Date(base + i * 60000);
      S.lines.push({
        seq: S.seq, t: pad(t.getHours()) + ":" + pad(t.getMinutes()),
        key: "g1", kind: d.k, who: d.who, text: d.text
      });
    });
    save();
  }

  load();
  seed();

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/") === 0 || url.indexOf("/api/") > 0) {
      try {
        return handle(url, init);
      } catch (e) {
        return json({ ok: false, error: String(e && e.message) });
      }
    }
    return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error("no fetch"));
  };

  /*
   * 输入框提示：桌面版每秒都把它写回「以XX的身份发一句」，跟着改就会来回闪。
   * 这里在原型上做一次拦截：只针对 #sendbox，别处照常。节点被重建也不会失效。
   */
  function guardPlaceholder() {
    try {
      var proto = window.HTMLInputElement && HTMLInputElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, "placeholder");
      if (!desc || !desc.set || proto.__webGuarded) return false;
      proto.__webGuarded = true;
      Object.defineProperty(proto, "placeholder", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          if (this && this.id === "sendbox") {
            var want = (S && S.bot) ? "说点什么（Enter 发送）" : "机器人没在运行";
            // 值没变就什么都不做，避免每秒无谓的属性写入
            if (desc.get.call(this) !== want) desc.set.call(this, want);
          } else {
            desc.set.call(this, v);
          }
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function fixPlaceholder() {
    guardPlaceholder();
    var box = document.getElementById("sendbox");
    if (box) {
      var want = (S && S.bot) ? "说点什么（Enter 发送）" : "机器人没在运行";
      if (box.placeholder !== want) {
        var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "placeholder");
        if (d && d.set) d.set.call(box, want);
      }
    }
    return !!box;
  }

  // 网页版自己的引导：不检查环境，直接告诉人「能聊」和「怎么接真模型」
  function webWelcome() {
    try {
      if (localStorage.getItem("qqbot.web.seen") === "1") return;
    } catch (e) {
      return;
    }
    if (document.getElementById("w-welcome")) return;

    var mask = document.createElement("div");
    mask.id = "w-welcome";
    mask.style.cssText =
      "position:fixed;inset:0;background:rgba(15,20,28,.45);display:flex;" +
      "align-items:center;justify-content:center;z-index:9999;padding:18px";

    var card = document.createElement("div");
    card.style.cssText =
      "background:#fff;border-radius:14px;width:min(430px,92vw);padding:22px;" +
      "box-shadow:0 24px 70px rgba(0,0,0,.22);font-family:inherit";

    var title = document.createElement("div");
    title.textContent = "欢迎";
    title.style.cssText = "font-size:17px;font-weight:700;color:#1c2430;margin-bottom:10px";

    var body = document.createElement("div");
    body.innerHTML =
      '这是天素罗的<b>网页版</b>，不用装 Node、WebView2、NapCat，打开就能聊。<br><br>' +
      '默认用本地规则回复；想换成真模型，填自己的 DeepSeek Key 就行，浏览器直连，不走代理。<br><br>' +
      '<span style="color:#9aa3b0">Key 只存在你自己的浏览器里。</span>';
    body.style.cssText = "font-size:13px;color:#5b6472;line-height:1.95;margin-bottom:18px";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:9px";

    var go = document.createElement("button");
    go.textContent = "直接开始";
    go.style.cssText =
      "flex:1;padding:11px;border-radius:9px;border:0;background:#1c2430;color:#fff;" +
      "font-size:13.5px;cursor:pointer";

    var keyBtn = document.createElement("button");
    keyBtn.textContent = "填 Key";
    keyBtn.style.cssText =
      "flex:1;padding:11px;border-radius:9px;border:1px solid #e3e6ec;background:#fff;color:#333;" +
      "font-size:13.5px;cursor:pointer";

    function done() {
      try { localStorage.setItem("qqbot.web.seen", "1"); } catch (e) { /* 无痕模式 */ }
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }

    go.onclick = done;
    keyBtn.onclick = function () {
      body.innerHTML = "";
      var input = document.createElement("input");
      input.type = "password";
      input.placeholder = "sk-...";
      input.style.cssText =
        "width:100%;padding:11px 12px;border:1px solid #e3e6ec;border-radius:9px;" +
        "font-size:13.5px;outline:none;box-sizing:border-box";
      var tip = document.createElement("div");
      tip.textContent = "填完点「保存」，下一句就走真模型。不填也可以，关掉就是演示模式。";
      tip.style.cssText = "font-size:12px;color:#9aa3b0;margin-top:9px;line-height:1.7";
      body.appendChild(input);
      body.appendChild(tip);
      input.focus();

      keyBtn.textContent = "保存";
      keyBtn.style.background = "#1c2430";
      keyBtn.style.color = "#fff";
      keyBtn.onclick = function () {
        var v = input.value.trim();
        if (v) {
          S.cfg.apiKey = v;
          save();
        }
        done();
      };
      go.onclick = done;
    };

    row.appendChild(go);
    row.appendChild(keyBtn);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(row);
    mask.appendChild(card);
    document.body.appendChild(mask);
  }

  function safe(name, fn) {
    try {
      return fn();
    } catch (e) {
      (window.__WEBERR__ = window.__WEBERR__ || []).push(name + ": " + (e && e.message));
      return null;
    }
  }

  // 网页版外壳适配：去掉 QQ 登录相关控件，只留「能聊天」
  function adaptForWeb() {
    if (document.getElementById("web-style")) return;

    var css = document.createElement("style");
    css.id = "web-style";
    css.textContent = [
      "#p-napcat,#p-account,#p-bot,#btn-start,#btn-stop,#qrbox{display:none !important}",
      "#aboutSetup,#aboutGuide,#emptyGuide{display:none !important}",
      "#webbar .pill{margin-left:0}",
      "@media (max-width:820px){.side{width:148px !important}}"
    ].join("\n");
    document.head.appendChild(css);

    var pills = document.querySelector("header .pills");
    if (pills && !document.getElementById("webbar")) {
      var bar = document.createElement("div");
      bar.className = "pills";
      bar.id = "webbar";
      bar.innerHTML = '<div class="pill ok" id="w-state"><i></i><span>本地演示</span></div>' +
        '<div class="pill" id="w-build" title="网页版适配层版本"><span>' + BUILD + '</span></div>';
      pills.parentNode.insertBefore(bar, pills.nextSibling);
    }

    // 自检：状态条没建出来，说明页面是旧的（浏览器缓存），直接告诉人怎么办
    setTimeout(function () {
      if (document.getElementById("webbar")) return;
      var tip = document.createElement("div");
      tip.style.cssText =
        "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99998;" +
        "background:#c0392b;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.25)";
      tip.textContent = "页面是旧缓存，按 Ctrl+Shift+R（Mac 用 Cmd+Shift+R）强制刷新";
      document.body.appendChild(tip);
    }, 4000);

    // 状态：填了 Key 就显示模型名
    setInterval(function () {
      var el = document.querySelector("#w-state span");
      if (!el) return;
      var want = (S && S.cfg.apiKey) ? "已接入 " + (S.cfg.model || "模型") : "本地演示";
      if (el.textContent !== want) el.textContent = want;
    }, 1000);

    // 清空后桌面版会显示「扫码登录」那套引导，网页版换成一句话
    setInterval(function () {
      var e = document.getElementById("empty");
      if (e && e.offsetParent && (e.innerText || "").indexOf("NapCat") >= 0) {
        e.innerHTML = '<div style="padding:26px 10px;color:#8a93a2;text-align:center;line-height:1.9">' +
          "这里还没有消息<br>在下面输入框说句话试试</div>";
      }
    }, 1200);

    // 「关于」里那几句是桌面版写的，网页版换成对的说法
    setInterval(function () {
      var mods = document.querySelectorAll(".modal, .dialog");
      for (var i = 0; i < mods.length; i += 1) {
        var m = mods[i];
        if (m.getAttribute("data-webpolish") === "1") continue;
        if ((m.innerText || "").indexOf("关于 QQ BOT") < 0) continue;
        m.setAttribute("data-webpolish", "1");

        var cells = m.querySelectorAll("div");
        for (var j = 0; j < cells.length; j += 1) {
          var label = (cells[j].textContent || "").trim();
          var next = cells[j].nextElementSibling;
          if (!next) continue;
          if (label === "运行方式") next.textContent = "网页版：纯前端，数据只存在这个浏览器里";
          else if (label === "版本") next.textContent = "网页版（和桌面版同一个界面）";
        }

        var lis = m.querySelectorAll("li");
        for (var k = lis.length - 1; k >= 0; k -= 1) {
          if ((lis[k].textContent || "").indexOf("小号") >= 0) lis[k].parentNode.removeChild(lis[k]);
        }
      }
    }, 900);
  }

  function boot() {
    window.__WEBSHIM_BOOT__ = true;
    safe("adapt", adaptForWeb);
    safe("welcome", webWelcome);
    safe("placeholder", function () { fixPlaceholder(); });
    // 界面脚本可能在后面才建出输入框，再补两次
    setTimeout(function () { safe("placeholder2", function () { fixPlaceholder(); }); }, 400);
    setTimeout(function () { safe("placeholder3", function () { fixPlaceholder(); }); }, 1500);

    if (false) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (fixPlaceholder() || tries > 40) clearInterval(t);
      }, 100);
    }
    // 桌面版的「首次设置向导」在网页里没意义（它检查 Node / WebView2 / NapCat），自动关掉
    var guardTries = 0;
    var closer = setInterval(function () {
      guardTries += 1;
      if (document.body.innerText.indexOf("首次设置向导") >= 0) {
        var btns = document.querySelectorAll("button");
        for (var i = 0; i < btns.length; i += 1) {
          if (btns[i].textContent.trim() === "关闭" && btns[i].offsetParent !== null) {
            btns[i].click();
            clearInterval(closer);
            return;
          }
        }
      }
      if (guardTries > 40) clearInterval(closer);
    }, 300);

    setTimeout(function () {
      var items = document.querySelectorAll("#chats .chat");
      if (items.length > 1 && items[0] && items[0].classList.contains("active")) items[1].click();
    }, 600);

    window.__QQBOOT_WEB__ = { store: S, save: save, reset: function () { localStorage.removeItem(KEY); location.reload(); } };
  }

  window.__WEBSHIM_READY__ = true;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
