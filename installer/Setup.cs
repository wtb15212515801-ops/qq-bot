using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("QQ BOT 安装程序")]
[assembly: System.Reflection.AssemblyProduct("QQ BOT")]
[assembly: System.Reflection.AssemblyCompany("Epsilon")]
[assembly: System.Reflection.AssemblyCopyright("Copyright © 2026 Epsilon")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool silent = false;
        bool uninstall = false;
        string dir = null;
        foreach (string a in args)
        {
            if (string.Equals(a, "/silent", StringComparison.OrdinalIgnoreCase)) silent = true;
            else if (string.Equals(a, "/uninstall", StringComparison.OrdinalIgnoreCase)) uninstall = true;
            else if (a.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase)) dir = a.Substring(5).Trim('"');
        }

        if (uninstall)
        {
            Application.Run(new UninstallForm());
            return;
        }

        Application.Run(new SetupForm(silent, dir));
    }
}

static class AppInfo
{
    public const string Name = "QQ BOT";
    public const string Version = "1.0.0";
    public const string Publisher = "Epsilon";
    public const string Url = "https://github.com/wtb15212515801-ops";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\QQBOT";

    public static string DefaultDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQBOT");
    }

    public static string DetectNapcat()
    {
        string env = Environment.GetEnvironmentVariable("NAPCAT_DIR");
        if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "launcher.bat"))) return env;

        string[] candidates =
        {
            @"D:\NapCat\Shell",
            @"C:\NapCat\Shell",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NapCat", "Shell"),
        };
        foreach (string c in candidates)
        {
            try
            {
                if (File.Exists(Path.Combine(c, "launcher.bat"))) return c;
            }
            catch { }
        }
        return "";
    }

    public static string NodeVersion()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "-v")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var p = Process.Start(psi))
            {
                string line = p.StandardOutput.ReadLine();
                p.WaitForExit(3000);
                return (line ?? "").Trim();
            }
        }
        catch { return ""; }
    }

    public static bool WebView2Installed()
    {
        try
        {
            using (var k = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
            {
                if (k != null) return true;
            }
            using (var k = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
            {
                if (k != null) return true;
            }
        }
        catch { }
        return Directory.Exists(@"C:\Program Files (x86)\Microsoft\EdgeWebView\Application");
    }
}

static class Shortcut
{
    public static void Create(string path, string target, string workDir, string icon, string args)
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                new object[] { path });
            Type linkType = link.GetType();
            linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
            linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { workDir });
            linkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { icon });
            linkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { args });
            linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }
        catch { }
    }

    public static void Remove(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }
}

class SetupForm : Form
{
    readonly bool extractOnly;
    readonly Panel content = new Panel();
    readonly Label heading = new Label();
    readonly Button back = new Button();
    readonly Button next = new Button();
    readonly Button cancel = new Button();
    readonly Label status = new Label();
    readonly ProgressBar progress = new ProgressBar();

    int step;
    int cursorY;
    string targetDir;
    bool createDesktop = true;
    bool createMenu = true;
    bool autoStart;
    bool installed;
    CheckBox launchBox;

    public SetupForm(bool silent, string dir)
    {
        extractOnly = silent;
        targetDir = string.IsNullOrEmpty(dir) ? AppInfo.DefaultDir() : dir;

        Text = AppInfo.Name + " 安装程序";
        ClientSize = new Size(580, 450);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9f);
        AutoScaleMode = AutoScaleMode.Font;
        BackColor = Color.FromArgb(248, 249, 251);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        heading.SetBounds(0, 0, ClientSize.Width, 64);
        heading.Padding = new Padding(22, 18, 22, 0);
        heading.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
        heading.Text = AppInfo.Name + " 安装向导";
        heading.BackColor = Color.White;

        content.SetBounds(0, 64, ClientSize.Width, 320);
        content.Padding = new Padding(22, 12, 22, 8);
        content.BackColor = Color.FromArgb(248, 249, 251);

        back.Text = "上一步";
        back.SetBounds(ClientSize.Width - 330, 392, 92, 32);
        next.Text = "下一步";
        next.SetBounds(ClientSize.Width - 228, 392, 100, 32);
        next.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        cancel.Text = "取消";
        cancel.SetBounds(ClientSize.Width - 118, 392, 92, 32);

        status.SetBounds(22, 348, ClientSize.Width - 44, 20);
        status.ForeColor = Color.FromArgb(90, 98, 112);
        progress.SetBounds(22, 370, ClientSize.Width - 44, 8);
        progress.Visible = false;
        status.Visible = false;

