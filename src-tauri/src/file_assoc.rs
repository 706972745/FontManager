#![cfg(target_os = "windows")]
//! 三种导出文件的 Windows 关联（1.2.4）。
//!
//! `.S-FontManager` 快照 / `.P-FontManager` 字体库整包 / `.D-FontManager` 整理数据：
//! - 每个扩展名各注册一枚纸片风图标（S / P / D，见 assets/*-icon.ico）；
//! - 每个扩展名都写 `shell\open\command`，双击就把路径交给本程序导入。
//!   导入端按**文件内容**分辨类型（file_kind.rs），所以后缀被改过也不影响。
//!
//! 约束：
//! - 只写 HKCU，不需要管理员权限，也不动系统级 HKCR；
//! - `.L-FontManager` 是「整理数据」的旧后缀（2.5.4 及以前），注册表里留一份
//!   兼容关联（见 `LEGACY_EXTS`），但**只做兼容读**：不许再往导出文件名、文件
//!   对话框过滤器、界面文案里出现，那些地方只出现 `.D-FontManager`；
//! - 图标文件优先落在 exe 同目录（卸载时随安装目录一起消失），
//!   那里不可写（例如装到 Program Files 的 MSI 版）才退回 `%APPDATA%\FontManager`；
//! - 值没变就不重写、不通知资源管理器刷新，避免每次启动都逼 Explorer 重建图标缓存。

use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_SZ,
};
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

struct Assoc {
    /// 不带点。连字符在 Windows 扩展名里是合法字符。
    ext: &'static str,
    icon_name: &'static str,
    icon_bytes: &'static [u8],
}

const ASSOCS: [Assoc; 3] = [
    Assoc {
        ext: "S-FontManager",
        icon_name: "snapshot-icon.ico",
        icon_bytes: include_bytes!("../assets/snapshot-icon.ico"),
    },
    Assoc {
        ext: "P-FontManager",
        icon_name: "pack-icon.ico",
        icon_bytes: include_bytes!("../assets/pack-icon.ico"),
    },
    Assoc {
        ext: "D-FontManager",
        icon_name: "data-icon.ico",
        icon_bytes: include_bytes!("../assets/data-icon.ico"),
    },
];

/// 只做兼容读的旧后缀。`.L-FontManager` 是「整理数据」在 2.5.4 及以前的扩展名，
/// 用户手上可能还存着这种文件：改名后如果不再注册这个键，那些文件在资源管理器里
/// 就既没有图标、双击也没反应 —— 等于把已经能用的东西改坏。
///
/// 所以这里单独列一份，注册时与 `ASSOCS` 一起写注册表，指向同一枚 `data-icon.ico`
/// 和同一条 `shell\open\command`。**故意不混进 `ASSOCS`**：
/// - `ASSOCS` 的语义是「当前在用的三种导出物，各一枚七帧图标」，掺进 legacy 会让
///   `three_icons_have_full_frames` 那条单测变得名不副实；
/// - 混进去也容易让后续代码把 legacy 当成一个可以导出的类型。
///
/// 硬约束：`.L-FontManager` 只出现在这里和注释/legacy 测试里，不许出现在导出文件名、
/// 文件对话框过滤器或任何界面文案（前端对应 `lib/fileKinds.ts` 的 `LEGACY_EXTENSIONS`）。
const LEGACY_EXTS: [&str; 1] = ["L-FontManager"];

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 内容一致就不写盘：启动路径每次都跑，别白白写三份 50 KB。
/// 返回是否真的写了盘（换图标版本时要靠这个结果去通知资源管理器）。
fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read(path) {
        if existing == bytes {
            return Ok(false);
        }
    }
    std::fs::write(path, bytes)?;
    Ok(true)
}

fn icon_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.is_dir() {
                return Some(dir.to_path_buf());
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("FontManager");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 读某个键的默认值（REG_SZ）。
fn current_value(key: &str) -> Option<String> {
    let sub = wide(key);
    let mut key: HKEY = null_mut();
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut key) };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let mut buf = vec![0u16; 4096];
    let mut len = (buf.len() * 2) as u32;
    let mut kind = 0u32;
    let name = wide("");
    let rc = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            null_mut(),
            &mut kind,
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        )
    };
    unsafe { RegCloseKey(key) };
    if rc != ERROR_SUCCESS || kind != REG_SZ || len < 2 {
        return None;
    }
    // REG_SZ 带结尾的 0，去掉再比
    let words = &buf[..(len as usize / 2).saturating_sub(1)];
    Some(String::from_utf16_lossy(words))
}

fn write_value(key: &str, value: &str) -> Result<(), String> {
    let sub = wide(key);
    let mut key: HKEY = null_mut();
    // RegCreateKeyW 建出来的键带写权限；这里不需要 SECURITY_ATTRIBUTES，
    // 也就不必为 RegCreateKeyExW 打开 Win32_Security 那一个大 feature。
    let rc = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, sub.as_ptr(), &mut key) };
    if rc != ERROR_SUCCESS {
        return Err(format!("couldn't create the file-association key (error {rc})"));
    }
    let name = wide("");
    let data = wide(value);
    let rc = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr() as *const u8,
            (data.len() * 2) as u32,
        )
    };
    unsafe { RegCloseKey(key) };
    if rc != ERROR_SUCCESS {
        return Err(format!("couldn't write the file-association value (error {rc})"));
    }
    Ok(())
}

