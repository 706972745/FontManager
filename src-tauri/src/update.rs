//! 检查更新（1.8.1）。
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
use tauri::AppHandle;

const UA: &str = concat!("FontManager/", env!("CARGO_PKG_VERSION"), " (+https://zsync.eu/fontmanager/)");

const API_URL: &str = "https://api.github.com/repos/706972745/FontManager/releases/latest";
const RAW_PKG_URL: &str = "https://raw.githubusercontent.com/706972745/FontManager/main/package.json";
/// 国内网络经常连不上 raw.githubusercontent.com，jsDelivr 的 GitHub 通道一般可用
/// （和 `net.rs` 给字体文件准备镜像是一个道理）。它只能给版本号，给不了发布说明。
const CDN_PKG_URL: &str = "https://cdn.jsdelivr.net/gh/706972745/FontManager@main/package.json";
const RELEASES_PAGE: &str = "https://github.com/706972745/FontManager/releases/latest";

const TIMEOUT: Duration = Duration::from_secs(12);

/// 测试钩子（1.8.7）：设了 `FM_UPDATE_ENDPOINT` 就用它替代 Releases API 地址，
/// `download_setup` 也放行 `http://127.0.0.1/`、`http://localhost/` 的安装包直链。
/// 只为本机端到端测试准备（假端点返回同构 JSON）；正常用户不设这个变量，
/// 行为与原来逐字节一致 —— 白名单、SHA-256、canonicalize 一道都没少。
fn endpoint_override() -> Option<String> {
    std::env::var("FM_UPDATE_ENDPOINT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
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
    /// 发布页地址（浏览器打开）
    pub url: String,
    /// 发布说明（Markdown 原文，截断到 4000 字符，界面按纯文本展示）
    pub notes: String,
    /// 发布时间（ISO 8601 原文；拿不到就是空串）
    pub published_at: String,
    /// `github` = Releases API；`raw` = 只能读到 package.json 的兜底
    pub source: String,
    /// NSIS 安装包直链（拿不到 = 空串，界面退回「打开下载页」）
    pub setup_url: String,
    /// 安装包文件名（落地文件名 + 二次校验用）
    pub setup_name: String,
    /// 安装包 SHA-256（小写十六进制，取自 GitHub Asset 的 `digest`；拿不到 = 空串）
    pub sha256: String,
    /// 安装包 Asset 的数字 id（`api.github.com` asset 直取通道用；拿不到 = 0）
    pub setup_asset_id: u64,
    /// 能不能一键静默安装（直链 + 校验值齐全 + 当前是「按用户安装」的 NSIS 版）
    pub can_auto_install: bool,
    /// 当前这份程序的安装形态：`user`（NSIS 按用户装，换盘符也算）/ `system`（MSI 按系统装）/ `portable`（目录里直接跑的副本）
    pub install_kind: String,
    /// 装不了时**是哪一条**没过（空 = 没有阻塞）。取值见 [`blocker`]。
    /// 1.9.5 起带上这个字段：以前只有一句「这一版没有可直接安装的包」，
    /// 分不清是「发布里缺包」还是「你这台机器装法不支持」，排查全靠猜。
    pub auto_install_blocked: String,
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

/// 与 [`get_json`] 相同，但不校验宿主白名单 —— 仅 `FM_UPDATE_ENDPOINT` 测试端点使用。
async fn get_json_lenient(url: &str) -> Result<serde_json::Value, String> {
    get_json_inner(url, false).await
}

async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    get_json_inner(url, true).await
}

/// 环回地址判定（127.0.0.1 / localhost / [::1]）。
/// 命中时客户端要 `.no_proxy()`：用户环境里常有 HTTP_PROXY（还往往没配 no_proxy），
/// 代理进程对「连回本机」这种目标大多直接拒绝 —— 下载会莫名失败，UI 只看到一句报错。
fn is_loopback_url(url: &str) -> bool {
    url.contains("://127.0.0.1:")
        || url.contains("://localhost:")
        || url.contains("://[::1]:")
        || url.contains("://[0:0:0:0:0:0:0:1]:")
}

async fn get_json_inner(url: &str, strict_host: bool) -> Result<serde_json::Value, String> {
    let client = {
        let mut b = reqwest::Client::builder()
            .user_agent(UA)
            .redirect(reqwest::redirect::Policy::limited(3))
            .timeout(TIMEOUT);
        if !strict_host && is_loopback_url(url) {
            b = b.no_proxy();
        }
        b.build().map_err(|e| format!("网络客户端初始化失败：{e}"))?
    };
    let res = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| explain(url, &e))?;
    // 跟随重定向之后必须再看一眼落点：304/301 都可能把请求带到别处
    let host = res.url().host_str().unwrap_or_default().to_string();
    if strict_host && !ALLOWED_HOSTS.contains(&host.as_str()) {
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

/// 从 release 的 assets 里挑出「能静默装的安装包」。
///
/// 只认 `*-setup.exe`（NSIS，currentUser 安装、不需要提权）。**不碰 MSI**：
/// perMachine 安装要 UAC，静默跑会直接失败或者弹一个没人点的授权框。
/// 同一版里若同时有 x64 与其它架构，优先 x64。
/// 返回 (url, name, sha256, asset_id)。
fn pick_setup(assets: &serde_json::Value) -> (String, String, String, u64) {
    let Some(list) = assets.as_array() else {
        return (String::new(), String::new(), String::new(), 0);
    };
    let mut best: Option<(u8, String, String, String, u64)> = None;
    for a in list {
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        if !name.to_ascii_lowercase().ends_with("-setup.exe") {
            continue;
        }
        let url = a
            .get("browser_download_url")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if url.is_empty() {
            continue;
        }
        // GitHub 从 2024 起给 asset 带 digest（"sha256:…"）；老接口没有就留空，
        // 没有校验值的版本一律不提供一键安装（见 can_auto_install）。
        let digest = a
            .get("digest")
            .and_then(|x| x.as_str())
            .and_then(|d| d.strip_prefix("sha256:"))
            .map(|h| h.to_ascii_lowercase())
            .unwrap_or_default();
        let id = a.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
        let rank = if name.contains("x64") { 1 } else { 0 };
        let cand = (rank, name.to_string(), url.to_string(), digest, id);
        if best.as_ref().map(|b| cand.0 > b.0).unwrap_or(true) {
            best = Some(cand);
        }
    }
    match best {
        Some((_, name, url, digest, id)) => (url, name, digest, id),
        None => (String::new(), String::new(), String::new(), 0),
    }
}

/// 当前这份程序是哪种装法。静默升级只对 `PerUser` 放行。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InstallKind {
    /// NSIS 按用户安装（currentUser）。**换盘符也算** —— 安装器把目录记在
    /// `HKCU\Software\IIEOzo\FontManager` 的默认值里，静默 `/S` 会照着装回同一个目录。
    PerUser,
    /// MSI 按系统安装（perMachine，通常在 `Program Files`）。静默装会装出第二份 + 两套字体关联打架。
    PerMachine,
    /// 从文件夹里直接跑的副本（注册表里没有对应安装记录）。
    Portable,
}

impl InstallKind {
    fn as_str(self) -> &'static str {
        match self {
            InstallKind::PerUser => "user",
            InstallKind::PerMachine => "system",
            InstallKind::Portable => "portable",
        }
    }
}

