//! 检查更新（1.9.0）。
//!
//! 只做三件事：**读最新版本号 → 和当前版本比 → 把结果告诉界面**。
//! 不下载、不解压、不执行任何远端内容 —— 真正的安装包由用户自己在浏览器里点，
//! 这样即使仓库被投毒也拿不到「静默替换可执行文件」的能力。
//!
//! 两个数据源（都是硬编码常量，不接受任何外部输入拼接）：
//!   ① GitHub Releases API —— 拿到版本号 + 发布说明 + 下载页地址；
//!   ② `raw.githubusercontent.com/.../main/package.json` —— 只拿版本号。
//! 国内网络经常连不上 api.github.com，②走的是 raw 镜像那条路（`net.rs` 里的
//! jsDelivr 轮询这里用不了：本模块是独立客户端，但 raw 域名本身在多数网络下可用），
//! 所以两个都失败才算失败，且失败要说清是哪一步断的。
//!
//! 隐私：请求里只有 UA（带版本号），不带任何本机信息；不开 `updateCheck` 就一次都不发。

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const UA: &str = concat!("FontManager/", env!("CARGO_PKG_VERSION"), " (+https://zsync.eu/fontmanager/)");

const API_URL: &str = "https://api.github.com/repos/706972745/FontManager/releases/latest";
const RAW_PKG_URL: &str = "https://raw.githubusercontent.com/706972745/FontManager/main/package.json";
/// 国内网络经常连不上 raw.githubusercontent.com，jsDelivr 的 GitHub 通道一般可用
/// （和 `net.rs` 给字体文件准备镜像是一个道理）。它只能给版本号，给不了发布说明。
const CDN_PKG_URL: &str = "https://cdn.jsdelivr.net/gh/706972745/FontManager@main/package.json";
const RELEASES_PAGE: &str = "https://github.com/706972745/FontManager/releases/latest";

const TIMEOUT: Duration = Duration::from_secs(12);
/// 进程内缓存：同一轮运行里反复点「检查更新」不重复打接口。
/// GitHub 匿名接口是 60 次/小时/IP，多开几次就会撞限流。
const CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前运行的版本（编译期写死，跟着安装包走）
    pub current: String,
    /// 远端最新版本（去掉前缀 `v`）
    pub latest: String,
    /// 远端比本机新
    pub has_update: bool,
    /// 发布页地址（浏览器打开，不在这里下载）
    pub url: String,
    /// 发布说明（Markdown 原文，截断到 4000 字符，界面按纯文本展示）
    pub notes: String,
    /// 发布时间（ISO 8601 原文；拿不到就是空串）
    pub published_at: String,
    /// `github` = Releases API；`raw` = 只能读到 package.json 的兜底
    pub source: String,
}

/// 版本号解析：`v1.8.10` / `1.8.10-beta.1` / `1.8` 都接受，只取主.次.修订三段。
///
/// 解析不出来就返回 None —— 调用方据此**不提示更新**（宁可少报，不可乱报：
/// 版本号格式变了却硬比大小，会让用户看到「1.10.0 < 1.9.0」这种荒唐提示）。
pub fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let s = raw.trim();
    let s = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or(s);
    let core = s.split(['-', '+']).next()?.trim();
    if core.is_empty() {
        return None;
    }
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

/// 远端是否比本机新。任一侧解析失败一律 false（见 [`parse_version`]）。
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// 允许落地的站点。仓库改名（本项目从 ZFontManager 改成 FontManager 就改过一次）
/// 会让 GitHub 回 301，所以这里跟随**有限次**重定向，但落点必须还在白名单里。
const ALLOWED_HOSTS: [&str; 5] = [
    "api.github.com",
    "raw.githubusercontent.com",
    "cdn.jsdelivr.net",
    "github.com",
    "objects.githubusercontent.com",
];

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        // 最多跟 3 跳（改名场景只需要 1 跳），落点由 `get_json` 再校验一次
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("网络客户端初始化失败：{e}"))
}

fn explain(url: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{url} 连接超时（当前网络可能访问不了 GitHub）")
    } else if e.is_connect() {
        format!("{url} 连不上（当前网络可能访问不了 GitHub）")
    } else {
        format!("{url} 请求失败：{e}")
    }
}

async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let client = client()?;
    let res = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| explain(url, &e))?;
    // 跟随重定向之后必须再看一眼落点：304/301 都可能把请求带到别处
    let host = res.url().host_str().unwrap_or_default().to_string();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("{url} 被重定向到非预期站点：{host}"));
    }
    let status = res.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            403 | 429 => format!("GitHub 接口限流了（HTTP {}），过一会儿再试", status.as_u16()),
            404 => format!("{url} 返回 404：仓库还没有正式发布"),
            code => format!("{url} 返回 HTTP {code}"),
        });
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("{url} 返回的不是有效 JSON：{e}"))
}

/// 发布说明只留前 4000 字符：CHANGELOG 动辄几万字，全量塞进界面只会卡顿。
fn trim_notes(text: &str) -> String {
    const MAX: usize = 4000;
    let mut out = String::new();
    for (i, ch) in text.chars().enumerate() {
        if i >= MAX {
            out.push_str("\n…");
            break;
        }
        out.push(ch);
    }
    out
}

