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

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::Mutex;
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
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, CallWindowProcW, DefWindowProcW, GetCursorPos, GetForegroundWindow,
        GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowLongPtrW, GWLP_WNDPROC, WNDPROC,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;

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

    /// 强行把窗口提到前台并给键盘焦点。
    ///
    /// Windows 有「前台窗口锁」：后台进程调用 SetForegroundWindow 通常会被直接拒绝。
    /// 用全局热键把速览叫出来时这一点很致命——面板弹出来了，但键盘焦点还在别的软件上，
    /// 用户接着敲 Esc / 打字全部落到别人那里（看起来就是「展开了但按键没反应」）。
    /// AttachThreadInput 把当前线程和前台窗口线程的输入队列临时挂在一起，
    /// 这样 SetForegroundWindow 才会被接受。
    pub unsafe fn force_foreground(hwnd: HWND) {
        let fg = GetForegroundWindow();
        let fg_tid = if fg.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, std::ptr::null_mut())
        };
        let me = GetCurrentThreadId();
        let attached = fg_tid != 0 && fg_tid != me && AttachThreadInput(me, fg_tid, 1) != 0;
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        SetFocus(hwnd);
        if attached {
            AttachThreadInput(me, fg_tid, 0);
        }
    }

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

/// 系统级快捷键被按下时发给前端的事件名（前端据此展开 / 收起速览）
pub const HOTKEY_EVENT: &str = "quickbar://hotkey";
/// 改键后注册失败（被别人占用）时发给前端的事件名，payload 是给人看的错误文案
pub const HOTKEY_ERROR_EVENT: &str = "quickbar://hotkey-error";

/// 让热键线程重新注册的消息（WM_APP 段，只要不和窗口自己用的消息撞就行）
#[cfg(windows)]
const WM_RELOAD_HOTKEY: u32 = 0x8000 + 0x21;

/// 用户配置的快捷键：虚拟键码 + 修饰键（与前端 lib/hotkey.ts 一一对应）
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySpec {
    pub vk: u32,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub meta: bool,
}

impl Default for HotkeySpec {
    fn default() -> Self {
        Self {
            // VK_OEM_3 = 键盘左上角那个 ` / ~
            vk: 0xC0,
            ctrl: false,
            alt: true,
            shift: false,
            meta: false,
        }
    }
}

impl HotkeySpec {
    /// 给人看的名字，只用在日志里
    fn describe(&self) -> String {
        let mut s = String::new();
        if self.ctrl {
            s.push_str("Ctrl+");
        }
        if self.alt {
            s.push_str("Alt+");
        }
        if self.shift {
            s.push_str("Shift+");
        }
        if self.meta {
            s.push_str("Win+");
        }
        s.push_str(&format!("VK({:#04X})", self.vk));
        s
    }
}

