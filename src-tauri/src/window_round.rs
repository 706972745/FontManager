//! 窗口圆角。
//!
//! 主窗口是 `decorations: false` 的自绘窗口，WebView 铺满整个矩形，四角原来是尖的。
//! 这里用 DWM 的 `DWMWA_WINDOW_CORNER_PREFERENCE` 让系统自己把窗口裁成圆角 ——
//! 和资源管理器、设置这些原生窗口用的是同一套裁剪，半径、抗锯齿都一致，
//! 也不用为了圆角把 html/body 改成透明（那会让「速览 ↔ 完整界面」形变过程中露出桌面）。
//!
//! 只有 Win11 认这个属性；Win10 上函数存在但会返回失败，四角维持原样，不影响功能。
//!
//! ## 为什么还要按高度关掉
//!
//! 速览收起时窗口只有 12 逻辑像素高，里面画的是 5px 的抓手线。DWM 圆角用的是固定
//! 半径（约 8px），套在这么矮的窗口上会把整个窗口裁成一颗胶囊，线的两头也被切进圆角里
//! —— 看起来就是「抓手线坏了」。所以窗口矮于阈值时切成直角，线该什么样还是什么样。

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::time::Duration;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

/// DWMWA_WINDOW_CORNER_PREFERENCE
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
/// DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_DONOTROUND
const DWMWCP_DONOTROUND: u32 = 1;
/// DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_ROUND
const DWMWCP_ROUND: u32 = 2;

/// 高度低于这个物理像素就认为窗口是「一根线」：12 逻辑 px × 125% ≈ 15，
/// 展开的速览提示条约 42，完整界面 800+，中间没有别的形态。
const FLAT_THRESHOLD_PX: i32 = 24;

#[link(name = "dwmapi")]
extern "system" {
    /// 签名必须和依赖里已有的声明一致（`windows-sys` 那边是裸 HWND 指针）
    fn DwmSetWindowAttribute(hwnd: *mut c_void, attr: u32, pv: *const c_void, cb: u32) -> i32;
}

fn set_round(raw_hwnd: *mut c_void, on: bool) {
    if raw_hwnd.is_null() {
        return;
    }
    let pref: u32 = if on { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
    // SAFETY: 只传一个指向本栈 u32 的指针和它的字节数，DWM 只读不写；hwnd 已判空。
    unsafe {
        let _ = DwmSetWindowAttribute(
            raw_hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

fn physical_height(raw_hwnd: *mut c_void) -> i32 {
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: rect 是栈上合法的输出缓冲；窗口句柄由 tauri 提供。
    let ok = unsafe { GetWindowRect(raw_hwnd, &mut rect) };
    if ok == 0 {
        return 0;
    }
    (rect.bottom - rect.top).max(0)
}

/// 给窗口开启系统圆角。raw_hwnd 由 tauri 的 `window.hwnd()` 提供。
pub fn round_corners(raw_hwnd: *mut c_void) {
    set_round(raw_hwnd, true);
}

/// 盯着窗口高度，在「一根线」和正常窗口之间自动切换圆角。
///
/// 150ms 轮询一次（`GetWindowRect` 是纯用户态读取，比一帧渲染便宜得多），
/// 只在判定翻转时才真的调用 DWM，所以常态下几乎没有开销。
pub fn watch_height(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut raw: *mut c_void = std::ptr::null_mut();
        let mut rounded: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(150));
            if raw.is_null() {
                match window.hwnd() {
                    Ok(h) => raw = h.0 as *mut c_void,
                    Err(_) => continue,
                }
            }
            let want_round = physical_height(raw) > FLAT_THRESHOLD_PX;
            if rounded != Some(want_round) {
                set_round(raw, want_round);
                rounded = Some(want_round);
            }
        }
    });
}
