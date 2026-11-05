//! 字体库文件夹的专属图标。
//!
//! 用户 2026-11-05 定：软件里指定的字体库地址（以及它在资源管理器 / 桌面的显示）
//! 要统一换成「灰底文件夹 + 抽出的纸 + 黑 F」这个图标，换库时图标跟着走。
//!
//! 做法是 Windows 的文件夹自定义图标标准机制：库里放一个隐藏的 `.zfm-folder.ico`，
//! 再放一份隐藏只读的 `desktop.ini` 指向它，最后给目录本身加只读属性
//! （Shell 只对带 ReadOnly / System 的目录读 desktop.ini）。
//!
//! 这里只动「显示」，不碰库里任何字体文件；`desktop.ini` 与 `.zfm-folder.ico`
//! 都是可逆的（删掉就恢复默认黄色文件夹）。

use std::path::Path;

/// 打包进二进制的图标（多尺寸 ICO：256/128/96/64/48/40/32/24/20/16）
const FOLDER_ICON: &[u8] = include_bytes!("../icons/library-folder.ico");
const ICON_NAME: &str = ".zfm-folder.ico";
const INI_NAME: &str = "desktop.ini";

/// 给 `dir` 挂上库文件夹图标。目录不存在时返回 Err，其余失败也带上原因，
/// 但调用方可以只记日志 —— 图标是装饰，不该阻断换库。
pub fn apply(dir: &str) -> Result<(), String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }

    let icon_path = root.join(ICON_NAME);
    let ini_path = root.join(INI_NAME);

    write_file(&icon_path, FOLDER_ICON)?;
    write_file(&ini_path, &desktop_ini(&icon_path))?;

    #[cfg(windows)]
    {
        set_attrs(&icon_path, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
        set_attrs(&ini_path, FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN);
        // Shell 只认带只读 / 系统属性的目录上的 desktop.ini
        set_attrs(root, FILE_ATTRIBUTE_READONLY);
        notify_dir_changed(root);
    }

    Ok(())
}

/// 摘掉库文件夹图标，恢复成系统默认的黄色文件夹。
///
/// 换库时对**旧库目录**调用：以前换库只给新目录挂图标，旧目录上那份
/// `desktop.ini` + `.zfm-folder.ico` 和目录只读属性会一直留着 —— 用户换走以后
/// 那个文件夹还挂着 FontManager 的图标，像是「这里还是库」。
///
/// 只在自己挂过的地方动：`desktop.ini` 里没有 `.zfm-folder.ico` 就说明是别人
/// （或用户自己）设的图标，一个字节都不碰。
pub fn retire(dir: &str) -> Result<(), String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Ok(());
    }
    let icon_path = root.join(ICON_NAME);
    let ini_path = root.join(INI_NAME);

    let mut touched = false;
    if let Ok(bytes) = std::fs::read(&ini_path) {
        let text = decode_ini(&bytes);
        if text.contains(ICON_NAME) {
            remove_file(&ini_path)?;
            touched = true;
        }
    }
    if icon_path.exists() {
        remove_file(&icon_path)?;
        touched = true;
    }

    // 只有真摘掉了我们的东西才动目录属性 / 通知 Shell：
    // 旧库有可能就是系统的 Windows 字体目录，那边的 ReadOnly 属性是有含义的，
    // 不能因为「换库顺手清一下」给清掉。
    if touched {
        #[cfg(windows)]
        {
            clear_readonly(root);
            notify_dir_changed(root);
        }
    }
    Ok(())
}

