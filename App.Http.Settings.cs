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

/// <summary>设置类接口：配置 / 人设 / 设计 / 首次向导。</summary>
partial class MainForm
{
    string ConfigPath()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
    }

    string ConfigValue(string name)
    {
        try
        {
            return JsonField(ConfigText(), name);
        }
        catch
        {
            return "";
        }
    }

    string ConfigJson()
    {
        string key = ConfigValue("apiKey");
        return "{\"provider\":\"" + JsonEscape(ConfigValue("provider"))
             + "\",\"baseUrl\":\"" + JsonEscape(ConfigValue("baseUrl"))
             + "\",\"model\":\"" + JsonEscape(ConfigValue("model"))
             + "\",\"hasKey\":" + (key.Trim() != "" ? "true" : "false") + "}";
    }

    string SaveConfig(string body)
    {
        try
        {
            string p = ConfigPath();
            if (!File.Exists(p)) return "{\"ok\":false,\"error\":\"找不到 config.json\"}";

            string text = File.ReadAllText(p, Encoding.UTF8).TrimStart('\uFEFF');
            foreach (string key in new[] { "provider", "baseUrl", "model", "apiKey" })
            {
                // apiKey 只有请求里真的带了才改，避免「只改模型」把 Key 清空
                if (key == "apiKey" && !body.Contains("\"apiKey\"")) continue;

                string value = JsonField(body, key);
                bool allowEmpty = key == "apiKey"; // 允许清空 Key
                if (value == "" && !allowEmpty) continue;
                text = ReplaceJsonString(text, key, value);
            }

            File.WriteAllText(p, text, new UTF8Encoding(false));
            InvalidateConfigCache();
            MarkSetupDone();
            AppendSys("配置已保存");
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    static string ReplaceJsonString(string json, string key, string value)
    {
        var re = new System.Text.RegularExpressions.Regex(
            "\"" + System.Text.RegularExpressions.Regex.Escape(key) + "\"\\s*:\\s*\"");
        var m = re.Match(json);
        if (!m.Success) return json;

        int start = m.Index + m.Length;
        int i = start;
        while (i < json.Length)
        {
            char c = json[i];
            if (c == '\\') { i += 2; continue; }
            if (c == '"') break;
            i += 1;
        }
        if (i >= json.Length) return json;

        return json.Substring(0, start) + JsonEscape(value) + json.Substring(i);
    }

    string ConfigText()
    {
        string p = ConfigPath();
        DateTime at;
        try { at = File.Exists(p) ? File.GetLastWriteTimeUtc(p) : DateTime.MinValue; }
        catch { at = DateTime.MinValue; }

        lock (cfgCacheLock)
        {
            if (p == cfgCachePath && at == cfgCacheAt) return cfgCacheText;
        }

        string text = "";
        try { if (File.Exists(p)) text = File.ReadAllText(p, Encoding.UTF8); } catch { }

        lock (cfgCacheLock)
        {
            cfgCachePath = p;
            cfgCacheAt = at;
            cfgCacheText = text;
        }
        return text;
    }

    void InvalidateConfigCache()
    {
        lock (cfgCacheLock)
        {
            cfgCacheAt = DateTime.MinValue;
            cfgCacheText = "";
        }
    }

    string PersonaPath()
    {
        try
        {
            string cfgFile = Path.Combine(AppDir(), "config.json");
            if (File.Exists(cfgFile))
            {
                var m = System.Text.RegularExpressions.Regex.Match(
                    File.ReadAllText(cfgFile, Encoding.UTF8), "\"file\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return Path.Combine(AppDir(), m.Groups[1].Value.Replace("\\\\", "\\"));
            }
        }
        catch { }
        return Path.Combine(AppDir(), "persona.md");
    }

    /// <summary>读 config.json 里 persona.name（机器人叫什么）</summary>
    string PersonaName()
    {
        try
        {
            var m = System.Text.RegularExpressions.Regex.Match(
                ConfigText(), "\"persona\"\\s*:\\s*\\{[^}]*\"name\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : "";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>改名字：同时把别名表里的旧名字保留、新名字放第一位</summary>
    string SetPersonaName(string name)
    {
        try
        {
            string p = ConfigPath();
            if (!File.Exists(p)) return "";
            string text = File.ReadAllText(p, Encoding.UTF8).TrimStart('\uFEFF');

            var re = new System.Text.RegularExpressions.Regex(
                "(\"persona\"\\s*:\\s*\\{[^}]*?\"name\"\\s*:\\s*\")[^\"]*(\")");
            if (!re.IsMatch(text)) return "";
            text = re.Replace(text, m => m.Groups[1].Value + JsonEscape(name) + m.Groups[2].Value, 1);

            var aliasRe = new System.Text.RegularExpressions.Regex("(\"aliases\"\\s*:\\s*\\[)([^\\]]*)(\\])");
            var am = aliasRe.Match(text);
            if (am.Success)
            {
                var items = new List<string>();
                items.Add(name);
                foreach (string raw in am.Groups[2].Value.Split(','))
                {
                    string item = raw.Trim().Trim('"').Trim();
                    if (item.Length == 0 || item == name) continue;
                    if (!items.Contains(item)) items.Add(item);
                }

                var parts = new List<string>();
                foreach (string item in items) parts.Add("\"" + JsonEscape(item) + "\"");
                string joined = string.Join(", ", parts.ToArray());
                text = aliasRe.Replace(text, m => m.Groups[1].Value + joined + m.Groups[3].Value, 1);
            }

            File.WriteAllText(p, text, new UTF8Encoding(false));
            AppendSys("机器人名字已改为：" + name + "（重启机器人后生效）");
            return name;
        }
        catch
        {
            return "";
        }
    }

    string PersonaJson()
    {
        try
        {
            string file = PersonaPath();
            string text = File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8).TrimStart('\uFEFF') : "";
            return "{\"text\":\"" + JsonEscape(text) + "\",\"path\":\"" + JsonEscape(file)
                 + "\",\"name\":\"" + JsonEscape(PersonaName()) + "\"}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    string SavePersona(string body)
    {
        try
        {
            string text = JsonField(body, "text");
            if (string.IsNullOrEmpty(text)) return "{\"ok\":false,\"error\":\"内容不能为空\"}";
            if (text.Length > 20000) return "{\"ok\":false,\"error\":\"太长了\"}";

            string file = PersonaPath();
            File.WriteAllText(file, text, new UTF8Encoding(false));

            string name = JsonField(body, "name").Trim();
            if (name.Length > 0 && name.Length <= 20) SetPersonaName(name);

            MarkSetupDone();
            AppendSys("人设已保存（机器人会自动重载）");
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    string DesignPath()
    {
        return Path.Combine(AppDir(), "data", "design.json");
    }

    string DesignJson()
    {
        try
        {
            string file = DesignPath();
            if (!File.Exists(file)) return "{}";
            return File.ReadAllText(file, Encoding.UTF8).TrimStart('\uFEFF');
        }
        catch (Exception ex)
        {
            return "{\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    string SaveDesign(string body)
    {
        try
        {
            try
            {
                // 先确认是合法 JSON 再落盘，坏数据别把设计文件写坏
                new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(body);
            }
            catch (Exception)
            {
                return "{\"ok\":false,\"error\":\"设计内容不是合法 JSON\"}";
            }

            string file = DesignPath();
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, body, new UTF8Encoding(false));

            string name = JsonField(body, "name").Trim();
            if (name.Length > 0 && name.Length <= 20 && name != PersonaName()) SetPersonaName(name);

            AppendSys("设计已保存（机器人下一次回复生效）");
            return "{\"ok\":true}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}";
        }
    }

    string SetupMarkerPath()
    {
        return Path.Combine(AppDir(), "data", "setup-done.json");
    }

    void MarkSetupDone()
    {
        try
        {
            string file = SetupMarkerPath();
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, "{\"done\":true}", new UTF8Encoding(false));
        }
        catch
        {
            /* 标记写不进去也不影响使用 */
        }
    }

    /// <summary>已经设置过？只看持久标记（旧用户的标记在启动时补写）</summary>
    bool SetupDone()
    {
        try
        {
            return File.Exists(SetupMarkerPath());
        }
        catch
        {
            return false;
        }
    }

    /// <summary>首次设置向导用的一次性环境快照。</summary>
    string SetupJson()
    {
        string node = NodeVersion();
        bool hasKey = ConfigValue("apiKey").Trim() != "";
        bool napcat = !string.IsNullOrEmpty(napcatDir) && Directory.Exists(napcatDir);
        bool webview = WebView2Installed();
        bool firstRun = !SetupDone();

        return "{\"firstRun\":" + (firstRun ? "true" : "false")
             + ",\"hasKey\":" + (hasKey ? "true" : "false")
             + ",\"provider\":\"" + JsonEscape(ConfigValue("provider")) + "\""
             + ",\"baseUrl\":\"" + JsonEscape(ConfigValue("baseUrl")) + "\""
             + ",\"model\":\"" + JsonEscape(ConfigValue("model")) + "\""
             + ",\"node\":" + (node != "" ? "true" : "false")
             + ",\"nodeVersion\":\"" + JsonEscape(node) + "\""
             + ",\"napcat\":" + (napcat ? "true" : "false")
             + ",\"napcatDir\":\"" + JsonEscape(napcatDir ?? "") + "\""
             + ",\"webview\":" + (webview ? "true" : "false")
             + ",\"personaName\":\"" + JsonEscape(PersonaName()) + "\""
             + ",\"version\":\"1.0.0\"}";
    }

    static string NodeVersion()
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
        catch
        {
            return "";
        }
    }

    static bool WebView2Installed()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
            {
                if (k != null) return true;
            }
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
            {
                if (k != null) return true;
            }
        }
        catch { }
        return Directory.Exists(@"C:\Program Files (x86)\Microsoft\EdgeWebView\Application");
    }
}
