//! 库数据整包（`.ZFontManager`，本质是一个 zip）：把「整理数据」和一个字体库的字体文件
//! 打成一个包，超过 2 GiB 自动分卷，用来整台机器搬家。
//!
//! 三条约束（用户 2026-11-03 定，改之前先看这里）：
//!
//! 1. **不依赖系统 / 第三方压缩工具**。打包、分卷、解包全在程序内用 `zip` crate 完成，
//!    机器上没装 7-Zip / WinRAR、或者系统自带的 zip 用不了，都不影响功能。
//! 2. **字体按 Stored（不压缩）写入 zip**。字体文件本身几乎压不动（实测收益只有个位数
//!    百分比），却要吃满一个核好几分钟 —— 弱机器上表现就是「软件卡死、风扇狂转」。
//!    宁可包大一点，也不让用户在导出时干等。整理数据那个 json 也很小，一并 stored。
//! 3. **单卷上限 2 GiB**。超过就按文件边界切卷：`xxx-part1.ZFontManager`、`-part2`……
//!    每卷都是**独立可用**的 zip（zip crate 不支持跨卷 zip64），所以导入时按文件名
//!    找同目录的兄弟卷，缺哪卷就在报告里列出来，不会静默丢一半字体。
//!
//! 导入去重：同一个相对路径已存在 → 跳过；库里已有**同名同大小**的字体（可能放在别的
//! 字族目录里）→ 也跳过。用户原话「有重复的就不重复导入」。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 单卷上限（用户定的 2 GiB）。再留 8 MiB 给 manifest / 目录区，保证成品文件本身 < 2 GiB。
pub const PART_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const PART_HEADROOM: u64 = 8 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";
const CURATION: &str = "zfontmanager.json";
const FONT_DIR: &str = "fonts";

/// 包内 manifest：每卷都有一份，用来判断「这是不是我的包」「一共几卷」「导出的库在哪」。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub app: String,
    pub kind: String,
    pub version: u32,
    pub created_at: String,
    pub package_id: String,
    pub part: u32,
    pub parts: u32,
    pub font_count: u64,
    pub total_bytes: u64,
    pub library_dir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackProgress {
    /// "export" | "import"
    pub kind: String,
    /// "打包" | "解包" 阶段名（前端只用来拼文案）
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub part: u32,
    pub parts: u32,
    pub bytes: u64,
    pub current: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackExportReport {
    pub paths: Vec<String>,
    pub parts: u32,
    pub files: u64,
    pub bytes: u64,
    /// 因为「是系统字体」被排除掉的文件数（导入端不关心，给提示用）
    pub skipped_system: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackImportReport {
    /// 包里的整理数据（原样交给前端按 lib/libraryData.ts 的规则合并）
    pub curation: Option<String>,
    pub added: u64,
    pub skipped: u64,
    pub failed: u64,
    pub parts: u32,
    pub missing_parts: Vec<u32>,
    pub library_dir: String,
}

#[derive(Clone, Debug)]
struct PackFile {
    abs: PathBuf,
    /// zip 内相对字体库的路径，统一用 '/'（Windows 的 '\' 在别的系统上解不开）
    rel: String,
    size: u64,
}

/// 单卷里放多少个文件（按体积切，返回每卷的文件数，顺序与 files 一致）。
pub fn plan_volumes(sizes: &[u64], limit: u64) -> Vec<usize> {
    // 余量按比例缩：默认 8 MiB（2 GiB 的 0.4%），但上限调小做测试时不能把预算吃光
    let headroom = PART_HEADROOM.min(limit / 4);
    let budget = limit.saturating_sub(headroom).max(1);
    let mut counts: Vec<usize> = Vec::new();
    let mut cur = 0usize;
    let mut cur_bytes = 0u64;
    for size in sizes {
        if cur > 0 && cur_bytes.saturating_add(*size) > budget {
            counts.push(cur);
            cur = 0;
            cur_bytes = 0;
        }
        cur += 1;
        cur_bytes = cur_bytes.saturating_add(*size);
        // 单个文件就超预算：独占一卷（字体文件不能对半切，切了就是坏文件）
        if cur_bytes > budget {
            counts.push(cur);
            cur = 0;
            cur_bytes = 0;
        }
    }
    if cur > 0 {
        counts.push(cur);
    }
    counts
}

/// `xxx.ZFontManager` + 3 卷 → `xxx-part1.ZFontManager`；只有一卷时原样返回用户选的名字。
fn part_path(dest: &Path, index: u32, parts: u32) -> PathBuf {
    if parts <= 1 {
        return dest.to_path_buf();
    }
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("ZFonts");
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("ZFontManager");
    dest.with_file_name(format!("{stem}-part{index}.{ext}"))
}

/// 从文件名里认出分卷号：`ZFonts-2026-11-03-part2.ZFontManager` → ("ZFonts-2026-11-03", 2)
fn part_of(path: &Path) -> Option<(String, u32)> {
    let stem = path.file_stem()?.to_str()?;
    let (base, tail) = stem.rsplit_once("-part")?;
    let idx: u32 = tail.parse().ok()?;
    if base.is_empty() || idx == 0 {
        return None;
    }
    Some((base.to_string(), idx))
}

/// 用户可能点开任意一卷 → 把同目录里同一套的其它卷也找出来（按卷号升序）。
fn resolve_parts(src: &Path) -> Vec<(u32, PathBuf)> {
    let Some((base, idx)) = part_of(src) else {
        return vec![(1, src.to_path_buf())];
    };
    let Some(dir) = src.parent() else {
        return vec![(idx, src.to_path_buf())];
    };
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("ZFontManager")
        .to_ascii_lowercase();
    let mut found: Vec<(u32, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase() != ext)
                .unwrap_or(true)
            {
                continue;
            }
            if let Some((b, n)) = part_of(&p) {
                if b == base {
                    found.push((n, p));
                }
            }
        }
    }
    found.sort_by_key(|(n, _)| *n);
    if found.is_empty() {
        vec![(idx, src.to_path_buf())]
    } else {
        found
    }
}

