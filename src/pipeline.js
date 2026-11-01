import { evaluateDecision, isQuestion, containsAlias } from './decision.js';
import { GroupState, buildSystemPrompt, buildUserPrompt } from './context.js';
import { normalizeEvent, chatKey } from './events.js';
import { analyzeConversation } from './cognition.js';
import { retrieve } from './retrieval.js';
import { loadDesign } from './design.js';
import { profileOf, describe as describeProfile } from './profile.js';
import { applyCommand as runCommand } from './commands.js';
import { trackEngagement, rememberReply } from './engagement.js';
import { dumpPrompt } from './prompt-snapshot.js';
import { splitReply, readDelay, typingDelay, gapDelay, sleep } from './humanize.js';
import { checkInput, filterOutput, isOutputBlocked } from './safety.js';
import { RateLimiter } from './ratelimit.js';
import { Brain } from './brain.js';
import { describeImage } from './vision.js';
import { TOOL_DEFS } from './tools.js';
import { StickerBook, decorateEmoji, toFileUri } from './expression.js';
import * as tasks from './tasks.js';
import * as notices from './notices.js';

/**
 * 主流程：收事件 → 归一化 → 决策 → 组装上下文 → 生成 → 拟人化发送。
 */
export class Pipeline {
  constructor({ cfg, persona, llm, client, store, logger, ui = null, stats = null }) {
    this.cfg = cfg;
    this.persona = persona;
    this.llm = llm;
    this.client = client;
    this.store = store;
    this.log = logger;
    this.states = new Map();
    this.limiter = new RateLimiter(cfg.limits);
    this.privateLimiter = new RateLimiter({
      minGapSeconds: 2,
      maxPerMinute: 10,
      maxPerHour: cfg.limits?.privateMaxPerHour ?? 120,
    });
    this.inflight = new Set();
    this.selfId = Number(cfg.onebot.selfId) || 0;
    this.brain = new Brain({ cfg, llm, store, logger });
    this.ui = ui;
    this.stats = stats;
    this.lastJudgeAt = new Map();
    this.noticeAt = new Map();
    this.pending = new Map();
    this.stickers = new StickerBook({
      dir: cfg.stickers?.dir || 'data/stickers',
      logger,
    });
    this.stickers.scan(Date.now(), true);
    if (cfg.stickers?.enabled !== false) {
      const n = this.stickers.size;
      logger.info(n ? `表情包图库：${n} 张` : '表情包图库是空的（把图片放进 data/stickers/<心情>/ 就能用）');
    }
  }

  setSelfId(id) {
    if (id) this.selfId = Number(id);
  }

  /** 接界面下发的控制指令（实现见 commands.js） */
  async applyCommand(cmd) {
    return runCommand(this, cmd);
  }

  /**
   * 停止后台定时任务。退出前调用，避免定时器在关闭过程中再触发一次。
   */
  dispose() {
    for (const t of [this.proactiveTimer, this.maintenanceTimer, this.consolidateTimer]) {
      if (t) clearInterval(t);
    }
    this.proactiveTimer = null;
    this.maintenanceTimer = null;
    this.consolidateTimer = null;
    this.noticeAt.clear();
  }

  /**
   * 配置热重载：只换会影响当下行为的几块，不动连接和记忆。
   * 主要是为了让「回应频度」能在运行中切换。
   */
  reload(next) {
    if (!next) return;
    this.cfg.behavior = next.behavior;
    this.cfg.limits = next.limits;
    this.cfg.proactive = next.proactive;
    this.cfg.emoji = next.emoji;
    this.cfg.stickers = next.stickers;
    this.cfg.timing = next.timing;

    this.limiter.cfg = {
      minGapSeconds: next.limits?.minGapSeconds ?? 30,
      maxPerMinute: next.limits?.maxPerMinute ?? 2,
      maxPerHour: next.limits?.maxPerHour ?? 6,
    };
    this.privateLimiter.cfg = {
      minGapSeconds: 2,
      maxPerMinute: 10,
      maxPerHour: next.limits?.privateMaxPerHour ?? 120,
    };

    this.log.info(
      `配置已重载：频度「${next.behavior?.replyLevel || '自定义'}」` +
        `（阈值 ${next.behavior?.replyThreshold}，每分钟最多 ${this.limiter.cfg.maxPerMinute} 条）`
    );
  }

