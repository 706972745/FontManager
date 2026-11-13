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

/// name 表里的一条记录。
///
/// **为什么不用 `ttf_parser::Names`**：它的迭代器遇到 platform 未知或字符串越界的记录会
/// 直接终止整个迭代，而老字体恰恰是前面几条记录坏的、后面才是标准 UCS-2 族名
/// （Barmeno / ATNadianne / AutographScriptEF 这批就是这样，族名明明写着 `Barmeno-Bold`，
/// 却被一路回退成文件名，全被收进「未识别字体」桶）。自己解析就能坏一条跳一条、继续读。
struct RawName {
    platform: u16,
    encoding: u16,
    language: u16,
    name_id: u16,
    value: String,
}

/// 编码组合的可靠性，越小越优先。
fn name_rank(n: &RawName) -> u8 {
    match (n.platform, n.encoding) {
        (3, 1) | (3, 10) => 0, // Windows UCS-2 / UCS-4，标准
        (0, _) => 1,           // Unicode
        (3, 3) | (3, 4) | (3, 2) | (3, 5) => 2, // PRC(GBK) / Big5 / ShiftJIS / Wansung：老中文字体常用
        (3, 0) => 3,           // Windows Symbol（中文名也可能塞这儿）
        (1, 0) => 4,           // Mac Roman
        _ => 9,
    }
}

/// 解码一条 name 字符串。返回 (文本, 是否干净)。
///
/// 「干净」= 整段没有非法字节。不干净的一律当可疑：老字体把 UCS-2 内容标成
/// Shift-JIS 时，非法字节会被吞掉，剩下的半角片假名看着像字，其实是垃圾。
fn decode_with(enc: &'static encoding_rs::Encoding, bytes: &[u8]) -> Option<(String, bool)> {
    let (decoded, _, had_errors) = enc.decode(bytes);
    let total = decoded.chars().count();
    let text: String = decoded
        .chars()
        .filter(|c| *c != '\u{FFFD}' && !c.is_control())
        .collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    // 一半以上是替换符 = 编码不对，宁可不给也不要把垃圾串当名字
    if had_errors && text.chars().count() * 2 < total {
        return None;
    }
    Some((text, !had_errors))
}

fn decode_one(platform: u16, encoding: u16, bytes: &[u8]) -> Option<(String, bool)> {
    use encoding_rs::{BIG5, EUC_KR, GBK, MACINTOSH, SHIFT_JIS, UTF_16BE};
    let enc = match (platform, encoding) {
        (0, _) => UTF_16BE,
        (3, 0) | (3, 1) | (3, 10) => UTF_16BE,
        (3, 2) => SHIFT_JIS,
        (3, 3) => GBK,
        (3, 4) => BIG5,
        (3, 5) => EUC_KR,
        (1, 0) => MACINTOSH,
        _ => return None,
    };
    decode_with(enc, bytes)
}

/// 「这串看起来像乱码」：出现成片的 Latin-1 高位字符（`¤¤°êÀs»¨Áõ®Ñ` 这种），
/// 且不比汉字更多。正常西文名偶尔带一两个重音字母，不会成群。
fn looks_suspicious(s: &str) -> bool {
    let mut high = 0;
    let mut cjk = 0;
    for c in s.chars() {
        let cp = c as u32;
        if (0x80..=0xFF).contains(&cp) {
            high += 1;
        } else if is_cjk_cp(cp) {
            cjk += 1;
        }
    }
    high >= 2 && high >= cjk
}

fn is_cjk_cp(cp: u32) -> bool {
    (0x2E80..=0x9FFF).contains(&cp)      // 汉字 / 假名 / 部首
        || (0xAC00..=0xD7AF).contains(&cp) // 谚文
        || (0xF900..=0xFAFF).contains(&cp) // 兼容汉字
        || (0xFF01..=0xFF60).contains(&cp) // 全角 ASCII / 全角标点
        || (0xFFE0..=0xFFE6).contains(&cp) // 全角货币等
}

/// 可读性打分：汉字/假名最值钱，ASCII 中性，Latin-1 高位和私用区扣分。
///
/// **半角片假名要扣分**：`0xB4 0xB4 0xD2 0xD5 …` 这种 GBK 字节用 Shift-JIS 解出来
/// 就是一串 `ｴｴﾒﾕｼﾐﾔｲ`，每个都长得像字，实际是垃圾，还会靠「字符多」把正确的中文名挤掉
/// （创艺简中圆 就是这么被解错的）。老字体的族名不会用半角片假名。
fn text_score(s: &str) -> i32 {
    let mut score = 0;
    for c in s.chars() {
        let cp = c as u32;
        if cp < 0x80 {
            score += 1;
        } else if (0xFF61..=0xFF9F).contains(&cp) {
            score -= 2;
        } else if is_cjk_cp(cp) {
            score += 6;
        } else if (0x80..=0xFF).contains(&cp) {
            score -= 3;
        } else if (0xE000..=0xF8FF).contains(&cp) {
            score -= 6;
        } else {
            score += 1;
        }
    }
    score
}

/// 双重编码：有些老字体把 Big5 / GBK 的**码值直接当 Unicode 存**
/// （`中國龍豪隸書` 存成 `¤¤°êÀs»¨Áõ®Ñ`）。把字符压回字节再按中文编码解一次。
fn double_decode(s: &str) -> Option<Vec<u8>> {
    if s.chars().count() < 3 {
        return None;
    }
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut high = 0;
    for c in s.chars() {
        let cp = c as u32;
        if cp > 0xFF {
            return None;
        }
        if cp >= 0xA0 {
            high += 1;
        }
        out.push(cp as u8);
    }
    // 高位不够多就不是「码值当字符」那类
    if high * 2 < out.len() {
        return None;
    }
    Some(out)
}

/// 剥掉零字节。老字体把单字节中文（GBK / Big5）按 16 位存成 `00 b4 00 b4 …`，
/// 直接交给 UTF-16BE 会解成 `´´ÒÕ…`，交给 GBK 又因 0x00 非法而失败。
/// 把 0x00 去掉再按中文编码解，就能拿到 `创艺简中圆`。
fn strip_nuls(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.contains(&0) {
        return None;
    }
    let out: Vec<u8> = bytes.iter().copied().filter(|b| *b != 0).collect();
    if out.len() < 4 {
        return None;
    }
    Some(out)
}

/// 解一条 name 字符串。
///
/// **不迷信 platform / encoding 标注** —— 老字体的标注经常是错的：
/// 把 Big5 字节标成 Mac Roman（中国龙豪隶书）、把 UCS-2 标成 Shift-JIS（日本雅艺体）、
/// 把 Big5 码值当 Unicode 存。所以先按标注解，结果可疑就把几种常见编码都试一遍，
/// 取「读起来最像人话」的那个。
fn decode_name(platform: u16, encoding: u16, bytes: &[u8]) -> Option<String> {
    use encoding_rs::{BIG5, EUC_KR, GBK, MACINTOSH, SHIFT_JIS, UTF_16BE};
    let (primary, primary_clean) = match decode_one(platform, encoding, bytes) {
        Some((text, clean)) => (Some(text), clean),
        None => (None, false),
    };
    // 不干净（有非法字节）也当可疑：UCS-2 内容被标成 Shift-JIS 时，
    // 非法字节会被吞掉，剩下半角片假名看着像字，其实是垃圾。
    let suspicious = !primary_clean || primary.as_ref().map_or(true, |s| looks_suspicious(s));
    if !suspicious {
        return primary;
    }
    // 平手时信标注：`创艺简中圆` 的 GBK 码值当 Unicode 存，剥零后 GBK 和 Big5 都能解出
    // 5 个汉字（`创艺简中圆` vs `斐眙潠笢埴`），分数一样；标注写的是 GBK，就该信它。
    let hint: Option<&'static encoding_rs::Encoding> = match (platform, encoding) {
        (3, 3) => Some(GBK),
        (3, 4) => Some(BIG5),
        (3, 2) => Some(SHIFT_JIS),
        (3, 5) => Some(EUC_KR),
        (1, 0) => Some(MACINTOSH),
        _ => None,
    };
    let mut cands: Vec<&'static encoding_rs::Encoding> = Vec::with_capacity(5);
    if let Some(h) = hint {
        cands.push(h);
    }
    for e in [UTF_16BE, GBK, BIG5, SHIFT_JIS, EUC_KR] {
        if hint.map_or(true, |h| h != e) {
            cands.push(e);
        }
    }

    let mut best = primary;
    let mut best_score = best.as_ref().map_or(i32::MIN, |s| text_score(s));
    for enc in &cands {
        // rescue 只接受干净的候选，否则垃圾串会靠「长度」混进来
        if let Some((t, true)) = decode_with(enc, bytes) {
            let score = text_score(&t);
            if best.is_none() || score > best_score {
                best = Some(t);
                best_score = score;
            }
        }
    }
    if let Some(raw) = best.as_deref().and_then(double_decode) {
        for enc in cands.iter().filter(|e| **e != UTF_16BE) {
            if let Some((t, true)) = decode_with(enc, &raw) {
                let score = text_score(&t);
                if score > best_score {
                    best = Some(t);
                    best_score = score;
                }
            }
        }
    }
    // 剥零再解：`00 b4 00 b4 …` 是 GBK 单字节按 16 位存，比上面那步更常见。
    // **不能再试 UTF-16BE**：剥零正是为了绕开 UTF-16 的解读，
    // 否则 `43 52 ff 23 …` 会被解成 `䍒Ｃ＆Ｇブーケ`（扩展 A 汉字比 CR 得分还高）。
    if let Some(stripped) = strip_nuls(bytes) {
        for enc in cands.iter().filter(|e| **e != UTF_16BE) {
            if let Some((t, true)) = decode_with(enc, &stripped) {
                let score = text_score(&t);
                if score > best_score {
                    best = Some(t);
                    best_score = score;
                }
            }
        }
    }
    best
}

