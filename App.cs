using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("QQ BOT")]
[assembly: System.Reflection.AssemblyDescription("QQ 群聊拟人机器人")]
[assembly: System.Reflection.AssemblyProduct("QQ BOT")]
[assembly: System.Reflection.AssemblyCompany("Epsilon")]
[assembly: System.Reflection.AssemblyCopyright("Copyright © 2026 Epsilon")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("1.0.0")]

class FeedItem
{
    public int Seq;
    public string Time;
    public string Key;
    public string Name;
    public string Kind;
    public string Who;
    public string Text;
}

partial class MainForm : Form
{
    const string MainJs = "main.js";
    const int QrLifeSeconds = 110;
    const int MaxFeed = 3000;

    // NapCat 目录不再写死：优先读 app.json，读不到就自动探测常见位置
    string napcatDir = "";

    WebView2 web;

    readonly List<FeedItem> feed = new List<FeedItem>();
    readonly object feedLock = new object();
    readonly Dictionary<string, int> unread = new Dictionary<string, int>();

    // 见过的会话（key → 显示名），持久化到 data/chats.json。
    // 清空屏幕记录后会话仍然留在左侧，否则连「记忆」都点不进去。
    readonly Dictionary<string, string> knownChats = new Dictionary<string, string>();

    // 记忆面板缓存（chat + memory.json mtime）
    string memCacheChat = "";
    long memCacheMtime = -1;
    string memCacheBody = "";
    readonly object memCacheLock = new object();

    // 二维码 base64 缓存（路径 + 修改时间）
    string qrCachePath = "";
    DateTime qrCacheAt = DateTime.MinValue;
    string qrCacheUrl = "";
    readonly object qrCacheLock = new object();
    int seq = 0;
    int total = 0;
    int feedGen = 0;
    long feedPos = 0;
    string activeChat = "all";

    Process bot;
    System.Windows.Forms.Timer uiTimer;
    System.Windows.Forms.Timer feedTimer;
    bool wantRunning = false;
    bool starting = false;
    bool cancelStart = false;
    bool pendingStart = false;
    bool wasOnline = false;
    bool loginLost = false;
    int autoRestarts = 0;
    DateTime windowStart = DateTime.MinValue;

    TcpListener http;
    int port = 8765;

    public MainForm()
    {
        Text = "QQ BOT";

        // 按屏幕可用区域自适应，避免窗口跑到屏幕外
        var wa = Screen.PrimaryScreen.WorkingArea;
        int winW = Math.Min(1120, wa.Width - 60);
        int winH = Math.Min(760, wa.Height - 60);
        if (winW < 720) winW = Math.Min(720, wa.Width);
        if (winH < 480) winH = Math.Min(480, wa.Height);
        Width = winW;
        Height = winH;
        MinimumSize = new Size(Math.Min(720, winW), Math.Min(480, winH));
        StartPosition = FormStartPosition.Manual;
        Location = new Point(wa.Left + Math.Max(0, (wa.Width - winW) / 2),
                             wa.Top + Math.Max(0, (wa.Height - winH) / 2));
        BackColor = Color.FromArgb(246, 247, 249);
        DoubleBuffered = true;

        // 首次运行先把配置文件补齐；之前已经有 config.json 的算老用户，补写「已设置」标记
        bool hadConfig = File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json"));
        EnsureFirstRunFiles();
        if (hadConfig) MarkSetupDone();

        // 先确定 NapCat 在哪（可配置 + 自动探测）
        ResolveNapcatDir();

        // 上次崩溃/强杀可能留下 WebView2 进程，先清掉再启动
        KillOrphanWebViews();

        web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(web);

        uiTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        uiTimer.Tick += delegate { Tick(); };
        uiTimer.Start();

        feedTimer = new System.Windows.Forms.Timer { Interval = 700 };
        feedTimer.Tick += delegate { TailFeed(); };
        feedTimer.Start();

        LogApp("进程启动");
        StartHttp();
        LogApp("HTTP 端口: " + port);
        LoadChats();
        LoadFeed();
        InitWeb();

        Task.Run(async delegate
        {
            await Task.Delay(1500);
            if (PortOpen(3001, 300)) StartBot();
        });
    }