  /** 把图片描述塞进消息文本，让模型"看得见" */
  async _describeImages(event, urls, now) {
    if (this.cfg.vision?.enabled === false) return;
    try {
      const desc = await describeImage({
        baseUrl: this.cfg.llm.baseUrl,
        apiKey: this.cfg.llm.apiKey,
        model: this.cfg.vision?.model || this.cfg.llm.model,
        url: urls[0],
      });
      if (!desc) return;
      event.text = event.text.replace('[图片]', `[图片：${desc}]`);
      event.isQuestion = isQuestion(event.text);
      this.log.info(`识图：${desc.slice(0, 40)}`);
    } catch (e) {
      this.log.debug(`识图失败：${e.message}`);
    }
  }

  _keyOf(event) {
    return event.groupId ? `g${event.groupId}` : `p${event.userId}`;
  }

  /**
   * 从界面手动发一条消息（不走模型）。
   * chat 形如 g578710075 / p705511097。
   */
  async sendManual(chat, text) {
    const key = String(chat || '').trim();
    const body = String(text || '').trim();
    if (!body) return false;
    if (body.length > 500) return false;

    if (key.startsWith('g')) {
      await this.client.sendGroupMsg(key.slice(1), body);
    } else if (key.startsWith('p')) {
      await this.client.sendPrivateMsg(key.slice(1), body);
    } else {
      this.log.warn(`手动消息的会话标识不合法：${key}`);
      return false;
    }

    // 记进上下文，让它知道自己刚说过这句。
    // 用 stateFor 而不是 states.get：会话可能是第一次出现，还没有状态。
    const st = this.stateFor(key);
    st.add({
      id: `manual-${Date.now()}`,
      userId: String(this.selfId),
      nickname: this.persona.name,
      text: body,
      time: Date.now(),
      receivedAt: Date.now(),
    });

    this.ui?.emit({
      chatId: key,
      chatName: key.startsWith('g')
        ? (this.cfg.groups?.[key.slice(1)]?.name ? `群 · ${this.cfg.groups[key.slice(1)].name}` : `群 · ${key.slice(1)}`)
        : `私聊 · ${key.slice(1)}`,
      kind: 'out',
      who: this.persona.name,
      text: body,
    });

    this.log.info(`手动发出（${key}）：${body.slice(0, 40)}`);
    return true;
  }

  // ---------------- 通知事件（实现见 notices.js） ----------------

  handleNotice(raw) {
    return notices.handleNotice(this, raw);
  }
  _nameOf(event) {
    if (event.groupId) {
      const g = this.cfg.groups?.[String(event.groupId)];
      return g?.name ? `群 · ${g.name}` : `群 · ${event.groupId}`;
    }
    return `私聊 · ${event.nickname || event.userId}`;
  }

  /** 判断这句话和它最近说过的是否重复 */
  _isRepeat(text, state) {
    const norm = (s) => String(s ?? '').replace(/[\s，。！？、~～…\.\,\!\?]/g, '');
    const a = norm(text);
    if (!a) return false;

    const mine = state.messages
      .filter((m) => String(m.userId) === String(this.selfId))
      .slice(-3);

    return mine.some((m) => {
      const b = norm(m.text);
      if (!b) return false;
      if (a === b) return true;
      if (a.length >= 4 && b.includes(a)) return true;
      if (b.length >= 4 && a.includes(b)) return true;
      return false;
    });
  }

  /**
   * 互动反馈：机器人回完一句，90 秒内这个人又说话了 → 标签 1；否则 0。
   * 具体逻辑在 engagement.js，这里只做转发。
   */
  _trackEngagement(key, event, now) {
    trackEngagement(this, key, event, now);
  }

  /** 把这次真正发给模型的东西落一份，界面上能直接看 */
  _dumpPrompt({ key, event, system, user, facts, speaker, cognition }) {
    dumpPrompt({
      dir: this.cfg.storage?.dir || 'data',
      key,
      event,
      system,
      user,
      facts,
      speaker,
      cognition,
      log: this.log,
    });
  }

  stateFor(key) {
    if (!this.states.has(key)) {
      // 把持久化记录挂进来，重启后「上次说话时间」之类的还能接上
      this.states.set(key, new GroupState({ maxMessages: 120, record: this.store.group(key) }));
    }
    return this.states.get(key);
  }

