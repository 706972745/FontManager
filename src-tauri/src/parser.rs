use crate::font_types::{Classification, FontFace, FontFormat, FontSource, LocalizedName, VariationAxis};
use std::fs;
use std::path::Path;

const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc", "woff", "woff2"];

pub fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| FONT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn detect_format(data: &[u8], path: &Path) -> FontFormat {
    if data.len() >= 4 {
        match &data[0..4] {
            b"OTTO" => return FontFormat::Otf,
            [0x00, 0x01, 0x00, 0x00] | b"true" | b"ttcf" => return FontFormat::Ttf,
            b"wOFF" => return FontFormat::Woff,
            b"wOF2" => return FontFormat::Woff2,
            _ => {}
        }
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("otf" | "otc") => FontFormat::Otf,
        Some("ttf" | "ttc") => FontFormat::Ttf,
        Some("woff") => FontFormat::Woff,
        Some("woff2") => FontFormat::Woff2,
        _ => FontFormat::Unknown,
    }
}

fn name_string(face: &ttf_parser::Face, id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|n| n.name_id == id)
        .find_map(|n| n.to_string())
}

/// 常见的 name 表主语言 → BCP-47 语言标签。
fn iso_language(primary: &str) -> Option<&'static str> {
    Some(match primary {
        "Afrikaans" => "af",
        "Albanian" => "sq",
        "Arabic" => "ar",
        "Armenian" => "hy",
        "Azeri (Cyrillic)" | "Azeri (Latin)" => "az",
        "Basque" => "eu",
        "Belarusian" => "be",
        "Bengali" => "bn",
        "Bosnian (Cyrillic)" | "Bosnian (Latin)" => "bs",
        "Bulgarian" => "bg",
        "Burmese" => "my",
        "Catalan" => "ca",
        "Croatian" => "hr",
        "Czech" => "cs",
        "Danish" => "da",
        "Dutch" => "nl",
        "English" => "en",
        "Estonian" => "et",
        "Faroese" => "fo",
        "Filipino" | "Tagalog" => "tl",
        "Finnish" => "fi",
        "French" => "fr",
        "Galician" => "gl",
        "Georgian" => "ka",
        "German" => "de",
        "Greek" => "el",
        "Gujarati" => "gu",
        "Hebrew" => "he",
        "Hindi" => "hi",
        "Hungarian" => "hu",
        "Icelandic" => "is",
        "Indonesian" => "id",
        "Irish" => "ga",
        "Italian" => "it",
        "Japanese" => "ja",
        "Kannada" => "kn",
        "Kazakh" => "kk",
        "Khmer" => "km",
        "Korean" => "ko",
        "Lao" => "lo",
        "Latvian" => "lv",
        "Lithuanian" => "lt",
        "Macedonian" => "mk",
        "Malay" => "ms",
        "Malayalam" => "ml",
        "Maltese" => "mt",
        "Mongolian" => "mn",
        "Nepali" => "ne",
        "Norwegian" => "no",
        "Persian" => "fa",
        "Polish" => "pl",
        "Portuguese" => "pt",
        "Punjabi" => "pa",
        "Romanian" => "ro",
        "Russian" => "ru",
        "Serbian (Cyrillic)" | "Serbian (Latin)" => "sr",
        "Sinhala" => "si",
        "Slovak" => "sk",
        "Slovenian" => "sl",
        "Spanish" => "es",
        "Swahili" => "sw",
        "Swedish" => "sv",
        "Tamil" => "ta",
        "Tatar" => "tt",
        "Telugu" => "te",
        "Thai" => "th",
        "Turkish" => "tr",
        "Ukrainian" => "uk",
        "Urdu" => "ur",
        "Uzbek (Cyrillic)" | "Uzbek (Latin)" => "uz",
        "Vietnamese" => "vi",
        "Welsh" => "cy",
        _ => return None,
    })
}