        back.Click += delegate { if (step > 0) { step -= 1; Render(); } };
        next.Click += OnNext;
        cancel.Click += delegate
        {
            if (installed) { Close(); return; }
            if (MessageBox.Show("确定退出安装吗？", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                Close();
        };

        Controls.Add(heading);
        Controls.Add(content);
        Controls.Add(status);
        Controls.Add(progress);
        Controls.Add(back);
        Controls.Add(next);
        Controls.Add(cancel);

        if (extractOnly)
        {
            try
            {
                InstallCore(delegate (int pct, string text) { });
                Environment.Exit(0);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                Environment.Exit(1);
            }
            return;
        }

        Render();
    }

    void OnNext(object sender, EventArgs e)
    {
        if (step == 0) { step = 1; Render(); return; }
        if (step == 1) { step = 2; Render(); return; }
        if (step == 2)
        {
            string dir = targetDir.Trim();
            if (dir.Length == 0 || Path.GetPathRoot(dir) == dir)
            {
                MessageBox.Show("请选一个具体文件夹，不要直接装在盘符根目录。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            targetDir = dir;
            step = 3;
            Render();
            return;
        }
        if (step == 3) { StartInstall(); return; }
        if (step == 4)
        {
            if (launchBox != null && launchBox.Checked)
            {
                try { Process.Start(Path.Combine(targetDir, "QQ BOT.exe")); } catch { }
            }
            Close();
        }
    }

    void Render()
    {
        content.Controls.Clear();
        cursorY = 6;
        back.Visible = step > 0 && step < 4;
        next.Visible = step != 4 || installed;
        cancel.Text = installed ? "关闭" : "取消";
        progress.Visible = false;
        status.Visible = false;

        if (step == 0)
        {
            next.Text = "下一步";
            AddLabel(AppInfo.Name + " " + AppInfo.Version, 15f, FontStyle.Bold);
            AddLabel("QQ 群聊拟人机器人 · 本地运行 · 不联网存储聊天记录");
            AddLabel("作者：" + AppInfo.Publisher + "　" + AppInfo.Url);
            AddLabel("安装内容：主程序、界面、机器人脚本，约 3 MB。");
            AddLabel("安装位置：" + targetDir + "（下一步可以改）", 9f, FontStyle.Regular, true);
        }
        else if (step == 1)
        {
            next.Text = "下一步";
            AddLabel("环境检查", 11f, FontStyle.Bold);

            string node = AppInfo.NodeVersion();
            AddEnvRow("Node.js", node != "", node != "" ? node : "未安装，去 nodejs.org 装 22 以上版本");
            bool webview = AppInfo.WebView2Installed();
            AddEnvRow("WebView2 运行时", webview, webview ? "已安装" : "缺失，请安装 Edge WebView2 运行时");
            string napcat = AppInfo.DetectNapcat();
            AddEnvRow("NapCat", napcat != "", napcat != "" ? napcat : "没找到，可先装后填 app.json 的 napcatDir");

            var recheck = new Button { Text = "重新检测", AutoSize = true, Location = new Point(22, cursorY + 8) };
            recheck.Click += delegate { Render(); };
            content.Controls.Add(recheck);
            cursorY += 40;

            AddLabel("缺 Node.js 装不了机器人；NapCat 可以稍后再配。", 9f, FontStyle.Regular, true);
        }
        else if (step == 2)
        {
            next.Text = "下一步";
            AddLabel("安装位置", 11f, FontStyle.Bold);
            var box = new TextBox { Text = targetDir, Location = new Point(22, cursorY + 4), Width = 430 };
            var browse = new Button { Text = "浏览…", Location = new Point(458, cursorY + 3), Width = 80, Height = 25 };
            browse.Click += delegate
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择安装目录";
                    if (dlg.ShowDialog() == DialogResult.OK) box.Text = dlg.SelectedPath;
                }
            };
            box.TextChanged += delegate { targetDir = box.Text; };
            content.Controls.Add(box);
            content.Controls.Add(browse);
            cursorY += 40;
            AddLabel("建议保持默认：装在当前用户目录，不需要管理员权限。", 9f, FontStyle.Regular, true);
        }
        else if (step == 3)
        {
            next.Text = "安装";
            AddLabel("选项", 11f, FontStyle.Bold);
            var d = new CheckBox { Text = "创建桌面快捷方式", Checked = createDesktop, Location = new Point(22, cursorY), AutoSize = true };
            var m = new CheckBox { Text = "创建开始菜单快捷方式", Checked = createMenu, Location = new Point(22, cursorY + 28), AutoSize = true };
            var a = new CheckBox { Text = "开机自动启动", Checked = autoStart, Location = new Point(22, cursorY + 56), AutoSize = true };
            d.CheckedChanged += delegate { createDesktop = d.Checked; };
            m.CheckedChanged += delegate { createMenu = m.Checked; };
            a.CheckedChanged += delegate { autoStart = a.Checked; };
            content.Controls.Add(d);
            content.Controls.Add(m);
            content.Controls.Add(a);
            cursorY += 90;
            AddLabel("会同时创建卸载入口（设置 → 应用 → 已安装的应用）。", 9f, FontStyle.Regular, true);
        }
        else if (step == 4)
        {
            next.Text = "完成";
            AddLabel("安装完成", 11f, FontStyle.Bold);
            AddLabel("已安装到：" + targetDir, 9f, FontStyle.Regular, true);
            launchBox = new CheckBox { Text = "立即启动 " + AppInfo.Name, Checked = true, Location = new Point(22, cursorY + 6), AutoSize = true };
            content.Controls.Add(launchBox);
            cursorY += 40;
            AddLabel("第一次启动后，按向导填 API Key、改人设，再点「启动」扫码登录。", 9f, FontStyle.Regular, true);
        }
    }

    void AddLabel(string text, float size = 9f, FontStyle style = FontStyle.Regular, bool muted = false)
    {
        var label = new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(content.Width - 56, 0),
            Location = new Point(22, cursorY),
            Font = new Font("Microsoft YaHei UI", size, style),
            ForeColor = muted ? Color.FromArgb(100, 108, 122) : Color.FromArgb(40, 46, 58),
            BackColor = Color.Transparent,
        };
        content.Controls.Add(label);
        cursorY += label.PreferredHeight + 8;
    }

