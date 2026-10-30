//! 版权分类：把版权信息分为 商用免费 / 个人免费 / 收费 / 限时 / 未知 五类。
//!
//! 「免费」原来只有一个格子，但免费字体里「可以商用」和「只准个人用」差别巨大
//! （后者拿去接单会侵权），所以拆成 FreeCommercial（商用免费）与 FreePersonal（个人免费）。
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
    /// 商用免费：允许商业使用（OFL / Apache / MIT / 公有领域 / 明确写「可商用」）
    FreeCommercial,
    /// 个人免费：免费，但授权只覆盖个人 / 非商业用途
    FreePersonal,
    Paid,
    Timelimited,
    Unknown,
}

impl CopyrightClass {
    pub fn as_str(self) -> &'static str {
        match self {
            CopyrightClass::FreeCommercial => "free_commercial",
            CopyrightClass::FreePersonal => "free_personal",
            CopyrightClass::Paid => "paid",
            CopyrightClass::Timelimited => "timelimited",
            CopyrightClass::Unknown => "unknown",
        }
    }
}

/// 许可证身份级证据：这些是**按条文本身**就允许商用的开源/自由许可证。
/// 只有命中这一类才敢下「商用免费」的结论 —— 命中它就是确定的，不是猜的。
const OPEN_LICENSE_MARKERS: &[&str] = &[
    "sil open font license",
    "open font license",
    "apache license",
    "mit license",
    "bsd license",
    "bsd 2-clause",
    "bsd 3-clause",
    "mozilla public license",
    "isc license",
    "zlib license",
    "wtfpl",
    "public domain",
    "cc0",
    "unlicense",
    "ubuntu font licence",
    "ubuntu font license",
    "gnu general public license",
    "arphic public license",
    "ipa font license",
];

/// 需要词边界匹配的短标记（避免 "soflow" 命中 "ofl"、"logo" 命中 "gpl"）。
/// bool = 允许后面紧跟版本号数字（GPL2 / OFL1.1）
const OPEN_WORD_MARKERS: &[(&str, bool)] = &[("ofl", true), ("gpl", true), ("cc by", false)];

/// 英文里「明确允许商用」的说法：`free for commercial or non-commercial use` 这种
/// 必须**先于** non-commercial 判定，否则「可以商用」会被当成「不许商用」。
const OPEN_EXPLICIT_EN: &[&str] = &[
    "free for commercial",
    "commercial use is free",
    "commercial use: free",
    "free for any commercial",
];

/// 中文「可商用」类声明。比「免费」强得多，但仍然不是许可证身份，
/// 放在收费判定之后（「不可商用」里含「可商用」）。
///
/// **2026-10-30 起改为严格整词**：关键词必须完整连续出现，拆开一律不算
/// （「免费商」不算、「免费」两个字也不算；「不可商用」不能因为含「可商用」被判成免费）。
/// 用户原话：「每个词都不可拆分开来」。
const OPEN_EXPLICIT_MARKERS: &[&str] = &[
    "免费商用",
    "商用免费",
    "免费可商用",
    "可免费商用",
];

/// 会被否定词吃掉的「可商用」类整词：只有前面**不是**否定字才算数。
/// 「不可商用 / 非可商用 / 禁止可商用」属于收费口径，不能算免费。
const OPEN_EXPLICIT_GUARDED: &[&str] = &["可商用", "允许商用", "商用授权免费"];

/// 否定前缀：出现在关键词正前方时，这个关键词作废
const NEG_PREFIX: &[char] = &['不', '非', '无', '免', '未', '勿', '禁', '非'];

/// 明确写着「个人免费」的表述（严格整词，2026-10-30 起不再接受拆字写法）。
const PERSONAL_MARKERS: &[&str] = &[
    "个人免费",
    "免费供个人",
    "个人版免费",
    "个人使用免费",
    "免费个人使用",
];

/// 「个人免费、商用要另买授权」里的**英文**写法 → 判个人免费。
///
/// 中文的「不可商用 / 禁止商用 / 非商业使用」**不在**这里：
/// 用户 2026-10-30 明确把它们归到收费类（见 `PAID_EXACT`）。
const PERSONAL_ONLY_MARKERS: &[&str] = &[
    "personal use only",
    "for personal use only",
    "personal use: free",
    "personal use is free",
    "non-commercial",
    "noncommercial",
    "not for commercial",
    "仅限个人",
    "仅供个人",
];

/// 收费关键词（严格整词，2026-10-30 用户给定）：
/// 非免费字体 / 非商业字体 / 商用需授权 / 不可商用 这一类的都算付费字体。
/// 匹配必须是**完整连续**的字符串，拆开或只命中一部分都不算。
const PAID_EXACT: &[&str] = &[
    "非免费字体",
    "非免费",
    "非商业字体",
    "非商业",
    "商用需授权",
    "商用需要授权",
    "商用需购买授权",
    "不可商用",
    "禁止商用",
    // 「企业授权」系（2026-10-30 用户口径）：出现这些字样说明商用要另买授权，
    // 绝不能因为别处写了「商用免费」就把整段判成商用免费。
    // 注意顺序无关：判定是「包含即命中」，「企业授权方案」也会被「企业授权」命中。
    "企业授权方案",
    "企业需授权",
    "企业授权",
    "收费",
    "付费",
];

/// 会被「无需 / 不需 / 免费」否定的收费词（「无需授权」不是要钱）
const PAID_GUARDED: &[&str] = &["购买授权", "购买商业授权", "需授权", "商用授权"];

/// 英文的收费 / 试用表述（这些不存在拆字歧义，保持原样）
const PAID_MARKERS_EN: &[&str] = &[
    "purchase a license",
    "purchase license",
    "requires a license",
    "buy the commercial license",
    "commercial license required",
    "evaluation only",
    "evaluation purposes",
    "trial version",
    "demo version",
    "shareware",
    "试用版",
    "演示版",
];

/// 有时间限制的许可特征串（小写）：限时字体、限时授权等
const TIME_MARKERS: &[&str] = &[
    "time limited",
    "time-limited",
    "timelimited",
    "subscription",
    "试用",
    "限时",
    "限时授权",
];

/// 弱线索：出现只能说明「可能免费」，**不足以判定能不能商用**。
/// 以前这些直接算「商用免费」——「免费」两个字就敢说可商用，正是误判的主要来源。
const WEAK_OPEN_CLUES: &[&str] = &[
    "免费",
    "free",
    "开源",
    "open source",
    "freely available",
    "免费下载",
];

/// 弱限制线索：「不许改 / 不许转发 / 保留所有权利」讲的是**分发**，不是能不能商用。
/// 以前这些被判成收费，其实是冤枉（很多免费字体都这么写）。
const WEAK_RESTRICTED_CLUES: &[&str] = &[
    "may not be modified",
    "may not be redistributed",
    "not be sold",
    "all rights reserved",
];

/// 与「开源许可证身份」直接冲突的硬表述：出现说明这份文本同时在讲收费，
/// 那就不能拿许可证身份下结论了。
const HARD_CONFLICT: &[&str] = &[
    "purchase a license",
    "requires a license",
    "购买授权",
    "需授权",
    "商用需授权",
    "不可商用",
    "禁止商用",
    "非免费",
    "非商业",
    "trial version",
    "demo version",
    "evaluation only",
    "收费",
    "付费",
];