fn lang_tag(name: &ttf_parser::name::Name) -> String {
    let primary = name.language().primary_language();
    if primary == "Chinese" {
        // 用 language id 区分简繁：台湾 / 香港 / 澳门 → 繁体
        return match name.language_id {
            0x0404 | 0x0C04 | 0x1404 => "zh-Hant".to_string(),
            _ => "zh-Hans".to_string(),
        };
    }
    match iso_language(primary) {
        Some(code) => code.to_string(),
        None if primary == "Unknown" => "und".to_string(),
        None => primary.to_ascii_lowercase(),
    }
}

/// 收集 name 表里所有语言的字族名（nameID 16 优先，缺失时退到 nameID 1）。
/// 同一字符串只保留第一次出现（通常英文记录排在最前）。
fn localized_family_names(face: &ttf_parser::Face) -> Vec<LocalizedName> {
    let mut typographic: Vec<LocalizedName> = Vec::new();
    let mut legacy: Vec<LocalizedName> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for name in face.names() {
        let target = match name.name_id {
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY => &mut typographic,
            ttf_parser::name_id::FAMILY => &mut legacy,
            _ => continue,
        };
        let Some(value) = name.to_string() else { continue };
        let value = value.trim().to_string();
        if value.is_empty() || seen.contains(&value) {
            continue;
        }
        seen.push(value.clone());
        target.push(LocalizedName {
            lang: lang_tag(&name),
            name: value,
        });
    }
    if typographic.is_empty() {
        legacy
    } else {
        typographic
    }
}

/// 书写系统的探针码位。命中「全部」才算支持。
///
/// `han` 单独用下面的 [`han_coverage`] 判定，不进这张表——汉字字数差异太大，
/// 两三个探针既可能冤枉字体也可能放过「只嵌了几十个字」的半成品。
const SCRIPT_PROBES: &[(&str, &[u32])] = &[
    ("latin", &[0x0041, 0x007A]),
    ("cyrillic", &[0x0410, 0x044F]),
    ("greek", &[0x0391, 0x03C9]),
    ("arabic", &[0x0627, 0x0645]),
    ("hebrew", &[0x05D0, 0x05EA]),
    ("devanagari", &[0x0915, 0x093E]),
    ("thai", &[0x0E01, 0x0E32]),
    ("kana", &[0x3042, 0x30A2]),
    ("korean", &[0xAC00, 0xD55C]),
    ("vietnamese", &[0x1EA1, 0x01B0]),
];

/// 汉字覆盖判定用的分层抽样字表。
///
/// 为什么不是像别的书写系统那样用两三个字：
/// ① 那样判不出「只有几十个汉字」的字体——图标字体、只做标题字的展示字体、
///    日文字体的汉字子集都会命中几个常用字，被打上「有中文」的标记，
///    用户拿它排中文正文才发现一片豆腐块，比没有标记更糟；
/// ② 也不能随便抓一堆字——生僻字在正常中文字体里也可能没有。
///
/// 选字标准：**简繁同形**（简体字体和繁体字体都必然收录，不会因为一款繁体字体
/// 缺简体字形被误判）、**高频**、并且沿 U+4E00–U+9AD4 整段分散（不能只做前几个字
/// 就蒙混过关）。正常的中文字体（GB2312 6763 字以上）应该接近百分之百命中。
pub const HAN_SAMPLE: &str = "一七三上下不世中主久之也事二五些交京人今代以位低作使供保信候做\
光全共兵再出分切列到制前力加化十半南印原友反取受名向合和品商四在地外大天女好子字安定家小\
山工年平心手文日月木水永火生田甲白目石立老金";

/// 汉字覆盖的三档结论。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HanCoverage {
    /// 一个汉字都没有——西文 / 阿拉伯文等专用字体，应用到排版软件里中文不会变
    None,
    /// 有汉字但明显不全（只有几百字），能排标题、不能排正文
    Sparse,
    /// 覆盖了抽样表的大部分，正常中文字体
    Full,
}

impl HanCoverage {
    pub fn as_str(self) -> &'static str {
        match self {
            HanCoverage::None => "none",
            HanCoverage::Sparse => "sparse",
            HanCoverage::Full => "full",
        }
    }
}

