//! 「最近在用的设计软件」：双击「点击复制」的位置要套到哪个软件。
//!
//! 1.9.10 这里还兼管「双击示例文字 → 点一下目标窗口」的两步捕获（80ms 轮询前台窗口）。
//! 1.9.12 起那套流程退役了：双击语义统一成「直接套用到最近在用的软件」，
//! 目标在**调用的那一刻**问一次就够，不需要待命、不需要轮询线程、也不需要事件通道。
//! 所以这个文件现在只剩一次性的窗口探测。

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GW_HWNDNEXT, GW_OWNER,
    };

    /// 任务栏、桌面、开始菜单都属于它。它**不是**目标，只是「切换途中」的路过窗口。
    const EXPLORER_EXE: &str = "explorer.exe";

    /// 某个窗口属于哪个进程、exe 叫什么。`cache` 按 pid 缓存，见 `active_target` 里的说明。
    ///
    /// SAFETY: 调用方保证 hwnd 是有效窗口句柄（这里只读，不持有）。
    unsafe fn pid_exe(hwnd: HWND, cache: &mut HashMap<u32, String>) -> (u32, String) {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return (0, String::new());
        }
        if let Some(exe) = cache.get(&pid) {
            return (pid, exe.clone());
        }
        let exe = crate::procs::exe_of_pid(pid).unwrap_or_default();
        cache.insert(pid, exe.clone());
        (pid, exe)
    }

    /// 当前「最近在用」的设计软件。
    ///
    /// 为什么要往下翻 Z 序而不是只看前台：调用它的时候前台往往是我们自己
    /// （用户刚在速览 / 主窗口里双击），点任务栏切窗口时前台还会先变成 explorer.exe，
    /// 真正在用的 PS/AI/CDR 被压在下面。
    /// 反过来，前台是别的软件时**不**往下翻 —— 那种情况下用户确实不在用设计软件，
    /// 硬从 Z 序里翻一个出来答，等于替他做决定。
    pub fn active_target() -> Option<(&'static str, String)> {
        // 往下翻多少个窗口。Z 序靠前的几十个里几乎一定有目标软件；翻太多会让
        // 「没装 PS 的机器」白跑几十次进程快照（每次都是一份全系统进程枚举）。
        const MAX_WALK: usize = 30;
        // SAFETY: 全是只读的窗口查询，不持有任何句柄；进程名走 Toolhelp 快照。
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_null() {
                return None;
            }
            // pid → exe 的小缓存：同一个进程常有好几个顶层窗口，每问一次都是一份
            // 全系统进程快照，缓存一下能把几十次降到几次。
            let mut cache: HashMap<u32, String> = HashMap::new();

            let (fg_pid, fg_exe) = pid_exe(fg, &mut cache);
            if let Some(app) = map_exe(&fg_exe) {
                return Some((app, fg_exe));
            }
            // 前台既不是我们、也不是任务栏/桌面：用户此刻不在用设计软件，别硬答
            if fg_pid != std::process::id() && fg_exe != EXPLORER_EXE {
                return None;
            }

            let mut hwnd = GetWindow(fg, GW_HWNDNEXT);
            let mut steps = 0usize;
            while !hwnd.is_null() && steps < MAX_WALK {
                steps += 1;
                // 先取 next 再判断：判断分支里可能 return，别把链子断在半路
                let next = GetWindow(hwnd, GW_HWNDNEXT);
                // 不可见 / 最小化 / 带 owner 的窗口都不算「用户在用的那个窗」：
                // PS 的浮动面板、各种对话框都是 owned window，它们本身不该被当成目标
                if IsWindowVisible(hwnd) != 0
                    && IsIconic(hwnd) == 0
                    && GetWindow(hwnd, GW_OWNER).is_null()
                {
                    let (pid, exe) = pid_exe(hwnd, &mut cache);
                    if pid != 0 {
                        if let Some(app) = map_exe(&exe) {
                            return Some((app, exe));
                        }
                    }
                }
                hwnd = next;
            }
            None
        }
    }

    /// exe → 目标软件标识。口径必须与 `procs::targets_running`（warm 心跳）一致，
    /// 否则会出现「底部说 CorelDRAW 在跑，双击却说不认识这个窗口」。
    fn map_exe(exe: &str) -> Option<&'static str> {
        match exe {
            "photoshop.exe" => Some("photoshop"),
            "illustrator.exe" => Some("illustrator"),
            // CorelDRAW 官方 exe 是 coreldrw.exe；少数汉化/绿色版被套了一层壳，
            // 文件名成了 coreldrw.exe.exe（procs.rs 里同一口径）
            "coreldrw.exe" | "coreldrw.exe.exe" => Some("coreldraw"),
            _ => None,
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows：项目也出 macOS 包，但 PS/AI/CDR 的窗口探测只对 Win32 有意义，
    /// 这里一律返回「没有」，保证整个 crate 在 macOS 上照样编得过。
    pub fn active_target() -> Option<(&'static str, String)> {
        None
    }
}

pub use imp::active_target;