  /**
   * 当前对话窗口的轻量理解：话题、未接问题、在跟谁说。
   * 开关在 config.json 的 cognition.enabled，关掉就退回纯关键词决策。
   */
  _cognition(state, now) {
    if (this.cfg.cognition?.enabled === false) return null;
    try {
      return analyzeConversation({
        messages: state.messages,
        botId: this.selfId,
        botAliases: this.persona.aliases || [],
        now,
        windowMs: (this.cfg.cognition?.windowMinutes ?? 6) * 60_000,
        topicLimit: this.cfg.cognition?.topicCount ?? 5,
      });
    } catch (e) {
      this.log.debug(`认知层跳过：${e.message}`);
      return null;
    }
  }

  async handle(raw) {
    if (!raw || raw.post_type !== 'message') return;

    const now = Date.now();
    const key = chatKey(raw);
    const state = this.stateFor(key);

    const norm = normalizeEvent(raw, {
      selfId: this.selfId,
      now,
      resolveName: (qq) =>
        Number(qq) === this.selfId ? this.persona.name : state.nameOf(qq),
      findByMessageId: (id) => state.findByMessageId(id),
    });
    if (!norm) return; // 不是消息，或自己发的（自己的在 speak() 里记录）

    this.stats?.bump('received');

    const { event, flat, isGroup } = norm;

    // 图片：只在可能对它说的时候才识图（控制成本）
    if (flat.images?.length && (event.isPrivate || event.atSelf || containsAlias(event.text, this.persona.aliases))) {
      await this._describeImages(event, flat.images, now);
    }

    this.ui?.emit({ chatId: key, chatName: this._nameOf(event), kind: 'in', who: event.nickname, text: event.text });
    state.add(event);

    this.store.bump(key, 'messageCount');

    this.brain.touchMood(key, event, now);
    this.brain.touchUser(event, now);
    this._trackEngagement(key, event, now);
    this.brain.observe(key, state).catch(() => {});

    if (!event.text) return;

    const blocked = checkInput({ event, cfg: this.cfg, now });
    if (blocked) {
      this.log.debug(`忽略（${blocked}）：${event.text.slice(0, 30)}`);
      return;
    }

    const cognition = this._cognition(state, now);

    const decision = evaluateDecision({
      event,
      state,
      persona: this.persona,
      behavior: this.cfg.behavior,
      now,
      cognition,
    });

    // 私聊是 1 对 1，只要开着就必须回（放在打日志之前，日志才不会误导）
    if (event.isPrivate) decision.shouldReply = true;

    const where = isGroup ? `群${event.groupId}` : '私聊';
    this.log.info(
      `${where} ${event.nickname}：${event.text.slice(0, 40)} → ${
        decision.shouldReply ? '回' : '不回'
      } (${decision.score}/${decision.threshold}${decision.reasons.length ? ' ' + decision.reasons.join('+') : ''})`
    );

    if (!decision.shouldReply) {
      const sinceSpoke = now - (state.lastSpokeAt || 0);
      const lastJudge = this.lastJudgeAt.get(key) || 0;

      if (event.text.length < 4 || now - lastJudge < 8000) return;
      if (this.inflight.has(key)) return;

      // 刚跟它聊过就每条都判，否则按档位给的抽样率判，控制成本
      const win = (this.cfg.behavior?.weakJudgeSeconds ?? 180) * 1000;
      const sample = this.cfg.behavior?.weakJudgeSample ?? 0.18;
      const chance = sinceSpoke < win ? 1 : sample;
      if (Math.random() > chance) return;

      this.lastJudgeAt.set(key, now);
      const toMe = await this.brain.judgeAddress({ state, event });
      if (!toMe) {
        this.log.debug(`判定：不是在跟我说（${event.text.slice(0, 24)}）`);
        return;
      }
      this.log.info('判定：在跟我说 → 接话');
    }

    if (this.inflight.has(key)) {
      this.log.debug('同一窗口正在生成，跳过这条');
      return;
    }

    const limiter = key.startsWith('p') ? this.privateLimiter : this.limiter;
    const allow = limiter.check(key, now);
    if (!allow.ok) {
      this.log.info(`限流跳过：${allow.reason}`);
      return;
    }

    this.inflight.add(key);
    try {
      await this._generateAndReply({ event, state, key, now, cognition });
    } catch (e) {
      this.log.error(`处理失败：${e.message}`);
    } finally {
      this.inflight.delete(key);
    }
  }