/// 抽样命中的比例达到这个值就算「完整支持中文」。
///
/// 留 40% 余量：真中文字体在抽样表上通常是 100%，但个别字体可能缺「些」「候」
/// 这类字，不该因此被判成半成品；而只嵌了几十个汉字的字体，抽样命中率一般在
/// 20% 以下，离 60% 很远，分档不会糊在一起。
const HAN_FULL_RATIO_NUM: usize = 6;
const HAN_FULL_RATIO_DEN: usize = 10;

pub fn han_coverage(face: &ttf_parser::Face) -> HanCoverage {
    let mut hits = 0usize;
    let mut total = 0usize;
    for ch in HAN_SAMPLE.chars() {
        total += 1;
        if face.glyph_index(ch).is_some() {
            hits += 1;
        }
    }
    if hits == 0 {
        HanCoverage::None
    } else if hits * HAN_FULL_RATIO_DEN >= total * HAN_FULL_RATIO_NUM {
        HanCoverage::Full
    } else {
        HanCoverage::Sparse
    }
}

fn script_coverage(face: &ttf_parser::Face) -> Vec<String> {
    let han = han_coverage(face);
    let mut out: Vec<String> = SCRIPT_PROBES
        .iter()
        .filter(|(_, probes)| {
            probes
                .iter()
                .all(|&cp| char::from_u32(cp).and_then(|c| face.glyph_index(c)).is_some())
        })
        .map(|(name, _)| (*name).to_string())
        .collect();
    // 半成品中文字体不标「支持中文」：它能画出几个字，但拿它排正文必然缺字，
    // 标上去等于骗用户。卡片上会另外显示「汉字不全」。
    if han == HanCoverage::Full {
        out.insert(0, "han".to_string());
    }
    out
}

fn classify(face: &ttf_parser::Face, family: &str) -> Classification {
    if face.is_monospaced() {
        return Classification::Mono;
    }
    if let Some(os2) = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2")) {
        if os2.len() >= 42 {
            let class = os2[30];
            match class {
                1..=5 | 7 => return Classification::Serif,
                8 => return Classification::Sans,
                9 | 12 => return Classification::Display,
                10 => return Classification::Script,
                _ => {}
            }
            let panose = &os2[32..42];
            if panose[0] == 2 && panose[3] == 9 {
                return Classification::Mono;
            }
            match panose[0] {
                3 => return Classification::Script,
                4 | 5 => return Classification::Display,
                2 => {
                    return if (11..=15).contains(&panose[1]) {
                        Classification::Sans
                    } else if (2..=10).contains(&panose[1]) {
                        Classification::Serif
                    } else {
                        Classification::Unknown
                    };
                }
                _ => {}
            }
        }
    }
    let name = family.to_lowercase();
    if name.contains("mono") {
        Classification::Mono
    } else if name.contains("script") || name.contains("hand") {
        Classification::Script
    } else if name.contains("sans") {
        Classification::Sans
    } else if name.contains("serif") {
        Classification::Serif
    } else {
        Classification::Unknown
    }
}

fn layout_features(face: &ttf_parser::Face) -> Vec<String> {
    const KEEP: [&str; 18] = [
        "liga", "dlig", "calt", "smcp", "c2sc", "onum", "lnum", "tnum", "pnum", "frac", "ordn",
        "sups", "subs", "zero", "salt", "swsh", "titl", "hist",
    ];
    let mut tags: Vec<String> = Vec::new();
    let mut collect = |table: Option<ttf_parser::opentype_layout::LayoutTable>| {
        if let Some(t) = table {
            for f in t.features {
                let tag = String::from_utf8_lossy(&f.tag.to_bytes()).into_owned();
                let stylistic_set = tag.len() == 4
                    && tag.starts_with("ss")
                    && tag[2..].chars().all(|c| c.is_ascii_digit())
                    && tag[2..] != *"00";
                if KEEP.contains(&tag.as_str()) || stylistic_set {
                    tags.push(tag);
                }
            }
        }
    };
    collect(face.tables().gsub);
    collect(face.tables().gpos);
    tags.sort_unstable();
    tags.dedup();
    tags
}