    void AddEnvRow(string name, bool ok, string detail)
    {
        var label = new Label
        {
            Text = (ok ? "✔ " : "✘ ") + name + "：" + detail,
            AutoSize = true,
            MaximumSize = new Size(content.Width - 56, 0),
            Location = new Point(22, cursorY),
            ForeColor = ok ? Color.FromArgb(22, 163, 74) : Color.FromArgb(192, 57, 43),
            BackColor = Color.Transparent,
        };
        content.Controls.Add(label);
        cursorY += Math.Max(22, label.PreferredHeight) + 10;
    }

    void StartInstall()
    {
        back.Visible = false;
        next.Visible = false;
        cancel.Text = "关闭";
        progress.Visible = true;
        progress.Minimum = 0;
        progress.Maximum = 100;
        status.Visible = true;
        status.Text = "正在安装…";

        Task.Run(delegate
        {
            try
            {
                InstallCore(delegate (int pct, string text)
                {
                    try
                    {
                        BeginInvoke((Action)delegate
                        {
                            progress.Value = Math.Max(0, Math.Min(100, pct));
                            status.Text = text;
                        });
                    }
                    catch { }
                });

                BeginInvoke((Action)delegate
                {
                    installed = true;
                    step = 4;
                    Render();
                });
            }
            catch (Exception ex)
            {
                BeginInvoke((Action)delegate
                {
                    MessageBox.Show("安装失败：\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                });
            }
        });
    }

    void InstallCore(Action<int, string> report)
    {
        Directory.CreateDirectory(targetDir);

        var entries = new List<ZipArchiveEntry>();
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (stream == null) throw new IOException("安装包损坏：找不到内置文件");
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    entries.Add(entry);
                }

                int done = 0;
                foreach (var entry in entries)
                {
                    string dest = Path.Combine(targetDir, entry.FullName.Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    entry.ExtractToFile(dest, true);
                    done += 1;
                    report(done * 90 / entries.Count, "正在安装 " + entry.Name);
                }
            }
        }

        string appJson = Path.Combine(targetDir, "app.json");
        if (!File.Exists(appJson))
        {
            string napcat = AppInfo.DetectNapcat();
            string json = "{\n  \"napcatDir\": \"" + napcat.Replace("\\", "\\\\") + "\",\n  \"uiPort\": 8765,\n" +
                          "  \"_说明\": \"napcatDir 是 NapCat 的 Shell 目录，里面应有 launcher.bat\"\n}\n";
            File.WriteAllText(appJson, json, new UTF8Encoding(false));
        }

        if (extractOnly) return;

        report(92, "正在创建卸载程序…");
        string uninstaller = Path.Combine(targetDir, "uninstall.exe");
        if (!string.Equals(Application.ExecutablePath, uninstaller, StringComparison.OrdinalIgnoreCase))
            File.Copy(Application.ExecutablePath, uninstaller, true);

        report(95, "正在创建快捷方式…");
        string exe = Path.Combine(targetDir, "QQ BOT.exe");
        if (createDesktop)
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            Shortcut.Create(Path.Combine(desktop, "QQ BOT.lnk"), exe, targetDir, exe, "");
        }
        if (createMenu)
        {
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "QQ BOT");
            Directory.CreateDirectory(menu);
            Shortcut.Create(Path.Combine(menu, "QQ BOT.lnk"), exe, targetDir, exe, "");
            Shortcut.Create(Path.Combine(menu, "卸载 QQ BOT.lnk"), uninstaller, targetDir, uninstaller, "/uninstall");
        }

        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "DisplayName", AppInfo.Name);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "DisplayVersion", AppInfo.Version);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "Publisher", AppInfo.Publisher);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "DisplayIcon", exe);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "InstallLocation", targetDir);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "UninstallString", "\"" + uninstaller + "\" /uninstall");
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "URLInfoAbout", AppInfo.Url);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "NoModify", 1, RegistryValueKind.DWord);
        Registry.SetValue("HKEY_CURRENT_USER\\" + AppInfo.UninstallKey, "NoRepair", 1, RegistryValueKind.DWord);

        using (var run = Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Run", true))
        {
            if (autoStart && run != null) run.SetValue("QQBOT", "\"" + exe + "\"");
            else if (run != null) run.DeleteValue("QQBOT", false);
        }

        report(100, "安装完成");
    }
}

