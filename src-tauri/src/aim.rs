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
        GetTopWindow, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GW_HWNDNEXT,
        GW_OWNER,
    };

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
    /// **从 Z 序最顶上往下扫**，第一个可见、未最小化、不带 owner 的目标窗口就是答案。
    /// 为什么不从「前台窗口往下翻」：1.9.14 之前就是这么写的，实测踩了两个坑 ——
    /// 1. 用户刚在速览里双击时，前台有时并不是我们自己（热键唤出 / 焦点没跟过来），
    ///    老逻辑遇到「前台是别的软件」直接返回 None，于是「自动应用」一直说没找到；
    /// 2. 就算前台是我们，目标软件（CorelDRAW）常常**压在速览上面**（Z 序更靠前），
    ///    往下翻永远翻不到它。
    ///
    /// 从顶上往下扫没有这两个问题：激活窗口会升到 Z 序顶部，所以「最上面的那个设计软件」
    /// 就是最近用过的那个，与前台是谁无关。
    pub fn active_target() -> Option<(&'static str, String)> {
        // 顶层窗口总数通常几十个；给 200 足够覆盖多显示器 + 一堆浮动面板的机器。
        const MAX_WALK: usize = 200;
        // SAFETY: 全是只读的窗口查询，不持有任何句柄；进程名走 Toolhelp 快照。
        unsafe {
            let mut cache: HashMap<u32, String> = HashMap::new();
            // 第一轮跳过最小化的；一个都找不到再来一轮允许最小化（用户把 CDR 最小化
            // 放在任务栏里也算「在用」，总比回一句「没找到」强）。
            for allow_iconic in [false, true] {
                let mut hwnd = GetTopWindow(std::ptr::null_mut());
                let mut steps = 0usize;
                while !hwnd.is_null() && steps < MAX_WALK {
                    steps += 1;
                    // 先取 next 再判断：判断分支里可能 return，别把链子断在半路
                    let next = GetWindow(hwnd, GW_HWNDNEXT);
                    let usable = IsWindowVisible(hwnd) != 0
                        && (allow_iconic || IsIconic(hwnd) == 0)
                        && GetWindow(hwnd, GW_OWNER).is_null();
                    if usable {
                        let (pid, exe) = pid_exe(hwnd, &mut cache);
                        // 跳过自己（速览是置顶窗口，永远排在 Z 序最前面）
                        if pid != 0 && pid != std::process::id() {
                            if let Some(app) = map_exe(&exe) {
                                return Some((app, exe));
                            }
                        }
                    }
                    hwnd = next;
                }
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
