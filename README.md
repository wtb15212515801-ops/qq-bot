# QQ 拟人化群聊 Bot

一个挂在真实 QQ 号上的群聊机器人。它不会「有问必答」，而是先判断这句话该不该接、隔一会儿再回、把一句话拆成几条发出去。

**零依赖**：只要有 Node.js 22+，`node main.js` 就能跑。不需要 Python、Docker、数据库。

> 不想装任何东西？这里有个**网页版**，打开就能聊：<https://wtb15212515801-ops.github.io/qq-bot/>
> 纯前端一个 HTML 文件，不填 Key 是演示模式，填自己的 Key 就是真的模型。

---

## 安装（拿到安装包的人看这里）

双击 `QQ BOT 安装程序.exe`，按向导点「下一步 → 安装 → 完成」。

- 默认装在 `%LOCALAPPDATA%\QQBOT`，当前用户安装，**不需要管理员权限**
- 会创建桌面 / 开始菜单快捷方式，并在「设置 → 应用」里注册卸载入口
- 第一次启动自动弹「首次设置向导」：环境检查 → 填 API Key → 改人设 → 完成
- 向导以后想重跑：主界面「关于」→「设置向导」
- 不想安装也行：直接用免安装版文件夹，双击 `QQ BOT.exe`；数据都在 `data\`

---

## 先看效果，不需要 QQ 号

```bash
node tools/dryrun.js
```

输出会逐条告诉你：这条群消息**回还是不回、为什么**，以及最后发出的内容。

```
【群消息】张三：今天好热啊
INFO  群888888 张三：今天好热啊 → 不回 (0.62/8.5)

【群消息】张三：小满你要不要  (并 @ 了机器人)
INFO  群888888 张三：@小满 小满你要不要 → 回 (10.43/8.5 被@)
      → 发出到群 888888：欧耶！要的
```

想看模型到底收到了什么 prompt（调人设时最有用）：

```bash
node tools/prompt.js
```

---

## 网页版（不用装任何东西）

`docs/index.html` 是同一个「脑子」，换了个壳：单文件、纯前端、没有任何依赖。

```
在线：  https://wtb15212515801-ops.github.io/qq-bot/
离线：  双击 docs/index.html（file:// 也能用，不用起服务器）
```

**两种模式**

| 模式 | 怎么进 | 说明 |
|---|---|---|
| 演示 | 直接打开 | 本地规则脚本回复，**断网也能用**，用来演示性格和交互 |
| 真聊 | 右上角「设置」填自己的 DeepSeek Key | 浏览器直接调 `api.deepseek.com`，**不需要代理** |

Key 只写进你自己浏览器的 `localStorage`，不会上传到任何地方；换台电脑要重新填。

**网页版为什么连不上 QQ**

真机版是 NapCat 把 QQ 客户端包成 OneBot 接口，再让 Node 进程去连——
这两步都要在你自己的 Windows 上跑，浏览器做不到。所以网页版只保留「说话的那一层」：
人设、记忆、心情、拆句、命中率统计，全部在浏览器里重写了一遍。

想让它真的在群里说话，还是得装桌面版。

---

## 它是怎么工作的

```
QQ 服务器
   ↕  真实 QQ 协议
NTQQ 客户端（NapCat 挂在里面）
   ↕  OneBot 11（WebSocket + JSON）
main.js
   └─ pipeline.js  主流程编排
        ├─ safety.js      免打扰 / 屏蔽词 / 白名单 / AI 腔过滤
        ├─ cognition.js   轻量理解：话题 / 未接的问题 / 在跟谁说
        ├─ text.js        文本切分：中文二元组 + 英文词（理解层和检索层共用）
        ├─ retrieval.js   记忆检索：IDF 加权 + 阈值 + 去重，不相关就不给
        ├─ profile.js     每人画像：说话习惯 / 常用词 / 互动小模型
        ├─ decision.js    该不该回？（被@ 10 分、提到我 7 分、问句 1.5 分…阈值 8.5）
        ├─ context.js     拼 system prompt + 最近 N 条群聊
        ├─ brain.js       长期记忆 / 心情 / 人物关系 / 定期整理
        ├─ vision.js      图片识别（多模态）
        ├─ tools.js       联网搜索 / 计算 / 时间
        ├─ llm.js         调大模型（重试 + 工具循环）
        ├─ expression.js  emoji + 表情包
        ├─ humanize.js    等 0.6~2.5 秒 → 按字数算打字时间 → 拆成 1~3 条发出
        └─ ratelimit.js   冷却 / 每分钟 / 每小时限额