/// UTF-16LE（带 BOM）或 ANSI/UTF-8 的 desktop.ini 都尽量解出文本，仅供内部判断。
fn decode_ini(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn remove_file(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    clear_readonly(path);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// desktop.ini 必须是 UTF-16LE 带 BOM，Shell 才稳定识别中文路径。
fn desktop_ini(icon: &Path) -> Vec<u8> {
    let icon = icon.to_string_lossy();
    let text = format!(
        "[.ShellClassInfo]\r\nIconResource={icon},0\r\nIconFile={icon}\r\nIconIndex=0\r\n"
    );
    let mut out = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// 覆盖写：先摘掉只读（上一版留下的 desktop.ini 是只读的），写完再恢复由调用方设置。
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    clear_readonly(path);
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_SYSTEM,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEDIR, SHCNF_PATHW};

/// GetFileAttributesW 的失败返回值
#[cfg(windows)]
const INVALID_FILE_ATTRIBUTES: u32 = 0xFFFF_FFFF;

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn clear_readonly(path: &Path) {
    let w = wide(path);
    unsafe {
        let cur = GetFileAttributesW(w.as_ptr());
        if cur != INVALID_FILE_ATTRIBUTES && cur & FILE_ATTRIBUTE_READONLY != 0 {
            SetFileAttributesW(w.as_ptr(), cur & !FILE_ATTRIBUTE_READONLY);
        }
    }
}

#[cfg(windows)]
fn set_attrs(path: &Path, add: u32) {
    let w = wide(path);
    unsafe {
        let cur = GetFileAttributesW(w.as_ptr());
        if cur == INVALID_FILE_ATTRIBUTES {
            return;
        }
        if cur & add != add {
            SetFileAttributesW(w.as_ptr(), cur | add);
        }
    }
}

/// 让资源管理器立刻重画这个目录的图标（不然要等缓存过期或重启 explorer）。
#[cfg(windows)]
fn notify_dir_changed(path: &Path) {
    let w = wide(path);
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEDIR as i32,
            SHCNF_PATHW,
            w.as_ptr() as *const core::ffi::c_void,
            std::ptr::null(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_icon_is_a_multi_size_ico() {
        assert_eq!(&FOLDER_ICON[0..2], &[0, 0], "ICO 头 reserved");
        assert_eq!(&FOLDER_ICON[2..4], &[1, 0], "ICO 类型应为图标");
        let count = u16::from_le_bytes([FOLDER_ICON[4], FOLDER_ICON[5]]);
        assert!(count >= 7, "至少要有 7 帧，实际 {count}");
        // 最后一帧的宽高字节 0 表示 256
        let last = 6 + (count as usize - 1) * 16;
        assert_eq!(FOLDER_ICON[last], 0, "最后一帧应是 256×256");
    }

    #[test]
    fn desktop_ini_points_at_the_bundled_icon() {
        let bytes = desktop_ini(Path::new(r"E:\Fonts\.zfm-folder.ico"));
        assert_eq!(&bytes[0..2], &[0xFF, 0xFE], "UTF-16LE BOM");
        let text = String::from_utf16(
            &bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(text.contains("[.ShellClassInfo]"));
        assert!(text.contains(r"IconResource=E:\Fonts\.zfm-folder.ico,0"));
        assert!(text.contains("\r\n"));
    }

    /// 真正落到磁盘：ico 与 desktop.ini 都要写出来，第二次调用要能从只读状态覆盖过去
    #[test]
    fn apply_writes_files_and_is_repeatable() {
        let root = std::env::temp_dir().join(format!("zfm-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().to_string();

        apply(&dir).unwrap();
        let icon = root.join(ICON_NAME);
        let ini = root.join(INI_NAME);
        assert_eq!(std::fs::read(&icon).unwrap(), FOLDER_ICON);
        let first = std::fs::read(&ini).unwrap();
        assert_eq!(&first[0..2], &[0xFF, 0xFE], "desktop.ini 应为 UTF-16LE");

        // 第二次（模拟换回同一个库）要能覆盖只读的 desktop.ini
        apply(&dir).unwrap();
        assert_eq!(std::fs::read(&ini).unwrap(), first);

        #[cfg(windows)]
        {
            clear_readonly(&icon);
            clear_readonly(&ini);
            clear_readonly(&root);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 换库后旧目录要恢复原样：ico 与 desktop.ini 都不留，目录只读属性摘掉
    #[test]
    fn retire_removes_our_marker() {
        let root = std::env::temp_dir().join(format!("zfm-retire-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().to_string();

        apply(&dir).unwrap();
        retire(&dir).unwrap();
        assert!(!root.join(ICON_NAME).exists(), "ico 应被删掉");
        assert!(!root.join(INI_NAME).exists(), "desktop.ini 应被删掉");

        // 再摘一次不能报错（换库逻辑可能重复走到）
        retire(&dir).unwrap();
        // 目录不存在时静默跳过
        retire(&root.join("nope").to_string_lossy()).unwrap();

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 不是我们设的 desktop.ini（比如用户自己的文件夹图标）不能删
    #[test]
    fn retire_keeps_foreign_desktop_ini() {
        let root = std::env::temp_dir().join(format!("zfm-foreign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let ini = root.join(INI_NAME);
        std::fs::write(&ini, b"[.ShellClassInfo]\r\nIconResource=C:\\other.ico,0\r\n").unwrap();

        retire(&root.to_string_lossy()).unwrap();
        assert!(ini.exists(), "别人的 desktop.ini 不该被删");

        let _ = std::fs::remove_dir_all(&root);
    }
}
