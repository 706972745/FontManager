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

/// 字族分类。**用户 2026-11-01 报「筛选选衬线，结果里还有无衬线」**后的重写。
///
/// 旧逻辑按「is_monospaced → OS/2 class → PANOSE → 英文名关键字」的顺序取第一个
/// 命中的信号，实测（4211 族全库核对 OS/2 / PANOSE 真值）有两类系统性错误：
///
/// 1. **中文字体的 PANOSE / OS/2 class 大量垃圾数据**：SimHei 的 `bProportion=9`
///    被判成等宽、方正黑体的 `sFamilyClass=10`（手写）被判成手写、SimSun 的
///    `bProportion=9` 把宋体判成等宽。中西文混排字体的这两张表基本不可信，
///    唯一可靠的是**名字**（中文优先：「黑体→无衬线、宋体→衬线、楷/隶→手写」），
///    本地化名（宋体 / 黑体）比英文名（SimSun / SimHei）更直接。
/// 2. **西文古典字体的 OS/2 class 与 PANOSE 互相矛盾**：Century Gothic 的
///    class=2（过渡衬线，错）而 PANOSE bSerifStyle=11（无衬线，对）；反例
///    Friz Quadrata 的 class=7（自由衬线，对）而 PANOSE=14。两个信号都无权威，
///    分歧时用**名字里的明确关键字**破平（Gothic / Sans → 无衬线，Serif → 衬线），
///    名字没说就维持 OS/2 class（旧行为，不回归）。
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

fn classify(face: &ttf_parser::Face, family: &str, localized: &[LocalizedName]) -> Classification {
    // 所有可用的名字（族名 + 各语言本地化名）小写化，关键字匹配用
    let names: Vec<String> = std::iter::once(family.to_lowercase())
        .chain(localized.iter().map(|l| l.name.to_lowercase()))
        .collect();
    let has = |kw: &str| names.iter().any(|n| n.contains(kw));

    if is_cjk_font(face, &names) {
        // —— 中文字体：名字优先，元数据兜底 ——
        if has("mono") || has("等宽") || has("等寬") {
            return Classification::Mono;
        }
        if has("黑")
            || has("hei")
            || has("雅黑")
            || has("gothic")
            || has("sans")
            || has("圆")
            || has("圓")
            || has("round")
            // 「等线」是无衬线（Windows 的 DengXian / 汉仪中等线 / 迷你简中等线），
            // 它们的 OS/2 class 常被写成 10（手写），不补这个关键字就会被归到手写里
            || has("等线")
            || has("等線")
        {
            return Classification::Sans;
        }
        if has("楷")
            || has("kai")
            || has("隶")
            || has("隷") // 隶的繁体写法（文鼎CS大隸書 / 日本青柳隷書）
            || has("篆")
            || has("seal")
            || has("行书")
            || has("行書")
            || has("草") // 草书（叶根友疾风草书）
        {
            return Classification::Script;
        }
        if has("宋") || has("song") || has("明") || has("ming") || has("仿") || has("serif") {
            return Classification::Serif;
        }
        // 名字没说：退 OS/2 class，再退 PANOSE 的 bSerifStyle（不用 bProportion）
        if let Some(c) = os2_class(face) {
            return c;
        }
        if let Some(c) = panose_serif_style(face) {
            return c;
        }
        return Classification::Unknown;
    }

    // —— 西文字体：is_monospaced 优先（Courier / Consolas 的 OS/2 class 会写成 8）——
    if face.is_monospaced() {
        return Classification::Mono;
    }
    match (os2_class(face), panose_class(face)) {
        // 两个信号一致，直接用
        (Some(a), Some(b)) if a == b => a,
        // 分歧：名字里有明确关键字就听名字（Century Gothic / GoudySans 的 class 是错的）；
        // 名字没说就维持 OS/2 class（Friz Quadrata 这类 PANOSE 写 14 的真衬线）
        (Some(a), Some(_)) => {
            if has("sans") || has("gothic") {
                Classification::Sans
            } else if has("serif") {
                Classification::Serif
            } else {
                a
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        // 都没有：英文名关键字兜底（原逻辑，补 gothic——日文「 Gothic 」= 无衬线）
        (None, None) => {
            let name = family.to_lowercase();
            if name.contains("mono") {
                Classification::Mono
            } else if name.contains("script") || name.contains("hand") {
                Classification::Script
            } else if name.contains("sans") || name.contains("gothic") {
                Classification::Sans
            } else if name.contains("serif") {
                Classification::Serif
            } else {
                Classification::Unknown
            }
        }
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
    FontFace {
        id: format!("{}#{}", path_str, index),
        path: path_str,
        preview_path: None,
        face_index: index,
        family: fallback_family(path),
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
        classification: Classification::Unknown,
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
            license_note: None,
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
            ("simkai.ttf", Classification::Script), // 楷体
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
