//! 「全部导出」= 把这个字体**所在的文件夹**整体打包成 zip（1.3.7）。
//!
//! 为什么要改成打包文件夹：字体圈的用法是「一个字族一个文件夹」，文件夹里除了
//! 各个字重的 ttf/otf，还躺着作者附的授权书（License.txt / 授权说明.pdf / jpg）、
//! 说明文档、甚至 woff。以前「全部导出」只挑字体文件复制到目标目录，授权书全丢，
//! 用户把字体发给同事后对方根本不知道能不能商用（用户 2026-11-06 反馈）。
//!
//! 三条约束：
//!
//! 1. **只读不写**。源文件夹一个字节都不动，产出只有一个 zip。
//! 2. **字体按 Stored（不压缩）写**。字体文件本身压不动，压它只是白烧一个核心
//!    （见 `library_pack` 的同一结论）；txt / pdf / 图片这些走 deflate，收益大。
//! 3. **字体直接放在字体库根目录时退化成「只打包本字族」**。那种情况下「所在文件夹」
//!    是整个库（几千个目录、几个 GB），把用户整个库压进去绝不是他想要的结果。
//!    判定依据就是库标记文件 `.zfm-folder.ico`（`library_marker` 写的）。
//! 4. 先写 `.writing` 再改名：中途关软件留下的是个一眼看得出没写完的临时文件，
//!    而不是一个「看起来正常、其实缺一半」的 zip。

use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 库标记文件：由 `library_marker` 往字体库根目录写，用来认出「这是整个库」
const LIBRARY_MARKER: &str = ".zfm-folder.ico";
/// 这两个是本软件自己往库里写的元数据，不该出现在给别人的 zip 里
const SKIP_NAMES: [&str; 2] = [LIBRARY_MARKER, "desktop.ini"];
/// 这些后缀本身已经是压缩格式（或压不动），一律 Stored
const STORED_EXT: [&str; 7] = ["ttf", "otf", "ttc", "otc", "woff", "woff2", "eot"];

/// 打包安全阀：真遇到「文件夹里套着整个库」也能及时停下，而不是把磁盘写满
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportReport {
    /// 落盘的 zip 绝对路径
    pub dest: String,
    /// zip 内顶层目录名（= 文件夹名）
    pub root: String,
    /// `folder` = 整个文件夹；`family` = 只打包了本字族的字体文件（字体在库根目录时的兜底）
    pub scope: String,
    /// 打进 zip 的文件数
    pub files: u32,
    /// 源文件总字节（未压缩）
    pub bytes: u64,
    /// zip 文件大小
    pub zip_bytes: u64,
    /// 被跳过的本软件元数据文件数
    pub skipped: u32,
}

fn is_stored(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| STORED_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 这个目录是不是「整个字体库」而不是单个字族目录。
///
/// 首选证据是库标记 `.zfm-folder.ico`（`library_marker` 挂图标时写进去的）。
/// 再补一条兜底：一个目录下直接躺着 300 个以上子目录，那不是字族目录，是库
/// —— 万一根目录的标记文件被用户删了，也不会把整个库压进 zip。
fn looks_like_library(dir: &Path) -> bool {
    if dir.join(LIBRARY_MARKER).is_file() {
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut dirs = 0usize;
    for e in entries.flatten() {
        if e.path().is_dir() {
            dirs += 1;
            if dirs >= 300 {
                return true;
            }
        }
    }
    false
}

/// 递归收集文件（保持目录结构，排序保证每次导出结果一致）
fn walk(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<u32, String> {
    let mut skipped = 0;
    let entries = fs::read_dir(dir).map_err(|e| format!("读不到 {}：{e}", dir.display()))?;
    let mut items: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            !p.file_name()
                .map(|n| SKIP_NAMES.contains(&n.to_string_lossy().as_ref()))
                .unwrap_or(false)
        })
        .collect();
    items.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for p in items {
        if p.is_dir() {
            skipped += walk(&p, base, out)?;
            continue;
        }
        let rel = p
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        out.push((p, rel));
        if out.len() > MAX_FILES {
            return Err(format!(
                "这个文件夹里超过 {MAX_FILES} 个文件，看起来不像单个字族目录，已停止导出"
            ));
        }
    }
    Ok(skipped)
}

/// 兜底：字体直接躺在字体库根目录时，只打包本字族的字体文件（扁平存放）
fn family_only(paths: &[String]) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if out.iter().any(|(_, n)| n == &name) {
            continue;
        }
        out.push((path, name));
    }
    out
}

/// 导出字体所在文件夹为 zip。
///
/// - `font_path`：该字族的代表字体文件；它的父目录就是要打包的文件夹
/// - `dest`：用户选的目标 zip 路径
/// - `family_paths`：该字族的全部字体文件（只在「字体在库根目录」的兜底分支用到）
pub fn export_folder(
    font_path: &Path,
    dest: &Path,
    family_paths: &[String],
) -> Result<FolderExportReport, String> {
    if !font_path.is_file() {
        return Err(format!("找不到字体文件：{}", font_path.display()));
    }
    let dir = font_path
        .parent()
        .ok_or_else(|| "字体路径没有父目录".to_string())?;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败：{e}"))?;
        }
    }

    let library_root = looks_like_library(dir);
    let (scope, files, skipped) = if library_root {
        ("family", family_only(family_paths), 0u32)
    } else {
        let mut files = Vec::new();
        let skipped = walk(dir, dir, &mut files)?;
        ("folder", files, skipped)
    };
    if files.is_empty() {
        return Err("这个文件夹里没有可导出的文件".into());
    }

    let root = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fonts".into());
    let total_bytes: u64 = files
        .iter()
        .filter_map(|(p, _)| fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    if total_bytes > MAX_BYTES {
        return Err(format!(
            "这个文件夹有 {} GB，超过单个 zip 的 {} GB 上限",
            total_bytes / 1024 / 1024 / 1024,
            MAX_BYTES / 1024 / 1024 / 1024
        ));
    }

    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".writing");
    let tmp_path = PathBuf::from(tmp_name);
    let result = write_zip(&tmp_path, &root, &files);
    let zip_bytes = match result {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    if dest.exists() {
        let _ = fs::remove_file(dest);
    }
    fs::rename(&tmp_path, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("写出 {} 失败：{e}", dest.display())
    })?;

    Ok(FolderExportReport {
        dest: dest.to_string_lossy().into_owned(),
        root,
        scope: scope.into(),
        files: files.len() as u32,
        bytes: total_bytes,
        zip_bytes,
        skipped,
    })
}