/// 自己解析 name 表（format 0/1 的记录区布局相同：6 字节头 + count × 12 字节记录）。
fn read_name_table(data: &[u8], index: u32) -> Vec<RawName> {
    let mut out: Vec<RawName> = Vec::new();
    let Ok(raw) = ttf_parser::RawFace::parse(data, index) else {
        return out;
    };
    let Some(t) = raw.table(ttf_parser::Tag::from_bytes(b"name")) else {
        return out;
    };
    if t.len() < 6 {
        return out;
    }
    let count = u16::from_be_bytes([t[2], t[3]]) as usize;
    let storage = u16::from_be_bytes([t[4], t[5]]) as usize;
    out.reserve(count.min(256));
    for i in 0..count {
        let p = 6 + i * 12;
        let Some(rec) = t.get(p..p + 12) else { break };
        let platform = u16::from_be_bytes([rec[0], rec[1]]);
        let encoding = u16::from_be_bytes([rec[2], rec[3]]);
        let language = u16::from_be_bytes([rec[4], rec[5]]);
        let name_id = u16::from_be_bytes([rec[6], rec[7]]);
        let len = u16::from_be_bytes([rec[8], rec[9]]) as usize;
        let off = u16::from_be_bytes([rec[10], rec[11]]) as usize;
        // 越界只跳过这一条，**不 break** —— 后面的记录很可能还是好的
        let Some(bytes) = t.get(storage + off..storage + off + len) else {
            continue;
        };
        if let Some(value) = decode_name(platform, encoding, bytes) {
            out.push(RawName {
                platform,
                encoding,
                language,
                name_id,
                value,
            });
        }
    }
    out
}

/// 取某个 nameID 的最优值：按编码可靠性挑，同档取先出现的（通常英文记录在前）。
fn name_string(names: &[RawName], id: u16) -> Option<String> {
    names
        .iter()
        .filter(|n| n.name_id == id)
        // 空串 / 全空白不算「有名字」：有字体把 name 记录写成空串（如 ALLMYHAN、Wartorn、
        // 苏新诗古印宋简），直接采信会让字族名变成 ""，前端按名归组时把若干互不相干的
        // 字体并成一个字族（卡片显示「6 种样式」、详情打不开、中文判定取错字面）。
        .filter(|n| !n.value.is_empty())
        .min_by_key(|n| name_rank(n))
        .map(|n| n.value.clone())
}

/// 把连字符后面的纯风格词从族名里去掉。
///
/// 老英文字体常把字重写进族名（`Barmeno-Bold`、`ATNadianne-BoldCondensed`、
/// `AutographScriptEF-LightExtra`），照字面归档会把一个系列拆成十几个单文件目录。
/// 只处理「连字符 + 纯风格词」：`Arial Black`（空格）这类通常是独立字族，不动。
fn collapse_style_suffix(family: &str) -> Option<&str> {
    let (head, tail) = family.rsplit_once('-')?;
    let head = head.trim_end();
    if head.len() < 2 || tail.is_empty() {
        return None;
    }
    let mut saw = false;
    for word in split_camel_case(tail) {
        let w = word.trim_end_matches(|c: char| c.is_ascii_digit());
        if !is_style_word(w) {
            return None;
        }
        saw = true;
    }
    if saw {
        Some(head)
    } else {
        None
    }
}

/// `BoldCondensed` → [bold, condensed]；`LightExtra` → [light, extra]。
fn split_camel_case(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_uppercase() && !cur.is_empty() {
            out.push(cur.to_ascii_lowercase());
            cur.clear();
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        out.push(cur.to_ascii_lowercase());
    }
    out
}

