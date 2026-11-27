using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;

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

        [DllImport("user32.dll")]
        static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        static extern bool LockWorkStation();

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr hObject);

        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint TOKEN_QUERY = 0x0008;
        const uint DESKTOP_WRITEOBJECTS = 0x0080;

        static long _lastBlockReportMs = 0;

        static void CheckAndReportInputBlock(bool cursorCallSucceeded)
        {
            long now = Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000);
            if (now - _lastBlockReportMs < 3500) return;

            IntPtr hDesk = OpenInputDesktop(0, false, DESKTOP_WRITEOBJECTS);
            if (hDesk == IntPtr.Zero)
            {
                _lastBlockReportMs = now;
                Console.WriteLine("PRIMEDESK_INPUT_BLOCKED SECURE_DESKTOP");
                Console.Out.Flush();
                return;
            }
            CloseDesktop(hDesk);

            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero)
            {
                uint pid = 0;
                GetWindowThreadProcessId(fg, out pid);
                if (pid != 0)
                {
                    IntPtr hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                    if (hProc == IntPtr.Zero)
                    {
                        if (Marshal.GetLastWin32Error() == 5)
                        {
                            _lastBlockReportMs = now;
                            Console.WriteLine("PRIMEDESK_INPUT_BLOCKED UIPI");
                            Console.Out.Flush();
                        }
                        return;
                    }
                    IntPtr hToken = IntPtr.Zero;
                    bool tokOk = OpenProcessToken(hProc, TOKEN_QUERY, out hToken);
                    int err = Marshal.GetLastWin32Error();
                    if (hToken != IntPtr.Zero) CloseHandle(hToken);
                    CloseHandle(hProc);
                    if (!tokOk && err == 5)
                    {
                        _lastBlockReportMs = now;
                        Console.WriteLine("PRIMEDESK_INPUT_BLOCKED UIPI");
                        Console.Out.Flush();
                        return;
                    }
                }
            }

            if (!cursorCallSucceeded)
            {
                _lastBlockReportMs = now;
                Console.WriteLine("PRIMEDESK_INPUT_BLOCKED UIPI");
                Console.Out.Flush();
            }
        }

        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint MOUSEEVENTF_WHEEL = 0x0800;
        const uint KEYEVENTF_KEYUP = 0x0002;

        const byte VK_LWIN = 0x5B;
        const byte VK_D = 0x44;
        const byte VK_CONTROL = 0x11;
        const byte VK_SHIFT = 0x10;
        const byte VK_ESCAPE = 0x1B;
        const byte VK_TAB = 0x09;
        const byte VK_MENU = 0x12; // Alt

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
                        CheckAndReportInputBlock(true);
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
                        CheckAndReportInputBlock(true);
                        byte vk = byte.Parse(parts[1]);
                        byte scan = (byte)MapVirtualKey(vk, 0);
                        keybd_event(vk, scan, 0, 0);
                    }
                    else if (cmd == "KU" && parts.Length >= 2)
                    {
                        byte vk = byte.Parse(parts[1]);
                        byte scan = (byte)MapVirtualKey(vk, 0);
                        keybd_event(vk, scan, KEYEVENTF_KEYUP, 0);
                    }
                    else if (cmd == "PASTE")
                    {
                        byte scanCtrl = (byte)MapVirtualKey(VK_CONTROL, 0);
                        byte scanV = (byte)MapVirtualKey(0x56, 0);
                        keybd_event(VK_CONTROL, scanCtrl, 0, 0);
                        keybd_event(0x56, scanV, 0, 0);
                        keybd_event(0x56, scanV, KEYEVENTF_KEYUP, 0);
                        keybd_event(VK_CONTROL, scanCtrl, KEYEVENTF_KEYUP, 0);
                    }
                    else if (cmd == "COPY")
                    {
                        byte scanCtrl = (byte)MapVirtualKey(VK_CONTROL, 0);
                        byte scanC = (byte)MapVirtualKey(0x43, 0);
                        keybd_event(VK_CONTROL, scanCtrl, 0, 0);
                        keybd_event(0x43, scanC, 0, 0);
                        keybd_event(0x43, scanC, KEYEVENTF_KEYUP, 0);
                        keybd_event(VK_CONTROL, scanCtrl, KEYEVENTF_KEYUP, 0);
                    }
                    else if (cmd == "RELEASE_MOUSE")
                    {
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
                        mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                    }
                    else if (cmd == "SPECIAL" && parts.Length >= 2)
                    {
                        string action = parts[1].ToUpper();
                        if (action == "TASKMGR")
                        {
                            // Open Task Manager via Ctrl+Shift+Esc
                            keybd_event(VK_CONTROL, 0, 0, 0);
                            keybd_event(VK_SHIFT, 0, 0, 0);
                            keybd_event(VK_ESCAPE, 0, 0, 0);
                            keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0);
                            keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
                            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
                        }
                        else if (action == "DESKTOP")
                        {
                            // Win + D
                            keybd_event(VK_LWIN, 0, 0, 0);
                            keybd_event(VK_D, 0, 0, 0);
                            keybd_event(VK_D, 0, KEYEVENTF_KEYUP, 0);
                            keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
                        }
                        else if (action == "LOCK")
                        {
                            LockWorkStation();
                        }
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