class UninstallForm : Form
{
    readonly CheckBox keepData;
    readonly string dir;

    public UninstallForm()
    {
        dir = Path.GetDirectoryName(Application.ExecutablePath);

        Text = "卸载 " + AppInfo.Name;
        ClientSize = new Size(440, 220);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var label = new Label
        {
            Text = "确定卸载 " + AppInfo.Name + " 吗？",
            Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(22, 20),
        };
        var hint = new Label
        {
            Text = "安装目录：" + dir,
            AutoSize = false,
            Width = 396,
            Height = 34,
            Location = new Point(22, 52),
        };
        keepData = new CheckBox
        {
            Text = "保留聊天记录与记忆（data 目录）",
            Checked = true,
            AutoSize = true,
            Location = new Point(22, 92),
        };
        var ok = new Button { Text = "卸载", Location = new Point(214, 168), Width = 96 };
        var no = new Button { Text = "取消", Location = new Point(320, 168), Width = 96 };
        ok.Click += delegate { DoUninstall(); };
        no.Click += delegate { Close(); };

        Controls.Add(label);
        Controls.Add(hint);
        Controls.Add(keepData);
        Controls.Add(ok);
        Controls.Add(no);
    }

    void DoUninstall()
    {
        try
        {
            Shortcut.Remove(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "QQ BOT.lnk"));
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "QQ BOT");
            if (Directory.Exists(menu)) Directory.Delete(menu, true);
            try { Registry.CurrentUser.DeleteSubKeyTree(AppInfo.UninstallKey, false); } catch { }
            using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (run != null) run.DeleteValue("QQBOT", false);
            }
        }
        catch { }

        string script;
        if (keepData.Checked)
        {
            script = "/c ping 127.0.0.1 -n 3 >nul & " +
                     "del /f /q \"" + Path.Combine(dir, "*.exe") + "\" >nul 2>&1 & " +
                     "del /f /q \"" + Path.Combine(dir, "*.dll") + "\" >nul 2>&1 & " +
                     "del /f /q \"" + Path.Combine(dir, "*.js") + "\" >nul 2>&1 & " +
                     "del /f /q \"" + Path.Combine(dir, "*.json") + "\" >nul 2>&1 & " +
                     "del /f /q \"" + Path.Combine(dir, "*.md") + "\" >nul 2>&1 & " +
                     "del /f /q \"" + Path.Combine(dir, "*.txt") + "\" >nul 2>&1 & " +
                     "rmdir /s /q \"" + Path.Combine(dir, "src") + "\" >nul 2>&1 & " +
                     "rmdir /s /q \"" + Path.Combine(dir, "ui") + "\" >nul 2>&1 & " +
                     "rmdir /s /q \"" + Path.Combine(dir, "tools") + "\" >nul 2>&1";
        }
        else
        {
            script = "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"";
        }

        try
        {
            var psi = new ProcessStartInfo("cmd.exe", script)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetTempPath(),
            };
            Process.Start(psi);
        }
        catch { }
        Close();
    }
}
