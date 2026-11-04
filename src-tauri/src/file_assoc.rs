#![cfg(target_os = "windows")]
//! 给导出的 `.ZFontManager` 整包一个专属文件图标（Z + fills）。
//!
//! 只写 `HKCU\Software\Classes\.ZFontManager\DefaultIcon` 这一个值：
//! - 不写 `shell\open`、不改默认打开方式 —— 用户之前用什么打开这个包，
//!   装完本软件之后还是什么，双击行为一点不变；
//! - 图标文件优先落在 exe 同目录（卸载时随安装目录一起消失，图标自动失效），
//!   那里不可写（例如装到 Program Files 的 MSI 版）才退回 `%APPDATA%\ZFontManager`；
//! - 值没变就不重写、不通知资源管理器刷新，避免每次启动都逼 Explorer 重建图标缓存。

use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_SZ,
};
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

/// 扩展名键下的 DefaultIcon；优先于 ProgID 上的同类设置，且不影响打开方式。
const ICON_KEY: &str = r"Software\Classes\.ZFontManager\DefaultIcon";

/// 多尺寸（16~256）ICO，小尺寸是纯 Z、48 以上带 fills。
const ICON_BYTES: &[u8] = include_bytes!("../assets/pack-icon.ico");

const ICON_NAME: &str = "pack-icon.ico";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 内容一致就不写盘：启动路径每次都跑，别白白写 400 KB。
fn write_if_changed(path: &Path) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read(path) {
        if existing == ICON_BYTES {
            return Ok(());
        }
    }
    std::fs::write(path, ICON_BYTES)
}

/// 先试 exe 同目录，失败退回用户配置目录。返回最终落地的路径。
fn install_icon_file() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(ICON_NAME);
            if write_if_changed(&candidate).is_ok() {
                return Some(candidate);
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("ZFontManager");
    std::fs::create_dir_all(&dir).ok()?;
    let candidate = dir.join(ICON_NAME);
    write_if_changed(&candidate).ok()?;
    Some(candidate)
}

/// 读现有 DefaultIcon 值（默认值，名字为空串）。
fn current_value() -> Option<String> {
    let sub = wide(ICON_KEY);
    let mut key: HKEY = null_mut();
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut key) };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let mut buf = vec![0u16; 2048];
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

fn write_value(value: &str) -> Result<(), String> {
    let sub = wide(ICON_KEY);
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
        return Err(format!("couldn't write the file-association icon (error {rc})"));
    }
    Ok(())
}

/// 幂等：已经指向我们这张图标就什么都不做。返回是否真的改过注册表。
pub fn ensure_pack_icon() -> Result<bool, String> {
    let icon = install_icon_file().ok_or_else(|| "couldn't place the pack icon file".to_string())?;
    let wanted = format!("{},0", icon.display());
    if current_value().as_deref() == Some(wanted.as_str()) {
        return Ok(false);
    }
    write_value(&wanted)?;
    // 只刷新关联图标，不重建整个图标缓存
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
    fn icon_has_expected_frames() {
        // ICO 头：reserved=0, type=1, count
        assert_eq!(&ICON_BYTES[0..2], &[0, 0]);
        assert_eq!(&ICON_BYTES[2..4], &[1, 0]);
        let count = u16::from_le_bytes([ICON_BYTES[4], ICON_BYTES[5]]);
        assert_eq!(count, 10, "16/20/24/32/40/48/64/96/128/256 十帧");
    }

    #[test]
    fn value_format_is_path_comma_index() {
        // 只是确认拼法；真实写入要用户机器上的注册表，测试不碰
        let p = PathBuf::from(r"C:\x\pack-icon.ico");
        assert_eq!(format!("{},0", p.display()), r"C:\x\pack-icon.ico,0");
    }
}