/// NSIS 安装器自己记的安装目录（`installer.nsi` 第 660 行 `WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR`，
/// 第 856 行 `RestorePreviousInstallLocation` 又靠它把静默升级装回原目录）。
const NSIS_DIR_KEY: &str = r"Software\IIEOzo\FontManager";
/// 兜底：卸载信息里的安装目录（值带引号，读出来要剥）。
const NSIS_UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\FontManager";

/// 读一个 `REG_SZ` / `REG_EXPAND_SZ` 值；不存在 / 读不到一律 None（调用方按「不知道」处理）。
#[cfg(target_os = "windows")]
fn reg_read_str(
    root: windows_sys::Win32::System::Registry::HKEY,
    sub: &str,
    value: &str,
) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_EXPAND_SZ, REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let sub_w = wide(sub);
    let val_w = wide(value);
    let mut hkey: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(root, sub_w.as_ptr(), 0, KEY_READ, &mut hkey) } != ERROR_SUCCESS {
        return None;
    }
    let mut buf = vec![0u8; 2048];
    let mut len = buf.len() as u32;
    let mut ty = 0u32;
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            val_w.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    unsafe { RegCloseKey(hkey) };
    if rc != ERROR_SUCCESS || (ty != REG_SZ && ty != REG_EXPAND_SZ) || len < 2 {
        return None;
    }
    let u16s: Vec<u16> = buf[..len as usize]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&c| c != 0)
        .collect();
    let s = String::from_utf16_lossy(&u16s).trim().trim_matches('"').to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(not(target_os = "windows"))]
fn reg_read_str(_root: usize, _sub: &str, _value: &str) -> Option<String> {
    None
}

