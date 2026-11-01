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

/// <summary>记忆类接口：记忆读取、三层清理、离线清记忆。</summary>
partial class MainForm
{
    string MemoryJson(string path)
    {
        string chat = "all";
        int ci = path.IndexOf("chat=");
        if (ci >= 0)
        {
            string v = path.Substring(ci + 5);
            int amp = v.IndexOf('&');
            if (amp >= 0) v = v.Substring(0, amp);
            chat = Uri.UnescapeDataString(v);
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(chat, "^[A-Za-z0-9_]*$")) chat = "all";

        string memFile = Path.Combine(AppDir(), "data", "memory.json");
        long mtime = 0;
        try { if (File.Exists(memFile)) mtime = File.GetLastWriteTimeUtc(memFile).Ticks; } catch { }

        lock (memCacheLock)
        {
            // 记忆没变就直接返回上次结果，别每个面板轮询都起一次 node
            if (chat == memCacheChat && mtime == memCacheMtime && memCacheBody.Length > 0) return memCacheBody;
        }

        try
        {
            var psi = new ProcessStartInfo("node", "\"" + Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tools", "memread.cjs") + "\" \"" + chat + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            using (var proc = Process.Start(psi))
            {
                string txt = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(3000);
                if (!string.IsNullOrEmpty(txt) && txt.TrimStart().StartsWith("{"))
                {
                    lock (memCacheLock)
                    {
                        memCacheChat = chat;
                        memCacheMtime = mtime;
                        memCacheBody = txt;
                    }
                    return txt;
                }
            }
        }
        catch { }
        return "{\"summary\":\"\",\"facts\":[],\"mood\":60,\"count\":0}";
    }

    string ClearChat(string body)
    {
        string scope = JsonField(body, "scope");
        string chat = JsonField(body, "chat");
        bool display = JsonBool(body, "display");
        bool context = JsonBool(body, "context");
        bool memory = JsonBool(body, "memory");

        bool all = scope == "all";
        if (!all && (string.IsNullOrEmpty(chat) || chat == "all"))
            return "{\"ok\":false,\"error\":\"先在左侧选一个会话，或把范围改成全部\"}";
        if (!all && !System.Text.RegularExpressions.Regex.IsMatch(chat, "^[A-Za-z0-9_]+$"))
            return "{\"ok\":false,\"error\":\"会话 ID 不合法\"}";
        if (!display && !context && !memory)
            return "{\"ok\":false,\"error\":\"没有勾选要清理的内容\"}";

        bool botAlive = bot != null && !bot.HasExited;

        // 记忆在磁盘上，机器人没运行也能清；上下文只在它内存里，没运行等于已经没了
        int clearedOffline = -1;
        if (memory && !botAlive)
        {
            clearedOffline = RunMemClear(all ? "*" : chat);
            if (clearedOffline < 0) return "{\"ok\":false,\"error\":\"写 memory.json 失败（文件可能被占用）\"}";
        }

        int removedFeed = 0;
        int removedLog = 0;

        if (display)
        {
            lock (feedLock)
            {
                feedGen++;
                if (all)
                {
                    removedFeed = feed.Count;
                    feed.Clear();
                    total = 0;
                    unread.Clear();
                }
                else
                {
                    removedFeed = feed.RemoveAll(delegate(FeedItem fi) { return fi.Key == chat; });
                    total = Math.Max(0, total - removedFeed);
                    unread[chat] = 0;
                }
            }
            try { removedLog = TrimUiLog(all ? "" : chat, all); } catch { }
        }

        string target = all ? "*" : chat;
        if (context && botAlive) EnqueueControl("{\"cmd\":\"clearContext\",\"chat\":\"" + JsonEscape(target) + "\"}");
        if (memory && botAlive) EnqueueControl("{\"cmd\":\"resetGroup\",\"chat\":\"" + JsonEscape(target) + "\"}");

        var done = new List<string>();
        if (display) done.Add("屏幕 " + removedFeed + " 条");
        if (context) done.Add(botAlive ? "最近上下文" : "最近上下文（机器人未运行，本来就没有）");
        if (memory) done.Add(clearedOffline >= 0 ? "长期记忆（离线清理 " + clearedOffline + " 个会话）" : "长期记忆");
        AppendSys("清理：" + string.Join(" + ", done) + (all ? "（全部会话）" : ""));

        return "{\"ok\":true,\"feed\":" + removedFeed + ",\"log\":" + removedLog +
               ",\"memory\":" + (memory ? (clearedOffline >= 0 ? clearedOffline : -1) : 0) + "}";
    }

    /// <summary>删掉 ui.log 里某个会话（或全部）的行，避免重启后“清空”又冒出来。</summary>
    int TrimUiLog(string chat, bool all)
    {
        string file = Path.Combine(AppDir(), "data", "ui.log");
        if (!File.Exists(file)) return 0;

        string[] lines = File.ReadAllLines(file, Encoding.UTF8);
        var keep = new List<string>();
        int removed = 0;

        foreach (string line in lines)
        {
            if (string.IsNullOrEmpty(line)) continue;
            if (all) { removed += 1; continue; }
            string[] parts = line.Split('\t');
            string key = parts.Length > 1 ? parts[1] : "";
            if (key == chat) { removed += 1; continue; }
            keep.Add(line);
        }

        File.WriteAllText(file, keep.Count > 0 ? string.Join("\n", keep) + "\n" : "", new UTF8Encoding(false));
        return removed;
    }

    /// <summary>离线清记忆：跑 tools/memclear.cjs，返回清掉的会话数，失败返回 -1。</summary>
    int RunMemClear(string target)
    {
        try
        {
            var psi = new ProcessStartInfo("node", "\"" + Path.Combine(AppDir(), "tools", "memclear.cjs") + "\" \"" + target + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            using (var proc = Process.Start(psi))
            {
                string text = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(5000);
                if (text.IndexOf("\"ok\":true", StringComparison.Ordinal) < 0) return -1;
                var m = System.Text.RegularExpressions.Regex.Match(text, "\"cleared\"\\s*:\\s*(\\d+)");
                return m.Success ? int.Parse(m.Groups[1].Value) : 0;
            }
        }
        catch { return -1; }
    }
}
