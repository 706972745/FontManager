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
    pub format: FontFormat,
    pub is_variable: bool,
    pub axes: Vec<VariationAxis>,
    pub weight: u16,
    pub italic: bool,
    pub monospaced: bool,
    pub classification: Classification,

    pub scripts: Vec<String>,
    pub features: Vec<String>,
    pub glyph_count: u16,
    pub file_size: u64,
    pub source: FontSource,
    pub deactivatable: bool,
    pub active: bool,
    /// 入库时间（Unix 秒）：安装/在线下载时记录，扫描时合并
    #[serde(default)]
    pub added_at: Option<u64>,
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
