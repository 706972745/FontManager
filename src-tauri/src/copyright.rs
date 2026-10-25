//! 版权分类：根据许可证文本把字体分为 免费 / 收费 / 未知 三类。
//! 用于安装时给字族目录名加后缀（如 "Lora（免费字体）"），
//! 与前端 src/lib/license.ts 的分类标记保持一致。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyrightClass {
    Free,
    Paid,
    Unknown,
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
];

pub fn classify(text: Option<&str>) -> CopyrightClass {
    let Some(text) = text else {
        return CopyrightClass::Unknown;
    };
    let t = text.to_lowercase();
    if PAID_MARKERS.iter().any(|m| t.contains(m)) {
        return CopyrightClass::Paid;
    }
    if OPEN_MARKERS.iter().any(|m| t.contains(m)) {
        return CopyrightClass::Free;
    }
    CopyrightClass::Unknown
}

fn suffix(class: CopyrightClass) -> &'static str {
    match class {
        CopyrightClass::Free => "免费字体",
        CopyrightClass::Paid => "收费字体",
        CopyrightClass::Unknown => "未知版权",
    }
}

/// 清理文件名非法字符
fn sanitize(name: &str) -> String {
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
    }
}
