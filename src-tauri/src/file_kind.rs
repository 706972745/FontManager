//! 导出文件的「内容嗅探」：只读文件头判断这是快照、整理数据还是字体库整包。
//!
//! 1.2.4 起三种导出物各有自己的后缀（S / P / L），但**导入判定完全不看后缀**：
//! 用户把文件改名、改成 .json、或者从旧机器拷来一份没见过的名字，都按内容认。
//! 每个导出文件里都写了 `kind / suffix / purpose / howTo`，所以即使后缀丢了，
//! 文件自己也能说明「我是什么、该怎么导回去」。
//!
//! 两条硬约束：
//! - 整包可能 2 GiB，绝不能整文件读进内存。zip 只打开中央目录 + 读 manifest。
//! - 文本 JSON 最多读前 2 MiB；整理数据和快照都远小于这个数，超了一律不认。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const KIND_PACK: &str = "library-pack";
pub const KIND_CURATION: &str = "curation";
pub const KIND_SNAPSHOTS: &str = "snapshots";
pub const KIND_UNKNOWN: &str = "unknown";

const MAX_TEXT: u64 = 2 * 1024 * 1024;
const MANIFEST: &str = "manifest.json";
const FONT_DIR: &str = "fonts/";

/// 给前端的返回值：四种字符串之一。任何异常都不抛错，返回 unknown 让前端提示。
pub fn detect(path: &Path) -> &'static str {
    let Ok(mut file) = File::open(path) else {
        return KIND_UNKNOWN;
    };
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return KIND_UNKNOWN;
    }
    if &magic[..2] == b"PK" {
        return detect_zip(path);
    }
    if file.seek(SeekFrom::Start(0)).is_err() {
        return KIND_UNKNOWN;
    }
    let mut buf = Vec::new();
    if file.take(MAX_TEXT).read_to_end(&mut buf).is_err() {
        return KIND_UNKNOWN;
    }
    let text = String::from_utf8_lossy(&buf);
    let text = text.trim_start_matches('\u{feff}').trim();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return KIND_UNKNOWN;
    };
    detect_json(&value)
}

/// 显式 kind 优先，老文件 / 被改过 kind 的文件按结构兜底认。
fn detect_json(value: &serde_json::Value) -> &'static str {
    let Some(obj) = value.as_object() else {
        return KIND_UNKNOWN;
    };
    if let Some(kind) = obj.get("kind").and_then(|v| v.as_str()) {
        match kind {
            "snapshots" => return KIND_SNAPSHOTS,
            "curation" => return KIND_CURATION,
            "library-pack" => return KIND_PACK,
            _ => {}
        }
    }
    if obj.contains_key("snapshots") {
        return KIND_SNAPSHOTS;
    }
    if obj.get("favorites").map(|v| v.is_array()).unwrap_or(false) {
        return KIND_CURATION;
    }
    for key in [
        "tags",
        "collections",
        "collectionFaces",
        "notes",
        "ratings",
        "copyrightStatus",
        "copyrightExpiry",
    ] {
        if obj.get(key).map(|v| v.is_object()).unwrap_or(false) {
            return KIND_CURATION;
        }
    }
    KIND_UNKNOWN
}