```

核心设计：**70% 的真人感来自「什么时候不说话」**，所以决策层比模型更重要。

### 它怎么「听懂」这几句

`cognition.js` 是一个不花钱的理解层——不额外调模型，只用文本统计和对话结构，得出三件事：

| 信号 | 怎么算 | 用在哪 |
|---|---|---|
| **当前话题** | 最近 6 分钟消息里的中文二元组，按出现次数和时间衰减打分，取前 5 个 | 决策里「接着聊」加分；prompt 里告诉模型在聊什么 |
| **未接的问题** | 最后一个人问的问题，之后没有机器人回复 | prompt 提醒「这个问题还没人接」；回复规矩要求优先答 |
| **在跟谁说** | 最近 3 条有没有 @ 我 / 提我名字；最后一句是不是 @ 了别人或「张三 你…」 | 在跟别人说 → 扣分不抢话；刚在说我 → 加分 |

另外还会看「同一个人连发几条」（刷屏时先别插嘴）和「一分钟内多少条」（判断热不热闹）。

记忆也跟着变聪明了：不再把 12 条事实全塞进 prompt，而是按和当前对话的相关度挑 8 条，
十几条不相干的记忆不会再把话题带偏。

不想要这层就在 `config.json` 里写 `"cognition": { "enabled": false }`，会退回纯关键词决策。

### 记忆检索（`retrieval.js`）

以前的问题：事实条数少于上限时**整包塞进 prompt**，一条都不相关时还会「回退前 N 条」，等于每次都给模型一堆旧记忆，话题很容易被带跑。

现在的做法：

1. **分词**：中文二元组 + 英文词（`text.js`），过滤口水词
2. **IDF 加权**：越常见的二元组权重越低；`张三`、`考公` 这种稀有词才拉得动分数
3. **长度封顶归一**：`√min(词数, 6)`，长事实不会因为长就被判无关
4. **双阈值**：绝对 `0.45` + 相对最高分 `35%`，达不到就丢弃
5. **去重**：两条事实 token 的 Jaccard > 0.8 视为重复
6. **事件独立检索**：事实不相关不会连累事件；事件按 7 天半衰期做一点时间加权

**结果**：查「今天好热」→ 一条记忆都不给；查「你会解行列式吗」→ 只给那条行列式的事实；查「Epsilon 说了什么」→ 给 Epsilon 相关的三条。


### 设计面板：结构化，不再是一篇作文

顶栏「更多 → 设计」里是表单，不是长长的 Markdown 输入框：

| 区块 | 内容 | 存哪 |
|---|---|---|
| 基本信息 | 名字、一句话定位 | `config.json` 的 `persona.name`（别名自动补） |
| 说话方式 | 句子长度、语气、emoji 频率、口头禅 | `data/design.json` → prompt 里的「## 说话方式」 |
| 不要聊 | 政治 / 色情 / 暴力 / 拉群引流 | 同上 |
| 示例对话 | 最多 3 组「群友说 / 它回」 | 同上，进 prompt 当语气参考 |
| API | provider / baseUrl / model / Key | `config.json`；Key 留空表示不改 |
| 高级 | 人设全文 `persona.md` | 仍可整篇编辑，保存后热重载 |

首次设置向导只在**第一次**运行出现（完成后写 `data/setup-done.json`），之后不再自动弹。
记忆清洗、在跟谁说话的判断也按 `persona.name` / `aliases` 动态生成，不再写死角色名。

### 它会慢慢认识每个人（内嵌的微型学习）

`profile.js` 是一个**零依赖、零额外 API 调用**的在线学习器，每人一份，存在 `memory.json` 的 `users[id].profile`：

| 学什么 | 方法 | 用在哪 |
|---|---|---|
| 说话习惯（长短、笑、表情、问句率） | 指数滑动平均（α=0.12） | prompt 里「你了解的这个人」 |
| 最近在聊什么 | 词权重 + 14 天半衰期 | 画像段落、回复语境 |
| 关于他的事实（喜欢/不喜欢…） | 从「我喜欢…」这类句子抽取，最多 8 条 | 同上 |
| **回什么他会接** | 5 维逻辑回归，用「回完 90 秒内他有没有继续说」当标签，在线 SGD | 决定话题贴合、语气松紧 |

不用装 Python、不用 GPU、不联网训练，聊得越多越准；每句话只多几十微秒。

**能看到它到底记住什么**：记忆面板 →「看这次发给模型的」，会列出触发消息、当前话题、未接问题、挑中的记忆、说话人画像，以及完整的 System / User prompt（`data/last-prompt.json`）。

### 记忆怎么遗忘

- 事实：按「最后一次被用到」算，14 天没被挑进 prompt 才忘；**被用过就续命**，置顶的永不遗忘
- 事件：同样按时间过期，最多留 12 条；整理时合并相似事件
- 对话：条数（25）+ 时间（3 小时）双上限，几小时前的对话不再占 prompt
- 摘要：群长期沉寂后淡出


### 会话状态放在哪

状态分两层，**不重复存储**：

| 数据 | 位置 | 生命周期 |
|---|---|---|
| 最近 120 条消息、群成员昵称 | 内存 `GroupState.messages` | 进程内 |
| 上次说话时间、消息计数、心情 | `data/memory.json` 的 `groups[key]` | 跨重启 |

`GroupState` 的 `lastSpokeAt` / `lastMessageAt` 直接读写持久化记录，
所以重启后不会「忘记自己刚说过话」而去重复插嘴。

### 清理分三层，不要混着理解

| 层 | 存在哪 | 清掉之后 |
|---|---|---|
| 屏幕记录 | 内存 feed + `data/ui.log` | 只是看不见了，重启不会复活（ui.log 一起删） |
| 最近上下文 | `GroupState.messages`（进程内存） | 机器人当这段没发生，长期记忆还在 |
| 长期记忆 | `data/memory.json` 的 summary / facts / mood | 真忘，不能撤销 |

界面顶栏的「清理」可以多选这三层，也可以选「全部会话」一次清所有窗口。
清上下文或记忆要求机器人正在运行——状态在它内存里，外部直接改文件会被下一次落盘覆盖。

事实卡支持「置顶」：置顶的不参与 `forget()` 的时间衰减，也不会被 `tidy()` 按条数裁掉；
记忆面板会显示每条事实是多久前记下的。

### 测试

```bash
npm test     # 158 个用例：决策 / 认知 / 上下文 / 拟人化 / 安全 / 记忆 / 表情 / 计算
```

改完核心逻辑先跑这个，比手动试聊天快得多。

---

## 目录结构

```
qq-bot/
├─ main.js                入口（单实例保护 + 全局异常兜底）
├─ config.json            配置（由 config.example.json 复制）
├─ persona.md             人设（由 persona.example.md 复制）
├─ docs/
│  └─ index.html          网页版（单文件，可直接部署 GitHub Pages）
├─ src/
│  ├─ onebot.js           OneBot 11 WebSocket 客户端
│  ├─ pipeline.js         主流程编排
│  ├─ decision.js         参与决策
│  ├─ context.js          上下文组装 + 会话状态
│  ├─ brain.js            长期记忆 / 心情 / 关系 / 整理
│  ├─ memory.js           记忆落盘
│  ├─ llm.js              大模型调用（重试 + 工具循环）
│  ├─ tools.js            工具：搜索 / 计算 / 时间
│  ├─ vision.js           图片识别
│  ├─ expression.js       emoji + 表情包
│  ├─ humanize.js         延迟 / 打字 / 分段
│  ├─ safety.js           免打扰 / 屏蔽 / AI 腔过滤
│  ├─ ratelimit.js        限流
│  ├─ logger.js           日志（5MB 运行时轮转）
│  ├─ config.js           配置加载
│  ├─ events.js          事件归一化（纯函数）
│  ├─ tasks.js           定时任务：维护 / 压缩 / 主动发言
│  ├─ presets.js         回应频度档位
│  ├─ ui.js               桌面界面事件流
│  └─ message.js          消息段解析
├─ test/                  单元测试（node --test）
├─ data/
│  └─ stickers/           表情包图库（按心情分文件夹）
└─ tools/
   ├─ dryrun.js           离线模拟（不需要 QQ / API Key）
   ├─ tidy.js             记忆体检
   ├─ level-check.js      档位接话率体检
   ├─ soak.js             压测（找泄漏）
   └─ fakenapcat.mjs      假 NapCat 服务端（全链路联调）
