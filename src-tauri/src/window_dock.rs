//! 速览界面（QuickBar）的窗口行为接管。
//!
//! 自绘标题栏靠返回 `HTCAPTION` 把拖动交给系统，这会顺带带来两个 Windows 默认行为：
//! 「把窗口拖到屏幕顶端就最大化」（Shell 贴靠 / Snap）和「双击标题栏最大化」。
//! 速览要的是「拖到顶部 → 整个窗口收起成一条」，而不是铺满屏幕，
//! 所以进入速览时这里会临时接管窗口过程，只拦掉这两条最大化指令，
//! 其余消息原样交给原来的窗口过程处理。
//!
//! 另外提供「光标靠近感应」：收起态只有几个像素高，光靠鼠标进窗口几乎碰不到，
//! 这里轮询光标位置，一旦落在窗口正下方的感应带里就通知前端展开。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use tauri::{Emitter, WebviewWindow};

/// 当前是否处于速览界面（前端在进入 / 退出速览时同步）
static QUICKBAR_MODE: AtomicBool = AtomicBool::new(false);
/// 接管之前原本的窗口过程地址
static PREV_PROC: AtomicIsize = AtomicIsize::new(0);
/// 感应是否开启（只有收成细线时开）
static DOCK_SENSOR: AtomicBool = AtomicBool::new(false);
/// 感应线程是否已经起过（只起一次，常驻轮询）
static SENSOR_STARTED: AtomicBool = AtomicBool::new(false);
/// 窗口句柄，供感应线程读矩形
static DOCK_HWND: AtomicIsize = AtomicIsize::new(0);

/// 前端监听的光标靠近事件
pub const DOCK_NEAR_EVENT: &str = "quickbar://dock-near";

/// 感应线程轮询间隔（毫秒）
#[cfg(windows)]
const SENSOR_POLL_MS: u64 = 90;
/// 感应带：窗口下沿再往下延伸这么多物理像素，光标落进来就算「够近」
#[cfg(windows)]
const SENSOR_BAND_PX: i32 = 22;