fn zip_rel(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 包内条目名 → 安全的相对路径。带 `..` / 绝对路径 / 盘符的一律拒绝，
/// 免得一个恶意包把文件写到字库外面去。
fn safe_rel(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') || part.contains('\\') {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 系统字体目录里的文件名（小写）。库里如果收了系统字体的副本，导出时按名字挡掉 ——
/// 「除系统字体以外」是用户的原话。
fn system_font_names() -> HashSet<String> {
    let mut names = HashSet::new();
    let dir = if cfg!(windows) {
        std::env::var("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("C:\\Windows"))
            .join("Fonts")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/System/Library/Fonts")
    } else {
        PathBuf::from("/usr/share/fonts")
    };
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                names.insert(name.to_ascii_lowercase());
            }
        }
    }
    names
}

/// 递归列出字库里的字体文件（跳过符号链接、以 '.' 开头的内部目录、以及 `skip` 自己）。
/// 第二个返回值是「因为是系统字体副本而被排除」的数量，只用于给用户一句提示。
fn walk_fonts(library: &Path, skip: Option<&Path>, sys: &HashSet<String>) -> (Vec<PackFile>, u64) {
    let mut out = Vec::new();
    let mut skipped_system = 0u64;
    let mut stack = vec![library.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                // 链接进来的字体，真身不在库里，打进包只会在换机器后变成死链
                continue;
            }
            if ft.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with('.') {
                    stack.push(path);
                }
                continue;
            }
            if !crate::parser::is_font_file(&path) {
                continue;
            }
            if let Some(skip) = skip {
                if same_file_path(skip, &path) {
                    continue;
                }
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if sys.contains(&name.to_ascii_lowercase()) {
                    skipped_system += 1;
                    continue;
                }
            }
            let Ok(rel) = path.strip_prefix(library) else { continue };
            let rel = zip_rel(rel);
            if rel.is_empty() {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(PackFile {
                abs: path,
                rel,
                size,
            });
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    (out, skipped_system)
}

fn same_file_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 读某一卷的 manifest（不是本程序的包就返回 None）。
fn read_manifest(path: &Path) -> Option<PackManifest> {
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name(MANIFEST).ok()?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).ok()?;
    serde_json::from_str(&buf).ok()
}

