#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 发布版没有控制台：panic 默认只往 stderr 写，用户看不到、我们也拿不到。
    // 挂个钩子先把它落进 activation.log，闪退才查得动。
    std::panic::set_hook(Box::new(|info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".into());
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "未知 panic".into()
        };
        fontmanager_lib::log_panic(&format!("{msg} @ {where_}"));
    }));
    fontmanager_lib::run()
}