fn has_any(t: &str, markers: &'static [&'static str]) -> Option<&'static str> {
    markers
        .iter()
        .find(|m| t.contains(*m))
        .map(|m| *m)
}

/// 整词命中 + **否定前缀**检查：关键词必须完整连续出现，而且它正前方不能紧挨否定字。
///
/// 这是「不可商用」与「可商用」的分界线：前者是收费关键词，后者才是免费声明。
/// 只看 `contains` 会让「不可商用」误判成「可商用」——正是用户报的那类误判。
fn guarded_hit(hay: &str, keys: &'static [&'static str], deny: &[char]) -> Option<&'static str> {
    for k in keys {
        let mut from = 0usize;
        while let Some(rel) = hay[from..].find(k) {
            let i = from + rel;
            let prev = hay[..i].chars().next_back();
            if !prev.is_some_and(|c| deny.contains(&c)) {
                return Some(k);
            }
            // 跳过这一处继续找（同一个词可能出现多次，有被否定的也有不被否定的）
            from = i + k.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }
    None
}

/// 词边界匹配：前后都不能是 ASCII 字母，避免长单词里的子串误命中。
/// `allow_trailing_digit` 让 "GPL2" / "GPLv3" / "OFL1.1" 这种带版本号的写法也算。
fn contains_word(hay: &str, word: &str, allow_trailing_digit: bool) -> bool {
    let bytes = hay.as_bytes();
    let w = word.as_bytes();
    if w.is_empty() || bytes.len() < w.len() {
        return false;
    }
    for i in 0..=bytes.len() - w.len() {
        if &bytes[i..i + w.len()] != w {
            continue;
        }
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphabetic();
        if before_ok && boundary_ok(&bytes[i + w.len()..], allow_trailing_digit) {
            return true;
        }
    }
    false
}

fn boundary_ok(rest: &[u8], allow_digit: bool) -> bool {
    match rest.first().copied() {
        None => true,
        Some(c) if c.is_ascii_digit() => allow_digit,
        Some(c) if c.is_ascii_alphabetic() => {
            // 版本号写法：GPLv3 / OFLv1.1
            if !allow_digit || (c != b'v' && c != b'V') {
                return false;
            }
            match rest.get(1).copied() {
                None => true,
                Some(d) => !d.is_ascii_alphabetic(),
            }
        }
        // 标点、空格、中文等一律视为边界
        _ => true,
    }
}

fn open_word_hit(t: &str) -> Option<&'static str> {
    OPEN_WORD_MARKERS
        .iter()
        .find(|(w, digit)| contains_word(t, w, *digit))
        .map(|(w, _)| *w)
}

/// 许可证 URL → 分类。name 表没写许可证正文时，官方 URL 是仅次于正文的硬证据。
pub fn classify_url(url: Option<&str>) -> Option<CopyrightClass> {
    let u = url?.to_lowercase();
    let u = u.trim();
    if u.is_empty() {
        return None;
    }
    if u.contains("scripts.sil.org/ofl") || u.contains("openfontlicense.org") {
        return Some(CopyrightClass::FreeCommercial);
    }
    if u.contains("apache.org/licenses") {
        return Some(CopyrightClass::FreeCommercial);
    }
    if u.contains("creativecommons.org/publicdomain/zero") {
        return Some(CopyrightClass::FreeCommercial);
    }
    if u.contains("ubuntu.com/licence") || u.contains("ubuntu.com/license") {
        return Some(CopyrightClass::FreeCommercial);
    }
    if u.contains("gnu.org/licenses") || u.contains("gnu.org/copyleft") {
        return Some(CopyrightClass::FreeCommercial);
    }
    if u.contains("opensource.org/license") {
        return Some(CopyrightClass::FreeCommercial);
    }
    None
}

/// 正文优先、URL 兜底：正文说清了就以正文为准（更具体），正文判不出来才看官方许可证链接。
#[allow(dead_code)]
pub fn classify_with_url(text: Option<&str>, url: Option<&str>) -> CopyrightClass {
    let from_text = classify(text);
    if from_text != CopyrightClass::Unknown {
        return from_text;
    }
    classify_url(url).unwrap_or(CopyrightClass::Unknown)
}

/// 这段文本里能看出什么线索（用于告诉用户「为什么判不出来」）。
/// 返回形如 "提到「免费」，但没写能不能商用" 的说明。
pub fn clue(text: Option<&str>) -> Option<&'static str> {
    let t = text?.to_lowercase();
    if has_any(&t, WEAK_RESTRICTED_CLUES).is_some() && has_any(&t, WEAK_OPEN_CLUES).is_some() {
        return Some("clueMixed");
    }
    if has_any(&t, WEAK_OPEN_CLUES).is_some() {
        return Some("clueFree");
    }
    if has_any(&t, WEAK_RESTRICTED_CLUES).is_some() {
        return Some("clueRestricted");
    }
    None
}