/// zip：先看 manifest 的 kind，老包没有 kind 就靠 `fonts/` 目录认。
/// `ZipArchive::new` 只读中央目录，不会把 2 GiB 的字体数据加载进来。
fn detect_zip(path: &Path) -> &'static str {
    let Ok(file) = File::open(path) else {
        return KIND_UNKNOWN;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return KIND_UNKNOWN;
    };
    if let Ok(mut entry) = archive.by_name(MANIFEST) {
        let mut buf = String::new();
        if entry.read_to_string(&mut buf).is_ok() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&buf) {
                if detect_json(&value) == KIND_PACK {
                    return KIND_PACK;
                }
            }
        }
    }
    for i in 0..archive.len() {
        if let Some(name) = archive.name_for_index(i) {
            if name.starts_with(FONT_DIR) || name == "fontmanager.json" {
                return KIND_PACK;
            }
        }
    }
    KIND_UNKNOWN
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-detect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn json_kinds_by_content_not_by_name() {
        // 文件名随便起，甚至故意互相串，都按内容认
        assert_eq!(detect(&write("curation.P-FontManager", br#"{"kind":"curation","tags":{}}"#)), KIND_CURATION);
        assert_eq!(detect(&write("snapshot.L-FontManager", br#"{"kind":"snapshots","snapshots":[]}"#)), KIND_SNAPSHOTS);
        assert_eq!(detect(&write("whatever.dat", br#"{"tags":{"Inter":["ui"]},"favorites":[]}"#)), KIND_CURATION);
        assert_eq!(detect(&write("old-backup.json", br#"{"version":1,"collections":{},"notes":{}}"#)), KIND_CURATION);
        assert_eq!(detect(&write("random.json", br#"{"hello":"world"}"#)), KIND_UNKNOWN);
        assert_eq!(detect(&write("broken.json", b"not json at all")), KIND_UNKNOWN);
    }

    #[test]
    fn zip_pack_recognized_by_manifest() {
        let p = write("pack.S-FontManager", &[]);
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zw.start_file(MANIFEST, opts).unwrap();
            zw.write_all(br#"{"app":"FontManager","kind":"library-pack","version":1}"#).unwrap();
            zw.start_file("fonts/A/Regular.ttf", opts).unwrap();
            zw.write_all(b"dummy").unwrap();
            zw.finish().unwrap();
        }
        assert_eq!(detect(&p), KIND_PACK);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn plain_zip_is_not_our_pack() {
        let p = write("not-ours.P-FontManager", &[]);
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            zw.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
            zw.write_all(b"hello").unwrap();
            zw.finish().unwrap();
        }
        assert_eq!(detect(&p), KIND_UNKNOWN);
        let _ = std::fs::remove_file(p);
    }

    /// 用户最关心的一条：导出后把后缀改掉（甚至改成 .dat / .txt），
    /// 识别和导入都必须照常工作 —— 导入只认内容，不认名字。
    #[test]
    fn renamed_exports_are_still_detected_and_importable() {
        // ① 真打一个整包，再改名成 .dat
        let root = std::env::temp_dir().join(format!("fm-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let library = root.join("lib");
        std::fs::create_dir_all(library.join("族A")).unwrap();
        std::fs::write(library.join("族A").join("A.ttf"), vec![1u8; 128]).unwrap();
        std::fs::write(library.join("族A").join("B.otf"), vec![2u8; 128]).unwrap();
        let pack = root.join("backup.P-FontManager");
        crate::library_pack::export_pack(&library, &pack, "{\"kind\":\"curation\"}", "2026-11-05T00:00:00Z", &|_| {})
            .expect("export ok");

        let renamed = root.join("改名之后.dat");
        std::fs::copy(&pack, &renamed).unwrap();
        assert_eq!(detect(&renamed), KIND_PACK, "改了后缀也要认出整包");

        // 识别对了，导入也照常：字体铺回 + 整理数据能读出
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        let report = crate::library_pack::import_pack(&fresh, &renamed, &|_| {}).expect("import ok");
        assert_eq!(report.added, 2);
        assert!(report.curation.is_some(), "整理数据跟着回来");
        assert!(fresh.join("族A").join("B.otf").is_file());

        // ② 三种 json 换成毫无关系的后缀 / 名字，照样按内容认
        let cur = write("a-whole-new-name.dat", br#"{"kind":"curation","tags":{}}"#);
        assert_eq!(detect(&cur), KIND_CURATION);
        let snap = write("notes.txt", br#"{"kind":"snapshots","snapshots":[]}"#);
        assert_eq!(detect(&snap), KIND_SNAPSHOTS);
        let no_ext = write("FontManager-backup-20261105", br#"{"version":1,"collections":{},"favorites":[]}"#);
        assert_eq!(detect(&no_ext), KIND_CURATION, "连后缀都没有的老备份也要认");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&cur);
        let _ = std::fs::remove_file(&snap);
        let _ = std::fs::remove_file(&no_ext);
    }
}
