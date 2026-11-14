use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariationAxis {
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontFormat {
    Otf,
    Ttf,
    Woff,
    Woff2,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontSource {
    System,

    User,

    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Classification {
    Serif,
    Sans,
    Mono,
    Display,
    Script,
    Unknown,
}

/// 字体 name 表里的一个本地化字族名（如 en → "Source Han Sans"、zh-Hans → "思源黑体"）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedName {
    /// BCP-47 语言标签（en / zh-Hans / zh-Hant / ja …），识别不出时回退为小写英文语言名
    pub lang: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    pub id: String,
    pub path: String,

    pub preview_path: Option<String>,
    pub face_index: u32,
    pub family: String,
    pub style: String,
    pub postscript_name: Option<String>,
    /// 该字面的所有本地化字族名（用于「复制英文名 / 复制其他语言名」）
    #[serde(default)]
    pub localized_names: Vec<LocalizedName>,
    pub foundry: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub copyright: Option<String>,
    /// 按「版权信息文件 > 文件夹备注 > 字体自带信息」判定的版权分类（free/paid/timelimited/unknown）。
    /// 字体库目录里的字体才有：目录名 / 同目录的版权文件写明的版权，扫描时一并带出来，
    /// 界面上就能显示文件夹备注的版权，而不只是字体 name 表里的那点信息。
    #[serde(default)]
    pub copyright_class: Option<String>,
    /// 从同目录授权文档里摘出的「哪些渠道能 / 不能商用」原话（只摘原句，不改写）。
    /// 扫描后首次见到这个字族时写进备注；用户改过 / 删过就不再写。
    #[serde(default)]
    pub license_note: Option<String>,
    pub format: FontFormat,
    pub is_variable: bool,
    pub axes: Vec<VariationAxis>,
    pub weight: u16,
    pub italic: bool,
    pub monospaced: bool,
    pub classification: Classification,
    /// OS/2 表 `panose`（偏移 32..42）的十字节视觉描述向量。
    ///
    /// **只给派生标签用，不参与一级分类**（分类看 `classification`）。全 0 / 全 1
    /// （Any / No Fit）的向量在解析时就被丢掉 → `None`，前端不需要再判一次。
    /// 中文字体这两个字节基本是模板默认值（sFamilyClass 61.9% 填「拉丁文本」、
    /// bProportion 41.7% 填 9），所以派生规则里对中文另有一套闸门。
    #[serde(default)]
    pub panose: Option<Vec<u8>>,
    /// OS/2 表 `sFamilyClass`（偏移 30）的原始 16 位值：高位 = classId、低位 = subclassId。
    /// 0（未分类）时为 `None`。同样只作派生标签的弱证据，不进分类主链。
    #[serde(default)]
    pub s_family_class: Option<u16>,

    pub scripts: Vec<String>,
    pub features: Vec<String>,
    pub glyph_count: u16,
    /// 损坏 / 不完整：`Some(原因)` 表示这个字面不可用
    /// （解析失败、缺 name 表、0 字形、缺 cmap、文件被截断…）。
    /// 系统字体不标记（动不了也不需要整理）；字库里的字体由导入流程归到「非完整字体」目录。
    #[serde(default)]
    pub incomplete: Option<String>,
    /// `family` 是拿文件名顶上的假族名（字体读不出 name 表 / 未转换的 WOFF）。
    ///
    /// 这不是「损坏」——老中文字体（长城/文鼎那批）name 表是 GBK，字体本身好好的。
    /// 只用来决定**导入时不要拿它建目录**：一个文件一个「族」目录，搬走内容后
    /// 就在库根留下永远没人用的空壳（2026-11-01 清掉 71 个）。
    #[serde(default)]
    pub name_fallback: bool,
    pub file_size: u64,
    pub source: FontSource,
    pub deactivatable: bool,
    pub active: bool,
    /// 入库时间（Unix 秒）：安装/在线下载时记录，扫描时合并
    #[serde(default)]
    pub added_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CharsetStats {
    /// cmap 里可用码位的总数（去掉控制字符、代理区、私用区、重复码位）
    pub total: u32,
    /// 汉字（U+3400–4DBF、4E00–9FFF、F900–FAFF、20000–2FA1F 等区段）
    pub han: u32,
    /// 日文假名（平假名 / 片假名 / 半角片假名）
    pub kana: u32,
    /// 韩文谚文
    pub hangul: u32,
    /// 拉丁字母（含 Latin-1 补充、扩展、越南语附加符）
    pub latin: u32,
    /// 其余：标点、符号、数学、emoji 等
    pub symbols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub original_path: String,
    pub trashed_path: String,
    pub family: String,
    pub trashed_at: u64,
}