fn parse_face(
    data: &[u8],
    index: u32,
    path: &Path,
    format: FontFormat,
    file_size: u64,
    source: FontSource,
) -> Option<FontFace> {
    let face = ttf_parser::Face::parse(data, index).ok()?;

    let family = name_string(&face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| name_string(&face, ttf_parser::name_id::FAMILY))
        .unwrap_or_else(|| fallback_family(path));
    let style = name_string(&face, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
        .or_else(|| name_string(&face, ttf_parser::name_id::SUBFAMILY))
        .unwrap_or_else(|| "Regular".to_string());
    let postscript_name = name_string(&face, ttf_parser::name_id::POST_SCRIPT_NAME);
    let foundry = name_string(&face, ttf_parser::name_id::MANUFACTURER)
        .or_else(|| name_string(&face, ttf_parser::name_id::DESIGNER));
    let license = name_string(&face, ttf_parser::name_id::LICENSE);
    let license_url = name_string(&face, ttf_parser::name_id::LICENSE_URL);
    let copyright = name_string(&face, ttf_parser::name_id::COPYRIGHT_NOTICE);

    let axes: Vec<VariationAxis> = face
        .variation_axes()
        .into_iter()
        .map(|a| VariationAxis {
            tag: String::from_utf8_lossy(&a.tag.to_bytes()).into_owned(),
            min: a.min_value,
            default: a.def_value,
            max: a.max_value,
        })
        .collect();

    let classification = classify(&face, &family);
    let scripts = script_coverage(&face);
    let features = layout_features(&face);
    let localized_names = localized_family_names(&face);
    let path_str = path.to_string_lossy().into_owned();
    Some(FontFace {
        id: format!("{}#{}", path_str, index),
        path: path_str,
        preview_path: None,
        face_index: index,
        family,
        style,
        postscript_name,
        localized_names,
        foundry,
        license,
        license_url,
        copyright,
        copyright_class: None,
        format,
        is_variable: face.is_variable(),
        axes,
        weight: face.weight().to_number(),
        italic: face.is_italic(),
        monospaced: face.is_monospaced(),
        classification,
        scripts,
        features,
        glyph_count: face.number_of_glyphs(),
        file_size,
        source,
        deactivatable: crate::activation::can_deactivate(source),
        active: true,
        added_at: None,
    })
}

fn fallback_family(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unknown".to_string())
}

pub fn parse_font_file(path: &Path, source: FontSource) -> Vec<FontFace> {
    let Ok(data) = fs::read(path) else {
        return Vec::new();
    };
    let file_size = data.len() as u64;
    let format = detect_format(&data, path);

    if matches!(format, FontFormat::Woff | FontFormat::Woff2) {
        let path_str = path.to_string_lossy().into_owned();
        return vec![FontFace {
            id: format!("{}#0", path_str),
            path: path_str,
            preview_path: None,
            face_index: 0,
            family: fallback_family(path),
            style: "Regular".to_string(),
            postscript_name: None,
            localized_names: Vec::new(),
            foundry: None,
            license: None,
            license_url: None,
            copyright: None,
            copyright_class: None,
            format,
            is_variable: false,
            axes: Vec::new(),
            weight: 400,
            italic: false,
            monospaced: false,
            classification: Classification::Unknown,
            scripts: Vec::new(),
            features: Vec::new(),
            glyph_count: 0,
            file_size,
            source,
            deactivatable: crate::activation::can_deactivate(source),
            active: true,
            added_at: None,
        }];
    }

    let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
    (0..count)
        .filter_map(|i| parse_face(&data, i, path, format, file_size, source))
        .collect()
}

/// 这个字面里到底有没有中文字形（用来提前告诉用户「应用了也不会有中文」）。
///
/// 判定口径见 [`han_coverage`]：沿 U+4E00–U+9AD4 抽样 97 个简繁同形高频字，
/// 命中比例够高才算支持。旧版只看「中国文一」命中 2 个，只要嵌了几十个汉字的
/// 半成品字体也会被判成「有中文」——用户应用后排版才发现缺字。
///
/// 不去读缓存里的 scripts 拿不到这个结论的原因：缓存里脚本是「按书写系统标全有」
/// 的粗粒度结论，判不了「有但不全」这档，卡片上的分档提示需要更细的数据。
pub fn face_han_coverage(path: &Path, face_index: u32) -> HanCoverage {
    let Ok(data) = fs::read(path) else {
        return HanCoverage::None;
    };
    let Ok(face) = ttf_parser::Face::parse(&data, face_index) else {
        return HanCoverage::None;
    };
    han_coverage(&face)
}

/// 有没有汉字（Sparse 也算有：它确实能画出几个字，不该说「一个都没有」）。
pub fn face_has_cjk(path: &Path, face_index: u32) -> bool {
    face_han_coverage(path, face_index) != HanCoverage::None
}

/// 精确统计一个字面的字符集构成：cmap 里有多少码位、其中汉字 / 假名 / 谚文 / 拉丁各多少。
///
/// 用途：卡片上「无中文」是个结论，用户没法核对，会怀疑判断错了（HarmonyOS Sans
/// 就是典型——它真的有 0 个汉字，但用户以为自己装的是一套中文）。详情面板给出
/// 「共 866 字符 · 汉字 0」这样的硬数据，判断立刻变得可验证。
///
/// **只在打开详情面板时调用，不参与扫描**：全量枚举码位比抽样贵两个数量级，
/// 放进扫描会让 5000 多个字面的启动时间多出十几秒。
pub fn face_charset_stats(path: &Path, face_index: u32) -> crate::font_types::CharsetStats {
    use crate::font_types::CharsetStats;
    let empty = CharsetStats::default();
    let Ok(data) = fs::read(path) else {
        return empty;
    };
    let Ok(face) = ttf_parser::Face::parse(&data, face_index) else {
        return empty;
    };
    let Some(cmap) = face.tables().cmap else {
        return empty;
    };

    // 同一批码位可能同时出现在多个 unicode 子表里，先去重
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut stats = CharsetStats::default();
    for subtable in cmap.subtables {
        if !subtable.is_unicode() {
            continue;
        }
        subtable.codepoints(|cp| {
            if !seen.insert(cp) {
                return;
            }
            // 控制字符、代理区、私用区不算「字符集」的一部分
            if cp < 0x20 || (0x7F..=0x9F).contains(&cp) {
                return;
            }
            if (0xD800..=0xDFFF).contains(&cp) || (0xE000..=0xF8FF).contains(&cp) {
                return;
            }
            stats.total += 1;
            match cp {
                0x3400..=0x4DBF
                | 0x4E00..=0x9FFF
                | 0xF900..=0xFAFF
                | 0x20000..=0x2FA1F
                | 0x30000..=0x3134F => stats.han += 1,
                0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9D => stats.kana += 1,
                0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7FF => {
                    stats.hangul += 1
                }
                0x0041..=0x005A
                | 0x0061..=0x007A
                | 0x00C0..=0x024F
                | 0x1E00..=0x1EFF
                | 0xFB00..=0xFB06 => stats.latin += 1,
                _ => stats.symbols += 1,
            }
        });
    }
    stats
}

/// 逐字符问「这个字面里有没有它的字形」，返回与 `chars` 等长的布尔数组。
///
/// 给「示例文字是哪种语言、这款字体能不能显示」用：前端把每个书写系统的探针字符
/// 拼成一条串一次问完，比按书写系统分多次调用省掉反复打开字体文件的开销。
/// 读不到 / 解析失败一律返回全 false（调用方会当成「缺字」，但这种字体本来就画不出字）。
pub fn face_glyph_hits(path: &Path, face_index: u32, chars: &[char]) -> Vec<bool> {
    let Ok(data) = fs::read(path) else {
        return vec![false; chars.len()];
    };
    let Ok(face) = ttf_parser::Face::parse(&data, face_index) else {
        return vec![false; chars.len()];
    };
    chars
        .iter()
        .map(|c| face.glyph_index(*c).is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_font() -> Option<std::path::PathBuf> {
        walkdir::WalkDir::new("/usr/share/fonts")
            .into_iter()
            .filter_map(|e| e.ok())
            .map(|e| e.into_path())
            .find(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf"))
            })
    }

    #[test]
    fn parses_a_real_system_font() {
        let Some(path) = system_font() else { return };
        let faces = parse_font_file(&path, FontSource::System);
        assert!(!faces.is_empty(), "no faces parsed from {path:?}");
        let f = &faces[0];
        assert!(!f.family.is_empty());
        assert!(f.file_size > 0);
    }

    #[test]
    fn rejects_non_font_files() {
        assert!(!is_font_file(Path::new("/tmp/readme.txt")));
        assert!(is_font_file(Path::new("/tmp/Inter.ttf")));
        assert!(is_font_file(Path::new("/tmp/Inter.WOFF2")));
    }

    #[test]
    fn maps_primary_languages_to_tags() {
        assert_eq!(iso_language("English"), Some("en"));
        assert_eq!(iso_language("Japanese"), Some("ja"));
        assert_eq!(iso_language("Russian"), Some("ru"));
        assert_eq!(iso_language("Portuguese"), Some("pt"));
        assert_eq!(iso_language("Klingon"), None);
    }

    /// 压测：把 `ZFM_BULK_DIR` 指向的目录里所有字体逐个解析一遍。
    /// 批量导入最怕的就是某个畸形字体让解析 panic（整个应用跟着崩），
    /// 这里用真实字体库把解析层先扫一遍：有 panic 会直接中断测试，没 panic 就输出统计。
    ///
    /// 跑法：`ZFM_BULK_DIR=<目录> cargo test --offline bulk_parse -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bulk_parse_real_folder() {
        let dir = match std::env::var("ZFM_BULK_DIR") {
            Ok(d) => d,
            Err(_) => return,
        };
        let start = std::time::Instant::now();
        let mut files = 0usize;
        let mut faces = 0usize;
        let mut empty = Vec::new();
        let mut slowest = (std::time::Duration::ZERO, String::new());
        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path().to_path_buf();
            if !path.is_file() || !is_font_file(&path) {
                continue;
            }
            files += 1;
            let t0 = std::time::Instant::now();
            let parsed = parse_font_file(&path, FontSource::Managed);
            let cost = t0.elapsed();
            if cost > slowest.0 {
                slowest = (cost, path.display().to_string());
            }
            if parsed.is_empty() {
                empty.push(path.display().to_string());
            }
            faces += parsed.len();
            if files % 500 == 0 {
                println!("  ... 已解析 {} 个文件 / {} 个字面", files, faces);
            }
        }
        println!(
            "解析完成：{} 个文件 / {} 个字面 / 空结果 {} 个 / 耗时 {:?}",
            files,
            faces,
            empty.len(),
            start.elapsed()
        );
        println!("最慢的一个：{:?} -> {}", slowest.0, slowest.1);
        for e in empty.iter().take(10) {
            println!("  空结果: {}", e);
        }
        // 需要一份「字族 + 样式」清单时：ZFM_BULK_DUMP=<输出文件>
        if let Ok(dump) = std::env::var("ZFM_BULK_DUMP") {
            let mut out = String::new();
            for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
                let path = entry.path().to_path_buf();
                if !path.is_file() || !is_font_file(&path) {
                    continue;
                }
                for f in parse_font_file(&path, FontSource::Managed) {
                    out.push_str(&format!("{}\t{}\t{}\n", f.family, f.style, f.path));
                }
            }
            let _ = std::fs::write(&dump, out);
            println!("已导出字族清单 -> {}", dump);
        }
        assert!(files > 0, "目录里没找到字体文件");
    }
}