fn is_style_word(w: &str) -> bool {
    matches!(
        w,
        "thin"
            | "extralight"
            | "ultralight"
            | "light"
            | "book"
            | "regular"
            | "medium"
            | "semibold"
            | "demibold"
            | "bold"
            | "extrabold"
            | "ultrabold"
            | "black"
            | "heavy"
            | "extra"
            | "semi"
            | "ultra"
            | "condensed"
            | "compressed"
            | "narrow"
            | "wide"
            | "expanded"
            | "extended"
            | "italic"
            | "oblique"
            | "slanted"
            | "alt"
            | "alts"
            | "extras"
    )
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

/// 收集 name 表里**所有**语言的字族名：nameID 16（typographic）排前，nameID 1（legacy）跟在后面。
/// 同一字符串只保留第一次出现（通常英文记录排在最前）。
///
/// 2026-11-11 改：以前是「有 nameID 16 就整组丢掉 nameID 1」，结果一批中文字体的
/// 中文名只写在 legacy 记录里（如 `方正品尚粗黑.ttf`：16 = `A-OTF Maru Folk Pro`、
/// 1 = `方正品尚粗黑`），中文名于是彻底消失 —— 列表里显示英文名、搜中文名也搜不到。
/// 用户要的是「不管中文、拉丁还是其他语言的名字都能搜到」，所以两组取并集：
/// typographic 先入（它是更规范的族名），legacy 里没出现过的再补进来。
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
    typographic.extend(legacy);
    typographic
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

/// OS/2 的 `sFamilyClass`（高字节）→ 分类。0 或未识别的值返回 `None`。
fn os2_class(face: &ttf_parser::Face) -> Option<Classification> {
    let os2 = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2"))?;
    if os2.len() < 42 {
        return None;
    }
    match os2[30] {
        1..=5 | 7 => Some(Classification::Serif),
        8 => Some(Classification::Sans),
        9 | 12 => Some(Classification::Display),
        10 => Some(Classification::Script),
        _ => None,
    }
}

/// PANOSE → 分类（含 `bProportion = 9` 等宽判定）。
fn panose_class(face: &ttf_parser::Face) -> Option<Classification> {
    let os2 = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2"))?;
    if os2.len() < 42 {
        return None;
    }
    let panose = &os2[32..42];
    if panose[0] == 2 && panose[3] == 9 {
        return Some(Classification::Mono);
    }
    panose_family_kind(panose)
}

/// PANOSE 的 `bSerifStyle` → serif/sans。**不用** `bProportion`：
/// 中文字体的西文半角字身等宽是排印假象（SimHei / 宋体的 bProportion 都是 9，
/// 但它们不是等宽字体），等宽判定只对西文字体做。
fn panose_serif_style(face: &ttf_parser::Face) -> Option<Classification> {
    let os2 = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2"))?;
    if os2.len() < 42 {
        return None;
    }
    panose_family_kind(&os2[32..42])
}

fn panose_family_kind(panose: &[u8]) -> Option<Classification> {
    match panose[0] {
        3 => Some(Classification::Script),
        4 | 5 => Some(Classification::Display),
        2 => {
            if (11..=15).contains(&panose[1]) {
                Some(Classification::Sans)
            } else if (2..=10).contains(&panose[1]) {
                Some(Classification::Serif)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 中日韩字符判定（汉字 / 假名 / 谚文 / 注音 / 全角）。
/// 比 `copyright::is_cjk` 宽：字体名可能是纯假名（「昭和モダン体」）或纯谚文。
fn is_cjk_char(c: char) -> bool {
    matches!(c,
        '\u{3000}'..='\u{303F}'   // CJK 符号和标点
        | '\u{3040}'..='\u{309F}' // 平假名
        | '\u{30A0}'..='\u{30FF}' // 片假名
        | '\u{3100}'..='\u{312F}' // 注音
        | '\u{3130}'..='\u{318F}' // 韩文兼容字母
        | '\u{3400}'..='\u{4DBF}' // 汉字扩展 A
        | '\u{4E00}'..='\u{9FFF}' // 汉字
        | '\u{AC00}'..='\u{D7AF}' // 韩文音节
        | '\u{F900}'..='\u{FAFF}' // 汉字兼容
        | '\u{FE30}'..='\u{FE4F}' // CJK 兼容形式
        | '\u{FF00}'..='\u{FFEF}' // 全角 / 半角形式
    )
}

/// 这个字体是不是中日韩字体？
///
/// **不能只看 `han_coverage`**：CID-keyed CFF 的中文 OTF（创艺简宋体、文鼎CS中宋、
/// 中国龙豪隶书…）`glyph_index` 查不到汉字，覆盖度是 `None`，于是被当成西文字体走
/// 西文分支 —— 而中日韩字体天然等宽（每个汉字 advance width 相同），
/// `is_monospaced()` 一律为真，结果**整批中文宋体 / 黑体 / 隶书被判成等宽字体**
/// （2026-11-01 实测：字体库 206 个 Mono 里 103 个是中文字体）。
/// 名字里有中日韩字符的一律按中日韩字体处理，这个信号比字形探测可靠得多。
fn is_cjk_font(face: &ttf_parser::Face, names: &[String]) -> bool {
    if han_coverage(face) != HanCoverage::None {
        return true;
    }
    names.iter().any(|n| n.chars().any(is_cjk_char))
}

// ———————————————————————————————————————————————————————————————
// 字族分类（2026-11-13 重做，用户说这是最频繁使用的功能）
//
// 问题（4214 族真实字体库实测）：45% 的字面被判成 `Unknown`，而筛选菜单只有
// 衬线 / 无衬线 / 等宽 / 展示 / 手写五项 —— `Unknown` 不在任何一项里，等于让
// 近一半字体「凭空消失」。点名的错例：汉仪琥珀体简 / 汉仪综艺体简 / 華康娃娃體
// 全落进 Unknown，迷你简综艺 / 簡琥珀 被元数据误判成了手写。
//
// 结论：**名字优先、逐层短路；判不出来就兜底给展示，绝不再产出 Unknown**。
// 理由沿用 2026-11-01 的实测结论 —— 中文字体的 OS/2 `sFamilyClass` 与 PANOSE
// 基本是垃圾数据（SimHei 宽高比写 9、方正黑体 class 写 10、SimSun 宽高比写 9），
// 只能当兜底信号；西文古典字体这两张表也常互相矛盾，需要名字破平。
//
// 用户 2026-11-13 定的口径（改这张表之前先看这四条）：
//   1. 印刷楷体（华文楷体、楷体_GB2312）→ 衬线；书写感强的美术字（方正康体）→ 手写；
//   2. 圆体（幼圆 / 圆黑 / 華康圓緣斗雲體）→ 展示，**不算无衬线**；
//   3. 图标 / 符号 / 专题字体（康熙海洋生物、華康可愛動物、XX篇）→ 展示；
//   4. 实在判不出来 → 展示（Unknown 筛不出来，留着等于隐藏字体）。
// ———————————————————————————————————————————————————————————————

/// 等宽关键词。中日韩分支**只**认这些 —— 中日韩字体天然等宽（每个汉字 advance
/// width 相同），`is_monospaced()` 对它们一律为真，不能拿来判等宽。
const MONO_KEYWORDS: &[&str] = &["等宽", "等寬"];

/// 西文名字里的等宽关键词。匹配 `mono` 时要把 `monotype` 排除掉 ——
/// `Monotype` 是字厂名（Monotype Corsiva 是手写体），不是等宽。
const MONO_LATIN_KEYWORD: &str = "mono";

/// 展示（美术字 / 标题字 / 圆体 / 图标符号 / 专题字）关键词。
///
/// 这张表是本次重做的主力：库里的美术字大多只有一个「描述性」中文名
/// （综艺、琥珀、娃娃、彩帶…），元数据全是 0，不靠名字就只能是 Unknown。
const DISPLAY_KEYWORDS: &[&str] = &[
    // 中文美术字 / 广告标题字
    "综艺", "综藝", "琥珀", "娃娃", "布丁", "彩带", "彩帶", "海报", "海報", "广告", "廣告",
    "标题", "標題", "美术", "美術", "艺术", "藝術", "装饰", "裝飾", "立体", "立體", "描边",
    "描邊", "卡通", "漫画", "漫畫", "像素", // 圆体：用户 2026-11-13 明确归展示，不归无衬线
    "圆", "圓", "round", // 图标 / 符号 / 专题字库（XX篇 / XX动物 / XX交通工具）
    "图标", "圖標", "符号", "符號", "篇", "生物", "动物", "動物", "植物", "食物", "人物", "星座",
    "音乐", "音樂", "建筑", "建築", "交通", "服饰", "服飾", "用品", "器具", "贴纸", "貼紙", "涂鸦",
    "塗鴉", // 西文展示体（名字兜底那一层复用这张表）
    "pop", "display", "decorative", "poster", "headline", "ornament", "dingbat", "symbol", "icon",
    "pixel", "bitmap", "3d", "outline", "shadow",
];

/// 手写（书法 / 毛笔 / 连笔 / 西文手写体）关键词。
const SCRIPT_KEYWORDS: &[&str] = &[
    "行书", "行書", "草", // 草书（叶根友疾风草书）
    "隶", "隷", // 隶的繁体写法（文鼎CS大隸書 / 日本青柳隷書）
    "篆", "seal", "硬笔", "硬筆", "毛笔", "毛筆", "钢笔", "鋼筆", "手写", "手寫", "流形", "连笔",
    "連筆", "brush", "script", "hand", "cursive", "calligraph",
];

/// 衬线关键词。
///
/// **不要往里加「衬线」二字**：`无衬线` 里也含这两个字，而衬线判定顺序在无衬线
/// 之前，加进去会把「无衬线体」判成衬线。
const SERIF_KEYWORDS: &[&str] = &["宋", "明", "仿", "楷", "kai", "字典", "serif", "song", "ming"];

/// 无衬线关键词。
///
/// 「等线」是无衬线（Windows 的 DengXian / 汉仪中等线 / 迷你简中等线），它们的
/// OS/2 class 常被写成 10（手写），不补这个关键字就会被归到手写里。
const SANS_KEYWORDS: &[&str] = &[
    "黑", "hei", "雅黑", "等线", "等線", "哥特", "gothic", "sans", "无衬线", "無襯線",
];

/// 显式覆盖表：关键词表对不上的**具体字族**，命中即用（族名或本地化名包含即可）。
///
/// 按用户 2026-11-13 口径，可持续追加 —— 以后每修一个「判错的字体」就往末尾加一条，
/// 比去改关键词表安全（关键词是全局的，覆盖表只影响指名的那一族）。
const FAMILY_OVERRIDES: &[(&str, Classification)] = &[
    // 方正康体系列：书写感很强的美术字，不是印刷楷体 → 手写
    ("康体", Classification::Script),
    ("康體", Classification::Script),
    // 方正新秀丽：衬线
    ("新秀丽", Classification::Serif),
    ("新秀麗", Classification::Serif),
];

/// 族名 + 各语言本地化名，小写化（关键词匹配用）。
fn normalized_names(family: &str, localized: &[LocalizedName]) -> Vec<String> {
    std::iter::once(family.to_lowercase())
        .chain(localized.iter().map(|l| l.name.to_lowercase()))
        .filter(|n| !n.trim().is_empty())
        .collect()
}

/// 分类编排：名字 / 元数据 / 字形 / 等宽四种信号按可信度组装，最后统一兜底成展示。
///
/// 单独拆出来是为了可测：`metadata` / `shape` 都是惰性闭包，测试里给 `|| None`
/// 就等于「这个字体没有可用的 OS/2 / PANOSE」或「字形层判不出」，不依赖真实字体。
///
/// 优先级（用户 2026-11-13 定的口径）：
/// - **中日韩字体**：名字 → 元数据 → 字形 → 展示。中文的 OS/2 / PANOSE 基本是垃圾
///   （见 `classify_by_metadata` 的注释），所以名字永远第一。
/// - **西文字体**：等宽 → 元数据 → 名字 → 字形 → 展示。西文古典字体的名字往往没有
///   任何有用关键词（"AcaciasHand" 这种手写体靠名字判得出，但 "Barmeno" 什么都说不
///   出来），元数据反而更靠谱，所以元数据在前。
/// - **元数据是垃圾（PANOSE 全 0 / sFamilyClass=0）时**：字形层的结论优先于元数据，
///   但**名字仍然更优先** —— 名字是厂家自己写的，字形只是几何推断。
pub(crate) fn resolve_classification<M, S>(
    cjk: bool,
    monospaced: bool,
    metadata_garbage: bool,
    names: &[String],
    metadata: M,
    shape: S,
) -> Classification
where
    M: Fn() -> Option<Classification>,
    S: Fn() -> Option<Classification>,
{
    // 等宽只对西文有意义：中日韩字体天然等宽（见 is_cjk_font 的注释），不能据此判等宽
    if monospaced && !cjk {
        return Classification::Mono;
    }
    // 名字层排第一的两种情形：中日韩字体 / 元数据不可信
    if cjk || metadata_garbage {
        if let Some(c) = classify_by_name(names) {
            return c;
        }
    }
    let signals = if metadata_garbage {
        // 元数据全 0：先问字形，再退回元数据
        shape().or_else(metadata)
    } else {
        // 元数据可信：元数据 → 名字（西文）→ 字形
        metadata().or_else(|| classify_by_name(names))
    };
    signals.or_else(shape).unwrap_or(Classification::Display)
}

/// 名字里带 `mono` 就够判等宽，但 `Monotype`（字厂名，如 Monotype Corsiva 手写体）
/// 不是等宽 —— 排除掉，否则那批字会被判成等宽。
fn has_mono_keyword(names: &[String]) -> bool {
    names.iter().any(|n| {
        MONO_KEYWORDS.iter().any(|kw| n.contains(kw))
            || (n.contains(MONO_LATIN_KEYWORD) && !n.contains("monotype"))
    })
}

/// **只靠名字**判分类；判不出返回 `None`（由调用方决定是否走元数据 / 兜底展示）。
///
/// 顺序即优先级，逐层短路：
/// 等宽 → 展示 → 手写 → 衬线 → 无衬线 → 显式覆盖表。
pub(crate) fn classify_by_name(names: &[String]) -> Option<Classification> {
    if names.is_empty() {
        return None;
    }
    let has = |kw: &str| names.iter().any(|n| n.contains(kw));
    let has_any = |kws: &[&str]| kws.iter().any(|kw| has(kw));

    // 1. 等宽
    if has_mono_keyword(names) {
        return Some(Classification::Mono);
    }
    // 2. 展示（美术字 / 标题字 / 圆体 / 图标符号 / 专题字）
    if has_any(DISPLAY_KEYWORDS) {
        return Some(Classification::Display);
    }
    // 3. 手写（书法 / 毛笔 / 连笔 / 西文手写体）
    if has_any(SCRIPT_KEYWORDS) {
        return Some(Classification::Script);
    }
    // 3.5「Xxx Sans Serif」这类名字两个词都在，无衬线优先（`serif` 只是修饰语）。
    // 这一步必须在衬线判定之前，否则「FreeSans Serif」会被判成衬线。
    if (has("sans") || has("gothic")) && has("serif") {
        return Some(Classification::Sans);
    }
    // 4. 衬线（印刷楷体也算这里：用户 2026-11-13 口径）
    if has_any(SERIF_KEYWORDS) {
        return Some(Classification::Serif);
    }
    // 5. 无衬线
    if has_any(SANS_KEYWORDS) {
        return Some(Classification::Sans);
    }
    // 6. 显式覆盖表：具体字族纠正（方正康体 → 手写、方正新秀丽 → 衬线）
    if let Some((_, class)) = FAMILY_OVERRIDES
        .iter()
        .find(|(kw, _)| names.iter().any(|n| n.contains(kw)))
    {
        return Some(*class);
    }
    None
}

/// **元数据层**：OS/2 `sFamilyClass` + PANOSE。
///
/// - 中日韩字体：这两张表基本不可信，只当名字判不出时的兜底（顺序同旧行为：
///   OS/2 class → PANOSE 的 `bSerifStyle`，**不用** `bProportion`）。
/// - 西文：两路信号互相校验 —— 一致就用；分歧时用名字里的明确关键字破平
///   （Century Gothic 的 class=2 是错的、PANOSE=11 才是对的；反过来
///   Friz Quadrata 的 class=7 对、PANOSE=14 是错的），名字没说就维持 OS/2 class；
///   两路都没有返回 `None`，交给调用方的名字层。
fn classify_by_metadata(
    face: &ttf_parser::Face,
    cjk: bool,
    names: &[String],
) -> Option<Classification> {
    if cjk {
        return os2_class(face).or_else(|| panose_serif_style(face));
    }
    let has = |kw: &str| names.iter().any(|n| n.contains(kw));
    match (os2_class(face), panose_class(face)) {
        // 两个信号一致，直接用
        (Some(a), Some(b)) if a == b => Some(a),
        // 分歧：名字里有明确关键字就听名字，名字没说就维持 OS/2 class（旧行为，不回归）
        (Some(a), Some(_)) => Some(if has("sans") || has("gothic") {
            Classification::Sans
        } else if has("serif") {
            Classification::Serif
        } else {
            a
        }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        // 都没有：交给名字层兜底
        (None, None) => None,
    }
}

/// 元数据是不是**明摆着的垃圾**：没有 OS/2 表，或者 `sFamilyClass` 与 PANOSE 全 0。
///
/// 命中时字形层要抢在元数据前面（见 `resolve_classification`）—— 全 0 的 OS/2 等于
/// 厂家没填，按它判出来的分类纯属噪声。实测库里 SitkaVF / SegUIVar 就是这种：
/// 名字里没有关键词、元数据全 0，只有字形判得出来。
fn metadata_is_garbage(face: &ttf_parser::Face) -> bool {
    const OS2: ttf_parser::Tag = ttf_parser::Tag::from_bytes(b"OS/2");
    let Some(os2) = face.raw_face().table(OS2) else {
        return true;
    };
    if os2.len() < 42 {
        return true;
    }
    os2[30] == 0 && os2[32..42].iter().all(|b| *b == 0)
}

/// 字族分类入口。
///
/// 用户 2026-11-13 的硬要求：分类必须能泛化到以后新导入的字体 —— 关键词表管不到
/// 没有可匹配词的字体，所以名字判不出时要靠**字形几何**，而不是直接倒进兜底展示
/// （细节见 `resolve_classification` 的优先级说明）。
fn classify(face: &ttf_parser::Face, family: &str, localized: &[LocalizedName]) -> Classification {
    let names = normalized_names(family, localized);
    let cjk = is_cjk_font(face, &names);
    resolve_classification(
        cjk,
        face.is_monospaced(),
        metadata_is_garbage(face),
        &names,
        || classify_by_metadata(face, cjk, &names),
        || crate::shape_class::classify_by_shape(face),
    )
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
    let face = match ttf_parser::Face::parse(data, index) {
        Ok(f) => f,
        Err(_) => {
            // 系统字体解析不了就跳过（不归我们管，也不该占列表）；
            // 字库 / 用户字体要留下来，标成不完整，交给「非完整字体」归集与筛选。
            return match source {
                FontSource::System => None,
                _ => Some(broken_face(
                    path,
                    index,
                    format,
                    file_size,
                    source,
                    "字体无法解析（文件损坏或格式不受支持）",
                )),
            };
        }
    };

    let names = read_name_table(data, index);
    let name_family = name_string(&names, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| name_string(&names, ttf_parser::name_id::FAMILY));
    // 真族名读不出来 → 下面会用文件名顶上。导入归档时不能拿这种「假族名」建目录，
    // 否则一个文件一个目录，搬走内容后就是库根上的一片空壳（2.4）。
    let name_fallback = name_family.is_none();
    let raw_family = name_family.unwrap_or_else(|| fallback_family(path));
    // 真名才做「字重后缀归并」：`Barmeno-Bold` → `Barmeno`。文件名顶上的假族名不参与，
    // 否则 `Barmeno-Bold-Regular` 会被削成 `Barmeno-Bold`，反而更难认。
    let family = if name_fallback {
        raw_family
    } else {
        collapse_style_suffix(&raw_family)
            .map(|s| s.to_string())
            .unwrap_or(raw_family)
    };
    let style = name_string(&names, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
        .or_else(|| name_string(&names, ttf_parser::name_id::SUBFAMILY))
        .unwrap_or_else(|| "Regular".to_string());
    let postscript_name = name_string(&names, ttf_parser::name_id::POST_SCRIPT_NAME);
    let foundry = name_string(&names, ttf_parser::name_id::MANUFACTURER)
        .or_else(|| name_string(&names, ttf_parser::name_id::DESIGNER));
    let license = name_string(&names, ttf_parser::name_id::LICENSE);
    let license_url = name_string(&names, ttf_parser::name_id::LICENSE_URL);
    let copyright = name_string(&names, ttf_parser::name_id::COPYRIGHT_NOTICE);

    // 能解析但明显残缺的：挑最严重的那个原因说清楚（越靠前越致命）。
    // 系统字体不标记 —— 用户说了「系统字体无需理会」。
    //
    // **不要**把「name 表读不出字族名」算成损坏：老中文字体（长城/文鼎/创艺那批）
    // 的 name 表是 GBK/自定义编码，ttf_parser 解不出来只能回退文件名，字体本身好好的。
    // 曾经把它当损坏，一次性把 104 个正常字体搬进了「非完整字体」目录（0.9.8-1 的坑）。
    let mut incomplete: Option<String> = if face.number_of_glyphs() == 0 {
        Some("字体里没有任何字形（文件不完整）".to_string())
    } else if face.tables().cmap.is_none() {
        Some("缺少字符映射表（cmap），文字无法正常显示".to_string())
    } else {
        None
    };
    if source == FontSource::System {
        incomplete = None;
    }
    // 结构问题（loca / post / cvt）本身不算损坏 —— 只要修复副本能生成，字体照样能看。
    // 只有**连修复都做不到**的，才是软件里永远显示不出来的真损坏（用户 2026-10-30 定）。
    if incomplete.is_none() && source != FontSource::System {
        if let Some(problem) = crate::preview_font::structural_problem(data) {
            if !crate::preview_font::repairable(data) {
                incomplete = Some(format!(
                    "字体结构异常且无法修复：{problem}（软件里无法显示）"
                ));
            }
        }
    }

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

    let localized_names = localized_family_names(&face);
    let classification = classify(&face, &family, &localized_names);
    let scripts = script_coverage(&face);
    let features = layout_features(&face);
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
        license_note: None,
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
        incomplete,
        name_fallback,
        file_size,
        source,
        deactivatable: crate::activation::can_deactivate(source),
        active: true,
        added_at: None,
    })
}

/// 连字体元数据都读不出来时（损坏 / 读不了 / 只有 woff 壳），文件名是唯一线索：
/// 照样按名字判，判不出给「展示」—— 用户 2026-11-13 定的口径是**不留 Unknown**
/// （筛选菜单里没有这一项，留着等于让字体从界面上消失）。
fn classify_by_family_name(family: &str) -> Classification {
    classify_by_name(&normalized_names(family, &[])).unwrap_or(Classification::Display)
}

/// 完全读不出来的字体：造一个占位字面，让它出现在列表里
/// （能被「不完整 / 损坏」筛出来，导入时也能被归到「非完整字体」目录）。
fn broken_face(
    path: &Path,
    index: u32,
    format: FontFormat,
    file_size: u64,
    source: FontSource,
    reason: &str,
) -> FontFace {
    let path_str = path.to_string_lossy().into_owned();
    let family = fallback_family(path);
    // 文件名也判不出就给展示（不留 Unknown，见 classify_by_family_name）
    let classification = classify_by_family_name(&family);
    FontFace {
        id: format!("{}#{}", path_str, index),
        path: path_str,
        preview_path: None,
        face_index: index,
        family,
        style: "Regular".to_string(),
        postscript_name: None,
        localized_names: Vec::new(),
        foundry: None,
        license: None,
        license_url: None,
        copyright: None,
        copyright_class: None,
        license_note: None,
        format,
        is_variable: false,
        axes: Vec::new(),
        weight: 400,
        italic: false,
        monospaced: false,
        classification,
        scripts: Vec::new(),
        features: Vec::new(),
        glyph_count: 0,
        incomplete: Some(reason.to_string()),
        name_fallback: true,
        file_size,
        source,
        deactivatable: crate::activation::can_deactivate(source),
        active: true,
        added_at: None,
    }
}

/// 这个 `incomplete` 原因算不算「真的用不了」。
///
/// 用户 2026-10-30 定的口径：**只要被标记为不完整/损坏，就是软件里显示不出来的**，
/// 一律归集到「非完整字体」。所以现在凡是标上来的都返回 true；
/// 保留这个函数是为了让调用点自己说明「为什么搬」。
pub const UNPREVIEWABLE_REASON: &str = "软件里无法预览（字体格式不受支持）";

pub fn is_hard_damage(reason: &str) -> bool {
    // 「运行时预览失败」不搬：浏览器拒收可能是 WebView2 的瞬时问题，不能据此动用户的文件。
    // 真正的文件损坏（读不出 / 解析失败 / 0 字形 / 缺 cmap）才整族归集。
    !reason.starts_with("软件里无法预览")
}

fn fallback_family(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unknown".to_string())
}

pub fn parse_font_file(path: &Path, source: FontSource) -> Vec<FontFace> {
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(_) => {
            // 读不出来也一样：字库 / 用户字体留个占位（标不完整），系统字体跳过
            return match source {
                FontSource::System => Vec::new(),
                _ => vec![broken_face(
                    path,
                    0,
                    FontFormat::Unknown,
                    0,
                    source,
                    "文件无法读取（可能已被删除或无权限）",
                )],
            };
        }
    };
    let file_size = data.len() as u64;
    let format = detect_format(&data, path);

    if matches!(format, FontFormat::Woff | FontFormat::Woff2) {
        let path_str = path.to_string_lossy().into_owned();
        let family = fallback_family(path);
        let classification = classify_by_family_name(&family);
        return vec![FontFace {
            id: format!("{}#0", path_str),
            path: path_str,
            preview_path: None,
            face_index: 0,
            family,
            style: "Regular".to_string(),
            postscript_name: None,
            localized_names: Vec::new(),
            foundry: None,
            license: None,
            license_url: None,
            copyright: None,
            copyright_class: None,
            license_note: None,
            format,
            is_variable: false,
            axes: Vec::new(),
            weight: 400,
            italic: false,
            monospaced: false,
            classification,
            scripts: Vec::new(),
            features: Vec::new(),
            glyph_count: 0,
            incomplete: None,
            name_fallback: true,
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

    /// 损坏 / 不完整的字库字体要留下占位并标记原因（好归到「非完整字体」、能被筛出来）；
    /// 系统字体解析不了就跳过，不占列表。
    #[test]
    fn broken_fonts_are_flagged_not_dropped() {
        let dir = std::env::temp_dir().join("zfm-broken-font-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("Broken Font.ttf");
        std::fs::write(&bad, b"this is definitely not a font file").unwrap();

        let managed = parse_font_file(&bad, FontSource::Managed);
        assert_eq!(managed.len(), 1, "字库字体要留占位");
        assert!(managed[0].incomplete.is_some(), "要标记不完整");
        assert_eq!(managed[0].family, "Broken Font", "用文件名当字族名");
        // 系统字体：跳过（用户说了「系统字体无需理会」）
        assert!(parse_font_file(&bad, FontSource::System).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// 取一台 Windows 上 `C:\Windows\Fonts` 里某个字体的分类。
    /// 文件不存在就返回 `None` —— 换机器 / CI 上缺字体时自动跳过，不误报失败。
    fn classify_system_font(file_name: &str) -> Option<(String, Classification)> {
        let path = Path::new(r"C:\Windows\Fonts").join(file_name);
        if !path.exists() {
            eprintln!("[skip] 系统字体缺失，跳过：{file_name}");
            return None;
        }
        let faces = parse_font_file(&path, FontSource::System);
        let f = faces.into_iter().next()?;
        Some((f.family, f.classification))
    }

    /// 断言一批系统字体的分类，缺文件就跳过那一条。
    fn assert_system_classification(cases: &[(&str, Classification)]) {
        for (file, want) in cases {
            let Some((family, got)) = classify_system_font(file) else {
                continue;
            };
            assert_eq!(got, *want, "{file}（字族「{family}」）分类错了");
        }
    }

    /// 回归（用户 2026-11-01 报「筛选选衬线，里面还会出现无衬线」）：
    /// **中文字体只能信名字**。它们的 OS/2 `sFamilyClass` / PANOSE 基本是垃圾数据 ——
    /// SimHei 的 `bProportion=9` 会被旧逻辑判成等宽、SimSun 同样，方正黑体的 class 还写成手写。
    /// 中文名（黑体 / 宋体 / 楷体 / 仿宋）比英文名（SimHei / SimSun）更直接，优先用它。
    #[test]
    fn classifies_cjk_fonts_from_localized_names() {
        assert_system_classification(&[
            ("simhei.ttf", Classification::Sans), // 黑体
            ("simsun.ttc", Classification::Serif), // 宋体
            // 楷体从「手写」改成「衬线」：用户 2026-11-13 口径 —— 印刷楷体（楷体_GB2312 /
            // 华文楷体）是衬线，只有书写感强的美术字（方正康体这类）才算手写。
            ("simkai.ttf", Classification::Serif), // 楷体
            ("simfang.ttf", Classification::Serif), // 仿宋
            ("msyh.ttc", Classification::Sans),    // 微软雅黑
            ("Deng.ttf", Classification::Sans),    // 等线
        ]);
    }

    #[test]
    fn cjk_char_detection_covers_kana_and_hangul() {
        for c in ['宋', '黑', '線', 'カ', 'モ', '한', '글', 'ㄱ', 'ㄴ'] {
            assert!(is_cjk_char(c), "{c} 该算中日韩字符");
        }
        for c in ['A', 'z', '0', 'é', 'ß', 'Ω'] {
            assert!(!is_cjk_char(c), "{c} 不该算中日韩字符");
        }
    }

    /// 回归（最要命的一条）：CID-keyed CFF 的中文 OTF 查不到汉字（`han_coverage` 是
    /// `None`），以前就被当成西文字体 —— 而中日韩字体天然等宽，`is_monospaced()` 一律
    /// 为真，于是**整批中文宋体 / 黑体 / 隶书被判成等宽字体**（字体库 206 个 Mono 里
    /// 103 个是中文字体）。现在名字里有中日韩字符就按中日韩字体处理。
    #[test]
    fn cjk_font_is_detected_by_name_when_glyph_lookup_fails() {
        let path = Path::new(r"C:\Windows\Fonts\arial.ttf");
        let Some(data) = std::fs::read(path).ok() else {
            eprintln!("[skip] 没有 arial.ttf");
            return;
        };
        let Some(face) = ttf_parser::Face::parse(&data, 0).ok() else {
            return;
        };
        let names = |n: &str| vec![n.to_string()];
        // Arial 既没有汉字、名字也不是中文 —— 不是中日韩字体
        assert!(!is_cjk_font(&face, &names("Arial")));
        // 同一个「查不到汉字」的字体，只要名字是中文，就要按中日韩字体处理
        assert!(is_cjk_font(&face, &names("文鼎CS中宋")));
        assert!(is_cjk_font(&face, &names("昭和モダン体")));
        assert!(is_cjk_font(&face, &names("안상수2000")));
    }

    /// 回归：西文古典字体的 OS/2 class 与 PANOSE 经常互相矛盾，此时听名字里的关键字。
    /// Century Gothic（`GOTHIC.TTF`）的 class=2「过渡衬线」是错的，PANOSE bSerifStyle=11
    /// 才是对的；Century Schoolbook（`CENTURY.TTF`）反过来，名字里没有 sans 关键字，
    /// 于是维持 OS/2 class 判成衬线（旧行为，不回归）。
    #[test]
    fn western_fonts_break_os2_panose_ties_by_name() {
        assert_system_classification(&[
            ("GOTHIC.TTF", Classification::Sans), // Century Gothic
            ("CENTURY.TTF", Classification::Serif), // Century Schoolbook
        ]);
    }

    /// 回归：等宽字体不能被 CJK 分支「不迷信 bProportion」的规则带偏，
    /// 也不能被 OS/2 class 抢走（Courier / Consolas 的 class 常写成 8「无衬线」）。
    #[test]
    fn monospaced_fonts_stay_mono() {
        assert_system_classification(&[
            ("cour.ttf", Classification::Mono),
            ("consola.ttf", Classification::Mono),
        ]);
    }

    // ———————————————————————————————————————————————————————————
    // 分类重做（2026-11-13）：名字层是纯函数，直接喂字符串断言，
    // 不依赖任何真实字体文件（字体库路径在不同机器上不一样）。
    // ———————————————————————————————————————————————————————————

    fn owned_lower(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_lowercase()).collect()
    }

    /// 中日韩分支、且「没有任何可用元数据」时的判定结果。
    fn cjk_class(names: &[&str]) -> Classification {
        resolve_classification(true, false, false, &owned_lower(names), || None, || None)
    }

    /// 西文分支、且「没有任何可用元数据」时的判定结果。
    fn west_class(names: &[&str]) -> Classification {
        resolve_classification(false, false, false, &owned_lower(names), || None, || None)
    }

    /// 综艺 / 琥珀这批中文美术字原本全是 Unknown（元数据全 0，名字里又没有旧关键词）。
    /// 用户点名的第一批错例。
    #[test]
    fn display_keywords_catch_chinese_decorative_faces() {
        for name in [
            "汉仪琥珀体简",
            "汉仪综艺体简",
            "经典综艺体简",
            "经典综艺体繁",
            "综艺繁体",
            "微软简综艺",
            "華康綜藝體",
        ] {
            assert_eq!(cjk_class(&[name]), Classification::Display, "{name} 该判展示");
        }
    }

    /// 華康那批美术字（娃娃 / 布丁 / 彩带 / 海报 / 流叶）。
    /// 流葉體名字里没有关键词，靠「判不出就兜底展示」落地 —— 这条同时守住兜底规则。
    #[test]
    fn display_keywords_catch_huakang_decorative_faces() {
        for name in [
            "華康娃娃體",
            "華康布丁體",
            "華康彩帶體",
            "華康海報體W12",
            "華康流葉體",
        ] {
            assert_eq!(cjk_class(&[name]), Classification::Display, "{name} 该判展示");
        }
    }

    /// 回归（本次重做的核心证据）：这两条**旧逻辑判成 script**（OS/2 class=10 /
    /// PANOSE family=3 的垃圾数据抢先命中），说明「名字优先」真的生效了。
    #[test]
    fn name_layer_beats_garbage_metadata() {
        for name in ["迷你简综艺", "簡琥珀"] {
            assert_eq!(cjk_class(&[name]), Classification::Display, "{name} 该判展示");
        }
        // 元数据说是手写也一样：中日韩分支名字优先
        let names = owned_lower(&["迷你简综艺"]);
        assert_eq!(
            resolve_classification(
                true,
                false,
                false,
                &names,
                || Some(Classification::Script),
                || None
            ),
            Classification::Display,
            "名字判得出时不该让元数据说话"
        );
    }

    /// 圆体归展示（用户 2026-11-13 口径），**不是**无衬线。
    #[test]
    fn round_faces_are_display_not_sans() {
        for name in ["幼圆", "幼圓", "漢儀圓體", "華康圓緣斗雲體"] {
            assert_eq!(cjk_class(&[name]), Classification::Display, "{name} 该判展示");
        }
    }

    /// 楷体口径：印刷楷体 → 衬线；书写感强的美术字 → 手写（走显式覆盖表）。
    #[test]
    fn printed_kai_is_serif_but_calligraphic_faces_are_script() {
        assert_eq!(cjk_class(&["华文楷体"]), Classification::Serif);
        assert_eq!(cjk_class(&["楷体_GB2312"]), Classification::Serif);
        assert_eq!(cjk_class(&["KaiTi"]), Classification::Serif);
        assert_eq!(cjk_class(&["方正康体简体"]), Classification::Script);
        assert_eq!(cjk_class(&["方正康體繁體"]), Classification::Script);
        assert_eq!(cjk_class(&["方正新秀丽简体"]), Classification::Serif);
    }

    #[test]
    fn sans_keywords_cover_hei_and_gothic() {
        for name in ["微软雅黑", "MS Gothic", "思源黑体", "等线", "Source Han Sans SC"] {
            assert_eq!(cjk_class(&[name]), Classification::Sans, "{name} 该判无衬线");
        }
    }

    #[test]
    fn serif_keywords_cover_song_and_fangsong() {
        for name in ["宋体", "华文仿宋", "经典宋体简", "思源宋体"] {
            assert_eq!(cjk_class(&[name]), Classification::Serif, "{name} 该判衬线");
        }
        // 英文名单独看没有 serif 关键词，靠同一字面的中文名（name 表里两条都收）判出来
        assert_eq!(cjk_class(&["SimSun", "宋体"]), Classification::Serif);
    }

    #[test]
    fn script_keywords_cover_calligraphy_faces() {
        for name in ["方正流形体简体", "迷你简隶书", "叶根友疾风草书"] {
            assert_eq!(cjk_class(&[name]), Classification::Script, "{name} 该判手写");
        }
    }

    /// 图标 / 符号 / 专题字库（康熙那批「XX篇」「XX动物」）。
    #[test]
    fn icon_and_thematic_fonts_are_display() {
        for name in [
            "康熙海洋生物",
            "華康可愛動物1",
            "華康可愛動物2",
            "華康交通工具篇",
            "949-CAI978立体字",
        ] {
            assert_eq!(cjk_class(&[name]), Classification::Display, "{name} 该判展示");
        }
    }

    /// 西文：名字兜底扩表 + 等宽优先 + 兜底展示（不是 Unknown）。
    #[test]
    fn western_names_fall_back_to_display_not_unknown() {
        assert_eq!(west_class(&["Playfair Display"]), Classification::Display);
        assert_eq!(west_class(&["Abbeyline"]), Classification::Display);
        assert_eq!(
            west_class(&["Helvetica"]),
            Classification::Display,
            "判不出也要给展示"
        );
        // 等宽优先于一切（Courier / Consolas 的 OS/2 class 会写成 8）
        let courier = owned_lower(&["Courier New"]);
        assert_eq!(
            resolve_classification(
                false,
                true,
                false,
                &courier,
                || Some(Classification::Sans),
                || None
            ),
            Classification::Mono
        );
        assert_eq!(west_class(&["Brush Script MT"]), Classification::Script);
        assert_eq!(
            west_class(&["FreeSans Serif"]),
            Classification::Sans,
            "sans 与 serif 同时出现时 sans 优先"
        );
        // `Monotype` 是字厂名不是等宽：Corsiva 名字里也没有 script 关键词，
        // 于是落到兜底展示 —— 关键是不能被判成等宽。
        assert_ne!(
            west_class(&["Monotype Corsiva"]),
            Classification::Mono,
            "Monotype 不是等宽"
        );
    }

    /// 字形层接力：族名是一串乱码（新导入字体最常见的样子）时，宋体 / 黑体也不能
    /// 掉进兜底展示 —— 这就是第二阶段加这层的目的（泛化到关键词表没覆盖的字体）。
    ///
    /// 这里直接对系统字体的 `Face` 调 `classify`，族名故意给乱码。
    #[test]
    fn shape_layer_rescues_fonts_whose_name_says_nothing() {
        let cases = [
            ("simsun.ttc", Classification::Serif),
            ("simhei.ttf", Classification::Sans),
            ("msyh.ttc", Classification::Sans),
            ("times.ttf", Classification::Serif),
            ("arial.ttf", Classification::Sans),
        ];
        for (file, want) in cases {
            let path = Path::new(r"C:\Windows\Fonts").join(file);
            if !path.exists() {
                eprintln!("[skip] 系统字体缺失，跳过：{file}");
                continue;
            }
            let Ok(data) = std::fs::read(&path) else { continue };
            let Ok(face) = ttf_parser::Face::parse(&data, 0) else {
                continue;
            };
            let garbage = "zzzqqq乱码";
            let got = classify(&face, garbage, &[]);
            eprintln!(
                "{file}: 元数据垃圾={} 字形层={:?} 乱码族名下最终={got:?}",
                metadata_is_garbage(&face),
                crate::shape_class::classify_by_shape(&face)
            );
            assert_eq!(got, want, "{file}（族名乱码）该靠元数据/字形判成 {want:?}");
        }
    }

    /// 「元数据明显是垃圾时，字形层的结论要优先于元数据」。
    ///
    /// Sitka / Segoe UI Variable 这几个可变字体的 OS/2 是**全 0**（厂家没填），
    /// 名字里也没有任何关键词 —— 靠元数据只能掉进兜底展示，靠字形才判得出来。
    #[test]
    fn shape_wins_when_metadata_is_all_zeros() {
        let cases = [
            ("SitkaVF.ttf", Classification::Serif),    // Sitka 是衬线家族
            ("SegUIVar.ttf", Classification::Sans),    // Segoe UI Variable 是无衬线
        ];
        for (file, want) in cases {
            let path = Path::new(r"C:\Windows\Fonts").join(file);
            if !path.exists() {
                eprintln!("[skip] 系统字体缺失，跳过：{file}");
                continue;
            }
            let Ok(data) = std::fs::read(&path) else { continue };
            let Ok(face) = ttf_parser::Face::parse(&data, 0) else {
                continue;
            };
            assert!(
                metadata_is_garbage(&face),
                "{file} 的 OS/2 本来就是全 0 —— 这是这条测试的前提"
            );
            eprintln!("{file} 字形层={:?}", crate::shape_class::classify_by_shape(&face));
            assert_eq!(classify(&face, "zzzqqq", &[]), want, "{file} 该靠字形判出来");
        }
    }

    /// 优先级铁律一：西文字体「名字比字形更可信」。手写体的名字（Hand / Script）
    /// 不能被字形层盖掉 —— AcaciasHand 这类手写体既没有衬线也没有笔画对比度，
    /// 几何上一片空白，只看字形会判成无衬线。
    #[test]
    fn western_name_beats_shape() {
        let names = owned_lower(&["AcaciasHand"]);
        assert_eq!(
            resolve_classification(
                false,
                false,
                false,
                &names,
                || None,
                || Some(Classification::Sans)
            ),
            Classification::Script,
            "名字判出手写时不该让字形说话"
        );
        // 元数据是垃圾时也一样：名字仍然优先于字形
        assert_eq!(
            resolve_classification(
                false,
                false,
                true,
                &names,
                || Some(Classification::Serif),
                || Some(Classification::Sans)
            ),
            Classification::Script
        );
    }

    /// 优先级铁律二：元数据全 0 时字形抬头（压过元数据），元数据可信时字形只补位。
    #[test]
    fn garbage_metadata_loses_to_shape_but_good_metadata_does_not() {
        let names = owned_lower(&["zzzqqq"]);
        // 垃圾元数据 + 名字判不出 → 听字形
        assert_eq!(
            resolve_classification(
                false,
                false,
                true,
                &names,
                || Some(Classification::Script),
                || Some(Classification::Sans)
            ),
            Classification::Sans
        );
        // 可信元数据 + 名字判不出 → 听元数据
        assert_eq!(
            resolve_classification(
                false,
                false,
                false,
                &names,
                || Some(Classification::Script),
                || Some(Classification::Sans)
            ),
            Classification::Script
        );
        // 四种信号都没有 → 兜底展示
        assert_eq!(
            resolve_classification(false, false, true, &names, || None, || None),
            Classification::Display
        );
    }

    /// 兜底铁律：再怎么判不出来，也不许产出 `Unknown` —— 筛选菜单里没有这一项，
    /// 留着等于让字体从用户的界面上消失。
    #[test]
    fn classification_never_returns_unknown() {
        let five = [
            Classification::Serif,
            Classification::Sans,
            Classification::Mono,
            Classification::Display,
            Classification::Script,
        ];
        for name in ["zzzqqq", "☃☃☃", "", "###", "字", "12345", "unknown-ish"] {
            for c in [cjk_class(&[name]), west_class(&[name])] {
                assert!(five.contains(&c), "「{name}」判出了 {c:?}");
            }
        }
    }

    /// 连字体都解析不了时（占位字面），文件名是唯一线索 —— 但也不留 Unknown。
    #[test]
    fn broken_fonts_still_get_a_classification_from_the_file_name() {
        let dir = std::env::temp_dir().join(format!("zfm-broken-class-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let hei = dir.join("某字体黑体.ttf");
        std::fs::write(&hei, b"this is not a font").unwrap();
        let odd = dir.join("zzzqqq.ttf");
        std::fs::write(&odd, b"this is not a font").unwrap();

        let faces = parse_font_file(&hei, FontSource::Managed);
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].classification, Classification::Sans, "文件名里的「黑体」要用上");
        assert!(faces[0].incomplete.is_some());

        let faces = parse_font_file(&odd, FontSource::Managed);
        assert_eq!(
            faces[0].classification,
            Classification::Display,
            "判不出也要给展示，不能是 Unknown"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 诊断：把系统字体目录里每个字体的「分类 + 原始元数据」dump 出来，
    /// 用来核对分类规则改动的真实影响面（改规则前后各跑一次对比）。
    /// 跑法：`cargo test --lib dump_system_classification -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_system_classification() {
        let dir = std::env::var("ZFM_DUMP_DIR").unwrap_or_else(|_| r"C:\Windows\Fonts".to_string());
        let mut rows: std::collections::BTreeMap<String, (Classification, String)> =
            std::collections::BTreeMap::new();
        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path().to_path_buf();
            if !path.is_file() || !is_font_file(&path) {
                continue;
            }
            for f in parse_font_file(&path, FontSource::System) {
                {
                    let han = (|| -> Option<String> {
                        let d = std::fs::read(&path).ok()?;
                        let face = ttf_parser::Face::parse(&d, f.face_index).ok()?;
                        Some(format!("{:?}", han_coverage(&face)))
                    })()
                    .unwrap_or_else(|| "?".to_string());
                    let raw = std::fs::read(&path).ok().and_then(|d| {
                        let face = ttf_parser::Face::parse(&d, 0).ok()?;
                        let os2 = face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2"))?;
                        if os2.len() < 42 {
                            return None;
                        }
                        Some(format!("class={} panose={:?}", os2[30], &os2[32..42]))
                    });
                    rows.insert(
                        f.family.clone(),
                        (
                            f.classification,
                            format!("{} {}", han, raw.unwrap_or_default()),
                        ),
                    );
                }
            }
        }
        let mut tally: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for (family, (c, raw)) in &rows {
            println!("{:?}\t{family}\t{raw}", c);
            *tally.entry(format!("{c:?}")).or_default() += 1;
        }
        println!("---- 合计 {} 条 ----", rows.len());
        for (k, v) in tally {
            println!("{k}\t{v}");
        }
    }

    /// `classify` 重写**之前**的实现（照抄 git HEAD 版），只给下面的新旧对比用。
    /// 生产代码里不要再调用它 —— 它把「中文字体的 OS/2 / PANOSE 垃圾数据」当真值。
    fn classify_legacy(face: &ttf_parser::Face, family: &str) -> Classification {
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

    fn os2_probe(face: &ttf_parser::Face) -> String {
        match face.raw_face().table(ttf_parser::Tag::from_bytes(b"OS/2")) {
            Some(os2) if os2.len() >= 42 => {
                format!("class={} panose={:?}", os2[30], &os2[32..42])
            }
            _ => "no-os2".to_string(),
        }
    }

    /// 诊断：对**整个字体库**跑「旧规则 vs 新规则」分类对比，量化重写影响面。
    ///
    /// 这是修「筛选选衬线却出现无衬线」时的核对工具 —— 光靠系统字体那十几个样本
    /// 看不出 4211 族的真实分布，必须全库跑。
    ///
    /// 跑法：
    /// ```bash
    /// ZFM_DIFF_DIR="E:\...\字体库" cargo test --lib diff_classification_library -- --ignored --nocapture
    /// ```
    /// 输出全部是 TSV，`face-change` 行是逐字面差异，`family-change` 行是**族级**差异
    /// （族级才是用户筛选时看到的：旧前端「第一个非 unknown 说了算」vs 新「代表字面说了算」）。
    #[test]
    #[ignore]
    fn diff_classification_library() {
        use std::collections::BTreeMap;
        let Ok(dir) = std::env::var("ZFM_DIFF_DIR") else {
            eprintln!("[skip] 没设 ZFM_DIFF_DIR");
            return;
        };
        // family → [(style, old, new, file)]
        let mut by_family: BTreeMap<String, Vec<(String, Classification, Classification, String)>> =
            BTreeMap::new();
        // (old, new) → 次数
        let mut moved: BTreeMap<(String, String), usize> = BTreeMap::new();
        let mut old_tally: BTreeMap<String, usize> = BTreeMap::new();
        let mut new_tally: BTreeMap<String, usize> = BTreeMap::new();
        let mut files = 0usize;
        let mut faces_seen = 0usize;

        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.into_path();
            if !path.is_file() || !is_font_file(&path) {
                continue;
            }
            files += 1;
            let Ok(data) = std::fs::read(&path) else { continue };
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            for f in parse_font_file(&path, FontSource::Managed) {
                let Ok(face) = ttf_parser::Face::parse(&data, f.face_index) else {
                    continue;
                };
                faces_seen += 1;
                let old = classify_legacy(&face, &f.family);
                let new = f.classification;
                *old_tally.entry(format!("{old:?}")).or_default() += 1;
                *new_tally.entry(format!("{new:?}")).or_default() += 1;
                if old != new {
                    let mut names = vec![f.family.to_lowercase()];
                    names.extend(
                        localized_family_names(&face)
                            .into_iter()
                            .map(|l| l.name.to_lowercase()),
                    );
                    println!(
                        "face-change\t{:?}\t{:?}\t{}\t{}\t{}\t{}{}",
                        old,
                        new,
                        f.family,
                        f.style,
                        file_name,
                        os2_probe(&face),
                        if is_cjk_font(&face, &names) {
                            " cjk=yes"
                        } else {
                            " cjk=no"
                        }
                    );
                }
                by_family.entry(f.family.clone()).or_default().push((
                    f.style.clone(),
                    old,
                    new,
                    file_name.clone(),
                ));
                *moved.entry((format!("{old:?}"), format!("{new:?}"))).or_default() += 1;
            }
        }

        // 族级：旧 = 碰见第一个非 unknown 就定（旧 computeFamilies）；新 = 代表字面（Regular 优先）
        // 代表字面自己判不出来时退「多数派」——与 src/lib/familyState.ts::familyClassification 同口径
        let mut family_changed = 0usize;
        let mut family_total = 0usize;
        for (family, list) in &by_family {
            family_total += 1;
            let old_family = list
                .iter()
                .map(|(_, o, _, _)| *o)
                .find(|c| *c != Classification::Unknown)
                .unwrap_or(Classification::Unknown);
            let lead = list
                .iter()
                .find(|(style, _, _, _)| style.eq_ignore_ascii_case("Regular"))
                .or_else(|| list.first())
                .map(|(_, _, n, _)| *n)
                .unwrap_or(Classification::Unknown);
            let new_family = if lead != Classification::Unknown {
                lead
            } else {
                let mut tally: BTreeMap<String, (Classification, usize)> = BTreeMap::new();
                for (_, _, n, _) in list {
                    if *n == Classification::Unknown {
                        continue;
                    }
                    let e = tally.entry(format!("{n:?}")).or_insert((*n, 0));
                    e.1 += 1;
                }
                tally
                    .values()
                    .max_by_key(|(_, c)| *c)
                    .map(|(c, _)| *c)
                    .unwrap_or(Classification::Unknown)
            };
            if old_family != new_family {
                family_changed += 1;
                println!(
                    "family-change\t{:?}\t{:?}\t{}\t{}",
                    old_family,
                    new_family,
                    family,
                    list.first().map(|(_, _, _, f)| f.as_str()).unwrap_or("")
                );
            }
        }

        println!("---- 文件 {files} / 字面 {faces_seen} / 族 {family_total} ----");
        println!("---- 族级变化 {family_changed} 个 ----");
        println!("old-dist\tnew-dist\tcount");
        for (k, v) in &old_tally {
            println!("{k}\t-\t{v}");
        }
        for (k, v) in &new_tally {
            println!("-\t{k}\t{v}");
        }
        println!("moves\told\tnew\tcount");
        let mut moves: Vec<_> = moved.into_iter().collect();
        moves.sort_by(|a, b| b.1.cmp(&a.1));
        for ((o, n), c) in moves {
            println!("move\t{o}\t{n}\t{c}");
        }
    }

    /// 分类结果 → 前端字面量（与 `Classification` 的 `serde(rename_all = "lowercase")` 一致）。
    fn class_key(c: Classification) -> &'static str {
        match c {
            Classification::Serif => "serif",
            Classification::Sans => "sans",
            Classification::Mono => "mono",
            Classification::Display => "display",
            Classification::Script => "script",
            Classification::Unknown => "unknown",
        }
    }

    /// 量化工具：把**真实字体库**的分类结果 dump 成 TSV，用来做规则改动的前后对比。
    ///
    /// 只看字面级分布不够 —— 筛选菜单里用户看到的是「族」，所以族级分布也一起打出来。
    /// 另外还会打出**字形层**的统计：多少字面能靠几何判出来、多少给不出结论（后者
    /// 最后进兜底展示，是已知且可接受的），以及字形层的耗时（这一层每个字体都要
    /// 解析 4 个字形，必须确认没有把扫描拖慢）。
    ///
    /// 跑法：
    /// ```bash
    /// ZFM_LIBRARY="E:\...\字体库" ZFM_OUT=classes-after.tsv \
    ///   cargo test --lib dump_library_classes -- --ignored --nocapture
    /// ```
    /// - `ZFM_LIBRARY`：字体库目录；没设或不存在就跳过（`eprintln!` 说明原因）
    /// - `ZFM_OUT`：输出文件，默认 `classes.tsv`，每行 `族名\t分类\t路径`
    #[test]
    #[ignore]
    fn dump_library_classes() {
        let Ok(dir) = std::env::var("ZFM_LIBRARY") else {
            eprintln!(r#"[skip] 没设 ZFM_LIBRARY（字体库目录），例如 ZFM_LIBRARY="E:\字体库""#);
            return;
        };
        let root = Path::new(&dir);
        if !root.is_dir() {
            eprintln!("[skip] ZFM_LIBRARY 不是目录：{dir}");
            return;
        }
        let out = std::env::var("ZFM_OUT").unwrap_or_else(|_| "classes.tsv".to_string());

        let mut rows: Vec<(String, Classification, String)> = Vec::new();
        // 字形层统计（族名 → 字形层结论），只收前若干个样本供人眼核对
        let mut shape_tally: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        let mut shape_none_samples: Vec<(String, Classification)> = Vec::new();
        let mut shape_cost = std::time::Duration::ZERO;
        let started = std::time::Instant::now();
        let mut files = 0usize;
        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path().to_path_buf();
            if !path.is_file() || !is_font_file(&path) {
                continue;
            }
            files += 1;
            let data = std::fs::read(&path).ok();
            for f in parse_font_file(&path, FontSource::Managed) {
                rows.push((f.family.clone(), f.classification, f.path.clone()));
                let Some(data) = data.as_deref() else { continue };
                let Ok(face) = ttf_parser::Face::parse(data, f.face_index) else {
                    continue;
                };
                let t0 = std::time::Instant::now();
                let shaped = crate::shape_class::classify_by_shape(&face);
                shape_cost += t0.elapsed();
                let key = match shaped {
                    Some(c) => format!("{:?}", c),
                    None => "无结论".to_string(),
                };
                *shape_tally.entry(key).or_default() += 1;
                if shaped.is_none() && shape_none_samples.len() < 20 {
                    shape_none_samples.push((f.family.clone(), f.classification));
                }
            }
        }
        let elapsed = started.elapsed();
        rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));

        let mut face_tally: std::collections::BTreeMap<&'static str, usize> =
            std::collections::BTreeMap::new();
        let mut body = String::with_capacity(rows.len() * 96);
        for (family, class, path) in &rows {
            *face_tally.entry(class_key(*class)).or_default() += 1;
            body.push_str(family);
            body.push('\t');
            body.push_str(class_key(*class));
            body.push('\t');
            body.push_str(path);
            body.push('\n');
        }

        // 族级分布：同一族的多个字面取第一个（与前端 familyClassification 同口径的简化版）
        let mut families: std::collections::BTreeMap<&str, Classification> =
            std::collections::BTreeMap::new();
        for (family, class, _) in &rows {
            families.entry(family.as_str()).or_insert(*class);
        }
        let mut family_tally: std::collections::BTreeMap<&'static str, usize> =
            std::collections::BTreeMap::new();
        for class in families.values() {
            *family_tally.entry(class_key(*class)).or_default() += 1;
        }

        match std::fs::write(&out, body) {
            Ok(()) => println!(
                "已导出 {} 个字面 / {} 个族（来自 {files} 个文件）-> {out}",
                rows.len(),
                families.len()
            ),
            Err(e) => eprintln!("[dump] 写 {out} 失败：{e}"),
        }
        println!("字面级分布：{face_tally:?}");
        println!("族级分布：{family_tally:?}");
        println!("字形层结论分布：{shape_tally:?}");
        println!(
            "字形层耗时：{:.2?} 总计 / {} 个字面 = {:.3?} 每个（整轮 {:.2?}）",
            shape_cost,
            rows.len(),
            shape_cost / rows.len().max(1) as u32,
            elapsed
        );
        println!("字形层「无结论」样例（族名 / 最终分类）：");
        for (family, class) in &shape_none_samples {
            println!("  {family}\t{}", class_key(*class));
        }
    }

    /// 量化：字形层给扫描加了多少钱。
    ///
    /// 同一批 `Face` 上跑两遍分类：一遍走完整链路（含字形层），一遍**跳过字形层**
    /// （等价于第一阶段的链路）。文件读取与字体解析都在计时之外，只比分类本身。
    ///
    /// 跑法：`ZFM_LIBRARY="E:\...\字体库" cargo test --lib bench_classify_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_classify_cost() {
        let Ok(dir) = std::env::var("ZFM_LIBRARY") else {
            eprintln!("[skip] 没设 ZFM_LIBRARY");
            return;
        };
        let root = Path::new(&dir);
        if !root.is_dir() {
            eprintln!("[skip] ZFM_LIBRARY 不是目录：{dir}");
            return;
        }
        let (mut with_shape, mut without_shape) = (
            std::time::Duration::ZERO,
            std::time::Duration::ZERO,
        );
        let mut faces = 0usize;
        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path().to_path_buf();
            if !path.is_file() || !is_font_file(&path) {
                continue;
            }
            let Ok(data) = std::fs::read(&path) else { continue };
            let Ok(probe) = ttf_parser::Face::parse(&data, 0) else {
                continue;
            };
            let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(8);
            for idx in 0..count {
                let Ok(face) = ttf_parser::Face::parse(&data, idx) else {
                    continue;
                };
                let names = normalized_names("zzzqqq", &[]);
                let cjk = is_cjk_font(&face, &names);
                let garbage = metadata_is_garbage(&face);
                let mono = face.is_monospaced();
                let t0 = std::time::Instant::now();
                let a = resolve_classification(
                    cjk,
                    mono,
                    garbage,
                    &names,
                    || classify_by_metadata(&probe, cjk, &names),
                    || crate::shape_class::classify_by_shape(&face),
                );
                with_shape += t0.elapsed();
                let t0 = std::time::Instant::now();
                let b = resolve_classification(
                    cjk,
                    mono,
                    garbage,
                    &names,
                    || classify_by_metadata(&probe, cjk, &names),
                    || None,
                );
                without_shape += t0.elapsed();
                let _ = (a, b);
                faces += 1;
            }
        }
        println!(
            "{faces} 个字面：含字形层 {with_shape:.2?} / 不含 {without_shape:.2?} \
             → 增量 {:.2?}（{:.0} µs/字面）",
            with_shape.saturating_sub(without_shape),
            (with_shape.saturating_sub(without_shape).as_secs_f64() * 1e6) / faces.max(1) as f64
        );
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

    /// 老字体的 name 表编码五花八门，标注还经常是错的（2026-11-07 实测 105 个字体
    /// 全被收进「未识别字体」桶，字体本身都是好的）。这四个用例就是那批里的代表。

    #[test]
    fn gbk_name_record_is_decoded() {
        // 长城美黑体：唯一的中文名记录标成 (3,3) PRC/GBK
        let bytes = [0xb3, 0xa4, 0xb3, 0xc7, 0xc3, 0xc0, 0xba, 0xda, 0xcc, 0xe5];
        assert_eq!(decode_name(3, 3, &bytes).as_deref(), Some("长城美黑体"));
    }

    #[test]
    fn mislabeled_shift_jis_record_recovers_as_utf16() {
        // 日本雅艺体：标注 Shift-JIS，内容其实是 UCS-2。按标注解会得到半角片假名垃圾串。
        let bytes = [
            0x00, 0x43, 0x00, 0x52, 0xff, 0x23, 0xff, 0x06, 0xff, 0x27, 0x30, 0xd6, 0x30, 0xfc,
            0x30, 0xb1,
        ];
        assert_eq!(decode_name(3, 2, &bytes).as_deref(), Some("CRＣ＆Ｇブーケ"));
    }

    #[test]
    fn big5_codepoints_stored_as_unicode_are_recovered() {
        // 中国龙豪隶书：把 Big5 码值当 Unicode 码位存（¤¤°êÀs»¨Áõ®Ñ），要压回字节再解。
        let bytes = [
            0x00, 0xa4, 0x00, 0xa4, 0x00, 0xb0, 0x00, 0xea, 0x00, 0xc0, 0x00, 0x73, 0x00, 0xbb,
            0x00, 0xa8, 0x00, 0xc1, 0x00, 0xf5, 0x00, 0xae, 0x00, 0xd1,
        ];
        assert_eq!(decode_name(3, 4, &bytes).as_deref(), Some("中國龍豪隸書"));
    }

    #[test]
    fn style_suffix_collapses_only_on_hyphen() {
        // 老英文体把字重写进族名 → 归并回本族，否则一个系列拆成十几个目录
        assert_eq!(collapse_style_suffix("Barmeno-Bold"), Some("Barmeno"));
        assert_eq!(
            collapse_style_suffix("ATNadianne-BoldCondensed"),
            Some("ATNadianne")
        );
        assert_eq!(
            collapse_style_suffix("AutographScriptEF-LightExtra"),
            Some("AutographScriptEF")
        );
        // 空格形式通常是独立字族，不能动
        assert_eq!(collapse_style_suffix("Arial Black"), None);
        // 语言/字重后缀是真族名的一部分，不能吃掉
        assert_eq!(collapse_style_suffix("Source Han Serif SC"), None);
        assert_eq!(collapse_style_suffix("Source-Han-Serif"), None);
        assert_eq!(collapse_style_suffix("Noto-Sans-CJK"), None);
    }
}