/// 判定依据：到底是哪一条证据下的结论。要写进备注给用户核对原文，
/// 所以这里的文案要能直接读——「只写了免费，没写能不能商用」比「unknown」有用得多。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// 开源许可证身份（OFL / Apache / GPL…）
    License(&'static str),
    /// name 表里的许可证链接（正文判不出来时的兜底）
    LicenseUrl,
    /// 明确写了可商用
    ExplicitCommercial(&'static str),
    /// 明确写了个人免费
    Personal(&'static str),
    /// 个人使用免费、商用需另购授权
    PersonalOnly(&'static str),
    /// 明确写了收费 / 受限 / 试用
    Paid(&'static str),
    /// 限时授权
    Timelimited(&'static str),
    /// 许可证身份与收费要求互相矛盾
    Conflict(String, String),
    /// 文件夹名里的标注（「X（商用免费）」）
    FolderNote(&'static str),
    /// 只提到免费
    ClueFree,
    /// 只写了保留权利 / 禁止转发
    ClueRestricted,
    /// 免费与限制条款混在一起
    ClueMixed,
    /// 什么都没找到
    Nothing,
}

impl Reason {
    pub fn label(&self) -> String {
        match self {
            Reason::License(m) => format!("开源许可证（{m}）"),
            Reason::LicenseUrl => "name 表里的许可证链接".to_string(),
            Reason::ExplicitCommercial(m) => format!("明确写了「{m}」"),
            Reason::Personal(m) => format!("明确写了「{m}」"),
            Reason::PersonalOnly(m) => format!("写明个人使用免费、商用需另购授权「{m}」"),
            Reason::Paid(m) => format!("限制条款「{m}」"),
            Reason::Timelimited(m) => format!("限时条款「{m}」"),
            // a / b 已经是「依据」的文案，这里只要说清谁和谁打架
            Reason::Conflict(a, b) => format!("两份证据互相矛盾（{a}｜{b}）"),
            Reason::FolderNote(s) => format!("文件夹名标注「{s}」"),
            Reason::ClueFree => "只写了免费，没写能不能商用".to_string(),
            Reason::ClueRestricted => "只写了保留权利 / 禁止转发，没说要收费".to_string(),
            Reason::ClueMixed => "免费和限制条款混在一起".to_string(),
            Reason::Nothing => "没有找到任何授权信息".to_string(),
        }
    }
}

/// 判定口径（2026-10-30 第 5 版，改口径记得把 `NOTE_RULES_VERSION` +1）。
///
/// **关键词一律严格整词**：必须完整连续出现，拆开 / 只命中一半都不算。
/// 顺序：
///   ① 许可证身份（OFL / Apache / MIT / GPL / CC0 / UFL…）→ 商用免费；
///      但同一段文本里还写着「不可商用 / 要买授权 / 收费」就不判（证据互相打架）
///   ② 免费商用关键词（免费商用 / 商用免费 / 免费可商用 / 可商用…）→ 商用免费
///   ③ **明确标注「个人免费」** → 个人免费（即使同时写了「商用需授权 / 不可商用」）
///   ④ 收费关键词（非免费 / 非商业 / 商用需授权 / 不可商用 / 收费 / 付费…）→ 收费
///   ⑤ 限时；⑥ 只写「免费」等弱线索 → 未知
///
/// ③ 必须先于 ④：用户 2026-10-30 定「能不能算个人免费，只看有没有明确标注个人免费，
/// 没标注的一律算收费」。而 ② 又先于 ③：「免费商用」是更强的结论。
/// 否定前缀检查兜一层（「无需授权」不是收费，「不可商用」不是可商用）。
pub fn explain(text: Option<&str>) -> (CopyrightClass, Reason) {
    let Some(text) = text else {
        return (CopyrightClass::Unknown, Reason::Nothing);
    };
    let t = text.to_lowercase();

    // ① 许可证身份
    if let Some(m) = has_any(&t, OPEN_LICENSE_MARKERS).or_else(|| open_word_hit(&t)) {
        if let Some(hit) = has_any(&t, HARD_CONFLICT) {
            // 同一份文本既给开源许可又要求付费 → 不猜
            return (
                CopyrightClass::Unknown,
                Reason::Conflict(m.to_string(), hit.to_string()),
            );
        }
        return (CopyrightClass::FreeCommercial, Reason::License(m));
    }
    // ①b 英文明确允许商用（"free for commercial or non-commercial use" 属于允许商用）
    if let Some(m) = has_any(&t, OPEN_EXPLICIT_EN) {
        return (CopyrightClass::FreeCommercial, Reason::ExplicitCommercial(m));
    }
    // ② 免费商用（严格整词；「可商用」要被否定前缀检查拦住）
    //    放在最前面：明确写了「免费商用」就是最干净的结论
    if let Some(m) = has_any(&t, OPEN_EXPLICIT_MARKERS)
        .or_else(|| guarded_hit(&t, OPEN_EXPLICIT_GUARDED, NEG_PREFIX))
    {
        return (CopyrightClass::FreeCommercial, Reason::ExplicitCommercial(m));
    }
    // ③ 明确写了「个人免费」→ 个人免费（即使同时说「商用需授权 / 不可商用」）
    //    用户 2026-10-30 口径：能不能算个人免费，**只看有没有明确标注个人免费**；
    //    没标注的一律算收费。所以这一步必须先于收费关键词。
    if let Some(m) = has_any(&t, PERSONAL_MARKERS) {
        return (CopyrightClass::FreePersonal, Reason::Personal(m));
    }
    // ③b 英文的「personal use only / non-commercial」同理
    if let Some(m) = has_any(&t, PERSONAL_ONLY_MARKERS) {
        return (CopyrightClass::FreePersonal, Reason::PersonalOnly(m));
    }
    // ④ 收费关键词（严格整词 + 否定前缀保护）：
    //    没写「个人免费」又出现「不可商用 / 禁止商用 / 商用需授权 / 非免费」→ 收费
    if let Some(m) = has_any(&t, PAID_EXACT)
        .or_else(|| guarded_hit(&t, PAID_GUARDED, NEG_PREFIX))
        .or_else(|| has_any(&t, PAID_MARKERS_EN))
    {
        return (CopyrightClass::Paid, Reason::Paid(m));
    }
    // ⑤ 限时
    if let Some(m) = has_any(&t, TIME_MARKERS) {
        return (CopyrightClass::Timelimited, Reason::Timelimited(m));
    }
    match clue(Some(text)) {
        Some("clueMixed") => (CopyrightClass::Unknown, Reason::ClueMixed),
        Some("clueFree") => (CopyrightClass::Unknown, Reason::ClueFree),
        Some("clueRestricted") => (CopyrightClass::Unknown, Reason::ClueRestricted),
        _ => (CopyrightClass::Unknown, Reason::Nothing),
    }
}

/// 判定口径的版本号。口径一变，旧的自动备注（「判定依据：…」）就作废、按新口径重写；
/// 用户自己写的备注永远不动。加规则 / 改分类时记得 +1。
/// v4：中文关键词改严格整词、把「不可商用 / 商用需授权 / 非免费 / 非商业」归到收费（2026-10-30）。
/// v5：只有**明确标注「个人免费」**才判个人免费，没标注的一律收费（2026-10-30 用户口径）。
/// v6：「企业授权方案 / 企业需授权 / 企业授权」加入收费关键词；文件夹名后缀与
///     文件名里的「商用需授权 / 企业授权」矛盾时不再采纳后缀（字魂 7 目录的教训）。
pub const NOTE_RULES_VERSION: u32 = 6;

pub fn classify(text: Option<&str>) -> CopyrightClass {
    explain(text).0
}

/// 按句子切分（备注里引用的「那一段」就是这里切出来的一句）
///
/// 两档粒度：`sentences_strong` 不切英文句点，网址和 "SIL Open Font License 1.1"
/// 就不会被切成 `org/OFL` 这种碎片；只有粗粒度找不到证据时，才退到按 `.` 细分。
fn sentences_strong(text: &str) -> Vec<&str> {
    text.split(|c: char| matches!(c, '\n' | '\r' | '。' | '；' | ';' | '！' | '!' | '？' | '?'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

fn sentences(text: &str) -> Vec<&str> {
    text.split(|c: char| {
        matches!(c, '\n' | '\r' | '。' | '；' | ';' | '！' | '!' | '？' | '?' | '.')
    })
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .collect()
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 找出支撑结论的那一句原文：逐句单独判定，能得出同样结论、且最短的那句。
/// 判不出来（只写了免费之类）就找含弱线索的那句。
fn find_quote(text: &str, class: CopyrightClass, reason: &Reason) -> Option<String> {
    // 先按「不切英文句点」的粗粒度找，找不到再细分
    pick_quote(&sentences_strong(text), class, reason)
        .or_else(|| pick_quote(&sentences(text), class, reason))
}

fn pick_quote(candidates: &[&str], class: CopyrightClass, reason: &Reason) -> Option<String> {
    let mut best: Option<&str> = None;
    for s in candidates.iter().copied() {
        let n = s.chars().count();
        if !(4..=400).contains(&n) {
            continue;
        }
        let hit = match reason {
            Reason::License(_)
            | Reason::ExplicitCommercial(_)
            | Reason::Personal(_)
            | Reason::PersonalOnly(_)
            | Reason::Paid(_)
            | Reason::Timelimited(_) => explain(Some(s)).0 == class,
            Reason::Conflict(a, b) => {
                let low = s.to_lowercase();
                low.contains(a.as_str()) || low.contains(b.as_str())
            }
            _ => clue(Some(s)).is_some(),
        };
        if !hit {
            continue;
        }
        if best.is_none_or(|b| n < b.chars().count()) {
            best = Some(s);
        }
    }
    best.map(|s| truncate_chars(s, 140))
}

/// 前端「版权状态」下拉里的值 → 版权分类；auto / 无法识别时返回 None（表示按来源重新判定）
pub fn class_from_status(status: &str) -> Option<CopyrightClass> {
    match status.trim().to_lowercase().as_str() {
        // "free" 是旧版存下来的值：那时候免费不分商用/个人，按「商用免费」处理，
        // 用户可以在详情面板里改成「个人免费」（我们不会替他把权限调窄）。
        "free" | "free_commercial" | "freecommercial" | "commercial" => {
            Some(CopyrightClass::FreeCommercial)
        }
        "free_personal" | "freepersonal" | "personal" => Some(CopyrightClass::FreePersonal),
        "paid" => Some(CopyrightClass::Paid),
        "timelimited" | "time_limited" | "timeLimited" => Some(CopyrightClass::Timelimited),
        "unknown" => Some(CopyrightClass::Unknown),
        _ => None,
    }
}

fn suffix(class: CopyrightClass) -> &'static str {
    match class {
        CopyrightClass::FreeCommercial => "商用免费",
        CopyrightClass::FreePersonal => "个人免费",
        CopyrightClass::Paid => "收费字体",
        CopyrightClass::Timelimited => "限时字体",
        CopyrightClass::Unknown => "未知版权",
    }
}

/// 字库里专门放「损坏 / 不完整」字体的目录名。
/// 用户 2026-10-30 要求：导入时坏掉的字体不能跟正常字族混在一起，单独归到这个目录下。
pub const INCOMPLETE_DIR: &str = "非完整字体";

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
        CopyrightClass::FreeCommercial,
        CopyrightClass::FreePersonal,
        CopyrightClass::Paid,
        CopyrightClass::Timelimited,
        CopyrightClass::Unknown,
    ] {
        if name.contains(&format!("（{}）", suffix(class))) {
            return Some(class);
        }
    }
    // 旧版本只分「免费」，历史目录名是「（免费字体）」：按商用免费读回来，
    // 不然升级之后一整片老目录会突然变「未知版权」。
    if name.contains("（免费字体）") {
        return Some(CopyrightClass::FreeCommercial);
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
///
/// 编码兜底：授权说明很多是 UTF-16（记事本另存为）或 GBK（国内字体包常见）。
/// 原来只认 UTF-8，读不出来就直接放弃 → 白白丢掉证据。现在：
/// UTF-8 → UTF-16(BOM) → UTF-8 lossy（GBK 里的 ASCII 标记照样能认出来）。
fn decode_text(buf: &[u8]) -> String {
    if buf.len() >= 2 {
        let le = buf[0] == 0xFF && buf[1] == 0xFE;
        let be = buf[0] == 0xFE && buf[1] == 0xFF;
        if le || be {
            let body = &buf[2..];
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| {
                    if le {
                        u16::from_le_bytes([c[0], c[1]])
                    } else {
                        u16::from_be_bytes([c[0], c[1]])
                    }
                })
                .collect();
            if !units.is_empty() {
                return String::from_utf16_lossy(&units);
            }
        }
    }
    match std::str::from_utf8(buf) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(buf).into_owned(),
    }
}

fn read_snippet(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.by_ref().take(limit as u64).read_to_end(&mut buf).ok()?;
    if buf.is_empty() {
        return None;
    }
    Some(decode_text(&buf))
}

/// 一条「带原文的判定」：结论 + 依据 + 引用的那句话 + 出处（文件名 / 文件夹名 / name 表）
struct Verdict {
    class: CopyrightClass,
    reason: Reason,
    quote: Option<String>,
    source: String,
}

fn class_label(class: CopyrightClass) -> &'static str {
    match class {
        CopyrightClass::FreeCommercial => "商用免费",
        CopyrightClass::FreePersonal => "个人免费",
        CopyrightClass::Paid => "收费",
        CopyrightClass::Timelimited => "限时免费",
        CopyrightClass::Unknown => "未知版权",
    }
}

/// 备注正文：授权渠道原文 + 判定依据（依据里必须带「那一段原文」和出处，
/// 用户能直接在软件里核对，不用去翻文件夹）。
fn compose_note(channels: Option<&str>, v: &Verdict) -> Option<String> {
    if channels.is_none() && v.quote.is_none() && v.reason == Reason::Nothing {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(ch) = channels {
        lines.push(format!("授权原文：{ch}"));
    }
    let mut line = format!("判定依据：{}（{}）", class_label(v.class), v.reason.label());
    if let Some(q) = &v.quote {
        line.push_str(&format!("｜原文「{q}」"));
    }
    if !v.source.is_empty() {
        line.push_str(&format!("｜来源：{}", v.source));
    }
    lines.push(line);
    let note = lines.join("\n");
    Some(truncate_chars(&note, 400))
}

/// 有结论就返回（含冲突）；全是未知就返回 None，让调用方继续往下找证据。
fn decide(verdicts: &[Verdict], channels: Option<&str>) -> Option<DirCopyright> {
    let mut classes: Vec<CopyrightClass> = Vec::new();
    for v in verdicts {
        if v.class != CopyrightClass::Unknown && !classes.contains(&v.class) {
            classes.push(v.class);
        }
    }
    match classes.len() {
        0 => None,
        1 => {
            let want = classes[0];
            // 优先挑有原文的那条，备注才有得看
            let v = verdicts
                .iter()
                .find(|v| v.class == want && v.quote.is_some())
                .or_else(|| verdicts.iter().find(|v| v.class == want))?;
            Some(DirCopyright {
                class: want,
                note: compose_note(channels, v),
            })
        }
        _ => {
            let a = verdicts.iter().find(|v| v.class == classes[0])?;
            let b = verdicts.iter().find(|v| v.class == classes[1])?;
            crate::diag::log(&format!(
                "copyright: 证据互相矛盾 {:?} / {:?} → 判未知",
                classes[0], classes[1]
            ));
            let conflict = Verdict {
                class: CopyrightClass::Unknown,
                // 直接把两边「依据」的文案当矛盾说明，用户一眼看出谁和谁冲突
                reason: Reason::Conflict(a.reason.label(), b.reason.label()),
                quote: a.quote.clone().or_else(|| b.quote.clone()),
                source: format!("{} + {}", a.source, b.source),
            };
            Some(DirCopyright {
                class: CopyrightClass::Unknown,
                note: compose_note(channels, &conflict),
            })
        }
    }
}

/// 没结论时，至少把「为什么判不出来」的那句原文留在备注里
fn trail_of(verdicts: &[Verdict], channels: Option<&str>) -> Option<String> {
    let v = verdicts.iter().find(|v| v.quote.is_some())?;
    compose_note(channels, v)
}

/// 渠道词：用户真正关心的「能不能用在某个场景」
const CHANNEL_WORDS: &[&str] = &[
    "公众号", "订阅号", "服务号", "微信", "微博", "抖音", "快手", "小红书", "哔哩", "b站",
    "视频", "直播", "电商", "淘宝", "天猫", "京东", "拼多多", "网店", "实体店",
    "印刷", "出版", "书刊", "杂志", "海报", "包装", "封面", "标题",
    "logo", "标志", "商标", "品牌", "vi", "包装设计",
    "游戏", "app", "客户端", "网站", "网页", "小程序", "h5", "ppt", "课件",
    "自媒体", "广告", "影视", "短视频", "接单", "外包", "嵌入", "转载", "销售", "售卖",
];

/// 授权口吻的词（和渠道词必须挨得够近才算「在讲这个渠道能不能用」）
const PERMISSION_WORDS: &[&str] = &[
    "可", "可用", "允许", "禁止", "不得", "不可", "仅限", "需", "必须", "不能", "免费",
    "收费", "授权", "严禁", "勿", "支持", "规定",
];

/// 使用范围总述（「个人和企业都可以免费商用」这类）
const SCOPE_WORDS: &[&str] = &["个人", "企业", "公司", "设计师", "用户", "甲方"];
const SCOPE_TARGETS: &[&str] = &["商用", "商业"];

/// 渠道词与授权词的最大间隔（字符）。取 6 是为了滤掉
/// 「可以帮忙点一下猫啃网上的广告」这种顺带提到渠道的句子。
const CHANNEL_WINDOW: usize = 6;

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

fn contains_cjk(s: &str) -> bool {
    s.chars().any(is_cjk)
}

/// 渠道词附近（±6 字）有没有授权口吻的词
fn channel_with_permission(lower: &str) -> bool {
    let chars: Vec<char> = lower.chars().collect();
    for ch in CHANNEL_WORDS {
        let needle: Vec<char> = ch.chars().collect();
        if needle.is_empty() || needle.len() > chars.len() {
            continue;
        }
        for i in 0..=chars.len() - needle.len() {
            if chars[i..i + needle.len()] != needle[..] {
                continue;
            }
            let from = i.saturating_sub(CHANNEL_WINDOW);
            let to = (i + needle.len() + CHANNEL_WINDOW).min(chars.len());
            let window: String = chars[from..to].iter().collect();
            if PERMISSION_WORDS.iter().any(|w| window.contains(w)) {
                return true;
            }
        }
    }
    false
}

fn is_usage_clause(clause: &str) -> bool {
    let lower = clause.to_lowercase();
    if channel_with_permission(&lower) {
        return true;
    }
    // 「个人 / 企业 …… 可 / 免费 …… 商用」
    SCOPE_WORDS.iter().any(|w| clause.contains(w))
        && SCOPE_TARGETS.iter().any(|w| clause.contains(w))
        && PERMISSION_WORDS.iter().any(|w| clause.contains(w))
}

/// 从授权原文里摘出「哪些渠道能 / 不能商用」的原句，用于写进详情面板的备注。
///
/// 只摘**原话**，不改写、不总结：判不出来就返回 None（备注留空）。
/// 英文许可证（OFL/Apache…）不含中文渠道说明，直接跳过，不会往备注里灌许可证全文。
pub fn usage_note(text: &str) -> Option<String> {
    const MAX_CLAUSES: usize = 3;
    const MAX_CHARS: usize = 200;
    let mut picked: Vec<String> = Vec::new();
    for raw in text.split(['\n', '\r', '。', '；', ';', '！', '!', '？', '?']) {
        let clause = raw
            .trim_matches(|c: char| {
                c.is_whitespace() || matches!(c, '·' | '-' | '—' | '*' | '#' | '>' | '|' | '　')
            })
            .trim();
        let n = clause.chars().count();
        if !(4..=160).contains(&n) || !contains_cjk(clause) || !is_usage_clause(clause) {
            continue;
        }
        let owned = clause.to_string();
        if !picked.contains(&owned) {
            picked.push(owned);
        }
        if picked.len() >= MAX_CLAUSES {
            break;
        }
    }
    if picked.is_empty() {
        return None;
    }
    // 返回的是裸文本（不带「授权原文：」前缀），前缀由 compose_note 统一加
    let mut note = String::new();
    for (i, c) in picked.iter().enumerate() {
        if i > 0 {
            note.push('；');
        }
        note.push_str(c);
        if note.chars().count() >= MAX_CHARS {
            break;
        }
    }
    // 按字符截断，别切出半个汉字
    if note.chars().count() > MAX_CHARS + 20 {
        note = note.chars().take(MAX_CHARS + 20).collect();
        note.push('…');
    }
    Some(note)
}

/// 目录里的授权文档 → 备注文本（第一个有货的文件说了算）
#[allow(dead_code)]
pub fn usage_note_dir(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut texts: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && crate::installer::is_info_file(p))
        .collect();
    texts.sort();
    for p in texts {
        // 纯 PDF 读不出来，跳过
        if p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            continue;
        }
        if let Some(text) = read_snippet(&p, 64 * 1024) {
            if let Some(note) = usage_note(&text) {
                return Some(note);
            }
        }
    }
    None
}

/// 一个目录的版权判定结果 + 要写进备注的留痕文本
#[derive(Clone)]
pub struct DirCopyright {
    pub class: CopyrightClass,
    /// 「授权原文」+「判定依据（含那一段原文和出处）」；没证据时为 None
    pub note: Option<String>,
}

/// 目录 → 版权分类 + 判定留痕，按「版权信息文件 > 文件夹备注 > 字体自带信息」三级权重。
///
/// 每一级内部都做冲突检测：两份授权文件说法不同 → 判未知，并把两条原文都留在备注里。
pub fn inspect_dir(dir: &Path) -> DirCopyright {
    inspect_dir_impl(dir, true)
}

/// 扫描时用这个：目录里的 name 表证据**不算数**（一个平铺目录里塞几千个字体时，
/// 拿别的字体的授权去判整个目录会把整目录染成同一个结论）。
pub fn inspect_dir_files_only(dir: &Path) -> DirCopyright {
    inspect_dir_impl(dir, false)
}


/// 目录里的文件名是否带着「商用需授权 / 企业授权」这类字样。
///
/// 这些字样是分发站标注的「商用要另买授权」。字库里有 7 个「字魂」目录，
/// 旧版判定把后缀写成了「（商用免费）」，与文件名自带的「(商用需授权)」直接矛盾
/// （用户 2026-10-30：这类字样**绝不能**归类为商用免费）。矛盾时不再采纳文件夹名，
/// 让后面的证据（版权文档 / name 表）说话。
fn dir_files_say_commercial_restricted(dir: &Path) -> bool {
    const MARKERS: [&str; 4] = ["商用需授权", "企业授权方案", "企业需授权", "企业授权"];
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
        .any(|name| MARKERS.iter().any(|m| name.contains(m)))
}

fn inspect_dir_impl(dir: &Path, include_name_table: bool) -> DirCopyright {
    let mut verdicts: Vec<Verdict> = Vec::new();
    let mut channels: Option<String> = None;

    // 1. 版权信息文件（LICENSE / OFL / 版权说明…）
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut texts: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && crate::installer::is_info_file(p))
            .collect();
        texts.sort();
        for p in texts {
            // 纯 PDF 读不出文字，跳过（不再白读一遍）
            if p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
            {
                continue;
            }
            let Some(text) = read_snippet(&p, 64 * 1024) else {
                continue;
            };
            if channels.is_none() {
                channels = usage_note(&text);
            }
            let (class, reason) = explain(Some(&text));
            let quote = find_quote(&text, class, &reason);
            let source = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("授权文件")
                .to_string();
            verdicts.push(Verdict {
                class,
                reason,
                quote,
                source,
            });
        }
    }
    if let Some(done) = decide(&verdicts, channels.as_deref()) {
        return done;
    }

    // 2. 文件夹名里备注的版权（我们自己的「（商用免费）」后缀最权威）
    //    但文件名带「商用需授权 / 企业授权」时，后缀的「商用免费」不可信 —— 直接跳过这一级
    let folder_says_free_commercial = dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|name| {
            suffix_class(name) == Some(CopyrightClass::FreeCommercial)
                || explain(Some(name)).0 == CopyrightClass::FreeCommercial
        })
        .unwrap_or(false);
    let folder_distrusted = folder_says_free_commercial && dir_files_say_commercial_restricted(dir);
    if let Some(name) = dir.file_name().and_then(|n| n.to_str()).filter(|_| !folder_distrusted) {
        let verdict = match suffix_class(name) {
            Some(class) => Verdict {
                class,
                reason: Reason::FolderNote(suffix(class)),
                quote: Some(truncate_chars(name, 120)),
                source: "文件夹名".to_string(),
            },
            None => {
                let (class, reason) = explain(Some(name));
                let quote = find_quote(name, class, &reason);
                Verdict {
                    class,
                    reason,
                    quote,
                    source: "文件夹名".to_string(),
                }
            }
        };
        let conclusive = verdict.class != CopyrightClass::Unknown;
        verdicts.push(verdict);
        if conclusive {
            if let Some(done) = decide(&verdicts, channels.as_deref()) {
                return done;
            }
        }
    }

    // 3. 字体自带的版权信息（name 表 13 / 0，正文判不出来时看 14 的许可证链接）
    //    平铺目录里这一步会串味，扫描时关掉、改成逐字面判定（inspect_face）
    if include_name_table {
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
                // 正文
                let (class, reason) = explain(f.license.as_deref());
                if class != CopyrightClass::Unknown {
                    let quote = f
                        .license
                        .as_deref()
                        .and_then(|t| find_quote(t, class, &reason));
                    verdicts.push(Verdict {
                        class,
                        reason,
                        quote,
                        source: "字体信息（name 表 13）".to_string(),
                    });
                    continue;
                }
                // 许可证链接兜底
                if let Some(url_class) = classify_url(f.license_url.as_deref()) {
                    verdicts.push(Verdict {
                        class: url_class,
                        reason: Reason::LicenseUrl,
                        quote: f.license_url.clone(),
                        source: "字体信息（name 表 14）".to_string(),
                    });
                    continue;
                }
                // 版权声明
                let (class, reason) = explain(f.copyright.as_deref());
                if class != CopyrightClass::Unknown {
                    let quote = f
                        .copyright
                        .as_deref()
                        .and_then(|t| find_quote(t, class, &reason));
                    verdicts.push(Verdict {
                        class,
                        reason,
                        quote,
                        source: "字体信息（name 表 0）".to_string(),
                    });
                }
            }
        }
        if let Some(done) = decide(&verdicts, channels.as_deref()) {
            return done;
        }
    }
    }

    // 没有任何结论：至少把「为什么判不出来」的那句原文留下
    DirCopyright {
        class: CopyrightClass::Unknown,
        note: trail_of(&verdicts, channels.as_deref()),
    }
}