```

---

## 一、准备工作

### 1. 一个 QQ 小号（不要用主号）

新注册的号一眼假，也更容易被风控。建议：

- 绑手机号、完成实名
- 正常使用 1~2 周：加几个群、和人聊几句、有几个好友
- 把 QQ 等级养起来（一个太阳比一个月亮可信得多）
- 头像、昵称、签名、资料卡填得像真人

### 2. 一个大模型 API Key

推荐 DeepSeek（中文自然、便宜）：<https://platform.deepseek.com/>

任何 OpenAI 兼容接口都能用，改 `llm.baseUrl` 和 `llm.model` 即可。

### 3. Node.js 22 或更高

<https://nodejs.org/> 下载 LTS 版。装完验证：

```bash
node -v
```

### 4. NapCatQQ

见下一节。

---

## 二、安装 NapCat

### Windows 一键安装（推荐）

1. 下载 [NapCat.Shell.Windows.OneKey.zip](https://github.com/NapNeko/NapCatQQ/releases/latest)
2. 解压，运行 `NapCatInstaller.exe`
3. 进入生成的 `NapCat.XXXX.Shell` 目录，双击 `napcat.bat`
4. 按提示用手机 QQ 扫码登录
5. 控制台会给出 WebUI 地址（一般是 `http://127.0.0.1:6099/webui`）和 token