async fn from_release_api() -> Result<UpdateInfo, String> {
    let v = get_json(API_URL).await?;
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "GitHub 返回里没有 tag_name".to_string())?;
    let latest = parse_version(tag)
        .map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .ok_or_else(|| format!("读不懂远端版本号：{tag}"))?;
    let url = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .filter(|s| s.starts_with("https://github.com/"))
        .unwrap_or(RELEASES_PAGE)
        .to_string();
    let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    let published_at = v.get("published_at").and_then(|x| x.as_str()).unwrap_or("");
    Ok(UpdateInfo {
        current: env!("CARGO_PKG_VERSION").to_string(),
        has_update: is_newer(&latest, env!("CARGO_PKG_VERSION")),
        latest,
        url,
        notes: trim_notes(notes),
        published_at: published_at.to_string(),
        source: "github".into(),
    })
}

/// 兜底：API 被墙时只读 package.json 里的版本号（没有发布说明，下载页指向 releases）。
async fn from_package_json(url: &str) -> Result<UpdateInfo, String> {
    let v = get_json(url).await?;
    let raw = v
        .get("version")
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("{url} 里没有 version"))?;
    let latest = parse_version(raw)
        .map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .ok_or_else(|| format!("读不懂远端版本号：{raw}"))?;
    Ok(UpdateInfo {
        current: env!("CARGO_PKG_VERSION").to_string(),
        has_update: is_newer(&latest, env!("CARGO_PKG_VERSION")),
        latest,
        url: RELEASES_PAGE.to_string(),
        notes: String::new(),
        published_at: String::new(),
        source: if url.contains("jsdelivr") { "cdn" } else { "raw" }.into(),
    })
}

fn cache() -> &'static Mutex<Option<(Instant, UpdateInfo)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, UpdateInfo)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 检查更新。`force = false` 时命中 10 分钟缓存直接返回。
pub async fn check(force: bool) -> Result<UpdateInfo, String> {
    if !force {
        if let Ok(guard) = cache().lock() {
            if let Some((at, info)) = guard.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return Ok(info.clone());
                }
            }
        }
    }

    // 三级回退：Releases API（带说明）→ raw 原始文件 → jsDelivr 镜像（只带版本号）。
    // 三条都断才报错，错误信息里把每一步的失败原因串起来，用户截图就能定位。
    let mut errs: Vec<String> = Vec::new();
    match from_release_api().await {
        Ok(info) => return Ok(remember(info)),
        Err(e) => errs.push(e),
    }
    for url in [RAW_PKG_URL, CDN_PKG_URL] {
        match from_package_json(url).await {
            Ok(info) => return Ok(remember(info)),
            Err(e) => errs.push(e),
        }
    }
    Err(errs.join("；备用源也不行："))
}

fn remember(info: UpdateInfo) -> UpdateInfo {
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((Instant::now(), info.clone()));
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("1.8.0"), Some((1, 8, 0)));
        assert_eq!(parse_version("v1.8.0"), Some((1, 8, 0)));
        assert_eq!(parse_version(" 2.0 "), Some((2, 0, 0)));
        assert_eq!(parse_version("1.9.0-beta.2"), Some((1, 9, 0)));
        assert_eq!(parse_version("1.9.0+build7"), Some((1, 9, 0)));
        assert_eq!(parse_version("nightly"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("v"), None);
    }

    #[test]
    fn newer_compare_is_numeric_not_lexicographic() {
        // 字符串比较会把 1.10.0 判成比 1.9.0 旧，这是最典型的坑
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("1.9.0", "1.8.99"));
        assert!(is_newer("v1.8.1", "1.8.0"));
        assert!(!is_newer("1.8.0", "1.8.0"));
        assert!(!is_newer("1.8.0", "1.9.0"));
        assert!(!is_newer("nightly", "1.9.0"));
        assert!(!is_newer("1.9.0", "nightly"));
    }

    #[test]
    fn notes_are_truncated() {
        let long = "a".repeat(5000);
        let out = trim_notes(&long);
        assert!(out.chars().count() <= 4010, "截断后的长度要收住");
        assert!(out.ends_with('…'));
        assert_eq!(trim_notes("short"), "short");
    }

    /// 远端地址必须是写死的 https 常量，不接受任何拼接
    #[test]
    fn endpoints_are_hardcoded_https() {
        assert!(API_URL.starts_with("https://api.github.com/repos/706972745/FontManager/"));
        assert!(RAW_PKG_URL.starts_with("https://raw.githubusercontent.com/706972745/FontManager/"));
        assert!(CDN_PKG_URL.starts_with("https://cdn.jsdelivr.net/gh/706972745/FontManager@"));
        assert!(ALLOWED_HOSTS.contains(&"api.github.com"));
        assert!(!ALLOWED_HOSTS.contains(&"evil.example"));
        assert!(RELEASES_PAGE.starts_with("https://github.com/706972745/FontManager/"));
    }
}
