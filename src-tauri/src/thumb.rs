//! 卡片缩略图缓存（交接文档 §13）。
//!
//! 为什么单独一个目录而不是复用 `preview-cache`：两者的失效条件完全不同 ——
//! 预览副本跟「源文件 mtime」走，缩略图还要跟「字符集 / 字号档 / DPR / 宽度 / 主题色」走，
//! 混在一起会让 `trim_cache` 的 384MB 预算被几百张 PNG 吃光。
//!
//! 目录在 `%APPDATA%\ZFontManager\thumb-cache`。**新目录必须 `allow_dir`**
//! （asset scope 的 `$APPDATA` 是指带应用标识的那个目录，覆盖不到这里 —— 0.9.4 踩过 os error 3）。
//!
//! key 由前端算好（含 face.id / 字符集 / 字号 / DPR / 宽度 / 文字颜色），
//! 这里只做三件事：校验 key、读写文件、按总量淘汰。

use std::fs;
use std::path::{Path, PathBuf};

const THUMB_DIR: &str = "thumb-cache";
/// 独立上限。一张 320×60 的 DPR2 PNG 约 10~20KB，256MB 够存上万张。
const THUMB_LIMIT: u64 = 256 * 1024 * 1024;

/// 启动时给 asset 协议放行用
pub fn root() -> Option<PathBuf> {
    let dir = dirs::data_dir()?.join("ZFontManager").join(THUMB_DIR);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// key 直接拼进文件名，必须挡住 `..` / 分隔符 / 超长名
fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 列出所有已有的 key。
///
/// 前端启动时拉一次放进内存 Set，卡片就能**同步**判断「这张卡有图」——
/// 不能靠异步查，否则首帧渲染成文字、随后切成图片，用户看到的是闪烁。
pub fn list() -> Vec<String> {
    let Some(dir) = root() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".png") else {
            continue;
        };
        if safe_key(stem) {
            out.push(stem.to_string());
        }
    }
    out.sort_unstable();
    out
}

pub fn get(key: &str) -> Option<PathBuf> {
    if !safe_key(key) {
        return None;
    }
    let dir = root()?;
    let path = dir.join(format!("{key}.png"));
    if !path.is_file() {
        return None;
    }
    // 用到就更新 mtime：淘汰按「最久没用」走
    if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    Some(path)
}

pub fn put(key: &str, png: &[u8]) -> Option<PathBuf> {
    if !safe_key(key) || png.is_empty() {
        return None;
    }
    let dir = root()?;
    let target = dir.join(format!("{key}.png"));
    // 先写临时文件再改名：并发下别让人读到半个 PNG
    let tmp = dir.join(format!(".{key}.{}.tmp", std::process::id()));
    fs::write(&tmp, png).ok()?;
    if fs::rename(&tmp, &target).is_err() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    trim(&dir);
    Some(target)
}

fn trim(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for e in entries.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let modified = md.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += md.len();
        files.push((modified, md.len(), e.path()));
    }
    if total <= THUMB_LIMIT {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= THUMB_LIMIT {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}