> 已经装过 QQ 的话，也可以下载 `NapCat.Shell.zip`，双击 `launcher.bat`（Win10 用 `launcher-win10.bat`）。
> 想直接指定 QQ 号登录：`launcher.bat 你的QQ号`

### 打开 WebSocket 服务

1. 浏览器打开 WebUI，用控制台给出的 token 登录
2. 进入「网络配置」→ 新建 → **WebSocket 服务器**
3. 按下面填：

| 项 | 值 |
|---|---|
| 端口 | `3001` |
| Token | 自己设一个，比如 `my-secret-token-123` |
| 消息格式 | `array` |
| 上报自身消息 | 关（否则会自己回自己） |

4. 保存并启用

如果 WebUI 里找不到，可以直接改 `napcat/config/` 下对应的配置文件，重启 NapCat。

### 验证

浏览器或命令行能连上 `ws://127.0.0.1:3001` 就说明通了。不需要验证，下一步项目会连。

---

## 三、配置本项目

```bash
cd qq-bot
npm run init
```

`npm run init` 会把首次运行需要的东西一次准备好，**已存在的文件不会覆盖**：

- `config.json` ← 从 `config.example.json` 复制
- `persona.md` ← 从 `persona.example.md` 复制（人格与初始设定）
- `data/`、`data/memory.json` ← 空的记忆库（会话摘要、事实、情绪值都存这里）

也可以手动复制（Linux/macOS 用 `cp`）：

```bash
copy config.example.json config.json
copy persona.example.md persona.md
```

`node main.js` 启动时如果发现缺文件，也会自动补上面这些，所以别人拿到压缩包直接运行也不会因为少文件而报错。

编辑 `config.json`，至少改这三处：

