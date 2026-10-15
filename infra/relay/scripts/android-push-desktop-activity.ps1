$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class T3PushDesktopActivity {
    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo { public uint Size; public uint Time; }
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    public static uint IdleMilliseconds() {
        var info = new LastInputInfo { Size = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("Cannot read desktop input activity");
        return unchecked(GetTickCount() - info.Time);
    }
    public static bool IsUnavailable() {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return true;
        try {
            var name = new StringBuilder(256);
            uint needed;
            if (!GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out needed))
                throw new InvalidOperationException("Cannot inspect input desktop");
            return !String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }
}
'@
# A locked/secure desktop is inaccessible to this interactive-session helper.
# Treat inaccessible desktops as away, so detection cannot mute important work.
@{ idleMs = [T3PushDesktopActivity]::IdleMilliseconds(); locked = [T3PushDesktopActivity]::IsUnavailable() } | ConvertTo-Json -Compress
