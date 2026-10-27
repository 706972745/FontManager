//! 版权分类：把版权信息分为 免费 / 收费 / 限时 / 未知 四类。
//! 用于安装时给字族目录名加后缀（如 "Lora（免费字体）"），
//! 与前端 src/lib/license.ts 的分类标记保持一致。
//!
//! 版权来源的权重（导入与目录判定时共用）：
//!   1. 版权信息文件（LICENSE / OFL / 版权说明 等正文）
//!   2. 文件夹备注的版权信息（文件夹名里写的「（免费字体）」「收费」之类）
//!   3. 字体自带的版权信息（name 表里的 license / copyright）

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyrightClass {
    Free,
    Paid,
    Timelimited,
    Unknown,
}

impl CopyrightClass {
    pub fn as_str(self) -> &'static str {
        match self {
            CopyrightClass::Free => "free",
            CopyrightClass::Paid => "paid",
            CopyrightClass::Timelimited => "timelimited",
            CopyrightClass::Unknown => "unknown",
        }
    }
}

/// 开源免费许可的特征串（小写）
const OPEN_MARKERS: &[&str] = &[
    "sil open font license",
    "open font license",
    "ofl",
    "apache license",
    "mit license",
    "gnu general public license",
    "gpl",
    "public domain",
    "cc0",
    "free for commercial",
    "freely available",
    "ubuntu font licence",
    // 中文备注：文件夹名 / 说明里常见的写法
    "免费",
    "开源",
    "可商用",
    "公有领域",
    "免费商用",
];

/// 限制性/收费许可的特征串（小写）
const PAID_MARKERS: &[&str] = &[
    "may not be modified",
    "may not be redistributed",
    "not be sold",
    "non-commercial",
    "noncommercial",
    "personal use only",
    "evaluation only",
    "evaluation purposes",
    "trial version",
    "demo version",
    "all rights reserved. this font",
    "purchase a license",
    "requires a license",
    // 中文备注
    "收费",
    "付费",
    "不可商用",
    "禁止商用",
    "仅限个人",
    "购买授权",
    "需授权",
];

/// 有时间限制的许可特征串（小写）：限时字体、试用授权等
const TIME_MARKERS: &[&str] = &[
    "time limited",
    "time-limited",
    "timelimited",
    "limited license",
    "subscription",
    "试用",
    "限时",
    "限时授权",
];

pub fn classify(text: Option<&str>) -> CopyrightClass {
    let Some(text) = text else {
        return CopyrightClass::Unknown;
    };
    let t = text.to_lowercase();
    if PAID_MARKERS.iter().any(|m| t.contains(m)) {
        return CopyrightClass::Paid;
    }
    if TIME_MARKERS.iter().any(|m| t.contains(m)) {
        return CopyrightClass::Timelimited;
    }
    if OPEN_MARKERS.iter().any(|m| t.contains(m)) {
        return CopyrightClass::Free;
    }
    CopyrightClass::Unknown
}

/// 前端「版权状态」下拉里的值 → 版权分类；auto / 无法识别时返回 None（表示按来源重新判定）
pub fn class_from_status(status: &str) -> Option<CopyrightClass> {
    match status.trim().to_lowercase().as_str() {
        "free" => Some(CopyrightClass::Free),
        "paid" => Some(CopyrightClass::Paid),
        "timelimited" | "time_limited" | "timeLimited" => Some(CopyrightClass::Timelimited),
        "unknown" => Some(CopyrightClass::Unknown),
        _ => None,
    }
}

fn suffix(class: CopyrightClass) -> &'static str {
    match class {
        CopyrightClass::Free => "免费字体",
        CopyrightClass::Paid => "收费字体",
        CopyrightClass::Timelimited => "限时字体",
        CopyrightClass::Unknown => "未知版权",
    }
}

/// 清理文件名非法字符
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => c,
        })
        .collect();
    cleaned.trim().to_string()
}

/// 字族目录名："<家族名>（<版权后缀>）"
pub fn family_dir_name(family: &str, class: CopyrightClass) -> String {
    format!("{}（{}）", sanitize(family), suffix(class))
}

/// 目录名里的版权后缀 → 分类（识别我们自己写的「（免费字体）」这类后缀）
fn suffix_class(name: &str) -> Option<CopyrightClass> {
    for class in [
        CopyrightClass::Free,
        CopyrightClass::Paid,
        CopyrightClass::Timelimited,
        CopyrightClass::Unknown,
    ] {
        if name.contains(&format!("（{}）", suffix(class))) {
            return Some(class);
        }
    }
    None
}

/// 文件夹备注的版权信息：文件夹名里写明的版权（"Lora（免费字体）"、"某某字体 收费"…）。
/// 这是三级权重里的第二级，比字体自带的版权信息优先。
pub fn classify_folder_name(name: &str) -> CopyrightClass {
    if let Some(class) = suffix_class(name) {
        return class;
    }
    classify(Some(name))
}

