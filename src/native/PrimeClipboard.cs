using System;
using System.Collections.Specialized;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace PrimeDesk
{
    class PrimeClipboard
    {
        [STAThread]
        static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            try { Console.InputEncoding = Encoding.UTF8; } catch { }
            if (args.Length == 0) return 1;

            string cmd = args[0].ToUpperInvariant();
            if (cmd == "GET_FILES")
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
                catch
                {
                    return 2;
                }
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
