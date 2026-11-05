//! 单实例守卫 + 「再点一次图标」唤起 + 「双击导出文件」把路径递给已开着的实例。
//!
//! 场景：
//! - 软件已经开着（多半正收在屏幕顶端那一根速览细线里），用户又点了一次桌面 /
//!   开始菜单图标 —— 第二个进程通知首实例把完整界面叫出来，然后自己退出。
//! - 用户在资源管理器双击 `.S-/.P-/.L-FontManager`，而软件已经开着 —— Windows 会
//!   按文件关联再起一个进程并把文件路径当命令行参数传进来。第二个进程把路径写到
//!   `%APPDATA%\FontManager\open-request.txt`，再 SetEvent；首实例收到后发
//!   `app://open-file`，由前端统一走内容嗅探导入。
//!
//! 做法（纯 Win32，不引新依赖）：
//! - 命名互斥体 `Local\FontManager.SingleInstance`：抢不到说明已经有实例在跑；
//! - 命名事件 `Local\FontManager.Activate`：第二个进程 SetEvent 一下就退出；
//! - 请求文件：只用本地临时小文本传一个路径，不引入管道 / 窗口消息。
//!
//! 用 `Local\` 前缀：作用域是当前登录会话，多用户同时登录时互不干扰。

/// 首实例收到「再点一次图标」时发给前端的应用内事件名
pub const ACTIVATE_EVENT: &str = "app://activate";
/// 首实例收到「有导出文件要打开」时发给前端的应用内事件名，payload 是文件路径
pub const OPEN_FILE_EVENT: &str = "app://open-file";

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::path::PathBuf;

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
    const MUTEX_NAME: &str = "Local\\FontManager.SingleInstance";
    const EVENT_NAME: &str = "Local\\FontManager.Activate";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 第二个实例把要打开的文件路径留给首实例。写在用户配置目录，不需要额外权限。
    fn request_path() -> PathBuf {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("FontManager").join("open-request.txt")
    }

    pub fn write_request(path: &str) {
        let p = request_path();
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, path);
    }

    /// 读一次就删，避免下次只是「点桌面图标」时又把上回的文件导一遍。
    pub fn take_request() -> Option<String> {
        let p = request_path();
        let text = std::fs::read_to_string(&p).ok()?.trim().to_string();
        let _ = std::fs::remove_file(&p);
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    /// 抢实例守卫。返回 `Some(事件句柄)` = 自己是首实例；`None` = 已经有实例在跑
    /// （并且已经通知它），调用方应当立刻退出。
    pub fn acquire(open_file: Option<&str>) -> Option<isize> {
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
                // 先写文件再发信号，保证首实例醒来时一定能读到路径
                if let Some(path) = open_file {
                    write_request(path);
                }
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

    /// 起一个线程等信号。收到后先唤起界面，再把待打开的文件路径（如果有）发给前端。
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
                    if let Some(path) = take_request() {
                        // 前端切回完整界面是异步的，稍等一拍再投递导入请求
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        let _ = app.emit(crate::single_instance::OPEN_FILE_EVENT, path);
                    }
                }
                // WAIT_FAILED / 句柄失效：没什么可等的了，退出线程
                _ => return,
            }
        });
    }
}

/// 抢实例守卫。`true` = 自己是首实例可以继续启动；`false` = 已有实例在跑，调用方退出。
/// `open_file` 是命令行里带进来的导出文件路径（双击文件时 Windows 会传）。
pub fn acquire(open_file: Option<&str>) -> bool {
    #[cfg(windows)]
    {
        match platform::acquire(open_file) {
            Some(handle) => {
                let _ = HANDLE.set(handle);
                true
            }
            None => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = open_file;
        true
    }
}

/// 首实例等到「再点一次图标 / 双击导出文件」时唤起界面。非首实例不需要调用。
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