/// 只要分类（改名、安装时用）
pub fn classify_dir(dir: &Path) -> CopyrightClass {
    inspect_dir(dir).class
}

/// 单个字面的 name 表证据 → (分类, 备注留痕)。
///
/// 目录里没有授权文件时用它兜底：只引用**这个字族自己**的 name 表原文
/// （目录级判定在平铺目录里会串味，见 `inspect_dir_files_only`）。
pub fn inspect_face(
    license: Option<&str>,
    license_url: Option<&str>,
    copyright: Option<&str>,
) -> (CopyrightClass, Option<String>) {
    let (class, reason) = explain(license);
    if class != CopyrightClass::Unknown {
        let quote = license.and_then(|t| find_quote(t, class, &reason));
        let v = Verdict {
            class,
            reason,
            quote,
            source: "字体信息（name 表 13）".to_string(),
        };
        return (class, compose_note(None, &v));
    }
    if let Some(url_class) = classify_url(license_url) {
        let v = Verdict {
            class: url_class,
            reason: Reason::LicenseUrl,
            quote: license_url.map(str::to_string),
            source: "字体信息（name 表 14）".to_string(),
        };
        return (url_class, compose_note(None, &v));
    }
    let (class, reason) = explain(copyright);
    let quote = copyright.and_then(|t| find_quote(t, class, &reason));
    let v = Verdict {
        class,
        reason,
        quote,
        source: "字体信息（name 表 0）".to_string(),
    };
    (class, compose_note(None, &v))
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
        assert_eq!(
            classify(Some("This Font is licensed under the SIL Open Font License")),
            CopyrightClass::FreeCommercial
        );
        assert_eq!(classify(Some("OFL.txt")), CopyrightClass::FreeCommercial);
        // 2026-10-30 口径：明确写了「个人使用」→ 个人免费（哪怕同时说要买商用授权）
        assert_eq!(
            classify(Some("Free for personal use only. Commercial license required.")),
            CopyrightClass::FreePersonal
        );
        assert_eq!(
            classify(Some("仅供个人使用，商用请购买授权")),
            CopyrightClass::FreePersonal
        );
        assert_eq!(classify(Some("不可商用")), CopyrightClass::Paid);
        assert_eq!(classify(Some("收费字体，购买授权后使用")), CopyrightClass::Paid);
        assert_eq!(classify(Some("免费商用，可商用")), CopyrightClass::FreeCommercial);
        assert_eq!(classify(Some("个人免费")), CopyrightClass::FreePersonal);
        // 英文写明了 personal use → 个人免费
        assert_eq!(
            classify(Some("Personal use: FREE. Commercial use: buy the commercial license.")),
            CopyrightClass::FreePersonal
        );
        assert_eq!(
            classify(Some("Personal use only, may not be redistributed")),
            CopyrightClass::FreePersonal
        );
        assert_eq!(classify(Some("Some custom text")), CopyrightClass::Unknown);
        assert_eq!(classify(None), CopyrightClass::Unknown);
    }

    /// 用户 2026-10-30 的核心要求：关键词必须**整词连续**出现，拆开一律不算
    #[test]
    fn keywords_must_match_whole_phrase() {
        // 「免费商用」四个字必须连着出现
        assert_eq!(classify(Some("免费商用")), CopyrightClass::FreeCommercial);
        assert_eq!(classify(Some("免费商")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("免费")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("商用")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("免费 商用")), CopyrightClass::Unknown);
        // 「个人免费」同理
        assert_eq!(classify(Some("个人免费")), CopyrightClass::FreePersonal);
        assert_eq!(classify(Some("个人")), CopyrightClass::Unknown);
        // 收费关键词也是整词
        assert_eq!(classify(Some("非免费字体")), CopyrightClass::Paid);
        assert_eq!(classify(Some("非免费")), CopyrightClass::Paid);
        assert_eq!(classify(Some("非商业字体")), CopyrightClass::Paid);
        assert_eq!(classify(Some("商用需授权")), CopyrightClass::Paid);
        assert_eq!(classify(Some("不可商用")), CopyrightClass::Paid);
        // 「不可商用」不能因为含「可商用」被判成免费
        assert_eq!(classify(Some("本字体不可商用")), CopyrightClass::Paid);
        // 但「可商用」本身仍然是免费声明（前置不是否定字）
        assert_eq!(classify(Some("可商用")), CopyrightClass::FreeCommercial);
        assert_eq!(classify(Some("允许商用")), CopyrightClass::FreeCommercial);
        // 「无需授权」讲的是不用买授权，不是收费
        assert_eq!(classify(Some("个人使用无需授权")), CopyrightClass::Unknown);
    }

    /// 保守口径的核心：证据不够就不下结论（误判比未知更糟）
    #[test]
    fn weak_evidence_stays_unknown() {
        // 只写「免费」，没说能不能商用 → 不判（旧版会判成商用免费）
        assert_eq!(classify(Some("免费下载，欢迎分享")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("This font is free.")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("Freely available from our site")), CopyrightClass::Unknown);
        // 只写「保留所有权利 / 不许转发」讲的是分发，不等于要收费
        assert_eq!(
            classify(Some("All rights reserved. May not be redistributed.")),
            CopyrightClass::Unknown
        );
        // 只写了「免费」+ 禁止商用 → 收费（2026-10-30 口径：「禁止商用」是收费关键词）
        assert_eq!(
            classify(Some("本字体免费，禁止商用")),
            CopyrightClass::Paid
        );
        // 只写了「免费」，但写清了可以商用 → 商用免费
        assert_eq!(classify(Some("完全免费，可商用")), CopyrightClass::FreeCommercial);
    }

    /// 2026-10-30 最终口径：**只有明确标注「个人免费」才算个人免费**，
    /// 没标注的只要出现「不可商用 / 禁止商用 / 商用需授权 / 非免费 / 非商业」一律收费。
    #[test]
    fn personal_free_requires_explicit_label() {
        // 明确标注了个人免费 → 个人免费（即便同一句里说要买商用授权）
        for text in [
            "个人免费，商用需授权",
            "本字体个人免费，但不可商用",
            "个人免费下载，禁止商用",
            "免费供个人学习使用，商用需另购授权",
            "仅供个人使用，商用请购买授权",
            "Personal use: FREE. Commercial use: buy the commercial license.",
            "Free for personal use only. Commercial license required.",
        ] {
            assert_eq!(
                classify(Some(text)),
                CopyrightClass::FreePersonal,
                "should be personal: {text}"
            );
        }
        // 没写「个人免费」→ 一律收费
        for text in [
            "不可商用",
            "本字体不可商用",
            "禁止商用",
            "商用需授权",
            "该字体为非商业字体",
            "非免费字体",
            "收费字体，购买授权后使用",
            "Trial version, evaluation only",
        ] {
            assert_eq!(
                classify(Some(text)),
                CopyrightClass::Paid,
                "should be paid: {text}"
            );
        }
    }


    /// 「free for commercial or non-commercial use」是允许商用，别被 non-commercial 带偏
    #[test]
    fn explicit_commercial_grant_beats_noncommercial_word() {
        assert_eq!(
            classify(Some(
                "This font is freeware. Free for commercial or non-commercial use."
            )),
            CopyrightClass::FreeCommercial
        );
        assert_eq!(
            classify(Some("Free for commercial use. Attribution appreciated.")),
            CopyrightClass::FreeCommercial
        );
        // 中文「不可商用」是收费关键词，仍然不能翻车
        assert_eq!(classify(Some("不可商用")), CopyrightClass::Paid);
    }

    #[test]
    fn short_markers_need_word_boundary() {
        // "Soflow" 里的 ofl、"logo" 里的 gpl 都不算许可证
        assert_eq!(classify(Some("Soflow Sans Display")), CopyrightClass::Unknown);
        assert_eq!(classify(Some("The logo font")), CopyrightClass::Unknown);
        // 真正的短写要认：OFL / GPL2
        assert_eq!(classify(Some("License: OFL")), CopyrightClass::FreeCommercial);
        assert_eq!(
            classify(Some("GPL2 with font embedding exception")),
            CopyrightClass::FreeCommercial
        );
        assert_eq!(classify(Some("License: GPLv3")), CopyrightClass::FreeCommercial);
    }

    #[test]
    fn contradictory_text_is_not_guessed() {
        // 同一段里既给开源许可又要买授权 → 两个都不信
        assert_eq!(
            classify(Some(
                "Licensed under the SIL Open Font License. Purchase a license for commercial use."
            )),
            CopyrightClass::Unknown
        );
    }

    #[test]
    fn license_url_counts_as_evidence() {
        assert_eq!(
            classify_with_url(None, Some("http://scripts.sil.org/OFL")),
            CopyrightClass::FreeCommercial
        );
        assert_eq!(
            classify_with_url(None, Some("https://www.apache.org/licenses/LICENSE-2.0")),
            CopyrightClass::FreeCommercial
        );
        // 认不出的 URL 不能当证据
        assert_eq!(
            classify_with_url(None, Some("https://example.com/license")),
            CopyrightClass::Unknown
        );
        // 正文优先：正文判出了结论就不看 URL
        assert_eq!(
            classify_with_url(Some("仅供个人使用"), Some("http://scripts.sil.org/OFL")),
            CopyrightClass::FreePersonal
        );
        // 正文判不出来（只说「免费」）→ 官方 URL 兜底
        assert_eq!(
            classify_with_url(Some("免费下载"), Some("http://scripts.sil.org/OFL")),
            CopyrightClass::FreeCommercial
        );
    }

    #[test]
    fn clues_explain_why_unknown() {
        assert_eq!(clue(Some("免费下载")), Some("clueFree"));
        assert_eq!(clue(Some("All rights reserved")), Some("clueRestricted"));
        assert_eq!(clue(Some("完全无关的说明")), None);
    }

    /// 备注里的「授权原文」：只摘渠道相关原句，客套话/许可全文不能进来
    #[test]
    fn extracts_channel_clauses_verbatim() {
        let text = "此款字体无论是个人还是企业都可以免费商用。\
                    可用于公众号、电商详情页，禁止用于商标注册。\
                    如果您觉得不错，可以帮忙点一下网站上的广告哦。";
        let note = usage_note(text).expect("should extract");
        assert!(note.contains("个人还是企业都可以免费商用"));
        assert!(note.contains("公众号"));
        assert!(note.contains("商标注册"));
        // 顺带提到渠道的客套话不该被摘进来
        assert!(!note.contains("点一下"));
    }

    #[test]
    fn no_note_without_channel_evidence() {
        assert!(usage_note("SIL Open Font License 1.1").is_none());
        assert!(usage_note("Copyright 2020 Some Foundry. All rights reserved.").is_none());
        // 只提到渠道但没有授权口吻
        assert!(usage_note("感谢公众号「某某设计」的推荐").is_none());
    }

    /// 目录版：同目录的授权说明文件能被读出来（含 GBK 编码的老文档）
    #[test]
    fn reads_usage_note_from_dir() {
        let dir = std::env::temp_dir().join("zfm-usage-note-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("字体授权说明.txt"),
            "本字体可用于公众号、电商详情页，禁止用于商标注册。",
        )
        .unwrap();
        let note = usage_note_dir(&dir).expect("should read note");
        assert!(note.contains("公众号"), "{note}");
        assert!(note.contains("商标注册"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「企业授权」系是收费关键词（2026-10-30 用户口径）；
    /// 但同一段里写明「免费商用 / 个人免费」的，仍按明确结论算。
    #[test]
    fn enterprise_license_words_are_paid() {
        for text in [
            "字魂字库-企业授权方案",
            "企业授权请联系客服",
            "企业需授权后使用",
            "本字体商用需授权",
        ] {
            assert_eq!(classify(Some(text)), CopyrightClass::Paid, "should be paid: {text}");
        }
        assert_eq!(
            classify(Some("本字体免费商用，企业授权请咨询")),
            CopyrightClass::FreeCommercial,
            "明确写了免费商用，不被「企业授权」拖累"
        );
        assert_eq!(
            classify(Some("个人免费，商用需授权")),
            CopyrightClass::FreePersonal
        );
    }

    /// 文件夹后缀说「商用免费」，但目录里的文件名带「商用需授权 / 企业授权」时，
    /// 后缀不可信（字魂 7 目录的教训）——不能判成商用免费。
    #[test]
    fn folder_suffix_distrusted_when_file_names_contradict() {
        let dir = std::env::temp_dir().join("zfm-suffix-conflict");
        let _ = std::fs::remove_dir_all(&dir);
        let bad = dir.join("zihuntest（商用免费）");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("字魂测试(商用需授权) #字体# .ttf"), b"fake").unwrap();
        assert_eq!(
            inspect_dir_files_only(&bad).class,
            CopyrightClass::Unknown,
            "矛盾时不能采纳「（商用免费）」后缀"
        );

        // 对照组：没有矛盾文件名的目录，后缀照常生效
        let good = dir.join("zihuntest2（商用免费）");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("SomeFont.ttf"), b"fake").unwrap();
        assert_eq!(
            inspect_dir_files_only(&good).class,
            CopyrightClass::FreeCommercial
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn trail_dir(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zfm-trail-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
        dir
    }

    /// 真机排查用：拿一个真实目录跑一遍，看分类和备注到底算出什么。
    /// `ZFM_TEST_DIR=<目录> cargo test --lib real_dir -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_dir_probe() {
        let Ok(dir) = std::env::var("ZFM_TEST_DIR") else {
            return;
        };
        let found = inspect_dir(std::path::Path::new(&dir));
        println!("class = {}\nnote = {:#?}", found.class.as_str(), found.note);
    }

    /// 备注要留痕：结论 + 依据 + 那一段原文 + 出处
    #[test]
    fn dir_note_records_the_evidence() {
        let dir = trail_dir(
            "paid",
            &[(
                "授权说明.txt",
                "本字体仅供个人使用，商用请购买授权。\n可用于公众号排版。",
            )],
        );
        let r = inspect_dir(&dir);
        // 2026-10-30 口径：写明「仅供个人使用」→ 个人免费
        assert_eq!(r.class, CopyrightClass::FreePersonal);
        let note = r.note.expect("should have note");
        assert!(note.contains("授权原文："), "{note}");
        assert!(note.contains("判定依据：个人免费"), "{note}");
        assert!(note.contains("仅供个人使用"), "{note}");
        assert!(note.contains("授权说明.txt"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 判不出来时也要留痕：写明「只写了免费」并附上那句原文
    #[test]
    fn dir_note_keeps_weak_evidence() {
        let dir = trail_dir(
            "weak",
            &[("说明.txt", "本字体免费下载，欢迎分享。")],
        );
        let r = inspect_dir(&dir);
        assert_eq!(r.class, CopyrightClass::Unknown);
        let note = r.note.expect("should keep trail");
        assert!(note.contains("判定依据：未知版权"), "{note}");
        assert!(note.contains("只写了免费"), "{note}");
        assert!(note.contains("免费下载"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两份授权文件打架 → 判未知，并在备注里说清楚
    #[test]
    fn dir_note_reports_conflict() {
        let dir = trail_dir(
            "conflict",
            &[
                ("OFL.txt", "This Font is licensed under the SIL Open Font License 1.1"),
                ("收费说明.txt", "本字体收费，购买授权后使用。"),
            ],
        );
        let r = inspect_dir(&dir);
        assert_eq!(r.class, CopyrightClass::Unknown);
        let note = r.note.expect("should have note");
        assert!(note.contains("互相矛盾"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 平铺目录不能把别的字体的授权串过来：目录里没有授权文件时，目录级不给结论
    #[test]
    fn flat_dir_does_not_leak_other_fonts_license() {
        let dir = trail_dir("flat", &[]);
        let r = inspect_dir_files_only(&dir);
        assert_eq!(r.class, CopyrightClass::Unknown);
        assert!(r.note.is_none(), "{:?}", r.note);
        // 逐字面才有结论，而且只引用这个字族自己的原文
        let (cls, note) =
            inspect_face(Some("This font is free for personal use only"), None, None);
        assert_eq!(cls, CopyrightClass::FreePersonal);
        let note = note.expect("face note");
        assert!(note.contains("personal use only"), "{note}");
        assert!(note.contains("name 表 13"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 开源许可证要能引用到「那一段」
    #[test]
    fn dir_note_quotes_the_license_line() {
        let dir = trail_dir(
            "o1",
            &[("OFL.txt", "Copyright 2020 X.\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n")],
        );
        let r = inspect_dir(&dir);
        assert_eq!(r.class, CopyrightClass::FreeCommercial);
        let note = r.note.expect("should have note");
        assert!(note.contains("判定依据：商用免费"), "{note}");
        assert!(note.contains("SIL Open Font License"), "{note}");
        assert!(note.contains("OFL.txt"), "{note}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_dir_names() {
        assert_eq!(
            family_dir_name("Lora", CopyrightClass::FreeCommercial),
            "Lora（商用免费）"
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
        assert_eq!(
            class_from_status("free"),
            Some(CopyrightClass::FreeCommercial)
        );
        assert_eq!(
            class_from_status("free_personal"),
            Some(CopyrightClass::FreePersonal)
        );
        assert_eq!(
            class_from_status("free_commercial"),
            Some(CopyrightClass::FreeCommercial)
        );
        assert_eq!(class_from_status("paid"), Some(CopyrightClass::Paid));
        assert_eq!(class_from_status("timelimited"), Some(CopyrightClass::Timelimited));
        assert_eq!(class_from_status("unknown"), Some(CopyrightClass::Unknown));
        // auto / 空值 → 交给来源权重重新判定
        assert_eq!(class_from_status("auto"), None);
    }

    #[test]
    fn reads_folder_notes() {
        assert_eq!(
            classify_folder_name("Lora（商用免费）"),
            CopyrightClass::FreeCommercial
        );
        assert_eq!(
            classify_folder_name("Lora（个人免费）"),
            CopyrightClass::FreePersonal
        );
        // 历史目录名
        assert_eq!(
            classify_folder_name("Lora（免费字体）"),
            CopyrightClass::FreeCommercial
        );
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