#[cfg(windows)]
mod platform {
    use super::{PREV_PROC, QUICKBAR_MODE, SENSOR_BAND_PX};
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetCursorPos, GetWindowLongPtrW, GetWindowRect,
        SetWindowLongPtrW, GWLP_WNDPROC, WNDPROC,
    };

    // dwmapi 只需要这一个函数，直接 extern 声明，不给 windows-sys 加 `Win32_Graphics_Dwm`
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            attr: u32,
            pv: *const std::ffi::c_void,
            cb: u32,
        ) -> i32;
    }

    const WM_SYSCOMMAND: u32 = 0x0112;
    const WM_NCLBUTTONDBLCLK: u32 = 0x00A3;
    /// WM_SYSCOMMAND 的最大化命令；wParam 低 4 位是系统内部数据，判断时要先掩掉
    const SC_MAXIMIZE: usize = 0xF030;
    const SYS_COMMAND_MASK: usize = 0xFFF0;

    unsafe extern "system" fn quickbar_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if QUICKBAR_MODE.load(Ordering::SeqCst) {
            match msg {
                // 拖到屏幕顶端时 Shell 请求最大化 —— 速览改为收起，这里直接吞掉
                WM_SYSCOMMAND if wparam & SYS_COMMAND_MASK == SC_MAXIMIZE => return 0,
                // 双击自绘标题栏 —— 同上
                WM_NCLBUTTONDBLCLK => return 0,
                _ => {}
            }
        }
        let prev = PREV_PROC.load(Ordering::SeqCst);
        if prev == 0 {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        // 原窗口过程地址：GetWindowLongPtrW 取出来的就是一个 LONG_PTR
        let prev_proc: WNDPROC = std::mem::transmute(prev);
        CallWindowProcW(prev_proc, hwnd, msg, wparam, lparam)
    }

    /// 给窗口挂上消息接管（只挂一次）。hwnd 由 tauri 的 `window.hwnd()` 提供。
    pub fn install(raw_hwnd: *mut std::ffi::c_void) {
        if raw_hwnd.is_null() {
            return;
        }
        unsafe {
            let prev = GetWindowLongPtrW(raw_hwnd, GWLP_WNDPROC);
            // 拿不到原过程（或已经挂过）就不再处理，宁可保持系统默认行为
            if prev == 0 || prev == quickbar_wnd_proc as *const () as usize as isize {
                return;
            }
            PREV_PROC.store(prev, Ordering::SeqCst);
            SetWindowLongPtrW(raw_hwnd, GWLP_WNDPROC, quickbar_wnd_proc as *const () as usize as isize);
        }
    }

    /// 光标是否落在窗口横向范围内、且高度上离窗口不超过一条感应带（物理像素）。
    /// 收成 5px 细线后鼠标几乎不可能「进入窗口」，靠这条感应带把它救回来。
    pub fn cursor_near(raw_hwnd: isize) -> bool {
        if raw_hwnd == 0 {
            return false;
        }
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(raw_hwnd as HWND, &mut rect) == 0 {
                return false;
            }
            let mut pt: POINT = std::mem::zeroed();
            if GetCursorPos(&mut pt) == 0 {
                return false;
            }
            if rect.right <= rect.left || rect.bottom <= rect.top {
                return false;
            }
            pt.y >= rect.top - 2
                && pt.y <= rect.bottom + SENSOR_BAND_PX
                && pt.x >= rect.left - 2
                && pt.x <= rect.right + 2
        }
    }

    /// 开 / 关这个窗口的 DWM 过渡（见外层 `set_window_transitions` 的说明）。
    ///
    /// 直接 extern 声明 dwmapi：只为一个属性去给 windows-sys 开 `Win32_Graphics_Dwm`
    /// feature 不值当（还得连带编译一堆 DWM 类型）。
    pub fn set_transitions(raw_hwnd: *mut std::ffi::c_void, disabled: bool) -> Result<(), String> {
        // DWMWA_TRANSITIONS_FORCEDISABLED
        const ATTR: u32 = 3;
        let value: i32 = if disabled { 1 } else { 0 };
        let hr = unsafe {
            DwmSetWindowAttribute(
                raw_hwnd,
                ATTR,
                &value as *const i32 as *const std::ffi::c_void,
                4,
            )
        };
        if hr < 0 {
            return Err(format!("DwmSetWindowAttribute 失败 0x{:08x}", hr as u32));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn install_once(window: &WebviewWindow) {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    match window.hwnd() {
        // tauri 用的是 `windows` crate 的 HWND（透明包装一个裸指针），这里换成裸指针交给 windows-sys
        Ok(hwnd) => platform::install(hwnd.0 as *mut std::ffi::c_void),
        Err(e) => eprintln!("[quickbar] 无法接管窗口消息，拖顶最大化可能仍然发生: {e}"),
    }
}

/// 前端进入 / 退出速览时调用：切换是否拦截最大化。
/// 完整界面的行为完全不变（含拖到顶部最大化）。
#[tauri::command]
#[allow(unused_variables)]
pub fn set_quickbar_mode(window: WebviewWindow, mode: bool) {
    QUICKBAR_MODE.store(mode, Ordering::SeqCst);
    // 速览是常驻的悬浮面板（收起来就剩屏幕顶一根线），不该在任务栏里占一格；
    // 回到完整界面再让它出现。想调出完整界面走桌面 / 开始菜单图标（单实例唤起）。
    let _ = window.set_skip_taskbar(mode);
    #[cfg(windows)]
    {
        if mode {
            install_once(&window);
        }
    }
}

/// 起一个常驻轮询线程：感应开启时每 90ms 看一眼光标，落进感应带就通知前端。
/// 线程只起一次，关闭时低频空转——每次收起都新建线程会把窗口抖动放大。
#[cfg(windows)]
fn start_sensor(window: WebviewWindow) {
    if SENSOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // 边沿触发：只在「感应带外 → 内」的跳变时发一次事件。
        // 原来是每 240ms 持续发——鼠标一直停在线上时，前端会被反复拉进
        // 展开/收回的循环里空转（光标不动也一直收发事件），既费电又不稳。
        let mut was_near = false;
        loop {
            if DOCK_SENSOR.load(Ordering::SeqCst) {
                let hit = platform::cursor_near(DOCK_HWND.load(Ordering::SeqCst));
                if hit && !was_near {
                    let _ = window.emit(DOCK_NEAR_EVENT, ());
                }
                was_near = hit;
                std::thread::sleep(std::time::Duration::from_millis(SENSOR_POLL_MS));
            } else {
                was_near = false;
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    });
}

/// 前端收成细线 / 重新展开时调用：开关光标靠近感应。
#[tauri::command]
#[allow(unused_variables)]
pub fn set_dock_sensor(window: WebviewWindow, active: bool) {
    DOCK_SENSOR.store(active, Ordering::SeqCst);
    #[cfg(windows)]
    {
        if !active {
            return;
        }
        if let Ok(hwnd) = window.hwnd() {
            DOCK_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        }
        start_sensor(window);
    }
}

/// 关掉 / 恢复这个窗口的 DWM 过渡（最小化、还原、最大化时系统播的那几个动画）。
///
/// 速览贴在屏幕顶边时窗口只剩十几像素高，点「最小化」时 Windows 会从这个又扁又宽的位置
/// 播一段「飞到任务栏」的动画，还原时又从任务栏「放大」回来——两下都很割裂。
/// `DWMWA_TRANSITIONS_FORCEDISABLED` 是逐窗口的开关，不碰系统全局设置，
/// 所以只在我们这一条贴顶路径上临时打开，还原后就关掉。
#[tauri::command]
#[allow(unused_variables)]
pub fn set_window_transitions(window: WebviewWindow, disabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        platform::set_transitions(hwnd.0 as *mut std::ffi::c_void, disabled)?;
    }
    Ok(())
}
