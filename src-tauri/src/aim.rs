//! 「点一下要应用到的窗口」：速览双击后的一次性目标捕获。
//!
//! 为什么轮询而不是 SetWinEventHook / WH_MOUSE_LL：
//! - 只在我们待命的那十几秒里工作，80ms 一次的 GetForegroundWindow 成本可忽略；
//! - 不挂全局输入钩子，不会被安全软件当成键盘记录器，也没有 LowLevelHooksTimeout
//!   被系统摘钩的风险；
//! - 取消只需要一个 AtomicBool，没有钩子生命周期与消息循环要管。
//!
//! 交互口径（用户 2026-11-19 定的）：速览双击示例文字 → 复制族名 + 进入待命 →
//! 用户下一次点到的那个窗口就是目标，**只捕获一次**，用完立刻解除。

/// 发给前端的待命结果。字段名就是事件负载的字段名，前端 `AimResult` 与之一一对应。
#[derive(Clone, serde::Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct AimResult {
    /// 发起待命时生成的 id：前端拿它丢弃过期的结果（用户连点两次双击时）
    pub id: String,
    /// 命中的目标软件；不是三个目标之一时为 None
    pub app: Option<&'static str>,
    /// 前台窗口的 exe 文件名（小写）；解析不到时为空串
    pub exe: String,
    /// "hit" | "not-target" | "timeout"
    pub reason: &'static str,
}

#[cfg(windows)]
mod imp {
    use super::AimResult;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, GA_ROOTOWNER,
    };

    /// 是否处于待命状态。取消 = 置 false，轮询线程下一拍就自己退出。
    static ARMED: AtomicBool = AtomicBool::new(false);
    /// 待命序号：每来一次新的待命就 +1，上一轮线程发现序号变了直接退场。
    /// 没有它的话「双击 A、再双击 B」会有两个线程同时盯着，先命中的那个会替用户做决定。
    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 待命总时长上限。用户双击后十几秒都不点别的窗口，基本就是走开了或者改主意了。
    const TIMEOUT: Duration = Duration::from_secs(15);
    /// 轮询间隔。80ms 是「点下去到有反应」的体感阈值以内，又不至于让一个后台线程白烧 CPU。
    const POLL: Duration = Duration::from_millis(80);

    /// 开始一次待命。
    pub fn arm(app: AppHandle, id: String) {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        ARMED.store(true, Ordering::SeqCst);
        std::thread::spawn(move || {
            // 记下当前前台窗口：速览是 always-on-top，双击那一刻它就在前台，
            // 所以「前台变了」就等于「用户点了别的窗口」，不用挂鼠标钩子。
            let baseline = unsafe { GetForegroundWindow() };
            let started = Instant::now();
            loop {
                std::thread::sleep(POLL);
                // 被取消 / 被新的一次待命顶掉：什么都不发，前端自己收尾
                if !ARMED.load(Ordering::SeqCst) || SEQ.load(Ordering::SeqCst) != seq {
                    return;
                }
                if started.elapsed() >= TIMEOUT {
                    ARMED.store(false, Ordering::SeqCst);
                    emit(
                        &app,
                        AimResult {
                            id,
                            app: None,
                            exe: String::new(),
                            reason: "timeout",
                        },
                    );
                    return;
                }
                let fg = unsafe { GetForegroundWindow() };
                if fg.is_null() || fg == baseline {
                    continue;
                }
                // 必须 GA_ROOTOWNER 而不是 GA_ROOT：PS 的浮动面板是 owned window，
                // 它自己就是 root，取到的是面板而不是用户以为的那个「整窗」。
                let root = unsafe { GetAncestor(fg, GA_ROOTOWNER) };
                let hwnd = if root.is_null() { fg } else { root };
                let mut pid: u32 = 0;
                unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
                // pid 为 0 = 窗口正在销毁；等于我们自己 = 用户点回速览面板。
                // 两种都不该算「选好目标」，静默跳过继续等 —— 面板内的点击由前端取消。
                if pid == 0 || pid == std::process::id() {
                    continue;
                }
                let exe = crate::procs::exe_of_pid(pid).unwrap_or_default();
                let app_id = map_exe(&exe);
                ARMED.store(false, Ordering::SeqCst);
                emit(
                    &app,
                    AimResult {
                        id,
                        app: app_id,
                        exe,
                        reason: if app_id.is_some() { "hit" } else { "not-target" },
                    },
                );
                return;
            }
        });
    }

    /// 取消当前待命（Esc、面板内点击、离开速览界面都走这里）。
    pub fn cancel() {
        ARMED.store(false, Ordering::SeqCst);
    }

    fn emit(app: &AppHandle, payload: AimResult) {
        // 前端窗口已经关掉时会失败，这不影响待命本身的状态，忽略即可
        let _ = app.emit("aim-target", payload);
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
    use tauri::AppHandle;

    /// 非 Windows：项目也出 macOS 包，但 PS/AI/CDR 的窗口探测只对 Win32 有意义，
    /// 这里给 no-op，保证整个 crate 在 macOS 上照样编得过（前端永远不会收到事件）。
    pub fn arm(_app: AppHandle, _id: String) {}

    pub fn cancel() {}
}

pub use imp::{arm, cancel};