/// 读一小段文本用于分类（许可证文件可能很大，只读前 64 KB 足够）
fn read_snippet(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.by_ref().take(limit as u64).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// 目录 → 版权分类，按「版权信息文件 > 文件夹备注 > 字体自带信息」三级权重判定。
/// 扫描字体库、以及把应用里改过的版权状态同步回目录时都用它。
pub fn classify_dir(dir: &Path) -> CopyrightClass {
    // 1. 版权信息文件（LICENSE / OFL / 版权说明…）
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut texts: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && crate::installer::is_info_file(p))
            .collect();
        texts.sort();
        for p in texts {
            if let Some(text) = read_snippet(&p, 64 * 1024) {
                let class = classify(Some(&text));
                if class != CopyrightClass::Unknown {
                    return class;
                }
            }
        }
    }
    // 2. 文件夹名里备注的版权
    if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
        let class = classify_folder_name(name);
        if class != CopyrightClass::Unknown {
            return class;
        }
    }
    // 3. 字体自带的版权信息
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut fonts: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && crate::parser::is_font_file(p))
            .collect();
        fonts.sort();
        for p in fonts {
            let faces = crate::parser::parse_font_file(&p, crate::font_types::FontSource::Managed);
            for f in faces {
                let class = classify(f.license.as_deref());
                if class != CopyrightClass::Unknown {
                    return class;
                }
                let class = classify(f.copyright.as_deref());
                if class != CopyrightClass::Unknown {
                    return class;
                }
            }
        }
    }
    CopyrightClass::Unknown
}

/// 字体库里属于某个字族的目录（含「在线」栏目下的子目录），用于同步改名
pub fn family_dirs_for(library: &Path, family: &str) -> Vec<PathBuf> {
    let base = sanitize(family);
    if base.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(library.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if is_family_dir_name(name, &base) {
                out.push(path.clone());
            } else if depth < 2 {
                stack.push((path, depth + 1));
            }
        }
    }
    out
}

/// 目录名是否属于该字族："Lora" 或 "Lora（免费字体）"
fn is_family_dir_name(name: &str, family: &str) -> bool {
    if name == family {
        return true;
    }
    name.starts_with(&format!("{family}（")) && name.ends_with("）")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_licenses() {
        assert_eq!(classify(Some("This Font is licensed under the SIL Open Font License")), CopyrightClass::Free);
        assert_eq!(classify(Some("OFL.txt")), CopyrightClass::Free);
        assert_eq!(classify(Some("Personal use only, may not be redistributed")), CopyrightClass::Paid);
        assert_eq!(classify(Some("Some custom text")), CopyrightClass::Unknown);
        assert_eq!(classify(None), CopyrightClass::Unknown);
    }

    #[test]
    fn builds_dir_names() {
        assert_eq!(
            family_dir_name("Lora", CopyrightClass::Free),
            "Lora（免费字体）"
        );
        assert_eq!(
            family_dir_name("A/B|Font", CopyrightClass::Unknown),
            "A B Font（未知版权）"
        );
        assert_eq!(
            family_dir_name("Lora", CopyrightClass::Timelimited),
            "Lora（限时字体）"
        );
    }

    #[test]
    fn maps_manual_status() {
        assert_eq!(class_from_status("free"), Some(CopyrightClass::Free));
        assert_eq!(class_from_status("paid"), Some(CopyrightClass::Paid));
        assert_eq!(class_from_status("timelimited"), Some(CopyrightClass::Timelimited));
        assert_eq!(class_from_status("unknown"), Some(CopyrightClass::Unknown));
        // auto / 空值 → 交给来源权重重新判定
        assert_eq!(class_from_status("auto"), None);
    }

    #[test]
    fn reads_folder_notes() {
        assert_eq!(classify_folder_name("Lora（免费字体）"), CopyrightClass::Free);
        assert_eq!(classify_folder_name("某某字体（收费字体）"), CopyrightClass::Paid);
        assert_eq!(classify_folder_name("某某字体（限时字体）"), CopyrightClass::Timelimited);
        assert_eq!(classify_folder_name("字体合集"), CopyrightClass::Unknown);
    }

    #[test]
    fn folder_dirs_match_family() {
        assert!(is_family_dir_name("Lora（免费字体）", "Lora"));
        assert!(is_family_dir_name("Lora", "Lora"));
        assert!(!is_family_dir_name("Lora Sans（免费字体）", "Lora"));
        assert!(!is_family_dir_name("Inter（免费字体）", "Lora"));
    }

    #[test]
    fn time_limited_text_is_its_own_class() {
        assert_eq!(classify(Some("试用授权，限时 30 天")), CopyrightClass::Timelimited);
    }
}
