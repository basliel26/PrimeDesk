using System;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PrimeDesk
{
    class PrimeClipboard
    {
        [DllImport("user32.dll")]
        static extern uint GetClipboardSequenceNumber();

        static volatile bool _watchStopRequested = false;

        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '\\') sb.Append("\\\\");
                else if (c == '"') sb.Append("\\\"");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static StringCollection ReadDropListSafe(out bool locked)
        {
            locked = false;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    if (Clipboard.ContainsFileDropList())
                    {
                        return Clipboard.GetFileDropList();
                    }
                    return null;
                }
                catch (ExternalException)
                {
                    locked = true;
                    Thread.Sleep(25);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }

        static int RunWatch(int parentPid)
        {
            _watchStopRequested = false;
            Thread stdinThread = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        if (line.Trim().Equals("QUIT", StringComparison.OrdinalIgnoreCase))
                        {
                            break;
                        }
                    }
                }
                catch { }
                _watchStopRequested = true;
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            uint lastSeq = GetClipboardSequenceNumber();
            string prevKey = "";
            bool initLocked = false;
            StringCollection initial = ReadDropListSafe(out initLocked);
            if (initial != null && initial.Count > 0)
            {
                StringBuilder initKey = new StringBuilder();
                foreach (string f in initial)
                {
                    if (!string.IsNullOrEmpty(f)) initKey.Append(f).Append('\n');
                }
                prevKey = initKey.ToString();
            }

            Console.WriteLine("{\"ready\":true}");
            Console.Out.Flush();

            int parentCheckCounter = 0;
            while (!_watchStopRequested)
            {
                Thread.Sleep(250);
                if (_watchStopRequested) break;

                if (parentPid > 0 && (++parentCheckCounter % 4 == 0))
                {
                    try
                    {
                        Process p = Process.GetProcessById(parentPid);
                        if (p.HasExited) break;
                    }
                    catch
                    {
                        break;
                    }
                }

                uint seq = GetClipboardSequenceNumber();
                if (seq == lastSeq) continue;

                bool clipLocked = false;
                StringCollection files = ReadDropListSafe(out clipLocked);
                if (clipLocked)
                {
                    // Explorer may hold OpenClipboard briefly; retry on next tick without dropping seq
                    continue;
                }
                lastSeq = seq;

                StringBuilder keyBuilder = new StringBuilder();
                StringBuilder jsonBuilder = new StringBuilder();
                jsonBuilder.Append("{\"seq\":").Append(seq).Append(",\"files\":[");
                bool first = true;
                if (files != null)
                {
                    foreach (string f in files)
                    {
                        if (!string.IsNullOrEmpty(f))
                        {
                            keyBuilder.Append(f).Append('\n');
                            if (!first) jsonBuilder.Append(',');
                            jsonBuilder.Append('"').Append(EscapeJson(f)).Append('"');
                            first = false;
                        }
                    }
                }
                jsonBuilder.Append("]}");

                string curKey = keyBuilder.ToString();
                if (curKey != prevKey)
                {
                    prevKey = curKey;
                    Console.WriteLine(jsonBuilder.ToString());
                    Console.Out.Flush();
                }
            }
            return 0;
        }

        [STAThread]
        static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            try { Console.InputEncoding = Encoding.UTF8; } catch { }
            if (args.Length == 0) return 1;

            string cmd = args[0].ToUpperInvariant();
            if (cmd == "WATCH")
            {
                int parentPid = 0;
                if (args.Length >= 2) int.TryParse(args[1], out parentPid);
                return RunWatch(parentPid);
            }
            if (cmd == "GET_FILES")
            {
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        if (Clipboard.ContainsFileDropList())
                        {
                            StringCollection files = Clipboard.GetFileDropList();
                            foreach (string f in files)
                            {
                                if (!string.IsNullOrEmpty(f))
                                {
                                    Console.WriteLine(f);
                                }
                            }
                        }
                        return 0;
                    }
                    catch (ExternalException)
                    {
                        Thread.Sleep(35);
                    }
                    catch
                    {
                        return 2;
                    }
                }
                return 2;
            }
            else if (cmd == "SET_FILES")
            {
                try
                {
                    StringCollection col = new StringCollection();
                    if (args.Length >= 2 && args[1] == "--stdin")
                    {
                        string line;
                        while ((line = Console.ReadLine()) != null)
                        {
                            string trimmed = line.Trim();
                            if (!string.IsNullOrEmpty(trimmed) && (File.Exists(trimmed) || Directory.Exists(trimmed)))
                            {
                                col.Add(trimmed);
                            }
                        }
                    }
                    else
                    {
                        for (int i = 1; i < args.Length; i++)
                        {
                            string p = args[i];
                            if (File.Exists(p) || Directory.Exists(p))
                            {
                                col.Add(p);
                            }
                        }
                    }
                    if (col.Count > 0)
                    {
                        Clipboard.SetFileDropList(col);
                        return 0;
                    }
                    return 3;
                }
                catch
                {
                    return 4;
                }
            }
            return 1;
        }
    }
}
