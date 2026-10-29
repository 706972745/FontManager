//! 窗口圆角。
//!
//! 主窗口是 `decorations: false` 的自绘窗口，WebView 铺满整个矩形，四角原来是尖的。
//! 这里用 DWM 的 `DWMWA_WINDOW_CORNER_PREFERENCE` 让系统自己把窗口裁成圆角 ——
//! 和资源管理器、设置这些原生窗口用的是同一套裁剪，半径、抗锯齿都一致，
//! 也不用为了圆角把 html/body 改成透明（那会让「速览 ↔ 完整界面」形变过程中露出桌面）。
//!
//! 只有 Win11 认这个属性；Win10 上函数存在但会返回失败，四角维持原样，不影响功能。
//!
//! ## 收起态为什么要切成直角
//!
//! 速览收起后窗口只剩屏幕顶部一条（提示条 ~43 物理像素 / 细线 ~15 物理像素）。
//! 这时候不能再用 DWM 圆角，有两个原因，都是实测出来的：
//!
//! 1. **细线会被裁成胶囊**：DWM 半径固定约 8 物理像素，套在 15px 高的窗口上，
//!    整条窗口变成胶囊，抓手线的两头被切掉。
//! 2. **DWM 只给圆角窗口画阴影**（这才是主要问题）：白色背景实测，43px 高的提示条
//!    下方亮度从 255 掉到 184，阴影一直拖到 140px 才收干净；同一条提示条只要把圆角
//!    关掉，整片立刻回到 255。收起态是贴在屏幕上沿的一条，底下就是用户的桌面，
//!    这圈大阴影在浅色背景上非常扎眼。
//!
//! 所以收起态一律切成直角，圆角改由 `.qb-frame` 的 CSS 画（半径按 8 物理像素换算，
//! 见 `--qb-radius`）。切换点落在提示条那 43px 高度上，两种圆角形状一致，看不出跳变。

#![cfg(target_os = "windows")]

use std::ffi::c_void;

use tauri::WebviewWindow;

/// DWMWA_WINDOW_CORNER_PREFERENCE
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
/// DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_DONOTROUND
const DWMWCP_DONOTROUND: u32 = 1;
/// DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_ROUND
const DWMWCP_ROUND: u32 = 2;

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

/// 由前端调用：切换这个窗口的 DWM 圆角偏好。
///
/// 现在只往「关掉」的方向用（DONOTROUND）：圆角统一由 CSS 画（`--qb-radius`），
/// 因为 DWM 只给圆角窗口画阴影，而完整界面和速览都不要窗口边缘阴影。
/// 保留 `on` 参数是为了语义完整（万一以后要恢复系统圆角），但调用方一律传 false。
pub fn set_rounded(window: &WebviewWindow, on: bool) {
    if let Ok(hwnd) = window.hwnd() {
        set_round(hwnd.0 as *mut c_void, on);
    }
}

#[tauri::command]
pub fn set_window_rounded(window: WebviewWindow, on: bool) {
    set_rounded(&window, on);
}
