use crate::parser;
use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

pub struct WatchHandle(pub Mutex<Option<notify::RecommendedWatcher>>);

/// 事件合并窗口（1.9.0 审查项 P6）。
///
/// 往字体库里拷 500 个字体，Windows 会给 500+ 个 create/modify 事件。
/// 原来每个事件都 `emit("fonts:changed")` —— 前端虽然有 1.5s 防抖，但每来一个事件
/// 就把计时器清零，批量导入过程中一直不会触发；导入刚结束又被最后一个事件重新计时，
/// 结果是「导入已经把库读好了，紧接着又白跑一次全量 rescan」。
/// 现在后端先合并：安静 400ms 才发一次，前端那层防抖保留作二次保险。
const QUIET_WINDOW: Duration = Duration::from_millis(400);

pub fn start(app: tauri::AppHandle, dirs: Vec<PathBuf>) -> Result<notify::RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<()>();
    // 合并线程的生命期跟着 watcher：watcher 被 drop 时闭包里的 tx 一起 drop，
    // rx.recv() 收到 Disconnected，线程自己退出，不会在切换字体库后留下野线程。
    let emitter = app.clone();
    let _ = std::thread::Builder::new()
        .name("zfm-watcher-debounce".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                // 拖尾合并：窗口内又来事件就继续等，直到连续 400ms 没有动静
                loop {
                    match rx.recv_timeout(QUIET_WINDOW) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let _ = emitter.emit("fonts:changed", ());
            }
        });

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else { return };

        let mutating = event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove();
        if mutating && event.paths.iter().any(|p| parser::is_font_file(p)) {
            // 只发一个「有事发生」的信号；合并窗口由上面的线程负责
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;

    for dir in dirs {
        if dir.is_dir() {
            let _ = watcher.watch(&dir, RecursiveMode::Recursive);
        }
    }
    Ok(watcher)
}
