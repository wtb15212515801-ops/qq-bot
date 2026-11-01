using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/// <summary>
/// MainForm 的 HTTP 与接口部分：本地 Web 服务、各 API 处理、JSON 工具。
/// 拆出来是为了让 App.cs 只保留「表单 + 进程 + 启动」。
/// </summary>
partial class MainForm
{
    // ---------------- HTTP ----------------

    void StartHttp()
    {
        for (int p = 8765; p <= 8775; p++)
        {
            try
            {
                http = new TcpListener(IPAddress.Loopback, p);
                http.Start();
                port = p;
                var t = new Thread(HttpLoop) { IsBackground = true };
                t.Start();
                return;
            }
            catch { }
        }
    }

    void HttpLoop()
    {
        while (true)
        {
            try
            {
                var client = http.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate { HandleClient(client); });
            }
            catch { Thread.Sleep(200); }
        }
    }

    void HandleClient(object o)
    {
        var client = (TcpClient)o;
        try
        {
            using (client)
            {
                var ns = client.GetStream();

                // 先把请求头按字节读到空行为止。
                // 注意不能直接用 StreamReader 读 body：Content-Length 是字节数，
                // 中文 UTF-8 一个字符占 3 字节，按字符读会一直等不到够数的数据。
                var headBuf = new System.Collections.Generic.List<byte>(512);
                int b;
                while ((b = ns.ReadByte()) >= 0)
                {
                    headBuf.Add((byte)b);
                    int n = headBuf.Count;
                    if (n >= 4 && headBuf[n - 4] == 13 && headBuf[n - 3] == 10 && headBuf[n - 2] == 13 && headBuf[n - 1] == 10)
                        break;
                }

                string headText = Encoding.ASCII.GetString(headBuf.ToArray());
                string[] headLines = headText.Split(new[] { "\r\n" }, StringSplitOptions.None);
                if (headLines.Length == 0 || string.IsNullOrEmpty(headLines[0])) return;

                var parts = headLines[0].Split(' ');
                if (parts.Length < 2) return;
                string path = parts[1];

                int len = 0;
                for (int i = 1; i < headLines.Length; i += 1)
                {
                    if (headLines[i].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                        int.TryParse(headLines[i].Substring(15).Trim(), out len);
                }

                string body = "";
                if (len > 0)
                {
                    var buf = new byte[len];
                    int read = 0;
                    while (read < len)
                    {
                        int n = ns.Read(buf, read, len - read);
                        if (n <= 0) break;
                        read += n;
                    }
                    body = Encoding.UTF8.GetString(buf, 0, read);
                }

                string outBody;
                string contentType = "application/json; charset=utf-8";
                int status = 200;

                if (path == "/" || path.StartsWith("/index"))
                {
                    string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui", "index.html");
                    outBody = File.Exists(file)
                        ? File.ReadAllText(file, Encoding.UTF8)
                        : "<h3>找不到 ui/index.html</h3>";
                    contentType = "text/html; charset=utf-8";
                }
                else if (path.StartsWith("/api/state"))
                {
                    outBody = StateJson();
                }
                else if (path.StartsWith("/api/messages"))
                {
                    outBody = MessagesJson(path);
                }
                else if (path.StartsWith("/api/memory"))
                {
                    outBody = MemoryJson(path);
                }
                else if (path.StartsWith("/api/persona"))
                {
                    outBody = (parts[0] == "POST" || body.Length > 0) ? SavePersona(body) : PersonaJson();
                }
                else if (path.StartsWith("/api/setup"))
                {
                    outBody = SetupJson();
                }
                else if (path.StartsWith("/api/design"))
                {
                    outBody = (parts[0] == "POST" || body.Length > 0) ? SaveDesign(body) : DesignJson();
                }
                else if (path.StartsWith("/api/shot"))
                {
                    outBody = ShotJson(path);
                }
                else if (path.StartsWith("/api/config"))
                {
                    outBody = (parts[0] == "POST" || body.Length > 0) ? SaveConfig(body) : ConfigJson();
                }
                else if (path.StartsWith("/api/clear"))
                {
                    outBody = (parts[0] == "POST" || body.Length > 0) ? ClearChat(body) : "{\"ok\":false,\"error\":\"use POST\"}";
                }
                else if (path.StartsWith("/api/lastprompt"))
                {
                    outBody = LastPromptJson();
                }
                else if (path.StartsWith("/api/stats"))
                {
                    outBody = StatsJson(path);
                }
                else if (path.StartsWith("/api/control"))
                {
                    // 记忆存在机器人内存里，它没跑就没人执行，直接拒绝而不是假装成功
                    outBody = (bot == null || bot.HasExited)
                        ? "{\"ok\":false,\"error\":\"机器人没在运行\"}"
                        : EnqueueControl(body);
                }
                else if (path.StartsWith("/api/diag"))
                {
                    LogApp("DIAG " + path);
                    outBody = "{\"ok\":true}";
                }
                else if (path.StartsWith("/api/action"))
                {
                    outBody = ActionJson(body);
                }
                else
                {
                    status = 404;
                    outBody = "{\"error\":\"not found\"}";
                }

                var bytes = Encoding.UTF8.GetBytes(outBody);
                var head = "HTTP/1.1 " + status + " OK\r\n" +
                           "Content-Type: " + contentType + "\r\n" +
                           "Content-Length: " + bytes.Length + "\r\n" +
                           "Cache-Control: no-store\r\n" +
                           "Connection: close\r\n\r\n";
                var headBytes = Encoding.ASCII.GetBytes(head);
                ns.Write(headBytes, 0, headBytes.Length);
                ns.Write(bytes, 0, bytes.Length);
                ns.Flush();
            }
        }
        catch { }
    }


    static bool IsValidLevel(string level)
    {
        return level == "quiet" || level == "normal" || level == "active" || level == "chatty";
    }

    /// <summary>读 config.json 里当前的回应频度档位</summary>
    string LevelOfConfig()
    {
        try
        {
            var m = System.Text.RegularExpressions.Regex.Match(ConfigText(), "\"replyLevel\"\\s*:\\s*\"([a-zA-Z]+)\"");
            if (m.Success && IsValidLevel(m.Groups[1].Value)) return m.Groups[1].Value;
        }
        catch { }
        return "normal";
    }

    /// <summary>写入档位；机器人监听到文件变化会自己热重载</summary>
    bool SetLevelInConfig(string level)
    {
        if (!IsValidLevel(level)) return false;
        try
        {
            string p = ConfigPath();
            string text = File.ReadAllText(p, Encoding.UTF8);
            var re = new System.Text.RegularExpressions.Regex("\"replyLevel\"\\s*:\\s*\"[a-zA-Z]+\"");

            if (re.IsMatch(text))
            {
                text = re.Replace(text, "\"replyLevel\": \"" + level + "\"", 1);
            }
            else
            {
                var b = System.Text.RegularExpressions.Regex.Match(text, "\"behavior\"\\s*:\\s*\\{");
                if (!b.Success) return false;
                text = text.Insert(b.Index + b.Length, "\n    \"replyLevel\": \"" + level + "\",");
            }

            File.WriteAllText(p, text, new UTF8Encoding(false));
            InvalidateConfigCache();
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>界面里手动发一句：写进发件箱，机器人进程会读出来发出去</summary>
    static void EnqueueOutgoing(string chat, string text)
    {
        string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
        Directory.CreateDirectory(dir);

        string line = "{\"chat\":\"" + JsonEscape(chat) + "\",\"text\":\"" + JsonEscape(text) + "\"}";
        File.AppendAllText(Path.Combine(dir, "outbox.jsonl"), line + "\n", new UTF8Encoding(false));
    }

    // ---------------- NapCat 位置：可配置 + 自动探测 ----------------

    string AppConfigPath()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.json");
    }

    string ReadAppConfig()
    {
        try
        {
            string file = AppConfigPath();
            if (!File.Exists(file)) return "";
            string text = File.ReadAllText(file, Encoding.UTF8);
            var m = System.Text.RegularExpressions.Regex.Match(text, "\"napcatDir\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value.Replace("\\\\", "\\") : "";
        }
        catch
        {
            return "";
        }
    }

    void WriteAppConfig()
    {
        try
        {
            string file = AppConfigPath();
            if (File.Exists(file)) return; // 不覆盖用户改过的
            string json =
                "{\n" +
                "  \"napcatDir\": \"" + napcatDir.Replace("\\", "\\\\") + "\",\n" +
                "  \"uiPort\": 8765,\n" +
                "  \"_说明\": \"napcatDir 是 NapCat 的 Shell 目录，里面应有 launcher.bat\"\n" +
                "}\n";
            File.WriteAllText(file, json, new UTF8Encoding(false));
        }
        catch { }
    }

    static bool HasLauncher(string dir)
    {
        try
        {
            return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "launcher.bat"));
        }
        catch
        {
            return false;
        }
    }

    void ResolveNapcatDir()
    {
        string configured = ReadAppConfig();
        if (HasLauncher(configured))
        {
            napcatDir = configured;
            return;
        }

        var candidates = new List<string>();
        string env = Environment.GetEnvironmentVariable("NAPCAT_DIR");
        if (!string.IsNullOrEmpty(env)) candidates.Add(env);
        candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "NapCat", "Shell"));
        candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "NapCat", "Shell"));
        candidates.Add(@"C:\NapCat\Shell");
        candidates.Add(@"D:\NapCat\Shell");
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NapCat", "Shell"));

        foreach (string c in candidates)
        {
            if (HasLauncher(c))
            {
                napcatDir = Path.GetFullPath(c);
                LogApp("自动找到 NapCat：" + napcatDir);
                WriteAppConfig();
                return;
            }
        }

        napcatDir = configured;
        LogApp("没找到 NapCat，请在 app.json 里填 napcatDir");
        WriteAppConfig();
    }

    static string JsonEscape(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') { }
            else if (c == '\t') sb.Append(' ');
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    string StateJson()
    {
        bool napcat = portsChecked ? napcatOnline : PortOpen(3001, 80);
        bool webui = portsChecked ? webuiOnline : PortOpen(6099, 80);
        bool botAlive = bot != null && !bot.HasExited;
        string qr = napcat ? "" : QrDataUrl();

        var sb = new StringBuilder();
        sb.Append("{\"napcat\":").Append(napcat ? "true" : "false");
        sb.Append(",\"webui\":").Append(webui ? "true" : "false");
        sb.Append(",\"bot\":").Append(botAlive ? "true" : "false");
        sb.Append(",\"hint\":\"").Append(JsonEscape(loginLost ? "账号掉线（可能被手机顶了）" : (napcat ? "" : "等待 NapCat 登录"))).Append("\"");
        sb.Append(",\"qr\":\"").Append(qr).Append("\"");
        sb.Append(",\"level\":\"").Append(LevelOfConfig()).Append("\"");
        sb.Append(",\"napcatDir\":\"").Append(JsonEscape(napcatDir ?? "")).Append("\"");
        sb.Append(",\"gen\":").Append(feedGen);
        sb.Append(",\"chats\":[{\"key\":\"all\",\"name\":\"全部\",\"count\":").Append(total).Append(",\"unread\":0}");

        lock (feedLock)
        {
            var seen = new HashSet<string>();
            for (int i = feed.Count - 1; i >= 0; i--)
            {
                var f = feed[i];
                if (string.IsNullOrEmpty(f.Key) || seen.Contains(f.Key)) continue;
                seen.Add(f.Key);
                int c = 0;
                for (int j = 0; j < feed.Count; j++) if (feed[j].Key == f.Key) c++;
                int u;
                unread.TryGetValue(f.Key, out u);
                sb.Append(",{\"key\":\"").Append(JsonEscape(f.Key))
                  .Append("\",\"name\":\"").Append(JsonEscape(f.Name))
                  .Append("\",\"count\":").Append(c)
                  .Append(",\"unread\":").Append(u).Append("}");
            }

            // 清掉屏幕记录后，会话本身还在（记忆、人设都还挂在这个 key 上），
            // 所以要把名册里没出现在 feed 里的会话补回来，否则侧栏会“整个消失”。
            foreach (var kv in knownChats)
            {
                if (seen.Contains(kv.Key)) continue;
                seen.Add(kv.Key);
                int u;
                unread.TryGetValue(kv.Key, out u);
                sb.Append(",{\"key\":\"").Append(JsonEscape(kv.Key))
                  .Append("\",\"name\":\"").Append(JsonEscape(kv.Value))
                  .Append("\",\"count\":0,\"unread\":").Append(u).Append("}");
            }
        }
        sb.Append("]}");
        return sb.ToString();
    }

    /// <summary>上次真正发给模型的内容（机器人每次回复时写入 data/last-prompt.json）</summary>
    string LastPromptJson()
    {
        try
        {
            string file = Path.Combine(AppDir(), "data", "last-prompt.json");
            if (!File.Exists(file)) return "{\"empty\":true}";
            return File.ReadAllText(file, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            return "{\"empty\":true,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    /// <summary>把当前 WebView 截一张图写到 data/shot.png，用来确认界面到底长什么样。</summary>
    string ShotJson(string path)
    {
        try
        {
            string click = "";
            int ci = path.IndexOf("click=");
            if (ci >= 0)
            {
                click = path.Substring(ci + 6);
                int amp = click.IndexOf('&');
                if (amp >= 0) click = click.Substring(0, amp);
                click = Uri.UnescapeDataString(click);
                if (!System.Text.RegularExpressions.Regex.IsMatch(click, "^[A-Za-z0-9_,-]+$")) click = "";
            }

            var done = new System.Threading.Tasks.TaskCompletionSource<bool>();
            string file = Path.Combine(AppDir(), "data", "shot.png");

            BeginInvoke((Action)(async delegate
            {
                try
                {
                    if (click.Length > 0)
                    {
                        foreach (string id in click.Split(','))
                        {
                            if (id.Length == 0) continue;
                            await web.CoreWebView2.ExecuteScriptAsync(
                                "document.getElementById('" + id + "').click()");
                            await System.Threading.Tasks.Task.Delay(150);
                        }
                        await System.Threading.Tasks.Task.Delay(150);
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    using (var stream = File.Create(file))
                    {
                        await web.CoreWebView2
                            .CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, stream);
                    }
                    done.TrySetResult(true);
                }
                catch (Exception ex)
                {
                    done.TrySetException(ex);
                }
            }));

            if (!done.Task.Wait(10000)) return "{\"ok\":false,\"error\":\"截图超时\"}";
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }


    string MessagesJson(string path)
    {
        string chat = "all";
        int after = 0;
        int ci = path.IndexOf("chat=");
        if (ci >= 0)
        {
            string v = path.Substring(ci + 5);
            int amp = v.IndexOf('&');
            if (amp >= 0) v = v.Substring(0, amp);
            chat = Uri.UnescapeDataString(v);
            activeChat = chat;
            lock (feedLock) { unread[chat] = 0; }
        }
        int ai = path.IndexOf("after=");
        if (ai >= 0)
        {
            string v = path.Substring(ai + 6);
            int amp = v.IndexOf('&');
            if (amp >= 0) v = v.Substring(0, amp);
            int.TryParse(v, out after);
        }

        var sb = new StringBuilder();
        sb.Append("{\"seq\":").Append(seq).Append(",\"total\":").Append(total).Append(",\"lines\":[");
        bool first = true;
        lock (feedLock)
        {
            for (int i = 0; i < feed.Count; i++)
            {
                var f = feed[i];
                if (f.Seq <= after) continue;
                if (chat != "all" && f.Key != chat) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"t\":\"").Append(JsonEscape(f.Time))
                  .Append("\",\"key\":\"").Append(JsonEscape(f.Key))
                  .Append("\",\"kind\":\"").Append(JsonEscape(f.Kind))
                  .Append("\",\"who\":\"").Append(JsonEscape(f.Who))
                  .Append("\",\"text\":\"").Append(JsonEscape(f.Text)).Append("\"}");
            }
        }
        sb.Append("]}");
        return sb.ToString();
    }

    /// <summary>容忍空格地读布尔字段：{"display": true}</summary>
    static bool JsonBool(string body, string name)
    {
        if (string.IsNullOrEmpty(body)) return false;
        var re = new System.Text.RegularExpressions.Regex(
            "\"" + System.Text.RegularExpressions.Regex.Escape(name) + "\"\\s*:\\s*(true|false)");
        var m = re.Match(body);
        return m.Success && string.Equals(m.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 从简单 JSON 里取字符串字段。
    /// 必须匹配「"key" 冒号 引号」，否则 {"type":"level"} 里的值会把别的字段带偏。
    /// </summary>
    static string JsonField(string body, string name)
    {
        if (string.IsNullOrEmpty(body)) return "";

        var re = new System.Text.RegularExpressions.Regex(
            "\"" + System.Text.RegularExpressions.Regex.Escape(name) + "\"\\s*:\\s*\"");
        var m = re.Match(body);
        if (!m.Success) return "";

        // 从开引号后逐字符解析：处理 \" \\ \n \uXXXX 等转义，
        // 否则带引号的人设文本会在第一个引号处被截断。
        var sb = new StringBuilder();
        int i = m.Index + m.Length;
        while (i < body.Length)
        {
            char c = body[i++];
            if (c == '"') break;
            if (c != '\\')
            {
                sb.Append(c);
                continue;
            }
            if (i >= body.Length) break;

            char e = body[i++];
            switch (e)
            {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    if (i + 4 <= body.Length)
                    {
                        int code;
                        if (int.TryParse(body.Substring(i, 4),
                                System.Globalization.NumberStyles.HexNumber, null, out code))
                        {
                            sb.Append((char)code);
                            i += 4;
                        }
                    }
                    break;
                default:
                    sb.Append(e);
                    break;
            }
        }
        return sb.ToString();
    }

    // ---------------- 通用化：人设 / 统计 / 控制 ----------------

    string AppDir()
    {
        return AppDomain.CurrentDomain.BaseDirectory;
    }






    // ---------------- 首次设置向导 ----------------

    /// <summary>读 config.json 里的一个字符串字段。</summary>
    // 配置文本缓存：状态接口每秒轮询，避免每秒重复读盘
    string cfgCachePath = "";
    DateTime cfgCacheAt = DateTime.MinValue;
    string cfgCacheText = "";
    readonly object cfgCacheLock = new object();










    // ---------------- 设计：结构化人设 + API 信息 ----------------




    // ---------------- 首次设置标记 ----------------




    // ---------------- 清理：显示 / 上下文 / 长期记忆 三层分开 ----------------




    string StatsJson(string path)
    {
        int hours = 24;
        int hi = path.IndexOf("hours=");
        if (hi >= 0)
        {
            string v = path.Substring(hi + 6);
            int amp = v.IndexOf('&');
            if (amp >= 0) v = v.Substring(0, amp);
            int.TryParse(v, out hours);
        }
        if (hours < 1) hours = 1;
        if (hours > 72) hours = 72;

        try
        {
            string file = Path.Combine(AppDir(), "data", "stats.json");
            if (!File.Exists(file)) return "{\"hours\":[]}";

            var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
            var root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            object hoursObj;
            var buckets = new Dictionary<string, object>();
            if (root != null && root.TryGetValue("hours", out hoursObj))
                buckets = hoursObj as Dictionary<string, object> ?? new Dictionary<string, object>();

            var sb = new StringBuilder("{\"hours\":[");
            for (int i = hours - 1; i >= 0; i -= 1)
            {
                var d = DateTime.Now.AddHours(-i);
                string key = d.ToString("yyyy-MM-dd") + "T" + d.ToString("HH");
                object b;
                buckets.TryGetValue(key, out b);
                var dict = b as Dictionary<string, object>;
                long rec = 0, rep = 0, drop = 0;
                if (dict != null)
                {
                    dict.TryGetValue("received", out b); long.TryParse(Convert.ToString(b), out rec);
                    dict.TryGetValue("replied", out b); long.TryParse(Convert.ToString(b), out rep);
                    dict.TryGetValue("dropped", out b); long.TryParse(Convert.ToString(b), out drop);
                }
                if (i < hours - 1) sb.Append(',');
                sb.Append("{\"label\":\"").Append(d.ToString("HH")).Append(":00\"")
                  .Append(",\"received\":").Append(rec)
                  .Append(",\"replied\":").Append(rep)
                  .Append(",\"dropped\":").Append(drop).Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    /// <summary>界面下发的记忆编辑指令，写进控制队列由机器人执行</summary>
    string EnqueueControl(string body)
    {
        try
        {
            string cmd = JsonField(body, "cmd");
            string chat = JsonField(body, "chat");
            if (string.IsNullOrEmpty(cmd)) return "{\"ok\":false,\"error\":\"缺少 cmd\"}";

            var allowed = new Dictionary<string, bool>
            {
                { "forgetFact", true }, { "clearFacts", true }, { "clearSummary", true },
                { "resetGroup", true }, { "setMood", true }, { "reloadPersona", true },
                { "clearContext", true }, { "pinFact", true },
            };
            if (!allowed.ContainsKey(cmd)) return "{\"ok\":false,\"error\":\"不支持的指令\"}";

            string line = "{\"cmd\":\"" + JsonEscape(cmd) + "\",\"chat\":\"" + JsonEscape(chat) + "\"";

            var mi = System.Text.RegularExpressions.Regex.Match(body, "\"index\"\\s*:\\s*(-?\\d+)");
            if (mi.Success) line += ",\"index\":" + mi.Groups[1].Value;

            var mv = System.Text.RegularExpressions.Regex.Match(body, "\"value\"\\s*:\\s*(-?\\d+)");
            if (mv.Success) line += ",\"value\":" + mv.Groups[1].Value;

            var mp = System.Text.RegularExpressions.Regex.Match(body, "\"pinned\"\\s*:\\s*(true|false)");
            if (mp.Success) line += ",\"pinned\":" + mp.Groups[1].Value;

            line += "}";

            string dir = Path.Combine(AppDir(), "data");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "control.jsonl"), line + "\n", new UTF8Encoding(false));

            AppendSys("记忆指令 → " + cmd);
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    string ActionJson(string body)
    {
        string type = JsonField(body, "type");
        string chat = JsonField(body, "chat");

        if (type == "start") Task.Run(delegate { StartBot(); });
        else if (type == "stop") StopBot(true);
        else if (type == "restart") Task.Run(delegate { RefreshNapcat(); });
        else if (type == "send")
        {
            string text = JsonField(body, "text").Trim();
            if (string.IsNullOrEmpty(text)) return "{\"ok\":false,\"error\":\"empty\"}";
            if (!chat.StartsWith("g") && !chat.StartsWith("p")) return "{\"ok\":false,\"error\":\"先选一个会话\"}";
            if (text.Length > 500) return "{\"ok\":false,\"error\":\"too long\"}";
            if (bot == null || bot.HasExited) return "{\"ok\":false,\"error\":\"机器人没在运行\"}";

            try
            {
                EnqueueOutgoing(chat, text);
                AppendSys("手动发送 → " + chat);
                return "{\"ok\":true}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
            }
        }
        else if (type == "level")
        {
            string lv = JsonField(body, "level");
            if (SetLevelInConfig(lv))
            {
                AppendSys("回应频度已切换：" + lv);
                return "{\"ok\":true,\"level\":\"" + JsonEscape(lv) + "\"}";
            }
            AppendSys("切换频度失败：档位不合法或配置写入失败");
            return "{\"ok\":false,\"error\":\"invalid level\"}";
        }
        else if (type == "clear")
        {
            string scope = string.IsNullOrEmpty(chat) || chat == "all" ? "all" : "chat";
            return ClearChat("{\"scope\":\"" + scope + "\",\"chat\":\"" + JsonEscape(chat) + "\",\"display\":true}");
        }
        else
        {
            return "{\"ok\":false,\"error\":\"unknown action\"}";
        }

        return "{\"ok\":true}";
    }

    string QrDataUrl()
    {
        try
        {
            string p = Path.Combine(napcatDir, "cache", "qrcode.png");
            if (!File.Exists(p)) return "";
            DateTime write = File.GetLastWriteTime(p);
            if ((DateTime.Now - write).TotalSeconds > QrLifeSeconds) return "";

            lock (qrCacheLock)
            {
                if (p == qrCachePath && write == qrCacheAt) return qrCacheUrl;
            }

            byte[] bytes;
            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var ms = new MemoryStream())
            {
                fs.CopyTo(ms);
                bytes = ms.ToArray();
            }
            string url = "data:image/png;base64," + Convert.ToBase64String(bytes);

            lock (qrCacheLock)
            {
                qrCachePath = p;
                qrCacheAt = write;
                qrCacheUrl = url;
            }
            return url;
        }
        catch { return ""; }
    }

}