fn set_if_changed(key: &str, wanted: &str, changed: &mut bool) -> Result<(), String> {
    if current_value(key).as_deref() == Some(wanted) {
        return Ok(());
    }
    write_value(key, wanted)?;
    *changed = true;
    Ok(())
}

/// 幂等：三个扩展名的图标 + 双击命令都已经指向本程序就什么都不做。
/// 返回是否需要通知 Explorer 刷新（注册表或图标文件任一真的变了）。
pub fn ensure_associations() -> Result<bool, String> {
    let dir = icon_dir().ok_or_else(|| "couldn't place the association icons".to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // 路径带空格也要能双击打开；%1 是资源管理器传进来的文件路径
    let open_command = format!("\"{}\" \"%1\"", exe.display());
    let mut changed = false;
    for a in &ASSOCS {
        let icon_path = dir.join(a.icon_name);
        // 图标文件内容换了（注册表里的路径没变）：也要让 Explorer 重读一遍，
        // 否则资源管理器继续拿缓存里的旧图标画 .S/.P/.D —— 1.7.3 换整set 图标
        // 时就是这样，文件明明已经替换，双击列表里看到的还是上一版。
        if write_if_changed(&icon_path, a.icon_bytes)
            .map_err(|e| format!("couldn't write {}: {e}", icon_path.display()))?
        {
            changed = true;
        }
        let icon_value = format!("{},0", icon_path.display());
        set_if_changed(
            &format!(r"Software\Classes\.{}\DefaultIcon", a.ext),
            &icon_value,
            &mut changed,
        )?;
        set_if_changed(
            &format!(r"Software\Classes\.{}\shell\open\command", a.ext),
            &open_command,
            &mut changed,
        )?;
    }
    // 旧后缀与「仅数据」共用同一枚图标、同一条双击命令；图标文件本身已经在上面
    // 那个循环里落过盘，这里只补注册表值。
    let data_icon_name = ASSOCS
        .iter()
        .find(|a| a.ext == "D-FontManager")
        .map(|a| a.icon_name)
        .ok_or_else(|| "the data association is missing from ASSOCS".to_string())?;
    let legacy_icon_value = format!("{},0", dir.join(data_icon_name).display());
    for ext in LEGACY_EXTS {
        set_if_changed(
            &format!(r"Software\Classes\.{}\DefaultIcon", ext),
            &legacy_icon_value,
            &mut changed,
        )?;
        set_if_changed(
            &format!(r"Software\Classes\.{}\shell\open\command", ext),
            &open_command,
            &mut changed,
        )?;
    }
    if !changed {
        return Ok(false);
    }
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_icons_have_full_frames() {
        for a in &ASSOCS {
            let b = a.icon_bytes;
            assert_eq!(&b[0..2], &[0, 0], "{} ICO 头", a.ext);
            assert_eq!(&b[2..4], &[1, 0], "{} ICO 类型", a.ext);
            let count = u16::from_le_bytes([b[4], b[5]]);
            assert_eq!(count, 7, "{} 应有 16/24/32/48/64/128/256 七帧", a.ext);
            let last = 6 + (count as usize - 1) * 16;
            assert_eq!(b[last], 0, "{} 最后一帧应是 256×256", a.ext);
        }
    }

    #[test]
    fn open_command_quotes_both_paths() {
        let exe = PathBuf::from(r"C:\Program Files\FontManager\FontManager.exe");
        assert_eq!(
            format!("\"{}\" \"%1\"", exe.display()),
            "\"C:\\Program Files\\FontManager\\FontManager.exe\" \"%1\""
        );
        assert_eq!(
            format!("{},0", PathBuf::from(r"C:\x\pack-icon.ico").display()),
            r"C:\x\pack-icon.ico,0"
        );
    }

    #[test]
    fn extensions_are_the_three_agreed_suffixes() {
        let exts: Vec<&str> = ASSOCS.iter().map(|a| a.ext).collect();
        assert_eq!(exts, vec!["S-FontManager", "P-FontManager", "D-FontManager"]);
    }

    #[test]
    fn legacy_suffix_is_read_compat_only() {
        // 旧后缀只走 LEGACY_EXTS；混进 ASSOCS 会让「三枚各七帧」的单测名不副实，
        // 也会让导出侧跟着冒出 .L
        assert_eq!(LEGACY_EXTS, ["L-FontManager"]);
        assert!(
            ASSOCS.iter().all(|a| a.ext != "L-FontManager"),
            "L-FontManager 不该出现在 ASSOCS 里"
        );
        // 兼容关联必须复用「仅数据」那枚图标，别再单独维护一个文件
        let data = ASSOCS
            .iter()
            .find(|a| a.ext == "D-FontManager")
            .expect("ASSOCS 必须有 D-FontManager");
        assert_eq!(data.icon_name, "data-icon.ico");
    }
}
