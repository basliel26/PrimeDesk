using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace PrimeDesk
{
    class PrimeInput
    {
        [DllImport("user32.dll")]
        static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint MOUSEEVENTF_WHEEL = 0x0800;
        const uint KEYEVENTF_KEYUP = 0x0002;

        static void Main(string[] args)
        {
            Console.WriteLine("PRIMEDESK_INPUT_READY");
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                try
                {
                    string[] parts = line.Split(' ');
                    string cmd = parts[0].ToUpper();

                    if (cmd == "M" && parts.Length >= 3)
                    {
                        int x = int.Parse(parts[1]);
                        int y = int.Parse(parts[2]);
                        SetCursorPos(x, y);
                    }
                    else if (cmd == "D")
                    {
                        string btn = parts.Length > 1 ? parts[1].ToLower() : "left";
                        if (btn == "left") mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                        else if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
                        else if (btn == "middle") mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                    }
                    else if (cmd == "U")
                    {
                        string btn = parts.Length > 1 ? parts[1].ToLower() : "left";
                        if (btn == "left") mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                        else if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
                        else if (btn == "middle") mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                    }
                    else if (cmd == "C")
                    {
                        string btn = parts.Length > 1 ? parts[1].ToLower() : "left";
                        if (btn == "left") { mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0); }
                        else if (btn == "right") { mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0); mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0); }
                        else if (btn == "middle") { mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0); mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0); }
                    }
                    else if (cmd == "W" && parts.Length >= 2)
                    {
                        int delta = int.Parse(parts[1]);
                        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)delta, 0);
                    }
                    else if (cmd == "KD" && parts.Length >= 2)
                    {
                        byte vk = byte.Parse(parts[1]);
                        keybd_event(vk, 0, 0, 0);
                    }
                    else if (cmd == "KU" && parts.Length >= 2)
                    {
                        byte vk = byte.Parse(parts[1]);
                        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
                    }
                    else if (cmd == "QUIT")
                    {
                        break;
                    }
                }
                catch (Exception)
                {
                    // Ignore parse errors to keep stream smooth
                }
            }
        }
    }
}
