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

  var KEY = "qqbot.web.v1";
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
      return f.pinned || !f.at || (Date.now() - f.at) < 14 * DAY;
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

  function bump(kind) {
    var h = new Date().getHours();
    S.stats[h] = S.stats[h] || { received: 0, replied: 0 };
    S.stats[h][kind] += 1;
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
            ? "网页版 · 已接入 " + S.cfg.model + "（不连 QQ，不用扫码）"
            : "网页版 · 本地规则回复（不连 QQ，不用扫码）")
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
    var nowH = new Date().getHours();
    for (var i = 0; i < hours; i += 1) {
      var h = (nowH - (hours - 1 - i) + 24) % 24;
      var b = S.stats[h] || { received: 0, replied: 0 };
      out.push({ h: h, received: b.received, replied: b.replied });
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
          node: false,
          nodeVersion: "",
          napcat: false,
          napcatDir: "web",
          webview: false,
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
        if (chat === "all") S.lines = [];
        else S.lines = S.lines.filter(function (l) { return l.key !== chat; });
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

  /* 输入框提示：桌面版写的是「以XX的身份发一句」，网页版是你在说话 */
  function fixPlaceholder() {
    var box = document.getElementById("sendbox");
    if (!box) return false;
    if (box.placeholder.indexOf("说点什么") !== 0 && !box.disabled) {
      box.placeholder = "说点什么（Enter 发送）";
    }
    return true;
  }

  function boot() {
    if (!fixPlaceholder()) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (fixPlaceholder() || tries > 40) clearInterval(t);
      }, 100);
    }
    var box = document.getElementById("sendbox");
    if (box && window.MutationObserver) {
      new MutationObserver(function () { fixPlaceholder(); })
        .observe(box, { attributes: true, attributeFilter: ["placeholder", "disabled"] });
    }
    // 桌面版的「首次设置向导」在网页里没意义（它检查 Node / WebView2 / NapCat），自动关掉
    var tries = 0;
    var closer = setInterval(function () {
      tries += 1;
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
      if (tries > 40) clearInterval(closer);
    }, 300);

    setTimeout(function () {
      var items = document.querySelectorAll("#chats .chat");
      if (items.length > 1 && items[0] && items[0].classList.contains("active")) items[1].click();
    }, 600);

    window.__QQBOOT_WEB__ = { store: S, save: save, reset: function () { localStorage.removeItem(KEY); location.reload(); } };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