```jsonc
{
  "onebot": {
    "url": "ws://127.0.0.1:3001",
    "accessToken": "my-secret-token-123",   // ← 和 NapCat 里设的一致
    "selfId": 0                              // ← 0 = 自动从 NapCat 获取
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-你的key",                  // ← 填这里
    "model": "deepseek-chat"
  },
  "persona": {
    "name": "小满",                        // ← 机器人的人设名
    "aliases": ["小满", "小满"],           // ← 别人叫这些名字也算"在叫我"
    "interests": ["薯片", "虾米糊糊"]        // ← 命中这些词会更容易接话
  },
  "groups": {
    "123456789": {                           // ← 改成你的群号
      "name": "闲聊群",
      "vibe": "学生为主，晚上活跃，爱发表情包和开玩笑",
      "memes": ["欧耶", "欧漏"]
    }
  }
}
```

`groups` 不填也能跑，只是模型不知道这个群是什么氛围。

---

## 四、先联调，再上线

### 第一步：假 NapCat（不需要 QQ）

开两个终端：

```bash
# 终端 1
node tools/fakenapcat.mjs 39998

# 终端 2：临时把 config.json 的 onebot.url 改成 ws://127.0.0.1:39998，
# 并把 llm.provider 改成 "mock"，然后：
node main.js
```

终端 1 会打印机器人发出的内容。这条链路通了，说明代码没问题，剩下的都是 QQ 那头的事。

### 第二步：私聊自己

改回真配置，`node main.js`，用另一个号私聊机器人。私聊是 100% 会回的，用来确认收发正常。

### 第三步：拉进小号群

拉一个只有自己几个号的群，观察 1~2 天。重点看：

- 是不是每条都回（太频繁 → 调高 `replyThreshold`）
- 回复是不是太长（→ 调小 `maxCharsPerSegment` 或改 prompt）
- 会不会答非所问（→ 调小 `expireSeconds`）

稳定了再考虑拉进真实的群。

---

## 五、调参速查

| 现象 | 改哪里 |
|---|---|
| 回得太频繁 | `behavior.replyThreshold` 调高（8.5 → 10） |
| 几乎不说话 | `replyThreshold` 调低，或 `interests` 加词 |
| 回复太长 | `timing.maxCharsPerSegment` 调小（45 → 25），prompt 里加「最多 20 字」 |
| 回得太快 | `timing.readDelayMs` 调大 |
| 回得太慢 | `timing.typingMsPerChar` 调小 |
| 消息拆得太碎 | `timing.maxSegments` 改成 1 |
| 晚上还在说话 | 检查 `behavior.quietHours` |
| 总是重复同一句 | `llm.temperature` 调高一点（1.0 → 1.15） |
| 说话太书面 | 改 `persona.md` 里的「说话习惯」，加 few-shot 例子 |
| 群里聊得太快、它总是答旧话题 | `behavior.expireSeconds` 调小（45 → 20） |

---

## 六、配置项完整说明

### `onebot`
| 字段 | 说明 |
|---|---|
| `url` | NapCat 的 WebSocket 地址 |
| `accessToken` | 与 NapCat 里配置的一致，没有就留空 |
| `selfId` | 机器人 QQ 号，0 表示自动获取 |
| `reconnectMs` | 断线重连初始间隔 |

### `llm`
| 字段 | 说明 |
|---|---|
| `provider` | `openai`（任何 OpenAI 兼容接口）或 `mock`（固定句子，测试用） |
| `baseUrl` | 接口地址，不带 `/chat/completions` |
| `model` | 模型名 |
| `temperature` | 0.9~1.15 比较有「人味」，太低会很机械 |
| `maxTokens` | 单次生成长度上限，120 足够 |