  async _generateAndReply({ event, state, key, now, cognition = null }) {
    const mem = this.brain.get(key);

    // 只把和当前对话相关的事实放进 prompt，避免十几条不相干的记忆把话题带偏
    const contextText = state.messages
      .slice(-8)
      .map((m) => m.text || '')
      .join(' ');
    // 只把和当前对话相关的事实/事件放进 prompt：不相关就一条都不给
    const picked = retrieve({
      facts: mem.facts,
      events: mem.events,
      query: `${event.text || ''} ${event.text || ''} ${contextText} ${(cognition?.topics || []).join(' ')}`,
      now: Date.now(),
      limitFacts: this.cfg.cognition?.factLimit ?? 6,
      limitEvents: 3,
    });
    const facts = picked.facts;
    const events = picked.events;
    this.brain.markUsed(key, facts);

    const userId = String(event.userId || '');
    const user = this.store.data.users?.[userId];
    const profile = user ? profileOf(user) : null;
    const speaker = profile
      ? {
          name: event.nickname,
          count: user.count || 0,
          text: describeProfile(profile, {
            name: event.nickname,
            count: user.count || 0,
            affinity: user.affinity || 30,
          }),
          emojiRate: profile.style?.emoji ?? 0,
          short: profile.style?.short ?? 0,
        }
      : null;

    if (cognition?.topics?.length) this.log.debug(`当前话题：${cognition.topics.join('、')}`);
    if (cognition?.openQuestion) this.log.debug(`未接的问题：${cognition.openQuestion.from}「${cognition.openQuestion.text}」`);

    const system = buildSystemPrompt({
      persona: this.persona,
      group: event.groupId ? this.cfg.groups?.[event.groupId] : null,
      memory: { ...mem, facts, events },
      mood: mem.mood,
      users: this.brain.friends(),
      cognition,
      speaker,
      design: loadDesign(this.cfg.storage?.dir || 'data'),
    });

    const userPrompt = buildUserPrompt({
      state,
      trigger: event,
      botName: this.persona.name,
      maxMessages: this.cfg.behavior.maxContextMessages,
      maxAgeMinutes: this.cfg.behavior.contextMaxAgeMinutes ?? 180,
      cognition,
    });

    this._dumpPrompt({ key, event, system, user: userPrompt, facts, speaker, cognition });

    this.log.debug('--- system ---\n' + system);
    this.log.debug('--- user ---\n' + userPrompt);

    const tools = this.cfg.tools?.enabled === false ? null : TOOL_DEFS;

    let text = filterOutput(
      await this.llm.chatWithTools({ system, user: userPrompt, tools }),
      { botName: this.persona.name }
    );

    // 和最近说过的话重复 → 让它换一句
    if (text && this._isRepeat(text, state)) {
      this.log.info(`输出重复（${text.slice(0, 20)}），重新生成一次`);
      const retryUser = `${userPrompt}\n\n（你刚才已经说过几乎一样的话，换一种说法，不要重复）`;
      text = filterOutput(
        await this.llm.chatWithTools({ system, user: retryUser, tools }),
        { botName: this.persona.name }
      );
      if (this._isRepeat(text, state)) {
        this.log.info('换个说法后仍然重复，这条不发');
        this.store.bump(key, 'dropped');
        this.stats?.bump('dropped');
        return;
      }
    }

    if (!text) {
      this.log.warn('模型输出为空，丢弃');
      return;
    }

    if (isOutputBlocked(text, this.cfg)) {
      this.log.warn(`输出命中屏蔽词，丢弃：${text}`);
      return;
    }

    // 心情对了就顺手带个 emoji（句子里已经有就不加）；这个人爱用表情就更容易带
    const moodNow = this.store.group(key).mood ?? 60;
    if (this.cfg.emoji?.enabled !== false) {
      const base = this.cfg.emoji?.chance ?? 0.3;
      const boost = speaker && speaker.emojiRate > 0.25 ? 0.15 : 0;
      text = decorateEmoji(text, { mood: moodNow, chance: Math.min(0.8, base + boost) });
    }

    const age = Date.now() - event.receivedAt;
    const expireMs = (this.cfg.behavior.expireSeconds ?? 45) * 1000;
    if (age > expireMs) {
      this.log.info(`回复已过期（${Math.round(age / 1000)}s），丢弃：${text}`);
      this.store.bump(key, 'dropped');
      this.stats?.bump('dropped');
      return;
    }

    const sent = await this.speak(event, text);
    if (!sent) {
      this.log.warn('一条都没发出去，本轮不占用限额');
      return;
    }

    (key.startsWith('p') ? this.privateLimiter : this.limiter).commit(key, now);
    state.lastSpokeAt = Date.now();
    this.store.dirty();
    this.store.bump(key, 'replied');
    this.stats?.bump('replied');

    // 记下这次回复，等对方 90 秒内有没有接话来当训练标签
    rememberReply(this, key, event, user, profile);

    // 说完话偶尔甩个表情包，跟真人一样
    await this._maybeSticker(event, key).catch((e) => this.log.debug(`表情包没发成：${e.message}`));
  }