    void LogApp(string s)
    {
        try
        {
            var dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "app.log");
            try
            {
                var info = new FileInfo(file);
                if (info.Exists && info.Length > 512 * 1024)
                {
                    string old = file + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(file, old);
                }
            }
            catch { }
            File.AppendAllText(file,
                DateTime.Now.ToString("HH:mm:ss") + "  " + s + Environment.NewLine);
        }
        catch { }
    }

    async void InitWeb()
    {
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQBOT", "WebView2");

        CoreWebView2Environment env = null;
        Exception lastError = null;

        // 第一步：正常目录
        try
        {
            Directory.CreateDirectory(dataDir);
            LogApp("创建 WebView2 环境: " + dataDir);
            env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
        }
        catch (Exception e1)
        {
            lastError = e1;
            LogApp("主目录失败：" + e1.Message);
        }

        // 第二步：清掉残留进程再试一次（最常见的失败原因就是上次没退干净）
        if (env == null)
        {
            LogApp("清理残留 WebView2 进程后重试");
            KillOrphanWebViews();
            await Task.Delay(600);
            try
            {
                env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
            }
            catch (Exception e2)
            {
                lastError = e2;
                LogApp("重试仍失败：" + e2.Message);
            }
        }

        // 第三步：换临时目录（数据目录被占死时的兜底）
        if (env == null)
        {
            try
            {
                string alt = Path.Combine(Path.GetTempPath(), "qqbot-wv2-" + Process.GetCurrentProcess().Id);
                Directory.CreateDirectory(alt);
                LogApp("改用临时目录：" + alt);
                env = await CoreWebView2Environment.CreateAsync(null, alt, null);
            }
            catch (Exception e3)
            {
                lastError = e3;
                LogApp("临时目录也失败：" + e3.Message);
            }
        }

        if (env == null)
        {
            FallbackToBrowser(lastError);
            return;
        }

        try
        {
            LogApp("环境创建完成");
            await web.EnsureCoreWebView2Async(env);
            LogApp("控件初始化完成");

            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsZoomControlEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;

            web.CoreWebView2.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
            {
                LogApp("导航完成: success=" + e2.IsSuccess + " status=" + e2.WebErrorStatus);
                if (!e2.IsSuccess)
                {
                    // 导航失败（多半是自己还没起来）→ 2 秒后重试一次
                    Task.Run(async delegate
                    {
                        await Task.Delay(2000);
                        try { BeginInvoke((Action)(() => { try { web.Source = new Uri("http://127.0.0.1:" + port + "/"); } catch { } })); }
                        catch { }
                    });
                }
            };

            string url = "http://127.0.0.1:" + port + "/";
            LogApp("开始导航: " + url);
            web.Source = new Uri(url);
        }
        catch (Exception ex)
        {
            lastError = ex;
            LogApp("控件初始化失败：" + ex.Message);
            FallbackToBrowser(ex);
        }
    }

    void OpenBrowser()
    {
        try
        {
            Process.Start("http://127.0.0.1:" + port + "/");
        }
        catch (Exception ex)
        {
            LogApp("打开浏览器失败：" + ex.Message);
        }
    }

    /// <summary>内置界面起不来时，降级用浏览器打开，别让用户对着空白窗口</summary>
    void FallbackToBrowser(Exception err)
    {
        string msg = err == null ? "未知错误" : err.Message;
        LogApp("界面降级到浏览器：" + msg);

        try
        {
            web.Visible = false;
            var tip = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 10f),
                ForeColor = Color.FromArgb(80, 88, 102),
                Text = "内置界面启动失败，已改用浏览器打开。\n\n" +
                       "错误：" + msg + "\n\n" +
                       "地址：http://127.0.0.1:" + port + "/\n" +
                       "（这个窗口可以最小化，关掉它就停止机器人）",
            };
            Controls.Add(tip);
            tip.BringToFront();
        }
        catch { }

        OpenBrowser();
    }

    // ---------------- 日志流 ----------------

    void AppendRaw(string time, string key, string name, string kind, string who, string text)
    {
        lock (feedLock)
        {
            seq++; total++;
            feed.Add(new FeedItem { Seq = seq, Time = time, Key = key, Name = name, Kind = kind, Who = who, Text = text });
            if (feed.Count > MaxFeed) feed.RemoveRange(0, feed.Count - MaxFeed);
            if (!string.IsNullOrEmpty(key) && key != activeChat)
            {
                int u; unread.TryGetValue(key, out u); unread[key] = u + 1;
            }
        }
    }

    void AppendSys(string text)
    {
        // 机器人的控制台输出自带时间戳，这里已经有了，去掉重复的
        string t = System.Text.RegularExpressions.Regex.Replace(
            text ?? "", @"^\d{2}:\d{2}:\d{2}\s+", "");
        AppendRaw(DateTime.Now.ToString("HH:mm:ss"), "", "", "sys", "系统", t);
    }

    void LoadFeed()
    {
        try
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "ui.log");
            if (!File.Exists(p)) return;
            string[] lines;
            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var sr = new StreamReader(fs, Encoding.UTF8))
            {
                var all = new List<string>();
                string l;
                while ((l = sr.ReadLine()) != null) all.Add(l);
                int start = Math.Max(0, all.Count - 300);
                lines = all.GetRange(start, all.Count - start).ToArray();
            }
            foreach (var l in lines) AddFeedLine(l);
            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                feedPos = fs.Length;
        }
        catch { }
    }

    void TailFeed()
    {
        try
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "ui.log");
            if (!File.Exists(p)) return;
            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (fs.Length < feedPos)
                {
                    feedPos = 0;
                    lock (feedLock) { feed.Clear(); total = 0; seq = 0; }
                }
                if (fs.Length == feedPos) return;
                fs.Seek(feedPos, SeekOrigin.Begin);
                using (var sr = new StreamReader(fs, Encoding.UTF8, true, 4096, true))
                {
                    string line;
                    while ((line = sr.ReadLine()) != null) AddFeedLine(line);
                }
                feedPos = fs.Position;
            }
        }
        catch { }
    }

    void AddFeedLine(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return;
        var p = raw.Split('\t');
        if (p.Length < 6) return;

        string key = p[1];
        string name = p[2];
        if (!string.IsNullOrEmpty(key))
        {
            bool changed = false;
            lock (feedLock)
            {
                string old;
                if (!knownChats.TryGetValue(key, out old) || old != name)
                {
                    knownChats[key] = name;
                    changed = true;
                }
            }
            if (changed) SaveChats();
        }

        AppendRaw(p[0], p[1], p[2], p[3], p[4], string.Join("\t", p, 5, p.Length - 5));
    }

    // ---------------- 会话名册（清屏后仍然记得这个会话） ----------------

    string ChatsPath()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "chats.json");
    }

    void LoadChats()
    {
        try
        {
            string file = ChatsPath();
            if (!File.Exists(file)) return;
            string text = File.ReadAllText(file, Encoding.UTF8);
            var matches = System.Text.RegularExpressions.Regex.Matches(
                text, "\"([gp]\\d+)\"\\s*:\\s*\"([^\"]*)\"");
            lock (feedLock)
            {
                foreach (System.Text.RegularExpressions.Match m in matches)
                    knownChats[m.Groups[1].Value] = m.Groups[2].Value;
            }
        }
        catch { }
    }

    void SaveChats()
    {
        try
        {
            var sb = new StringBuilder("{");
            bool first = true;
            lock (feedLock)
            {
                foreach (var kv in knownChats)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('"').Append(JsonEscape(kv.Key)).Append("\":\"")
                      .Append(JsonEscape(kv.Value)).Append('"');
                }
            }
            sb.Append('}');

            string file = ChatsPath();
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
        }
        catch { }
    }

    // ---------------- 状态 / 进程 ----------------

    // 端口探测缓存：界面每秒轮询，NapCat 没开时每次都等完整超时会拖慢状态接口
    readonly Dictionary<int, bool> portCache = new Dictionary<int, bool>();
    readonly Dictionary<int, DateTime> portCacheAt = new Dictionary<int, DateTime>();
    readonly object portCacheLock = new object();

    // Tick 每 2 秒刷新一次，状态接口只读这两个字段，不再自己阻塞探测
    volatile bool napcatOnline = false;
    volatile bool webuiOnline = false;
    volatile bool portsChecked = false;

    bool PortOpen(int port, int timeoutMs)
    {
        DateTime now = DateTime.UtcNow;
        lock (portCacheLock)
        {
            bool cached;
            DateTime at;
            if (portCache.TryGetValue(port, out cached)
                && portCacheAt.TryGetValue(port, out at)
                && (now - at).TotalMilliseconds < 1500)
            {
                return cached;
            }
        }

        bool result = false;
        try
        {
            using (var c = new TcpClient())
            {
                var task = c.ConnectAsync("127.0.0.1", port);
                result = task.Wait(Math.Min(timeoutMs, 80)) && c.Connected;
            }
        }
        catch { result = false; }

        lock (portCacheLock)
        {
            portCache[port] = result;
            portCacheAt[port] = now;
        }
        return result;
    }

    void Tick()
    {
        if (IsDisposed) return;
        bool napcat = PortOpen(3001, 200);
        bool webui = PortOpen(6099, 150);
        napcatOnline = napcat;
        webuiOnline = webui;
        portsChecked = true;

        if (napcat)
        {
            if (loginLost) loginLost = false;
            wasOnline = true;
        }
        else
        {
            if (wasOnline && webui) { loginLost = true; wasOnline = false; AppendSys("⚠ 账号掉线（很可能在手机上登录了同一个号）"); }
            else if (!webui) { wasOnline = false; loginLost = false; }
        }

        if (pendingStart && napcat && (bot == null || bot.HasExited))
        {
            pendingStart = false;
            AppendSys("检测到已登录，自动启动机器人");
            Task.Run(delegate { StartBot(); });
        }
    }

    void StartBot()
    {
        if (starting) return;
        if (bot != null && !bot.HasExited) return;
        cancelStart = false;
        starting = true;
        try { StartBotCore(); }
        finally { starting = false; }
    }

    void StartBotCore()
    {
        KillOrphanBot();

        if (!PortOpen(3001, 250))
        {
            AppendSys("NapCat 没运行，先拉起它");
            if (!StartNapcat()) return;
            bool up = false;
            for (int i = 0; i < 45; i++)
            {
                Thread.Sleep(2000);
                if (cancelStart) return;
                if (PortOpen(3001, 250)) { up = true; break; }
            }
            if (!up)
            {
                pendingStart = true;
                AppendSys("需要扫码登录，扫完会自动启动机器人");
                return;
            }
        }

        var psi = new ProcessStartInfo("node", MainJs);
        psi.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) AppendSys(e.Data); };
        proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) AppendSys(e.Data); };
        proc.Exited += delegate { BotExited(proc); };

        try
        {
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            bot = proc;
            wantRunning = true;
            windowStart = DateTime.Now;
            AppendSys("机器人已启动");
        }
        catch (Exception ex)
        {
            AppendSys("启动失败：" + ex.Message);
            bot = null;
        }
    }

    /// <summary>
    /// 清理上次遗留的 WebView2 子进程。
    /// 强杀或崩溃时 Chromium 的子进程不会跟着退出，会白占几百 MB 内存。
    /// </summary>
    void KillOrphanWebViews()
    {
        try
        {
            using (var searcher = new System.Management.ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedgewebview2.exe'"))
            {
                foreach (System.Management.ManagementBaseObject mo in searcher.Get())
                {
                    string cmd = Convert.ToString(mo["CommandLine"]);
                    if (cmd == null) continue;
                    // 只清理本项目自己的 WebView2 数据目录
                    bool mine = cmd.IndexOf("QQBOT", StringComparison.OrdinalIgnoreCase) >= 0
                             || cmd.IndexOf("qqbot-wv2", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (!mine) continue;

                    int pid = Convert.ToInt32(mo["ProcessId"]);
                    try
                    {
                        var pr = Process.GetProcessById(pid);
                        pr.Kill();
                    }
                    catch
                    {
                        /* 已经退出 */
                    }
                }
            }
        }
        catch
        {
            /* 拿不到进程列表就算了，不影响使用 */
        }
    }

    /// <summary>
    /// 首次运行自举：没配置文件就从模板复制一份。
    /// 这样把文件夹拷给别人，双击就能跑。
    /// </summary>
    void EnsureFirstRunFiles()
    {
        try
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string cfg = Path.Combine(dir, "config.json");
            string cfgTpl = Path.Combine(dir, "config.example.json");
            if (!File.Exists(cfg) && File.Exists(cfgTpl))
            {
                File.Copy(cfgTpl, cfg);
                LogApp("首次运行：已从模板生成 config.json");
            }

            string persona = Path.Combine(dir, "persona.md");
            string personaTpl = Path.Combine(dir, "persona.example.md");
            if (!File.Exists(persona) && File.Exists(personaTpl))
            {
                File.Copy(personaTpl, persona);
                LogApp("首次运行：已从模板生成 persona.md");
            }
        }
        catch (Exception ex)
        {
            LogApp("首次运行初始化失败：" + ex.Message);
        }
    }

    /// <summary>上一次异常退出可能留下机器人进程，先结束它，否则会重复回复</summary>
    void KillOrphanBot()
    {
        try
        {
            string pidPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "bot.pid");
            if (!File.Exists(pidPath)) return;
            int pid;
            if (!int.TryParse(File.ReadAllText(pidPath).Trim(), out pid) || pid <= 0) return;

            var pr = Process.GetProcessById(pid);
            if (pr != null && string.Equals(pr.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
            {
                try { pr.Kill(); AppendSys("已清理上次残留的机器人进程（PID " + pid + "）"); } catch { }
                Thread.Sleep(400);
            }
        }
        catch
        {
            /* 进程不存在或没权限，忽略 */
        }
    }

    void BotExited(Process proc)
    {
        if (proc != bot) return;
        int code = 0;
        try { code = proc.ExitCode; } catch { }
        AppendSys("机器人已退出，退出码 " + code);
        bot = null;

        if (!wantRunning) return;
        if ((DateTime.Now - windowStart).TotalSeconds > 120) autoRestarts = 0;
        if (autoRestarts >= 6) { AppendSys("10 分钟内崩了 6 次，停止自动重启"); wantRunning = false; return; }
        autoRestarts++;
        AppendSys("5 秒后自动重启（第 " + autoRestarts + " 次）");
        Task.Run(async delegate
        {
            await Task.Delay(5000);
            if (wantRunning) StartBot();
        });
    }

    void StopBot(bool userAction)
    {
        wantRunning = false;
        cancelStart = true;
        pendingStart = false;
        var p = bot;
        if (p == null) return;
        try { if (!p.HasExited) p.Kill(); } catch { }
        if (userAction) AppendSys("已停止机器人（NapCat 仍在运行）");
    }

    bool StartNapcat()
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments =
                "-NoProfile -WindowStyle Hidden -Command \"Start-Process -FilePath '" + napcatDir + "\\launcher.bat' " +
                "-WorkingDirectory '" + napcatDir + "' -Verb RunAs -WindowStyle Hidden\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
            AppendSys("正在后台拉起 NapCat，请在 UAC 点「是」");
            return true;
        }
        catch (Exception ex)
        {
            AppendSys("拉起 NapCat 失败：" + ex.Message);
            return false;
        }
    }

    void RefreshNapcat()
    {
        AppendSys("正在以管理员权限重启 NapCat…（会弹 UAC）");
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments =
                    "/c taskkill /F /IM QQ.exe >nul 2>&1 & timeout /t 4 >nul & " +
                    "start \"\" \"" + napcatDir + "\\launcher.bat\"",
                UseShellExecute = true,
                Verb = "runas",
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            AppendSys("重启失败：" + ex.Message);
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && bot != null && !bot.HasExited)
        {
            var r = MessageBox.Show(
                "关闭会同时停止机器人。\n\n确定要关闭吗？",
                "QQ BOT", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (r != DialogResult.Yes) { e.Cancel = true; return; }
        }
        try { if (http != null) http.Stop(); } catch { }
        SaveChats();
        StopBot(false);
        try { if (web != null) web.Dispose(); } catch { }
        base.OnFormClosing(e);
    }
}

static class Program
{
    [STAThread]
    static void Main()
    {
        bool created;
        var mutex = new Mutex(true, "TianSuLuo_QQBot_SingleInstance", out created);
        if (!created)
        {
            MessageBox.Show(
                "QQ BOT 已经在运行了。\n\n请到任务栏找到它的窗口，不要重复打开。",
                "QQ BOT", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            Application.Run(new MainForm());
        }
        finally
        {
            GC.KeepAlive(mutex);
        }
    }
}