### `behavior`
| 字段 | 默认 | 说明 |
|---|---|---|
| `replyThreshold` | 8.5 | 决策分数阈值，越高越少说话 |
| `spontaneousChance` | 0.015 | 每条消息的「随机插话」概率 |
| `spontaneousCooldownSec` | 180 | 距离上次发言至少多久才允许随机插话 |
| `maxContextMessages` | 25 | 喂给模型的历史消息条数 |
| `expireSeconds` | 45 | 生成超过这个时间就丢弃，避免答非所问 |
| `quietHours` | `["23:30","08:00"]` | 免打扰时段 |
| `replyInQuietHoursWhenAt` | false | 免打扰时段被 @ 也不回 |
| `privateReply` | true | 是否回私聊 |

### `cognition`
| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉后退回纯关键词决策，不做话题/未接问题分析 |
| `windowMinutes` | 6 | 看最近多久的消息来推话题 |
| `topicCount` | 5 | 最多提取几个话题关键词 |
| `factLimit` | 8 | 每次最多塞几条相关记忆进 prompt |

### `timing`
| 字段 | 默认 | 说明 |
|---|---|---|
| `readDelayMs` | `[600,2500]` | 看到消息后多久开始「打字」 |
| `typingMsPerChar` | `[220,520]` | 每字打字耗时，10 个字约 2.4~5 秒 |
| `typingMaxMs` | 8000 | 打字延迟上限 |
| `gapBetweenSegmentsMs` | `[500,1500]` | 多条之间的停顿 |
| `maxSegments` | 3 | 一条回复最多拆成几条 |
| `maxCharsPerSegment` | 45 | 每条的软长度上限 |
| `scale` | 1 | 全局缩放，调试时设 0.1 |

### `limits`
| 字段 | 默认 | 说明 |
|---|---|---|
| `minGapSeconds` | 15 | 同一窗口两次发言的最小间隔 |
| `maxPerMinute` | 3 | 每分钟上限 |
| `maxPerHour` | 12 | 每小时上限（保命参数，别调太高） |

> 这几项在选用「回应频度」档位时会被档位覆盖，见 `behavior.replyLevel`。

### `notices`
群里除了聊天，还有入群、退群、撤回、戳一戳这些事件。默认全开，嫌吵可以关：

| 字段 | 默认 | 说明 |
|---|---|---|
| `welcome` | true | 有人入群时 @ 他打声招呼（同群 30 秒内只发一次） |
| `farewell` | true | 有人退群/被踢时说一句（同群 60 秒一次） |
| `poke` | true | 被戳时戳回去；协议端不支持就退化成文字 |
| `recallCleanup` | true | 有人撤回消息时，把那条从上下文删掉，避免对着空气接话 |

### `safety`
| 字段 | 说明 |
|---|---|
| `blockedWords` | 消息里出现这些词直接无视 |
| `blockedUsers` | 不回这些人 |
| `allowGroups` | 白名单，非空时只回这些群 |
| `denyGroups` | 黑名单 |

---

## 七、长期运行

### Windows
用 `pm2` 或「任务计划程序」开机自启：

```bash
npm install -g pm2
pm2 start main.js --name qqbot
pm2 save
```

NapCat 本身也需要保持运行（`napcat.bat` 的窗口别关）。