/// 安装记录里的目录（用户级 NSIS 优先）。
fn recorded_user_install_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        // 安装器写的默认值最干净（不带引号、就是 $INSTDIR 原文）
        if let Some(p) = reg_read_str(HKEY_CURRENT_USER, NSIS_DIR_KEY, "") {
            return Some(std::path::PathBuf::from(p));
        }
        if let Some(p) = reg_read_str(HKEY_CURRENT_USER, NSIS_UNINSTALL_KEY, "InstallLocation") {
            return Some(std::path::PathBuf::from(p));
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 两个目录是不是同一处。大小写不敏感、分隔符归一、去掉 `\\?\` 与尾部分隔符 ——
/// 注册表里存的是 `D:\FontManager`，而 `current_exe()` 可能回 `D:\FontManager\fontmanager.exe`
/// 的原样或带扩展长度前缀的形态，直接用 `==` 比较会漏判。
fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    fn norm(p: &std::path::Path) -> String {
        let s = p.to_string_lossy().replace('/', "\\");
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
        s.trim_end_matches('\\').to_lowercase()
    }
    !a.as_os_str().is_empty() && norm(a) == norm(b)
}

fn current_exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// 目录是否落在系统级安装位置（`Program Files` / `Program Files (x86)`）。
fn looks_system_wide(dir: &std::path::Path) -> bool {
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .any(|base| {
            let s = dir.to_string_lossy().to_lowercase().replace('/', "\\");
            let b = base.to_string_lossy().to_lowercase().replace('/', "\\");
            s == b || s.starts_with(&(b + "\\"))
        })
}

/// 判定当前安装形态。
///
/// **1.9.5 修正**：旧实现是「exe 路径必须以 `%LOCALAPPDATA%\FontManager` 开头」——
/// 用户把安装目录改到 D 盘后，这条永远为假，一键升级直接退化成「打开发布页」。
/// 真正的判据是**注册表记录的安装目录 == 当前 exe 所在目录**（NSIS 静默升级会装回同一目录，
/// 换盘符一样有效），路径在不在 C 盘与此无关。
pub fn install_kind() -> InstallKind {
    let Some(dir) = current_exe_dir() else {
        return InstallKind::Portable;
    };
    // ① 安装器自己记的目录（放第一：换盘符、改目录都靠它）
    if let Some(rec) = recorded_user_install_dir() {
        if same_dir(&rec, &dir) {
            return InstallKind::PerUser;
        }
        // 记录指向别处：说明当前这份是被拷出来的副本，别按「已安装」处理
    } else if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        // ② 没有安装记录时退回默认位置判断（老版本 / 注册表读不到）
        if same_dir(&std::path::Path::new(&base).join("FontManager"), &dir) {
            return InstallKind::PerUser;
        }
    }
    // ③ 系统级安装（MSI perMachine）
    if looks_system_wide(&dir) {
        return InstallKind::PerMachine;
    }
    InstallKind::Portable
}

/// 装不了的**具体**原因（空串 = 没有阻塞）。
fn blocker(setup_url: &str, sha256: &str, kind: InstallKind) -> &'static str {
    match kind {
        InstallKind::PerMachine => "system",
        InstallKind::Portable => "portable",
        InstallKind::PerUser => {
            if setup_url.is_empty() {
                "no-asset"
            } else if sha256.is_empty() {
                "no-digest"
            } else {
                ""
            }
        }
    }
}

async fn from_release_api() -> Result<UpdateInfo, String> {
    let override_url = endpoint_override();
    let v = match &override_url {
        // 测试端点：宿主白名单不适用（它本来就指向 127.0.0.1）
        Some(u) => get_json_lenient(u).await?,
        None => get_json(API_URL).await?,
    };
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
    let (setup_url, setup_name, sha256, setup_asset_id) =
        pick_setup(v.get("assets").unwrap_or(&serde_json::Value::Null));
    let kind = install_kind();
    let blocked = blocker(&setup_url, &sha256, kind);
    if !blocked.is_empty() {
        // 每轮检查都会重算，静默检查一天一次，写一行日志不碍事；
        // 用户报「点了直接跳浏览器」时，这里能一句话说清是哪条闸。
        crate::diag::log(&format!(
            "[update] 一键安装不可用：install_kind={}, blocked_by={}",
            kind.as_str(),
            blocked
        ));
    }
    Ok(UpdateInfo {
        current: env!("CARGO_PKG_VERSION").to_string(),
        has_update: is_newer(&latest, env!("CARGO_PKG_VERSION")),
        latest,
        url,
        notes: trim_notes(notes),
        published_at: published_at.to_string(),
        source: "github".into(),
        can_auto_install: blocked.is_empty(),
        install_kind: kind.as_str().into(),
        auto_install_blocked: blocked.into(),
        setup_url,
        setup_name,
        sha256,
        setup_asset_id,
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
        // 兜底源只有版本号，没有资产信息：一律不给一键安装
        setup_url: String::new(),
        setup_name: String::new(),
        sha256: String::new(),
        setup_asset_id: 0,
        can_auto_install: false,
        install_kind: install_kind().as_str().into(),
        auto_install_blocked: "no-asset".into(),
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

// ═════════════════ 下载 + 静默安装（1.8.4） ═════════════════
//
// 从这里往下会**真的下载可执行文件并执行它**，所以规矩比「检查更新」严得多：
//
//   · 只接受 https + 白名单域名（github.com / objects / release-assets），
//     跟着重定向之后的落点也要落在里面；
//   · 必须带 SHA-256（GitHub Asset 的 digest）。下完核对不上 → **删掉，绝不执行**；
//   · 只认 NSIS 的 `*-setup.exe`。MSI 是 perMachine 安装，静默跑会弹 UAC 或直接失败；
//   · 只给「按用户安装」的版本用（程序在 `%LOCALAPPDATA%\FontManager` 下）。
//     装在 Program Files 的 MSI 版走手动下载 —— 否则会装出第二份、两套字体关联打架；
//   · 安装本身交给一段临时 PowerShell 脚本：等本进程退出 → `/S` 静默装 → 启动新版本。
//     必须等进程退出，Windows 不允许覆盖正在运行的 exe。

/// 安装包下载进度（`update:progress` 事件）
pub const PROGRESS_EVENT: &str = "update:progress";

const DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// 备用通道宿主（1.9.1）：国内网络下 `github.com` 常被干扰而 `api.github.com` 可用，
/// 所以镜像前缀与 asset API 都是真实可行的退路。**镜像只是换条路拿同一个文件**，
/// SHA-256 校验值取自 GitHub 官方 digest、贯穿所有通道 —— 通道被投毒也过不了校验。
const MIRROR_HOSTS: [&str; 2] = ["gh-proxy.com", "ghfast.top"];
const MIRROR_PREFIXES: [&str; 2] = ["https://gh-proxy.com/", "https://ghfast.top/"];
const ASSET_API_PREFIX: &str = "https://api.github.com/repos/706972745/FontManager/releases/assets/";

fn download_url_ok(url: &str) -> bool {
    // 测试端点配套：`FM_UPDATE_ENDPOINT` 设着的时候放行本机回环直链（带不带端口都算）
    if endpoint_override().is_some() && is_loopback_url(url) {
        return true;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    DOWNLOAD_HOSTS.contains(&host)
}

/// 重定向**落点**的白名单：比入口宽一档 —— 镜像通道的落点可以是镜像域自身
/// （代理流），asset API 的落点是 objects/release-assets。
fn download_resp_host_ok(url: &str) -> bool {
    if endpoint_override().is_some() && is_loopback_url(url) {
        return true;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    DOWNLOAD_HOSTS.contains(&host) || MIRROR_HOSTS.contains(&host) || host == "api.github.com"
}

/// 一条下载通道。`octet = true` 时请求要带 `Accept: application/octet-stream`
///（asset API 靠这个头返回文件内容而不是 JSON 元数据）。
struct DlChannel {
    url: String,
    octet: bool,
    label: &'static str,
}

/// 通道接力表（1.9.1）：
///   ① 直连 browser_download_url —— 海外/直连可用时最快；
///   ② gh-proxy.com 镜像、③ ghfast.top 镜像 —— 国内网络实测可用；
///   ④ asset API —— 只依赖 api.github.com（与「检查更新」同一条命），
///      慢但最难挂，放最后兜底。
/// 测试端点（FM_UPDATE_ENDPOINT）保持只有一条：就是给定的那个 URL。
fn download_channels(url: &str, asset_id: u64) -> Vec<DlChannel> {
    let mut v = vec![DlChannel {
        url: url.to_string(),
        octet: false,
        label: "direct",
    }];
    if endpoint_override().is_some() {
        // 测试钩子也要能端到端验证通道接力：假端点只替代「检查」这一步，
        // 它给出的 setupUrl 若是真实的 github.com 直链，镜像 / asset API
        // 照拼 —— 下载走的仍是真 GitHub 链路。
        if download_url_ok(url) {
            for m in MIRROR_PREFIXES {
                v.push(DlChannel {
                    url: format!("{m}{url}"),
                    octet: false,
                    label: "mirror",
                });
            }
            if asset_id != 0 {
                v.push(DlChannel {
                    url: format!("{ASSET_API_PREFIX}{asset_id}"),
                    octet: true,
                    label: "asset-api",
                });
            }
        }
        return v;
    }
    if download_url_ok(url) {
        for m in MIRROR_PREFIXES {
            v.push(DlChannel {
                url: format!("{m}{url}"),
                octet: false,
                label: "mirror",
            });
        }
        if asset_id != 0 {
            v.push(DlChannel {
                url: format!("{ASSET_API_PREFIX}{asset_id}"),
                octet: true,
                label: "asset-api",
            });
        }
    }
    v
}

/// 文件名只允许 `…-setup.exe`，且不含路径分隔符 / 通配符（防目录穿越与参数注入）
fn setup_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.to_ascii_lowercase().ends_with("-setup.exe")
        && !name.contains(['/', '\\', ':', '"', '<', '>', '|', '?', '*'])
}

fn sha256_hex_ok(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("读不到安装包：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn emit_progress(app: &AppHandle, phase: &str, received: u64, total: u64, error: Option<&str>) {
    use tauri::Emitter as _;
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({
            "phase": phase,
            "received": received,
            "total": total,
            "percent": if total > 0 { (received.saturating_mul(100) / total).min(100) } else { 0 },
            "error": error,
        }),
    );
}

/// 安装包落地的固定目录（`install_setup` 只认这里的文件）
fn update_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("FontManager-update")
}

/// 清掉临时目录里**以前版本**留下的安装包。
///
/// 每次升级都把 setup 下到这里，而 NSIS 只覆盖程序目录、不碰下下来的包——于是每升一次
/// 就多留一份约 6MB 的安装包。2026-11-12 实测：升到 1.9.6 时目录里还躺着 1.9.4 和 1.9.6
/// 两份，共 13MB，用户问「装完到底删没删」。
///
/// 在**开始下载新包时**顺手扫一遍：只保留下载目标这一个（「下到一半断了再点一次」要复用
/// 它，靠 SHA-256 校验决定能不能直接用），其余 `FontManager_*_setup.exe` 一律删掉。
/// 日志与其它文件不动——`apply-update.log` 是排障入口，不能跟着一起清。
fn prune_stale_setups(dir: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with("FontManager_") && name.ends_with("-setup.exe") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 下载安装包到临时目录并校验 SHA-256，返回落地路径。
///
/// 已经下过且哈希对的文件直接复用：用户网络差、第一次下到一半断了再点一次，
/// 不该从头再来一遍。
///
/// 1.9.1 起**通道接力**：直连 → gh-proxy.com → ghfast.top → asset API。
/// 国内网络下 `github.com` 常被干扰（连接直接重置）而 `api.github.com` 可用，
/// 只试直连的话「下载并安装」永远失败 —— 这正是用户反馈的问题。
/// 每条通道下载完都要过同一把 SHA-256（官方 digest），通道内容被篡改照样拦下。
pub fn download_setup(
    app: &AppHandle,
    url: &str,
    name: &str,
    want_sha: &str,
    asset_id: u64,
) -> Result<String, String> {
    crate::diag::log(&format!("[update] download start {name} <- {url}"));
    if !setup_name_ok(name) {
        return Err(format!("安装包文件名不合法：{name}"));
    }
    let want = want_sha.trim().to_ascii_lowercase();
    if !sha256_hex_ok(&want) {
        return Err("这一版没有提供 SHA-256 校验值，不能自动安装（请到发布页手动下载）".into());
    }

    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败：{e}"))?;
    let dest = dir.join(name);
    // 先把更早版本留下的包清掉：不然每次升级都多留一份 6MB（见 prune_stale_setups）
    prune_stale_setups(&dir, &dest);

    if dest.is_file() {
        if let Ok(h) = sha256_file(&dest) {
            if h == want {
                emit_progress(app, "ready", 1, 1, None);
                return Ok(dest.to_string_lossy().into_owned());
            }
        }
        let _ = std::fs::remove_file(&dest);
    }

    let channels = download_channels(url, asset_id);
    let mut errs: Vec<String> = Vec::new();
    for ch in &channels {
        // 只有直连通道的 URL 来自外部（Releases API 的 browser_download_url），
        // 必须过一遍白名单；镜像 / asset API 是内部拼的，格式自证。
        if ch.label == "direct" && !download_url_ok(&ch.url) {
            errs.push(format!("{}：下载地址不在允许的站点内", ch.label));
            continue;
        }
        emit_progress(app, "download", 0, 0, None);
        match try_channel(app, ch, name, &want, &dir, &dest) {
            Ok(()) => {
                crate::diag::log(&format!("[update] download done {name} (sha ok, via {})", ch.label));
                emit_progress(app, "ready", 1, 1, None);
                return Ok(dest.to_string_lossy().into_owned());
            }
            Err(e) => {
                crate::diag::log(&format!("[update] channel {} failed: {e}", ch.label));
                errs.push(format!("{}：{e}", ch.label));
            }
        }
    }
    emit_progress(app, "error", 0, 0, Some("下载失败"));
    Err(format!(
        "直连与备用通道都下载失败（{}）；可以到发布页手动下载",
        errs.join("；")
    ))
}

/// 走单条通道把文件下到 `.part`，SHA-256 校验通过后挪到 `dest`。
fn try_channel(
    app: &AppHandle,
    ch: &DlChannel,
    name: &str,
    want: &str,
    dir: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    use std::io::{Read as _, Write as _};

    let partial = dir.join(format!("{name}.part"));
    let client = {
        let mut b = reqwest::blocking::Client::builder()
            .user_agent(UA)
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(600));
        // 环回目标（FM_UPDATE_ENDPOINT 的本机假服务）绝不走代理：
        // 用户的 HTTP_PROXY 常常没配 no_proxy，代理进程会拒收「连回本机」的请求。
        if is_loopback_url(&ch.url) {
            b = b.no_proxy();
        }
        b.build()
            .map_err(|e| format!("网络客户端初始化失败：{e}"))?
    };
    let mut req = client.get(&ch.url);
    if ch.octet {
        req = req.header(reqwest::header::ACCEPT, "application/octet-stream");
    }
    let mut resp = req
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("{e}"))?;
    // 重定向后的落点也要在白名单里（GitHub 的下载会 302 到 objects.githubusercontent.com）
    if !download_resp_host_ok(resp.url().as_str()) {
        return Err(format!(
            "下载被重定向到非预期站点：{}",
            resp.url().host_str().unwrap_or("?")
        ));
    }
    let total = resp.content_length().unwrap_or(0);

    {
        let mut f = std::fs::File::create(&partial).map_err(|e| format!("写临时文件失败：{e}"))?;
        let mut received: u64 = 0;
        let mut last_emit = Instant::now();
        let mut buf = [0u8; 65536];
        loop {
            let n = resp.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| format!("写临时文件失败：{e}"))?;
            received += n as u64;
            if last_emit.elapsed() >= Duration::from_millis(200) {
                emit_progress(app, "download", received, total, None);
                last_emit = Instant::now();
            }
        }
        f.flush().ok();
    }

    emit_progress(app, "verify", total, total, None);
    let got = sha256_file(&partial)?;
    if got != want {
        let _ = std::fs::remove_file(&partial);
        emit_progress(app, "error", 0, 0, Some("校验失败"));
        return Err("安装包校验失败（内容与发布页的 SHA-256 不一致），已删除，没有安装".into());
    }
    std::fs::rename(&partial, dest).map_err(|e| format!("保存安装包失败：{e}"))?;
    Ok(())
}

/// `canonicalize()` / 某些启动方式会给回 `\\?\C:\...`（扩展长度路径）。
///
/// `Start-Process` **不认**这种前缀，会「找不到路径」；而脚本顶部是
/// `SilentlyContinue`，于是 NSIS 静默没跑、应用照常重启 —— 看起来像升级成功，
/// 实际什么都没换（1.8.8 端到端测试抓到的就是这个）。UNC 的
/// `\\?\UNC\server\share` 归一成 `\\server\share`。
///
/// 安装包路径和本程序路径都要过这一道：后者漏了同样会让「装完自动重启」静默失效。
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    }
}

/// 生成安装脚本。
///
/// 为什么不是「直接 spawn 安装器」：Windows 不允许覆盖正在运行的 exe，
/// 而我们要退出的这个进程正是它。所以脚本先等我们的 pid 消失，再 `/S` 静默装，
/// 最后把新版启动起来。`-Wait` 保证「装完才启动」，否则会出现新版启动时文件还在写。
///
/// 全链写日志（`apply-update.log`，和脚本同目录，脚本自删后仍留着）：NSIS `/S` 失败
/// 是**完全静默**的 —— 没有日志的话，「装完自动重启」到底成没成只能靠用户看版本号猜。
/// 日志里记：等待耗时 / 安装器退出码 / 装完的 exe 版本 vs 期望版本 / 有没有拉起来。
fn ps1_script(
    pid: u32,
    setup: &std::path::Path,
    exe: &std::path::Path,
    want_version: &str,
    log: &std::path::Path,
) -> String {
    let q = |p: &std::path::Path| format!("'{}'", p.display().to_string().replace('\'', "''"));
    let mut s = String::from("\u{feff}"); // UTF-8 BOM：PowerShell 5.1 才认得出中文路径
    s.push_str("$ErrorActionPreference = 'SilentlyContinue'\r\n");
    s.push_str(&format!("$log = {}\r\n", q(log)));
    s.push_str(&format!("$want = '{}'\r\n", want_version.replace('\'', "''")));
    s.push_str(
        "function Note($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 }\r\n",
    );
    s.push_str(&format!(
        "Note ('start: host pid={pid}, setup=' + {} )\r\n",
        q(setup)
    ));
    s.push_str(&format!("$target = {pid}\r\n"));
    s.push_str("$i = 0\r\n");
    s.push_str("for ($i = 0; $i -lt 240; $i++) {\r\n");
    s.push_str("  if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) { break }\r\n");
    s.push_str("  Start-Sleep -Milliseconds 250\r\n");
    s.push_str("}\r\n");
    s.push_str("Note ('host gone after ' + ($i * 250) + ' ms')\r\n");
    s.push_str("Start-Sleep -Milliseconds 800\r\n");
    // WebView2 子进程（msedgewebview2）可能比宿主多活几秒，还握着 exe 的句柄；
    // 不等它们退出，NSIS /S 会「覆盖失败、静默中止」，看起来像装好了其实没装。
    // 这里等「命令行里带本程序名字的 msedgewebview2」全部退出，最多再等 30 秒。
    s.push_str(&format!("$exeName = (Split-Path -Leaf {})\r\n", q(exe)));
    s.push_str("$j = 0\r\n");
    s.push_str("for ($j = 0; $j -lt 120; $j++) {\r\n");
    s.push_str("  $left = Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" |\r\n");
    s.push_str("    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($exeName) }\r\n");
    s.push_str("  if (-not $left) { break }\r\n");
    s.push_str("  Start-Sleep -Milliseconds 250\r\n");
    s.push_str("}\r\n");
    s.push_str("Note ('webview gone after ' + ($j * 250) + ' ms')\r\n");
    s.push_str("Start-Sleep -Milliseconds 500\r\n");
    // -PassThru -Wait：要拿退出码判断 NSIS 到底跑没跑成（0 = 成功）
    s.push_str(&format!(
        "$p = Start-Process -FilePath {} -ArgumentList '/S' -Wait -PassThru\r\n",
        q(setup)
    ));
    s.push_str("Note ('install exit code = ' + $(if ($p) { $p.ExitCode } else { 'unknown' }))\r\n");
    s.push_str("Start-Sleep -Milliseconds 500\r\n");
    // 装完核对版本：/S 失败时旧 exe 还在原位，光看「文件存在」会误判成功
    s.push_str(&format!(
        "$v = (Get-Item -LiteralPath {} -ErrorAction SilentlyContinue).VersionInfo.ProductVersion\r\n",
        q(exe)
    ));
    s.push_str("if ($v) {\r\n");
    s.push_str("  if ($want -and ($v -ne $want)) { Note ('WARN version after install = ' + $v + ', want ' + $want + ' (安装可能没生效)') }\r\n");
    s.push_str("  else { Note ('version after install = ' + $v) }\r\n");
    s.push_str("} else { Note 'WARN exe not found after install' }\r\n");
    s.push_str(&format!(
        "if (Test-Path -LiteralPath {p}) {{ Start-Process -FilePath {p}; Note 'relaunched' }}\r\n",
        p = q(exe)
    ));
    s.push_str("else { Note 'WARN exe missing, cannot relaunch' }\r\n");
    // 装完把安装包删掉（2026-11-12 用户提问「下载的安装包到底删没删」——之前一直没删，
    // 每升一次就在 %TEMP% 里多留一份 6MB）。只删**装成功**的那一个：
    // 退出码非 0 时留着，用户重试时还能复用，也方便排查。
    // NSIS 退出后句柄通常立刻释放，但杀软扫描偶尔会晚一两秒，所以带重试。
    s.push_str(&format!("$setupPath = {}\r\n", q(setup)));
    s.push_str("if ($p -and $p.ExitCode -eq 0) {\r\n");
    s.push_str("  for ($k = 0; $k -lt 20; $k++) {\r\n");
    s.push_str("    Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue\r\n");
    s.push_str("    if (-not (Test-Path -LiteralPath $setupPath)) { break }\r\n");
    s.push_str("    Start-Sleep -Milliseconds 250\r\n");
    s.push_str("  }\r\n");
    s.push_str("  if (Test-Path -LiteralPath $setupPath) { Note ('WARN setup still present: ' + $setupPath) }\r\n");
    s.push_str("  else { Note 'setup removed' }\r\n");
    s.push_str("} else { Note 'setup kept (installer exit code not 0)' }\r\n");
    s.push_str("Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force\r\n");
    s
}

/// 校验通过后启动安装脚本，并在 1.2 秒后退出本进程。
///
/// `want_version` 只用于**装完核对**（写进 apply-update.log），不参与任何安全判定：
/// 空字符串表示不核对。静默安装失败时旧 exe 还在原位，没有这一步就看不出「装了但没换」。
pub fn install_setup(app: &AppHandle, path: &str, want_sha: &str, want_version: &str) -> Result<(), String> {
    crate::diag::log(&format!("[update] install start {path}"));
    let dir = update_dir();
    let canon_dir = dir
        .canonicalize()
        .map_err(|_| "临时目录里没有待安装的包（可能被杀毒软件清掉了）".to_string())?;
    let canon = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("找不到安装包：{e}"))?;
    if !canon.starts_with(&canon_dir) {
        return Err("安装包不在允许的位置，拒绝执行".into());
    }
    let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !setup_name_ok(name) {
        return Err("安装包文件名不合法，拒绝执行".into());
    }
    let want = want_sha.trim().to_ascii_lowercase();
    if !sha256_hex_ok(&want) {
        return Err("缺少校验值，拒绝执行安装包".into());
    }
    // 前端已经拦过一道，这里再拦一次：IPC 可以被插件或脚本直接调用，
    // 「按系统安装 / 目录副本」的机器上跑 `/S` 会装出第二份。
    let kind = install_kind();
    if kind != InstallKind::PerUser {
        return Err(match kind {
            InstallKind::PerMachine => {
                "当前是按系统安装的 MSI 版，静默升级会装出第二份，请到发布页手动下载".to_string()
            }
            _ => "当前这份是从文件夹直接运行的副本，没有安装记录，请到发布页手动下载安装包".to_string(),
        });
    }
    // 执行前再算一次：下载完到点安装之间，文件可能被替换掉
    if sha256_file(&canon)? != want {
        let _ = std::fs::remove_file(&canon);
        return Err("安装包校验失败（内容已被改动），已删除，没有安装".into());
    }

    let exe = std::env::current_exe().map_err(|e| format!("找不到当前程序路径：{e}"))?;
    // 两条路径都要剥 `\\?\`：安装包（canonicalize 一定会带）和本程序（某些启动方式会带）。
    // 漏掉后者 → 脚本里 Test-Path 失败 → 装完了却拉不起来，「自动重启」静默失效。
    let setup_for_script = strip_verbatim(&canon);
    let exe_for_script = strip_verbatim(&exe);
    let script = dir.join("apply-update.ps1");
    let log = dir.join("apply-update.log");
    std::fs::write(
        &script,
        ps1_script(
            std::process::id(),
            std::path::Path::new(&setup_for_script),
            std::path::Path::new(&exe_for_script),
            want_version.trim(),
            &log,
        ),
    )
    .map_err(|e| format!("写安装脚本失败：{e}"))?;

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 1.9.1 修复：不能再叠加 DETACHED_PROCESS —— powershell.exe 是控制台程序，
    // DETACHED 下拿不到控制台又不会新建，-NonInteractive 模式下**启动即退**，
    // NSIS 根本不会跑（真机实验实锤：同一段脚本普通 spawn 全程 9~68 秒完成，
    // 加 DETACHED 后 3 秒内进程消失）。CREATE_NO_WINDOW 已足够不弹窗。
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            crate::diag::log(&format!("[update] ps1 spawn failed: {e}"));
            format!("启动安装脚本失败：{e}")
        })?;
    crate::diag::log("[update] ps1 spawned (host exit -> webview exit -> /S -> relaunch)");
    crate::diag::log(&format!(
        "[update] 安装脚本日志（装完/没装成都能在这看）：{}",
        log.display()
    ));

    // 留一点时间让前端把「正在安装」画完、把 IPC 收掉，然后自己退出
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        app.exit(0);
    });
    Ok(())
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

    // ── 下载 / 静默安装（1.8.4）──────────────────────────────────────

    #[test]
    fn download_url_must_be_https_and_whitelisted() {
        assert!(download_url_ok(
            "https://github.com/706972745/FontManager/releases/download/v1.8.3/FontManager_1.8.3_x64-setup.exe"
        ));
        assert!(download_url_ok("https://objects.githubusercontent.com/x/y"));
        // 下面这些一律拒绝：http、外站、伪装成白名单前缀的域名
        assert!(!download_url_ok("http://github.com/x"));
        assert!(!download_url_ok("https://evil.example/setup.exe"));
        assert!(!download_url_ok("https://github.com.evil.example/x"));
        assert!(!download_url_ok("https://raw.githubusercontent.com/x"));
        assert!(!download_url_ok("file:///C:/setup.exe"));
        assert!(!download_url_ok(""));
    }

    #[test]
    fn setup_name_cannot_escape_the_directory() {
        assert!(setup_name_ok("FontManager_1.8.3_x64-setup.exe"));
        assert!(!setup_name_ok("../../evil-setup.exe"));
        assert!(!setup_name_ok("C:\\Windows\\evil-setup.exe"));
        assert!(!setup_name_ok("FontManager_1.8.3_x64.msi"));
        assert!(!setup_name_ok("setup.exe"));
        assert!(!setup_name_ok(""));
        assert!(!setup_name_ok(&format!("{}-setup.exe", "a".repeat(200))));
    }

    #[test]
    fn sha256_hex_shape() {
        assert!(sha256_hex_ok(&"a".repeat(64)));
        assert!(sha256_hex_ok(&"0123456789abcdef".repeat(4)));
        assert!(!sha256_hex_ok(""));
        assert!(!sha256_hex_ok("xyz"));
        assert!(!sha256_hex_ok(&"a".repeat(63)));
        assert!(!sha256_hex_ok(&"g".repeat(64)));
    }

    #[test]
    fn sha256_of_known_bytes() {
        let dir = std::env::temp_dir().join("fontmanager-update-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("abc.bin");
        std::fs::write(&f, b"abc").unwrap();
        let h = sha256_file(&f).unwrap();
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn pick_setup_prefers_x64_and_lowercases_digest() {
        let assets = serde_json::json!([
            { "name": "FontManager_1.8.3_x64_en-US.msi", "browser_download_url": "https://github.com/a.msi",
              "digest": "sha256:cccc" },
            { "name": "FontManager_1.8.3_arm64-setup.exe", "browser_download_url": "https://github.com/b.exe",
              "digest": "sha256:DDDD", "id": 11 },
            { "name": "FontManager_1.8.3_x64-setup.exe", "browser_download_url": "https://github.com/c.exe",
              "digest": "sha256:ABCDEF", "id": 42 }
        ]);
        let (url, name, sha, id) = pick_setup(&assets);
        assert_eq!(name, "FontManager_1.8.3_x64-setup.exe");
        assert_eq!(url, "https://github.com/c.exe");
        assert_eq!(sha, "abcdef", "digest 要转小写，和本地 hex 比较才一致");
        assert_eq!(id, 42, "asset id 给 asset API 兜底通道用");
    }

    #[test]
    fn pick_setup_without_assets_returns_empty() {
        for assets in [serde_json::json!(null), serde_json::json!([])] {
            let (url, name, sha, id) = pick_setup(&assets);
            assert!(url.is_empty() && name.is_empty() && sha.is_empty() && id == 0);
        }
    }

    // ── 下载通道接力（1.9.1）────────────────────────────────────────

    #[test]
    fn channels_direct_mirrors_then_asset_api() {
        let url = "https://github.com/706972745/FontManager/releases/download/v1.9.0/FontManager_1.9.0_x64-setup.exe";
        let ch = download_channels(url, 735072858);
        assert_eq!(ch.len(), 4, "直连 + 2 镜像 + asset API");
        assert_eq!(ch[0].label, "direct");
        assert_eq!(ch[1].url, format!("https://gh-proxy.com/{url}"));
        assert_eq!(ch[2].url, format!("https://ghfast.top/{url}"));
        assert_eq!(ch[3].url, format!("{ASSET_API_PREFIX}735072858"));
        assert!(ch[3].octet, "asset API 必须带 octet-stream 头");
    }

    #[test]
    fn channels_without_asset_id_still_have_mirrors() {
        let url = "https://github.com/a/b/releases/download/v1.0.0/x-setup.exe";
        let ch = download_channels(url, 0);
        assert_eq!(ch.len(), 3, "没有 asset id 就只有直连 + 镜像");
    }

    #[test]
    fn channels_for_test_endpoint_are_single() {
        // 测试钩子存在时只有给定的一条 —— 但本测试进程没设 FM_UPDATE_ENDPOINT，
        // 所以这里用非白名单 URL 验证「镜像不拼」这一半即可。
        let ch = download_channels("https://evil.example/x-setup.exe", 5);
        assert_eq!(ch.len(), 1, "非白名单直连不给配镜像/asset API");
    }

    #[test]
    fn resp_host_allows_mirrors_and_api() {
        assert!(download_resp_host_ok("https://gh-proxy.com/https://github.com/x"));
        assert!(download_resp_host_ok("https://ghfast.top/file"));
        assert!(download_resp_host_ok(
            "https://api.github.com/repos/706972745/FontManager/releases/assets/1"
        ));
        assert!(download_resp_host_ok("https://objects.githubusercontent.com/x/y"));
        assert!(download_resp_host_ok("https://release-assets.githubusercontent.com/x/y"));
        assert!(!download_resp_host_ok("https://evil.example/x"));
        assert!(!download_resp_host_ok("https://github.com.evil.example/x"));
        assert!(!download_resp_host_ok("http://gh-proxy.com/x"));
    }

    #[test]
    fn ps1_waits_for_our_pid_then_installs_silently() {
        let setup = std::path::Path::new("C:\\Users\\a b\\Temp\\FontManager-update\\fm-setup.exe");
        let exe = std::path::Path::new("C:\\Users\\a b\\AppData\\Local\\FontManager\\fontmanager.exe");
        let log = std::path::Path::new("C:\\Users\\a b\\Temp\\FontManager-update\\apply-update.log");
        let s = ps1_script(4321, setup, exe, "1.9.2", log);
        assert!(s.starts_with('\u{feff}'), "PowerShell 5.1 靠 BOM 认 UTF-8 路径");
        assert!(s.contains("$target = 4321"), "必须等本进程退出再装");
        assert!(s.contains("Get-Process -Id $target"));
        assert!(s.contains("-ArgumentList '/S'"), "静默安装参数");
        assert!(s.contains("-Wait"), "装完才启动新版本");
        assert!(s.contains("'C:\\Users\\a b\\Temp\\FontManager-update\\fm-setup.exe'"));
        assert!(s.contains("'C:\\Users\\a b\\AppData\\Local\\FontManager\\fontmanager.exe'"));
        // 装完必须把新版拉起来（用户要求：安装完成后自动重启）
        assert!(
            s.contains("Test-Path -LiteralPath 'C:\\Users\\a b\\AppData\\Local\\FontManager\\fontmanager.exe'")
                && s.contains("Start-Process -FilePath 'C:\\Users\\a b\\AppData\\Local\\FontManager\\fontmanager.exe'"),
            "装完要自动重启"
        );
        // 全链日志 + 装后版本核对：/S 静默失败时旧 exe 还在，不核对就看不出来
        assert!(s.contains("apply-update.log"));
        assert!(s.contains("$want = '1.9.2'"));
        assert!(s.contains("-PassThru"), "要拿安装器退出码");
        assert!(s.contains("WARN version after install"));
        // 等待循环的计数变量不能复用（原来两段都写 $i，第一段的耗时会被第二段覆盖）
        assert!(s.contains("$j = 0") && s.contains("($i * 250)") && s.contains("($j * 250)"));
        // 装成功就把安装包删掉；失败时留着（复用 / 排查），别把「删不掉」也当成功
        assert!(s.contains("$setupPath = 'C:\\Users\\a b\\Temp\\FontManager-update\\fm-setup.exe'"));
        assert!(s.contains("$p.ExitCode -eq 0"), "只在安装器报成功时才删包");
        assert!(s.contains("setup removed") && s.contains("setup kept"));
    }

    /// 下新包时清掉更早版本留下的安装包，但不动正在用的那个、也不动日志。
    #[test]
    fn stale_setups_are_pruned_but_keep_and_log_survive() {
        let dir = std::env::temp_dir().join("fontmanager-prune-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("FontManager_1.9.4_x64-setup.exe");
        let keep = dir.join("FontManager_1.9.7_x64-setup.exe");
        let log = dir.join("apply-update.log");
        let other = dir.join("notes.txt");
        for f in [&old, &keep, &log, &other] {
            std::fs::write(f, b"x").unwrap();
        }
        prune_stale_setups(&dir, &keep);
        assert!(!old.exists(), "旧版本的安装包要删掉");
        assert!(keep.exists(), "这次要用的那个必须留着（断点续下靠它复用）");
        assert!(log.exists(), "排障日志不能跟着清");
        assert!(other.exists(), "不是安装包的文件一律不碰");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 生成的脚本必须能被 PowerShell **真正解析**。
    ///
    /// 只做语法解析、不执行任何东西。1.8.8 的教训：脚本里 `SilentlyContinue` 一挂，
    /// 写错一个括号的后果是「静默什么都没发生」，靠日志和退出码都很难看出来。
    #[cfg(target_os = "windows")]
    #[test]
    fn generated_script_parses_in_powershell() {
        let dir = std::env::temp_dir().join(format!("zfm-ps1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("apply-update.ps1");
        std::fs::write(
            &script,
            ps1_script(
                1,
                std::path::Path::new(r"C:\a b\setup.exe"),
                std::path::Path::new(r"C:\a b\fontmanager.exe"),
                "1.9.2",
                &dir.join("apply-update.log"),
            ),
        )
        .unwrap();
        let cmd = format!(
            "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{}',[ref]$null,[ref]$e); \
             if ($e) {{ $e | ForEach-Object {{ $_.Message }}; exit 1 }} else {{ 'PARSE_OK' }}",
            script.display().to_string().replace('\'', "''")
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .output();
        let _ = std::fs::remove_dir_all(&dir);
        let Ok(out) = out else {
            return; // 没有 powershell（非开发机）就跳过，别让测试假红
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("PARSE_OK"),
            "生成的安装脚本语法有错：{stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 扩展长度路径前缀必须剥掉：`Start-Process` 不认 `\\?\`，静默失败会伪装成「装好了」
    #[test]
    fn verbatim_prefix_is_stripped_for_both_paths() {
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\C:\Users\a\setup.exe")),
            r"C:\Users\a\setup.exe"
        );
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\UNC\srv\share\setup.exe")),
            r"\\srv\share\setup.exe"
        );
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"C:\Users\a\setup.exe")),
            r"C:\Users\a\setup.exe",
            "没前缀的原样返回"
        );
    }

    // ── 安装形态判定（1.9.5：换盘符也能一键升级）────────────────────

    /// 注册表里存 `D:\FontManager`，exe 路径可能是 `D:\FontManager\fontmanager.exe` 的
    /// 任意写法（大小写、斜杠、`\\?\`、尾部分隔符）——都要判成同一处。
    #[test]
    fn same_dir_ignores_case_separators_and_verbatim_prefix() {
        let rec = std::path::Path::new(r"D:\FontManager");
        assert!(same_dir(rec, std::path::Path::new(r"D:\FontManager")));
        assert!(same_dir(rec, std::path::Path::new(r"d:\fontmanager")));
        assert!(same_dir(rec, std::path::Path::new(r"\\?\D:\FontManager")));
        assert!(same_dir(rec, std::path::Path::new("D:/FontManager/")));
        // 不是同一处：只比前缀会把 D:\FontManager-old 也算进来
        assert!(!same_dir(rec, std::path::Path::new(r"D:\FontManager-old")));
        assert!(!same_dir(rec, std::path::Path::new(r"D:\FontManager2")));
        assert!(!same_dir(rec, std::path::Path::new(r"C:\FontManager")));
        assert!(!same_dir(std::path::Path::new(""), rec), "空路径不算命中");
    }

    /// 装不了时必须给出**具体**原因，前端才能说清「为什么点了跳浏览器」。
    #[test]
    fn blocker_names_the_failing_gate() {
        let sha = "a".repeat(64);
        let url = "https://github.com/x/y-setup.exe";
        // 按用户安装 + 直链 + 校验值齐 → 放行
        assert_eq!(blocker(url, &sha, InstallKind::PerUser), "");
        // 安装形态优先报：这两种它根本没有 `/S` 的机会
        assert_eq!(blocker(url, &sha, InstallKind::PerMachine), "system");
        assert_eq!(blocker(url, &sha, InstallKind::Portable), "portable");
        // 发布侧缺东西
        assert_eq!(blocker("", &sha, InstallKind::PerUser), "no-asset");
        assert_eq!(blocker(url, "", InstallKind::PerUser), "no-digest");
    }

    /// `install_kind()` 在开发机上不该把自己误判成「按系统安装」——
    /// 测试进程跑在 `rust-target\debug`，既不在 Program Files 也不在安装记录里。
    #[test]
    fn dev_build_is_not_system_wide() {
        assert!(!looks_system_wide(
            &std::env::current_exe().unwrap().parent().unwrap().to_path_buf()
        ));
    }

    /// 注册表里的安装目录能被读出来（读不到就跳过：CI / 没装过的机器上不可能有）。
    #[test]
    fn recorded_install_dir_is_parseable_when_present() {
        if let Some(dir) = recorded_user_install_dir() {
            let s = dir.to_string_lossy().to_string();
            assert!(s.contains("FontManager"), "读到的目录不像安装目录：{s}");
            assert!(!s.starts_with('"'), "引号必须剥掉：{s}");
        }
    }
}