  /** 按心情挑一张表情包发出去；有冷却，宁可少发 */
  async _maybeSticker(event, key) {
    const cfg = this.cfg.stickers;
    if (!cfg || cfg.enabled === false) return false;
    if (!this.stickers.size) return false;

    const g = this.store.group(key);
    const now = Date.now();
    const cooldown = (cfg.cooldownMinutes ?? 8) * 60_000;
    if (now - (g.lastStickerAt || 0) < cooldown) return false;

    const hourAgo = now - 3600_000;
    g.stickerTimes = (g.stickerTimes || []).filter((t) => t > hourAgo);
    if (g.stickerTimes.length >= (cfg.maxPerHour ?? 8)) return false;

    if (Math.random() > (cfg.chance ?? 0.18)) return false;

    const file = this.stickers.pick(g.mood ?? 60);
    if (!file) return false;

    const uri = toFileUri(file);
    if (event.groupId) await this.client.sendGroupImage(event.groupId, uri);
    else await this.client.sendPrivateImage(event.userId, uri);

    g.lastStickerAt = now;
    g.stickerTimes.push(now);
    this.store.dirty();

    this.log.info(`  ↳ 表情包：${file.split(/[\\/]/).slice(-2).join('/')}`);
    this.ui?.emit({
      chatId: this._keyOf(event),
      chatName: this._nameOf(event),
      kind: 'out',
      who: this.persona.name,
      text: '[表情包]',
    });
    return true;
  }

  async speak(event, text) {
    const timing = this.cfg.timing;
    const chunks = splitReply(text, timing);
    if (!chunks.length) return 0;

    // 先假装没看到，过一会儿才回
    await sleep(readDelay(timing));

    let sent = 0;
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (i > 0) await sleep(gapDelay(timing));
        await sleep(typingDelay(chunk, timing));

        if (event.groupId) {
          await this.client.sendGroupMsg(event.groupId, chunk);
        } else {
          await this.client.sendPrivateMsg(event.userId, chunk);
        }
        sent += 1;

        this.log.info(`  ↳ ${i + 1}/${chunks.length} 发出：${chunk}`);
        this.ui?.emit({
          chatId: this._keyOf(event),
          chatName: this._nameOf(event),
          kind: 'out',
          who: this.persona.name,
          text: chunk,
        });

        // 记进上下文：它得知道自己刚说过什么（也供重复检测使用）
        const st = this.states.get(this._keyOf(event));
        st?.add({
          id: `self-${Date.now()}-${i}`,
          userId: String(this.selfId),
          nickname: this.persona.name,
          text: chunk,
          time: Date.now(),
          receivedAt: Date.now(),
        });
      }
    } catch (e) {
      this.log.warn(`发送中断（已发 ${sent} 条）：${e.message}`);
    }

    return sent;
  }

  // ---------------- 定时任务（实现见 tasks.js） ----------------

  startMaintenance() {
    return tasks.startMaintenance(this);
  }

  runMaintenance(now) {
    return tasks.runMaintenance(this, now);
  }

  runConsolidate(limit) {
    return tasks.runConsolidate(this, limit);
  }

  startProactive() {
    return tasks.startProactive(this);
  }

  _proactiveTick() {
    return tasks.proactiveTick(this);
  }
}