/// 当前想要的快捷键；热键线程每次重新注册都读这里
static HOTKEY_SPEC: Mutex<Option<HotkeySpec>> = Mutex::new(None);
/// 热键线程 id（用 PostThreadMessage 叫它重新注册）
static HOTKEY_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// 给热键线程回传事件用的 AppHandle
static HOTKEY_APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// 注册「系统级」快捷键。
///
/// 原来这个快捷键只挂在页面的 keydown 上：只有本软件有焦点时才生效，
/// 窗口收成顶上一条之后、或者用户在别的软件里时，按键根本到不了我们的页面。
/// `RegisterHotKey` 是 Win32 的全局热键，无论谁有焦点都会把 `WM_HOTKEY`
/// 投递给注册它的线程。
///
/// 单独开一个线程做消息泵：`RegisterHotKey(hwnd = null)` 的消息发到
/// 「注册所在线程」的队列里，必须自己跑 `GetMessage` 循环捞出来。
/// 也正因为注册绑线程，改键不能在前端命令线程里做——只能 PostThreadMessage
/// 叫醒这个线程，让它在自己的消息循环里重新注册。
pub fn start_hotkey_listener(app: tauri::AppHandle, spec: HotkeySpec) {
    if let Ok(mut s) = HOTKEY_SPEC.lock() {
        *s = Some(spec);
    }
    if let Ok(mut a) = HOTKEY_APP.lock() {
        *a = Some(app);
    }
    #[cfg(windows)]
    {
        std::thread::Builder::new()
            .name("zfm-global-hotkey".into())
            .spawn(move || unsafe {
                use windows_sys::Win32::System::Threading::GetCurrentThreadId;
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
                    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
                    MOD_WIN,
                };
                use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

                // 本进程内唯一的热键 id，取值随意，只要不和其他线程的 id 撞
                const HOTKEY_ID: i32 = 0x5A46;
                HOTKEY_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

                let register = |spec: &HotkeySpec| -> bool {
                    let mut mods = MOD_NOREPEAT;
                    if spec.ctrl {
                        mods |= MOD_CONTROL;
                    }
                    if spec.alt {
                        mods |= MOD_ALT;
                    }
                    if spec.shift {
                        mods |= MOD_SHIFT;
                    }
                    if spec.meta {
                        mods |= MOD_WIN;
                    }
                    UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                    RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods as u32, spec.vk) != 0
                };

                let current = HOTKEY_SPEC
                    .lock()
                    .ok()
                    .and_then(|g| *g)
                    .unwrap_or_default();
                if !register(&current) {
                    // 被别的软件占了（常见于输入法 / 录屏工具）：不致命，
                    // 界面内的同一组按键仍然可用，设置里还可以改成别的
                    eprintln!("[hotkey] {} 注册失败（可能已被其他程序占用）", current.describe());
                    if let Ok(a) = HOTKEY_APP.lock() {
                        if let Some(app) = a.as_ref() {
                            let _ = app.emit(HOTKEY_ERROR_EVENT, current.describe());
                        }
                    }
                } else {
                    eprintln!("[hotkey] {} 已注册为系统级热键", current.describe());
                }

                let mut msg: MSG = std::mem::zeroed();
                loop {
                    let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
                    if r <= 0 {
                        break;
                    }
                    if msg.message == WM_RELOAD_HOTKEY {
                        // 设置里改了键：按最新的配置重新注册
                        let want = HOTKEY_SPEC
                            .lock()
                            .ok()
                            .and_then(|g| *g)
                            .unwrap_or_default();
                        if register(&want) {
                            eprintln!("[hotkey] 已切换为 {}", want.describe());
                        } else {
                            eprintln!("[hotkey] {} 注册失败（可能已被其他程序占用）", want.describe());
                            if let Ok(a) = HOTKEY_APP.lock() {
                                if let Some(app) = a.as_ref() {
                                    let _ = app.emit(HOTKEY_ERROR_EVENT, want.describe());
                                }
                            }
                        }
                    } else if msg.message == WM_HOTKEY && msg.wParam == HOTKEY_ID as usize {
                        if let Ok(a) = HOTKEY_APP.lock() {
                            if let Some(app) = a.as_ref() {
                                let _ = app.emit(HOTKEY_EVENT, ());
                            }
                        }
                    }
                }
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
            })
            .ok();
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// 设置里改键后调用：更新目标配置并叫醒热键线程重新注册。
/// 注册结果通过 `quickbar://hotkey-error` 事件回传（成功则不出声）。
#[tauri::command]
pub fn set_quickbar_hotkey(hotkey: HotkeySpec) -> Result<(), String> {
    if hotkey.vk == 0 {
        return Err("快捷键不能为空".into());
    }
    if let Ok(mut s) = HOTKEY_SPEC.lock() {
        *s = Some(hotkey);
    }
    #[cfg(windows)]
    {
        let tid = HOTKEY_THREAD_ID.load(Ordering::SeqCst);
        if tid == 0 {
            return Err("热键线程尚未就绪，请稍后再试".into());
        }
        let ok = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                tid,
                WM_RELOAD_HOTKEY,
                0,
                0,
            )
        };
        if ok == 0 {
            return Err("通知热键线程失败".into());
        }
    }
    Ok(())
}

/// 把速览窗口强行提到前台并给键盘焦点（全局热键叫出面板后调用）。
#[tauri::command]
#[allow(unused_variables)]
pub fn focus_quickbar(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe { platform::force_foreground(hwnd.0 as *mut std::ffi::c_void) };
    }
    Ok(())
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