fn write_zip(tmp: &Path, root: &str, files: &[(PathBuf, String)]) -> Result<u64, String> {
    let file = File::create(tmp).map_err(|e| format!("创建 {} 失败：{e}", tmp.display()))?;
    let mut zw = zip::ZipWriter::new(BufWriter::new(file));
    let mut buf = vec![0u8; 64 * 1024];
    for (abs, rel) in files {
        let opts = zip::write::SimpleFileOptions::default().compression_method(if is_stored(abs) {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        });
        zw.start_file(format!("{root}/{rel}"), opts)
            .map_err(|e| format!("写入 zip 条目失败：{e}"))?;
        let mut src = File::open(abs).map_err(|e| format!("读取 {} 失败：{e}", abs.display()))?;
        loop {
            let n = src
                .read(&mut buf)
                .map_err(|e| format!("读取 {} 失败：{e}", abs.display()))?;
            if n == 0 {
                break;
            }
            zw.write_all(&buf[..n])
                .map_err(|e| format!("写入 zip 失败：{e}"))?;
        }
    }
    let writer = zw.finish().map_err(|e| format!("收尾 zip 失败：{e}"))?;
    let mut inner = writer
        .into_inner()
        .map_err(|e| format!("刷新 zip 缓冲失败：{e}"))?;
    inner.flush().map_err(|e| e.to_string())?;
    drop(inner);
    fs::metadata(tmp).map(|m| m.len()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zfm-folder-export-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let file = File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    /// 字族目录：字体 + 授权书 + 子目录里的说明，全部进 zip；库标记不进
    #[test]
    fn exports_whole_folder_with_license_files() {
        let base = temp_dir("folder");
        let fam = base.join("Antonio（商用免费）");
        fs::create_dir_all(fam.join("说明")).unwrap();
        fs::write(fam.join("Antonio-Regular.ttf"), "fake-font-bytes").unwrap();
        fs::write(fam.join("Antonio-Bold.ttf"), "fake-font-bytes").unwrap();
        fs::write(fam.join("License.txt"), "免费商用，详见作者主页").unwrap();
        fs::write(fam.join("说明/readme.pdf"), "%PDF-1.4 fake").unwrap();
        fs::write(fam.join("desktop.ini"), "[.ShellClassInfo]").unwrap();

        let dest = base.join("Antonio.zip");
        let report = export_folder(&fam.join("Antonio-Regular.ttf"), &dest, &[]).unwrap();
        assert_eq!(report.scope, "folder");
        assert_eq!(report.files, 4, "两个字体 + 授权书 + pdf（desktop.ini 跳过）");
        assert_eq!(report.root, "Antonio（商用免费）");
        assert!(report.zip_bytes > 0);

        let names = zip_names(&dest);
        assert!(names.contains(&"Antonio（商用免费）/Antonio-Regular.ttf".to_string()));
        assert!(names.contains(&"Antonio（商用免费）/License.txt".to_string()));
        assert!(names.contains(&"Antonio（商用免费）/说明/readme.pdf".to_string()));
        assert!(
            !names.iter().any(|n| n.ends_with("desktop.ini")),
            "本软件的元数据文件不该进 zip"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// 字体直接放在库根目录：只打包本字族文件，绝不把整个库塞进去
    #[test]
    fn library_root_falls_back_to_family_files() {
        let base = temp_dir("root");
        let lib_name = base.join("字体库");
        fs::create_dir_all(lib_name.join("别的字族")).unwrap();
        fs::write(lib_name.join(LIBRARY_MARKER), "ico").unwrap();
        fs::write(lib_name.join("Loose.ttf"), "x").unwrap();
        fs::write(lib_name.join("别的字族/Other.ttf"), "y").unwrap();

        let dest = base.join("Loose.zip");
        let paths = vec![lib_name.join("Loose.ttf").to_string_lossy().into_owned()];
        let report = export_folder(&lib_name.join("Loose.ttf"), &dest, &paths).unwrap();
        assert_eq!(report.scope, "family");
        assert_eq!(report.files, 1);

        let names = zip_names(&dest);
        assert!(names.contains(&"字体库/Loose.ttf".to_string()));
        assert!(!names.iter().any(|n| n.contains("别的字族")));
        let _ = fs::remove_dir_all(&base);
    }


    /// 目标已存在时覆盖（用户在保存对话框里选了个旧文件）
    #[test]
    fn overwrites_existing_destination() {
        let base = temp_dir("overwrite");
        let fam = base.join("Fam");
        fs::create_dir_all(&fam).unwrap();
        fs::write(fam.join("a.ttf"), "abc").unwrap();
        let dest = base.join("out.zip");
        fs::write(&dest, "old").unwrap();
        let report = export_folder(&fam.join("a.ttf"), &dest, &[]).unwrap();
        assert_eq!(report.files, 1);
        assert!(fs::metadata(&dest).unwrap().len() > 3);
        assert!(!base.join("out.zip.writing").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