/// 打包。`curation` 是前端给的那份整理数据 json（原样塞进包），`created_at` 由前端给
/// （本地时区的 ISO 串，Rust 侧没有日期库，不自己造）。
pub fn export_pack(
    library: &Path,
    dest: &Path,
    curation: &str,
    created_at: &str,
    on_progress: &dyn Fn(PackProgress),
) -> Result<PackExportReport, String> {
    export_pack_with_limit(library, dest, curation, created_at, PART_LIMIT, on_progress)
}

/// 真正的打包实现。`limit` 平时恒为 [`PART_LIMIT`]，只有单测 / 真机核对会传小上限，
/// 用来在几 MB 的真实字体上验证「切卷 + 跨卷导入」。
pub fn export_pack_with_limit(
    library: &Path,
    dest: &Path,
    curation: &str,
    created_at: &str,
    limit: u64,
    on_progress: &dyn Fn(PackProgress),
) -> Result<PackExportReport, String> {
    if !library.is_dir() {
        return Err(format!("字体库目录不存在：{}", library.display()));
    }
    let sys = system_font_names();
    let (files, skipped_system) = walk_fonts(library, Some(dest), &sys);
    if files.is_empty() {
        return Err("字体库里没有可导出的字体文件（系统字体不在导出范围内）".into());
    }

    let sizes: Vec<u64> = files.iter().map(|f| f.size).collect();
    let counts = plan_volumes(&sizes, limit);
    let parts = counts.len() as u32;
    let total: u64 = files.len() as u64;
    let total_bytes: u64 = sizes.iter().sum();
    let package_id = format!("{}", now_unix());

    let mut written = 0u64;
    let mut cursor = 0usize;
    let mut paths: Vec<String> = Vec::new();
    let mut done = 0u64;

    for (idx, count) in counts.iter().enumerate() {
        let part_no = (idx + 1) as u32;
        let path = part_path(dest, part_no, parts);
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }
        // 先写 `.writing`，写完再改名：中途关掉软件留下的是个一眼看得出没写完的临时文件，
        // 而不是一个「看起来正常、其实缺一半」的 .ZFontManager（导入时才会发现坏卷）
        let mut tmp_name = path.clone().into_os_string();
        tmp_name.push(".writing");
        let tmp_path = PathBuf::from(tmp_name);
        let file = File::create(&tmp_path)
            .map_err(|e| format!("创建 {} 失败：{e}", tmp_path.display()))?;
        let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        let manifest = PackManifest {
            app: "ZFontManager".into(),
            kind: "library-pack".into(),
            version: 1,
            created_at: created_at.to_string(),
            package_id: package_id.clone(),
            part: part_no,
            parts,
            font_count: total,
            total_bytes,
            library_dir: library.to_string_lossy().to_string(),
        };
        zw.start_file(MANIFEST, opts).map_err(|e| e.to_string())?;
        zw.write_all(serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes())
            .map_err(|e| e.to_string())?;

        // 整理数据只放第一卷：其余卷纯粹是字体分片，单独拿出来也用不上
        if part_no == 1 {
            zw.start_file(CURATION, opts).map_err(|e| e.to_string())?;
            zw.write_all(curation.as_bytes()).map_err(|e| e.to_string())?;
        }

        on_progress(PackProgress {
            kind: "export".into(),
            phase: "export".into(),
            done,
            total,
            part: part_no,
            parts,
            bytes: written,
            current: String::new(),
        });

        for file in files.iter().skip(cursor).take(*count) {
            let mut src = File::open(&file.abs)
                .map_err(|e| format!("读取 {} 失败：{e}", file.abs.display()))?;
            zw.start_file(format!("{FONT_DIR}/{}", file.rel), opts)
                .map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = src.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                zw.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            }
            done += 1;
            written += file.size;
            if done % 4 == 0 || done == total {
                on_progress(PackProgress {
                    kind: "export".into(),
                    phase: "export".into(),
                    done,
                    total,
                    part: part_no,
                    parts,
                    bytes: written,
                    current: file
                        .abs
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
        cursor += count;
        let mut out = zw.finish().map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&tmp_path, &path)
            .map_err(|e| format!("保存 {} 失败：{e}", path.display()))?;
        paths.push(path.to_string_lossy().to_string());
    }

    // 收口：进度必须落在 100%，否则前端停在 99% 看起来像卡住
    on_progress(PackProgress {
        kind: "export".into(),
        phase: "export".into(),
        done: total,
        total,
        part: parts,
        parts,
        bytes: total_bytes,
        current: String::new(),
    });

    Ok(PackExportReport {
        paths,
        parts,
        files: total,
        bytes: total_bytes,
        skipped_system,
    })
}

/// 解包：把包里 `fonts/` 下的字体铺回字库（保持原目录结构），重复的跳过。
pub fn import_pack(
    library: &Path,
    src: &Path,
    on_progress: &dyn Fn(PackProgress),
) -> Result<PackImportReport, String> {
    if !src.is_file() {
        return Err(format!("找不到文件：{}", src.display()));
    }
    if !library.is_dir() {
        return Err(format!("字体库目录不存在：{}", library.display()));
    }
    let parts = resolve_parts(src);

    // 先读各卷的 manifest：知道一共几卷、缺哪卷
    let mut declared_parts = 0u32;
    let mut missing_parts: Vec<u32> = Vec::new();
    let mut present: Vec<u32> = parts.iter().map(|(n, _)| *n).collect();
    for (_, path) in &parts {
        if let Some(m) = read_manifest(path) {
            declared_parts = declared_parts.max(m.parts);
        }
    }
    if declared_parts > 0 {
        for n in 1..=declared_parts {
            if !present.contains(&n) {
                missing_parts.push(n);
            }
        }
    }
    present.sort_unstable();

    // 现有字库索引：同名同大小 → 视为重复（可能放在别的字族目录里）
    let mut index: HashMap<String, Vec<u64>> = HashMap::new();
    let (existing, _) = walk_fonts(library, None, &HashSet::new());
    for f in &existing {
        if let Some(name) = f.abs.file_name().and_then(|s| s.to_str()) {
            index
                .entry(name.to_ascii_lowercase())
                .or_default()
                .push(f.size);
        }
    }

    // 数一遍总条目（进度条要分母）
    let mut total: u64 = 0;
    for (_, path) in &parts {
        if let Ok(archive) = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?) {
            let archive = archive;
            for i in 0..archive.len() {
                if let Some(entry) = archive.name_for_index(i) {
                    if entry.starts_with(&format!("{FONT_DIR}/"))
                        && crate::parser::is_font_file(Path::new(entry))
                    {
                        total += 1;
                    }
                }
            }
        }
    }

    let mut curation: Option<String> = None;
    let mut added = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut done = 0u64;

    for (part_no, path) in &parts {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut entry = match archive.by_index(i) {
                Ok(e) => e,
                Err(_) => {
                    failed += 1;
                    continue;
                }
            };
            let name = entry.name().to_string();
            if name == CURATION {
                let mut buf = String::new();
                if entry.read_to_string(&mut buf).is_ok() && !buf.trim().is_empty() {
                    curation = Some(buf);
                }
                continue;
            }
            let Some(rel) = name.strip_prefix(&format!("{FONT_DIR}/")) else {
                continue;
            };
            if name.ends_with('/') || !crate::parser::is_font_file(Path::new(rel)) {
                continue;
            }
            let Some(safe) = safe_rel(rel) else {
                failed += 1;
                done += 1;
                continue;
            };
            let target = library.join(&safe);
            let size = entry.size();
            let fname = safe
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let duplicate = target.exists()
                || index
                    .get(&fname)
                    .map(|sizes| sizes.contains(&size))
                    .unwrap_or(false);
            if duplicate {
                skipped += 1;
            } else {
                let mut ok = true;
                if let Some(dir) = target.parent() {
                    if fs::create_dir_all(dir).is_err() {
                        ok = false;
                    }
                }
                let written = ok
                    && File::create(&target)
                        .and_then(|mut out| std::io::copy(&mut entry, &mut out).map(|_| ()))
                        .is_ok();
                if written {
                    added += 1;
                    index.entry(fname).or_default().push(size);
                } else {
                    failed += 1;
                }
            }
            done += 1;
            if done % 4 == 0 || done == total {
                on_progress(PackProgress {
                    kind: "import".into(),
                    phase: "import".into(),
                    done,
                    total,
                    part: *part_no,
                    parts: declared_parts.max(present.len() as u32),
                    bytes: 0,
                    current: safe.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                });
            }
        }
    }

    on_progress(PackProgress {
        kind: "import".into(),
        phase: "import".into(),
        done: total,
        total,
        part: declared_parts.max(present.len() as u32),
        parts: declared_parts.max(present.len() as u32),
        bytes: 0,
        current: String::new(),
    });

    Ok(PackImportReport {
        curation,
        added,
        skipped,
        failed,
        parts: declared_parts.max(present.len() as u32),
        missing_parts,
        library_dir: library.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zfm-pack-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn volumes_split_by_size() {
        // 5 个 0.5G = 2.5G，上限 2G → 前 3 个塞满（1.5G，第 4 个会超），剩下 2 个第二卷
        let gb = 1024u64 * 1024 * 1024;
        let sizes = vec![gb / 2; 5];
        assert_eq!(plan_volumes(&sizes, 2 * gb), vec![3, 2]);
        // 刚好等于上限的一组不会被多切一卷（余量吃掉时才会切）
        assert_eq!(plan_volumes(&[gb], 2 * gb), vec![1]);
    }

    #[test]
    fn volumes_respect_limit_and_single_huge_file() {
        let mib = 1024u64 * 1024;
        let sizes = vec![mib; 10]; // 每卷预算 2G-8M，10 个 1M 只占 10M
        assert_eq!(plan_volumes(&sizes, 2 * 1024 * mib), vec![10]);
        // 单个文件超过预算 → 独占一卷，不切文件
        let sizes = vec![3000 * mib, mib];
        assert_eq!(plan_volumes(&sizes, 2048 * mib), vec![1, 1]);
    }

    #[test]
    fn part_naming_roundtrip() {
        let dest = PathBuf::from(r"D:\backup\ZFonts-2026-11-03.ZFontManager");
        assert_eq!(part_path(&dest, 1, 1), dest);
        assert_eq!(
            part_path(&dest, 2, 3),
            PathBuf::from(r"D:\backup\ZFonts-2026-11-03-part2.ZFontManager")
        );
        assert_eq!(
            part_of(Path::new("ZFonts-2026-11-03-part3.ZFontManager")),
            Some(("ZFonts-2026-11-03".to_string(), 3))
        );
        assert_eq!(part_of(Path::new("ZFonts-2026-11-03.ZFontManager")), None);
    }

    #[test]
    fn unsafe_entry_names_rejected() {
        assert!(safe_rel("../../etc/passwd").is_none());
        assert!(safe_rel("a/../../b.ttf").is_none());
        assert!(safe_rel("C:/Windows/a.ttf").is_none());
        assert_eq!(
            safe_rel("某某体/Regular/Bold.ttf").unwrap(),
            PathBuf::from("某某体").join("Regular").join("Bold.ttf")
        );
    }

    #[test]
    fn export_skips_system_fonts_and_import_skips_duplicates() {
        let root = tmp("roundtrip");
        let library = root.join("lib");
        let a = library.join("字族A");
        let b = library.join("字族B");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("Alpha-Regular.ttf"), vec![1u8; 64]).unwrap();
        fs::write(b.join("Beta-Regular.otf"), vec![2u8; 64]).unwrap();

        let dest = root.join("ZFonts-2026-11-03.ZFontManager");
        let report = export_pack(&library, &dest, "{\"app\":\"ZFontManager\"}", "2026-11-03T00:00:00Z", &|_| {})
            .expect("export ok");
        assert_eq!(report.files, 2);
        assert_eq!(report.parts, 1);
        assert!(dest.is_file());

        // 导进一个已经有 Alpha 的空库：只补 Beta
        let fresh = root.join("fresh");
        fs::create_dir_all(fresh.join("字族A")).unwrap();
        fs::write(fresh.join("字族A").join("Alpha-Regular.ttf"), vec![1u8; 64]).unwrap();
        let imported = import_pack(&fresh, &dest, &|_| {}).expect("import ok");
        assert_eq!(imported.added, 1, "Beta 应该进来");
        assert_eq!(imported.skipped, 1, "Alpha 已存在应跳过");
        assert_eq!(imported.failed, 0);
        assert!(imported.curation.is_some());
        assert!(fresh.join("字族B").join("Beta-Regular.otf").is_file());

        // 再导一次：全部重复
        let again = import_pack(&fresh, &dest, &|_| {}).expect("import again");
        assert_eq!(again.added, 0);
        assert_eq!(again.skipped, 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_part_is_reported_not_silent() {
        let root = tmp("missing");
        let library = root.join("lib");
        fs::create_dir_all(library.join("族A")).unwrap();
        fs::write(library.join("族A").join("A.ttf"), vec![1u8; 64]).unwrap();
        fs::write(library.join("族A").join("B.ttf"), vec![2u8; 64]).unwrap();
        let dest = root.join("ZFonts-2026-11-03.ZFontManager");
        // 上限 100 字节 → 每个文件独占一卷，稳定切成 2 卷
        let report =
            export_pack_with_limit(&library, &dest, "{}", "2026-11-03T00:00:00Z", 100, &|_| {})
                .expect("export ok");
        assert_eq!(report.parts, 2);

        // 用户只拷了第 1 卷过来：能导的照导，缺的卷要明确报出来
        let part1 = root.join("ZFonts-2026-11-03-part1.ZFontManager");
        let part2 = root.join("ZFonts-2026-11-03-part2.ZFontManager");
        assert!(part1.is_file() && part2.is_file());
        fs::remove_file(&part2).unwrap();
        let fresh = root.join("fresh");
        fs::create_dir_all(&fresh).unwrap();
        // 多卷时用户点的就是 part1（只有单卷时文件名才是 dest 本身）
        let imported = import_pack(&fresh, &part1, &|_| {}).expect("import ok");
        assert_eq!(imported.parts, 2);
        assert_eq!(imported.missing_parts, vec![2]);
        assert_eq!(imported.added, 1, "第 1 卷里的那个照导");
        assert_eq!(imported.failed, 0);

        let _ = fs::remove_dir_all(&root);
    }

    /// 真机核对（手动跑，默认忽略）：用真实字体文件打一个包出来，留给外部工具验证
    /// （Windows 资源管理器 / 7-Zip / Python zipfile 都能打开，才算「不依赖本程序的压缩能力」）。
    ///
    /// `ZFM_PACK_SMOKE=<字体目录> ZFM_PACK_SMOKE_OUT=<输出文件> cargo test --lib -- --ignored smoke_pack_from_env`
    #[test]
    #[ignore]
    fn smoke_pack_from_env() {
        let Some(src) = std::env::var_os("ZFM_PACK_SMOKE") else {
            eprintln!("未设置 ZFM_PACK_SMOKE，跳过");
            return;
        };
        let src = PathBuf::from(src);
        let out = std::env::var_os("ZFM_PACK_SMOKE_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("ZFonts-smoke.ZFontManager"));
        let _ = fs::remove_file(&out);
        let limit = std::env::var("ZFM_PACK_SMOKE_LIMIT")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(PART_LIMIT);
        let report = export_pack_with_limit(
            &src,
            &out,
            "{\"app\":\"ZFontManager\",\"kind\":\"curation\",\"version\":2}",
            "2026-11-03T00:00:00Z",
            limit,
            &|_| {},
        )
        .expect("export ok");
        eprintln!(
            "[pack] 输出 {:?}，{} 个文件 / {} 字节 / {} 卷",
            report.paths, report.files, report.bytes, report.parts
        );
        assert_eq!(report.paths.len(), report.parts as usize);
        assert!(report.paths.iter().all(|p| Path::new(p).is_file()));

        // 第二步（可选）：把刚打出来的包解开到另一个目录，验证跨卷导入 + 去重
        if let Some(target) = std::env::var_os("ZFM_PACK_SMOKE_IMPORT") {
            let first = PathBuf::from(&report.paths[0]);
            let imported =
                import_pack(&PathBuf::from(target), &first, &|_| {}).expect("import ok");
            eprintln!(
                "[pack] 导入：新增 {} / 跳过重复 {} / 失败 {} / 缺卷 {:?} / 整理数据 {}",
                imported.added,
                imported.skipped,
                imported.failed,
                imported.missing_parts,
                imported.curation.is_some()
            );
        }
    }
}