### Linux / 云服务器
NapCat 官方提供 Docker：

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: 换成你自己的token
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
```

```bash
docker compose up -d
```

然后 `pm2 start main.js --name qqbot`。

> 云服务器的 IP 是机房段，风控上比家宽吃亏。家里有旧电脑/NAS 的话，放家里更稳。

### 终端中文乱码（Windows）
```bash
chcp 65001
```

---

## 八、常见问题

**连不上 NapCat（一直「3 秒后重连」）**
1. NapCat 是否在运行、QQ 是否在线
2. WebUI 里「WebSocket 服务器」是否启用
3. 端口是不是 3001，`config.json` 的 `url` 对没对
4. Token 是否两边一致
5. 防火墙是否拦了本地端口

**能连上但收不到群消息**
- NapCat 网络配置里确认「群消息」事件已勾选
- 确认「上报自身消息」是关的，否则会自己回自己
- 先私聊测试，私聊通说明协议层没问题

**发消息失败 `retcode=...`**
- 常见是风控（发太快）或群被禁言
- 把 `limits.maxPerHour` 调低，`minGapSeconds` 调高

**模型回复还是像 AI**
- 改 `persona.md`，加 10~20 条「这个角色真实会说的话」当例子
- `temperature` 调到 1.1 左右
- 把 `maxCharsPerSegment` 调小，逼它说短句

**记忆丢失**
- 数据在 `data/memory.json`（摘要 / 事实卡 / 事件 / 心情 / 人物关系都在这里），删了就没了，记得备份
- 想主动清：顶栏「清理」可以只清一层，见上面「清理分三层」
- 机器人在线时由它执行（改内存+落盘），不在线时直接改 `memory.json`（`tools/memclear.cjs`）
- 清掉之后不是永久失忆：再聊够 40 条会重新总结出摘要、事实和事件

---

## 九、可以继续加的东西

按性价比排序：

1. **人物记忆**：现在事实是群级的，做不到「关于张三，它记得什么」；需要给事实加 `subject`，并从 @/称呼里归因
2. **向量检索**：现在是字符二元组算相关性，换成 embedding 后对同义改写更稳
3. **记忆可解释性**：把「这次到底选了哪几条记忆、哪个话题、有没有未接问题」在界面上列出来，调人设时最有用
4. **多群差异化**：每个群一套人设、阈值和回复频度（目前 `groups` 只能配氛围和梗）
5. **作息表**：按小时给不同活跃度，白天几乎不回、晚上活跃（现在只有整段免打扰）
6. **主动话题**：冷场时从「今天发生的事」里挑一个抛出来

---

## 十、风险与底线

- **用非官方协议端违反 QQ 用户协议**，封号风险真实存在，用小号、别心疼
- QQ 对发送频率、重复内容、新注册账号都有风控，`limits` 里的数字不是随便定的，别往大调
- **不要用来**：诈骗、冒充真人骗钱骗感情、骚扰、刷屏、冒充公众人物
- 群里都是真人，长期保存他人聊天记录涉及隐私，注意 `data/` 目录的存放
- 如果只是想要「AI 陪聊」体验，Telegram / Discord 没有封号风险，能省掉一半麻烦

---

## 构建与发布

需要：Node.js 22、.NET Framework 4.x 自带的 `csc.exe`、WebView2 Runtime（Win10/11 一般已装）。

**直接跑机器人（控制台）**

```bash
node main.js
```

**编译桌面壳（`QQ BOT.exe`）**

```bat
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /platform:x86 /optimize+ ^
  /out:"QQ BOT.exe" /win32icon:assets\icon.ico ^
  /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll ^
  App.cs App.Http.cs App.Http.Settings.cs App.Http.Memory.cs
```

必须是 **x86**：仓库里的 `WebView2Loader.dll` 是 32 位的，x64 会报 `0x8007000B`。

**打包安装程序**

```bat
:: 1) 把 dist\QQ BOT\ 整个目录压成 installer\payload.zip
:: 2) 编译安装器
csc /target:winexe /win32icon:assets\icon.ico ^
  /resource:payload.zip,payload.zip ^
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ^
  /out:"QQ BOT 安装程序.exe" Setup.cs
```

**测试**

```bash
node --test "test/*.test.js"
```

> 仓库里不含 `config.json` / `persona.md` / `data/`：这三样是每台机器本地的私密配置与聊天数据。
> 首次运行会用 `config.example.json`、`persona.example.md` 自动生成。

展开看 [目录结构](#目录结构)。

---

## 附：常用命令

```bash
npm run init                     # 初始化 config.json / persona.md / data/memory.json（不覆盖已有文件）
node tools/dryrun.js             # 离线模拟决策（不需要 QQ / API Key）
node tools/prompt.js             # 打印模型实际收到的完整 prompt
node tools/groups.js             # 列出机器人所在的群和群号
node tools/fakenapcat.mjs 39998  # 起假 NapCat
node main.js                     # 正式启动
node main.js 其他配置.json        # 用指定配置文件启动
```

配套文档：

- [persona.md](persona.md)：当前人设
- [README](README.md)：安装、配置与排障都在这里
