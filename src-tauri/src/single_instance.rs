//! 单实例守卫 + 「再点一次图标」唤起。
//!
//! 场景：软件已经开着（多半正收在屏幕顶端那一根速览细线里），用户又点了一次桌面 /
//! 开始菜单图标。没有这道守卫时 Windows 会原样再起一个进程——任务栏里于是出现第二个
//! 一模一样的图标，而用户想要的「把已经开着的那个程序打开」什么也没发生。
//!
//! 做法（纯 Win32，不引新依赖）：
//! - 命名互斥体 `Local\ZFontManager.SingleInstance`：抢不到说明已经有实例在跑；
//! - 命名事件 `Local\ZFontManager.Activate`：第二个进程 SetEvent 一下就退出，
//!   第一个实例里等这个事件的线程收到后发 `app://activate`，由前端把完整界面叫出来。
//!
//! 用 `Local\` 前缀：作用域是当前登录会话，多用户同时登录时互不干扰。

/// 首实例收到「再点一次图标」时发给前端的应用内事件名
pub const ACTIVATE_EVENT: &str = "app://activate";

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    // 自己声明 kernel32 入口：windows-sys 的 CreateMutexW / CreateEventW 签名要
    // `Security` 模块的类型，多开一个 feature 只为一对空指针没有意义。
    extern "system" {
        fn CreateMutexW(attrs: *const c_void, initial_owner: i32, name: *const u16) -> isize;
        fn CreateEventW(attrs: *const c_void, manual_reset: i32, initial: i32, name: *const u16)
            -> isize;
        fn SetEvent(handle: isize) -> i32;
        fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
        fn GetLastError() -> u32;
    }

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const MUTEX_NAME: &str = "Local\\ZFontManager.SingleInstance";
    const EVENT_NAME: &str = "Local\\ZFontManager.Activate";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 抢实例守卫。返回 `Some(事件句柄)` = 自己是首实例；`None` = 已经有实例在跑
    /// （并且已经通知它把界面叫出来），调用方应当立刻退出。
    pub fn acquire() -> Option<isize> {
        let name = wide(MUTEX_NAME);
        // SAFETY: name 是以 NUL 结尾的宽字符串，且活得比调用久；属性指针传空用默认安全描述符。
        unsafe {
            let mutex = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
            if mutex == 0 {
                // 连互斥体都建不出来（极少见），当作首实例放行，宁可多开一个也不能起不来
                return Some(0);
            }
            // 互斥体句柄故意不关：进程退出时由系统回收。提前关会让「已存在」判定失效。
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let ev = wide(EVENT_NAME);
                let handle = CreateEventW(std::ptr::null(), 0, 0, ev.as_ptr());
                if handle != 0 {
                    SetEvent(handle);
                }
                return None;
            }
            let ev = wide(EVENT_NAME);
            let handle = CreateEventW(std::ptr::null(), 0, 0, ev.as_ptr());
            if handle == 0 {
                return Some(0);
            }
            Some(handle)
        }
    }

    /// 起一个线程等「再点一次图标」的信号，收到就发应用内事件。
    pub fn wait_activate(app: tauri::AppHandle, handle: isize) {
        if handle == 0 {
            return;
        }
        std::thread::spawn(move || loop {
            // SAFETY: handle 来自 CreateEventW，进程活着期间一直有效
            let r = unsafe { WaitForSingleObject(handle, INFINITE) };
            match r {
                0 => {
                    use tauri::Emitter;
                    let _ = app.emit(crate::single_instance::ACTIVATE_EVENT, ());
                }
                // WAIT_FAILED / 句柄失效：没什么可等的了，退出线程
                _ => return,
            }
        });
    }
}

/// 抢实例守卫。`true` = 自己是首实例可以继续启动；`false` = 已有实例在跑，调用方退出。
pub fn acquire() -> bool {
    #[cfg(windows)]
    {
        match platform::acquire() {
            Some(handle) => {
                let _ = HANDLE.set(handle);
                true
            }
            None => false,
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// 首实例等到「再点一次图标」时唤起界面。非首实例不需要调用。
pub fn watch(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        let handle = HANDLE.get().copied().unwrap_or(0);
        platform::wait_activate(app, handle);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
static HANDLE: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
