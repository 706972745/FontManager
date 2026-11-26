//! 插件中心（M1，v3 架构）：**面板是独立产物**（`workshop.html` + `assets/`），
//! 主程序只管三件事：
//!
//! 1. 下载 / 校验 / 安装面板（设置 → 插件 →「获取更多插件」区块）；
//! 2. 打开面板窗口（复用插件面板机制：127.0.0.1 临时 HTTP + 一次性 key +
//!    主题 / 界面语言下发）；
//! 3. 面板请求安装插件时，**由 Rust 侧**下载、校验、落盘 —— 面板自己碰不到文件系统。
//!
//! 权限口径
//! - 面板会话：每次开面板生成一枚一次性 key（32 hex），只在本机回环有效，
//!   面板的三个 API（列已装 / 安装 / 卸载）都要带 `x-workshop-key`；
//! - 安装能力**只**走这条回环通道。`api.rs` 的本地 API **不**再登记装插件的路由：
//!   仓库铁律是「路由声明的权限名必须在 `PERMS` 白名单里」，而装插件这项能力
//!   不该让插件令牌申请到（`sanitize_plugin_perms` 只放行 PERMS 里登记过的名字）。
//!   与其登记一条插件拿不到的路由，不如**不登记** —— 安全面更小，也不违反不变式。
//!
//! 主机白名单独立于在线字库（`net::ALLOWED_HOSTS`）：插件中心要访问 GitHub release
//! 资产链路（github.com → objects.githubusercontent.com），在线字库用不到它们。

use crate::store;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// registry 聚合清单（index.json）的地址**只存在于面板侧**
// （src/workshop/api.ts 的 INDEX_URL）：面板是独立产物，自己 fetch 清单，
// 主程序不读它 —— 这边再留一份常量就是死代码（编译器会报 never used）。
// 面板侧对应的白名单校验在 Rust 的 check_host()。

/// 面板元数据（版本 + sha256 + 体积）。
///
/// **走 release 资产、不走 raw 分支**：raw 前面有 CDN（实测 `max-age=300`，
/// 且查询参数绕不过缓存），「zip 是新的、meta 是旧的」会让 sha256 硬门槛拒装，
/// 用户点「下载插件中心面板」直接失败。meta 与 zip 同在 release v1、同批发布
/// → 两边永远一致（2026-11-15 实测 raw 的 index.json 也踩过同一坑）。
pub const PANEL_META_URL: &str =
    "https://github.com/706972745/Manager-Workshop/releases/download/v1/panel-fm-meta.json";

/// 面板发布包（GitHub release 资产直链，公开、免登录）
pub const PANEL_RELEASE_URL: &str =
    "https://github.com/706972745/Manager-Workshop/releases/download/v1/panel-fm.zip";

/// 插件中心允许访问的主机：raw（index / meta / 社区件）+ github release 资产链路。
///
/// `release-assets.githubusercontent.com` 是 GitHub 新版 release 资产的落点
/// （`github.com/…/releases/download/…` 302 过去的地方）。它不是随手开的口子：
/// 只有 github.com 的 release 下载链接会跳到那儿，其余来源一概不接。
///
/// `static` 而不是 `const`：重定向策略要求名单是 `'static`（闭包必须 `'static`）。
static WORKSHOP_HOSTS: [&str; 4] = [
    "raw.githubusercontent.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

const INDEX_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

/// 面板包体积上限（20MB，与 registry 单插件上限一致）
const PANEL_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// 插件中心面板的窗口标签。**只此一处**：Open / 卸载关窗 / 前端能力白名单
/// （plugins.rs `panel_webview_dir_name`）都按它认窗口。
pub const PANEL_LABEL: &str = "workshop-panel";

/// 「失焦别隐藏」的守卫位。
///
/// 面板是失焦即藏（`plugins.rs` 的 `close_on_blur`），但有几种失焦**是软件自己造成的**：
/// 选插件文件夹会弹系统对话框、点「打开审核请求」会拉起浏览器 —— 这些时候面板
/// 被藏起来就等于「用户刚点完按钮，界面没了」。
///
/// 所以面板在发起这类动作前先置位，窗口重新获得焦点后（前端监听 window focus）清除；
/// 判据放在这里而不是 `PanelState` 里，是因为窗口事件回调在 plugins.rs 那侧。
static BLUR_GUARD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 失焦时要不要放行隐藏（见 [`BLUR_GUARD`]）
pub fn blur_guarded() -> bool {
    BLUR_GUARD.load(std::sync::atomic::Ordering::Relaxed)
}

// ───────────────────────────── http 小工具 ─────────────────────────────

fn check_host(url: &str) -> Result<(), String> {
    // 判据在低层（plugins.rs）：运行时下载那条链路也用同一份实现，别各写一套
    crate::plugins::check_host_in(url, &WORKSHOP_HOSTS)
}

/// 重定向策略：**每一次重定向都重新校验落点的 host**。
///
/// `Policy::limited(6)` 只管跳几次、不管跳到哪去 —— QA 2026-11-15 实测：
/// release 资产直链会 302 落到白名单外的 `release-assets.githubusercontent.com`
/// （所以它也得在白名单里，见 [`WORKSHOP_HOSTS`]）。
///
/// 同步（阻塞）与异步两个客户端**共用这一个策略**，别只改一处。
fn redirect_policy() -> reqwest::redirect::Policy {
    crate::plugins::redirect_policy_for(&WORKSHOP_HOSTS)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::net::USER_AGENT)
        .timeout(DOWNLOAD_TIMEOUT)
        // release 资产直链会 302 到 objects / release-assets.githubusercontent.com：
        // 必须跟随，但落点要复检（见 redirect_policy）
        .redirect(redirect_policy())
        .build()
        .map_err(|e| e.to_string())
}

/// 读一个 release 小资产（不是 zip）。
///
/// 给「运行时版本提示」用：走的是**和面板包完全相同的一条链路** ——
/// 同一份 host 白名单、同一次重定向复检、同一个 UA。别在调用方另起一套 reqwest，
/// 那等于把校验口径拆成两份，迟早只剩一份是对的。
pub(crate) async fn release_asset_bytes(
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    get_bytes(url, timeout).await
}

async fn get_bytes(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    check_host(url)?;
    let res = client()?
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{} returned HTTP {}", url, res.status().as_u16()));
    }
    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// 相对路径安全检查（与 `plugins::install_zip_into` 的 zip-slip 防护同一口径）
fn safe_rel_path(rel: &str) -> bool {
    let p = FsPath::new(rel);
    !rel.is_empty()
        && !p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir))
        && !rel.contains('\\')
        && !rel.contains(':')
}

/// registry 目录名只当插件目录名用：无分隔符的窄字符集（`<id>__<author>`）
fn safe_dir_name(dir: &str) -> bool {
    !dir.is_empty()
        && dir.len() <= 120
        && dir
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !dir.starts_with('.')
}

/// registry 的 `dir` 字段是**仓库相对路径**（如 `plugins/font-renamer__alice`），
/// 落到主程序的插件目录里只用**最后一段** —— 中间那段是 registry 仓库自己的
/// 目录结构，跟本机的插件布局无关。
///
/// 但「只取最后一段」不能变成「悄悄吃掉越界」：`plugins/../evil` 的最后一段是
/// `evil`，看着像个正常目录名，可它是从一条 `..` 穿越过来的。registry 是远程
/// 可写的清单，这段输入按**不可信**处理：
/// - 任意一段含 `..` → 拒（路径穿越）
/// - 任意一段是 `.` → 拒（当前目录，语义不明确）
/// - 含 `\` → 拒（Windows 上 `\` 也是分隔符，混用能绕过上面两条）
/// - 含 `:` → 拒（盘符 / NTFS 数据流）
///
/// 最后一段还要过 [`safe_dir_name`]：只允许字母数字、`-`、`_`、`.`，且不能以 `.` 开头。
fn dir_name_of(dir: &str) -> Option<&str> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('\\') || trimmed.contains(':') {
        return None;
    }
    for seg in trimmed.split('/') {
        if seg.contains("..") || seg == "." {
            return None;
        }
    }
    let last = trimmed.rsplit('/').next().unwrap_or("").trim();
    if last.is_empty() || !safe_dir_name(last) {
        return None;
    }
    Some(last)
}

// ───────────────────── 插件安装（面板与本地 API 共用） ─────────────────────

/// 社区件的逐文件清单项（来自 index.json 的 files 数组）
#[derive(Deserialize, Clone)]
pub struct WorkshopFile {
    pub path: String,
    pub sha256: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
}

/// 单个文件的完整性校验（纯函数，能单测）。
///
/// **sha256 是硬门槛**：缺失 / 不是 64 位 hex / 与内容不符，一律拒。
/// index.json 是**远程可写**的（设计允许匿名上传与迭代），「sha256 留空就跳过校验」
/// 等于允许未经哈希校验的代码落进插件目录并被执行 —— 与面板包口径保持一致。
fn verify_payload(f: &WorkshopFile, bytes: &[u8]) -> Result<(), String> {
    let want = f.sha256.trim().to_ascii_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "清单里的 {} 没有合法的 sha256（缺失或格式不对），已拒绝安装",
            f.path
        ));
    }
    let got = sha256_hex(bytes);
    if got != want {
        return Err(format!(
            "sha256 校验失败：{}（期望 {want}，实际 {got}）",
            f.path
        ));
    }
    if f.size > 0 && bytes.len() as u64 != f.size {
        return Err(format!(
            "大小不符：{}（期望 {}，实际 {}）",
            f.path,
            f.size,
            bytes.len()
        ));
    }
    Ok(())
}

/// 校验 + 落盘。**全有或全无**：先把每个文件都验一遍（sha256 硬门槛），
/// 任何一个没过就立刻返回 Err —— 此时**一个字节都没写**；
/// 全部过了才逐个写盘。所以「中途失败不留半套文件」是结构保证的，不是靠祈祷。
fn verify_and_write(
    target: &FsPath,
    files: &[WorkshopFile],
    payloads: &[(String, Vec<u8>)],
) -> Result<(), String> {
    for f in files {
        let bytes = payloads
            .iter()
            .find(|(p, _)| *p == f.path)
            .map(|(_, b)| b.as_slice())
            .ok_or_else(|| format!("清单与下载结果对不上：{}", f.path))?;
        verify_payload(f, bytes)?;
    }
    for (rel, data) in payloads {
        let out = target.join(rel);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建目录失败：{e}"))?;
        }
        std::fs::write(&out, data).map_err(|e| format!("写 {} 失败：{e}", out.display()))?;
    }
    Ok(())
}

/// 安装结果（面板与本地 API 共用一份形状）
#[derive(Serialize, Clone)]
pub struct InstallOutcome {
    pub id: String,
    pub name: String,
    pub version: String,
    pub files: usize,
    /// 插件目录（官方件 = 插件目录；社区件 = registry 的 `<id>__<author>`）
    pub dir: String,
}

/// 官方件安装：release zip 直链下载 → 落临时文件 → 复用 `plugins::install_zip`
/// （zip-slip 防护 / api_level 校验 / 数据文件保留）→ 装完热重启在跑的实例。
pub async fn install_official(url: &str) -> Result<InstallOutcome, String> {
    let bytes = get_bytes(url, DOWNLOAD_TIMEOUT).await?;
    let (id, name, version) = tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!(
            "fontmanager-plugin-{}-{}.zip",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let result = (|| -> Result<(String, String, String), String> {
            std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
            crate::plugins::install_zip(&tmp)
        })();
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    // 关键：更新不能只换文件 —— 正在运行的插件进程还抱着旧代码，装完立即热重启
    let _ = crate::plugins::restart_if_running(&id);
    let dir = crate::plugins::plugin_dir_for_id(&id)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(InstallOutcome {
        id,
        name,
        version,
        files: 0,
        dir,
    })
}

/// 社区件装前的清单硬闸（纯函数，可单测）。
///
/// registry 的 `plugin.json` **就是插件自己的运行时清单再加一组市场字段**
/// （同一个文件，不是两份）。运行时清单的 `entry` 是必填 —— 早先 registry 只存
/// 市场字段，装完的插件目录里那份 plugin.json 解析不了，插件在界面里显示成
/// 目录名、版本空白，开关也打不开（2026-11-15 真机实测）。
///
/// 四道闸，全部发生在**写盘之前**（失败零字节落盘，与 all-or-nothing 同一口径）：
/// 1. plugin.json 必须能解析成运行时清单（缺 `entry` → 明确报「缺少入口字段」）；
/// 2. 清单的 `id` 必须等于请求的 `id`（目录与清单打架 = 装出来的东西对不上号）；
/// 3. `apiLevel` 高于当前软件 → 拒装并提示升级；
/// 4. index.json 声称的权限必须与清单实际申请的一致（index 远程可写，
///    「面板展示的权限」和「真正签发的权限」必须来自同一份声明）。
fn validate_community_payload(
    id: &str,
    declared_perms: &[String],
    payloads: &[(String, Vec<u8>)],
) -> Result<(), String> {
    let bytes = payloads
        .iter()
        .find(|(p, _)| p == "plugin.json" || p.ends_with("/plugin.json"))
        .map(|(_, b)| b.as_slice())
        .ok_or_else(|| "插件包里没有 plugin.json".to_string())?;
    let m = crate::plugins::parse_manifest_bytes(bytes)?;
    if m.id != id {
        return Err(format!(
            "插件包清单的 id 是「{}」，与要安装的「{id}」不一致，已拒绝安装",
            m.id
        ));
    }
    if m.api_level > crate::plugins::API_LEVEL {
        return Err(format!(
            "这个插件要求 API 级别 {}，当前软件只支持 {}，请升级软件",
            m.api_level,
            crate::plugins::API_LEVEL
        ));
    }
    // 入口脚本必须在包里：没有它清单解析得过、插件也照样起不来
    if !payloads.iter().any(|(p, _)| p == &m.entry) {
        return Err(format!(
            "入口脚本「{}」不在插件包里，装了也跑不起来，已拒绝安装",
            m.entry
        ));
    }
    let norm = |v: &[String]| -> Vec<String> {
        let mut x: Vec<String> = v
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect();
        x.sort();
        x.dedup();
        x
    };
    let want = norm(declared_perms);
    let got = norm(&m.permissions);
    // index 没写权限 = 老格式清单，跳过比对（sha256 那条硬门槛不受影响）
    if !want.is_empty() && want != got {
        return Err(format!(
            "清单声称的权限 {:?} 与插件包实际申请的 {:?} 不一致，已拒绝安装",
            want, got
        ));
    }
    Ok(())
}

/// 社区件安装：逐文件下载 → sha256 校验 → **全部通过后才落盘**（all-or-nothing，
/// 校验到一半失败不写半个残缺插件进目录）→ 热重启在跑的实例。
pub async fn install_community(
    id: &str,
    dir: &str,
    files: Vec<WorkshopFile>,
    declared_perms: &[String],
) -> Result<InstallOutcome, String> {
    // id 来自远程可写的 index.json，会进日志（`[plugin:{id}]`）与目录查找 ——
    // 先过一遍 id 白名单（与 manifest 那条同一份实现），防日志注入（控制字符 / 换行）。
    let id = crate::plugins::sanitize_plugin_id(id)?;
    // registry 的 dir 是仓库相对路径（`plugins/<id>__<author>`）→ 只取最后一段
    let dir_name = dir_name_of(dir)
        .ok_or_else(|| format!("registry 目录名不合法：{dir:?}"))?
        .to_string();
    if files.is_empty() {
        return Err("清单里没有文件，拒绝安装".into());
    }
    // plugin.json 必须在清单里：没有它装完不会被 plugins_list 认出来
    if !files
        .iter()
        .any(|f| f.path == "plugin.json" || f.path.strip_suffix("/plugin.json").is_some())
    {
        return Err("清单里没有 plugin.json —— 这不是完整的插件包".into());
    }
    let mut payloads: Vec<(String, Vec<u8>)> = Vec::with_capacity(files.len());
    for f in &files {
        if !safe_rel_path(&f.path) {
            return Err(format!("越界路径，已拒绝安装：{}", f.path));
        }
        let bytes = get_bytes(&f.url, DOWNLOAD_TIMEOUT).await?;
        payloads.push((f.path.clone(), bytes));
    }
    // 清单硬闸（见函数注释）：写盘之前判「这是不是能跑的插件包」
    validate_community_payload(&id, declared_perms, &payloads)?;
    // 校验 + 落盘放进同一个阻塞线程：**先全部校验、全过了才写**（全有或全无）
    let count = payloads.len();
    let install_id = id.clone();
    let target = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let base = crate::plugins::plugins_dir();
        // 已装清单里有同 id 的目录就装进原地（保留 config/secret/state 数据文件），
        // 否则按 registry 的 `<id>__<author>` 目录名新建
        let target = crate::plugins::install_target_for(&base, &install_id, &dir_name);
        verify_and_write(&target, &files, &payloads)?;
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = crate::plugins::restart_if_running(&id);
    // 名字 / 版本从装好的 plugin.json 里读回来（面板要显示）
    let (name, version) = read_installed_identity(&target);
    Ok(InstallOutcome {
        id,
        name,
        version,
        files: count,
        dir: target.to_string_lossy().to_string(),
    })
}

fn read_installed_identity(dir: &FsPath) -> (String, String) {
    let Ok(text) = std::fs::read_to_string(dir.join("plugin.json")) else {
        return (String::new(), String::new());
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (String::new(), String::new());
    };
    (
        v.get("name")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
        v.get("version")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
    )
}

/// 卸载插件：停进程 → 删目录（与设置页的「禁用」对称，插件中心面板用）
pub fn uninstall_plugin(id: &str) -> Result<(), String> {
    let dir = crate::plugins::plugin_dir_for_id(id)?;
    let _ = crate::plugins::disable(id);
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败：{e}"))
}

// ───────────────────────────── 面板自身 ─────────────────────────────

/// 面板安装目录：跟着**应用数据根**走（`store::app_data_dir()`，即 `data_root()`）。
///
/// 为什么不是 `legacy_app_data_dir()`：那个函数的契约写死了「只给迁移源、
/// 插件老位置判定、卸载白名单三件事用，不要往业务代码里扩散」——
/// 面板目录是业务数据，走了它就等于把面板放在 2.1.4 之前的老账本旁边，
/// 与「数据根唯一入口」的口径打架。
///
/// 为什么不是插件目录（`plugins::plugins_dir()`）：那个目录会跟着安装目录走，
/// MSI 装到 Program Files 时**可能不可写**（插件目录有写探针 + 老用户不搬家
/// 两套兜底），面板要能下载安装换装，必须挑一个稳定可写的地方。
/// `data_root()` 正是为此存在的那个「离程序最近的可写数据根」。
pub fn panel_dir() -> PathBuf {
    store::app_data_dir().join("workshop-panel")
}

/// 面板安装状态（前端拿它决定侧栏入口显不显示）
#[derive(Serialize, Clone, Debug)]
pub struct PanelStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dir: String,
}

pub fn panel_status() -> PanelStatus {
    let dir = panel_dir();
    let has_files = dir.join("workshop.html").is_file();
    let pref = prefs_value("workshopInstalled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    PanelStatus {
        installed: is_panel_installed(pref, has_files),
        version: prefs_str("workshopPanelVersion"),
        dir: dir.to_string_lossy().to_string(),
    }
}

/// 「已安装」要**两个信号都在**才算：
/// - `prefs.workshopInstalled`：安装流程写的那一位，也是「侧栏入口显不显示」的口径；
/// - 文件夹里有没有 `workshop.html`：**真相** —— 用户手动删了目录、或者换了数据根，
///   prefs 会撒谎，文件不会。
/// 只看 prefs 会出现「入口在，点开是白屏」；只看文件会出现「prefs 没写但面板在」，
///   那种情况让用户重下一次就好（重下会补写 pref）。
fn is_panel_installed(prefs_flag: bool, has_workshop_html: bool) -> bool {
    prefs_flag && has_workshop_html
}

fn prefs_value(key: &str) -> Option<Value> {
    let hub = crate::api::hub()?;
    let state = hub.store.0.lock().ok()?;
    state.prefs.get(key).cloned()
}

fn prefs_str(key: &str) -> Option<String> {
    prefs_value(key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
}

fn set_prefs(key: &str, value: Value) -> Result<(), String> {
    let hub = crate::api::hub().ok_or("主程序还没初始化完（API Hub 不可用）")?;
    let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
    let mut prefs = state.prefs.clone();
    if !prefs.is_object() {
        prefs = json!({});
    }
    if let Some(obj) = prefs.as_object_mut() {
        obj.insert(key.to_string(), value);
    }
    state.prefs = prefs;
    store::save_prefs(&state)
}

/// 面板元数据（registry 仓库里的 panel-meta.json）
#[derive(Deserialize)]
struct PanelMeta {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// 流式下载面板包：**跟解释器运行时的下载同一套口径** ——
/// 边下边发进度（每 250ms 一次），所以设置页那条进度条是真的在走，
/// 不是「0% → 100%」两级跳。
///
/// 用 `reqwest::blocking` 而不是 async：读取循环是阻塞的，放进
/// `spawn_blocking` 的线程池里跑，不占主线程，也不占 tokio 的 worker。
fn download_panel_bytes(
    url: &str,
    total_hint: u64,
    app: &AppHandle,
) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    check_host(url)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::net::USER_AGENT)
        .timeout(DOWNLOAD_TIMEOUT)
        // release 资产直链会 302 到 objects / release-assets.githubusercontent.com：
        // 必须跟随，但**每一次重定向都要复检落点 host**（同一个策略，见 redirect_policy）
        .redirect(redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载失败：{e}（检查网络，或到 release 页手动下载）"))?;
    // 服务端给的长度优先；拿不到就退回元数据里的 size
    let total = resp.content_length().unwrap_or(total_hint);
    let mut bytes: Vec<u8> = Vec::with_capacity(total.min(PANEL_MAX_BYTES) as usize);
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut buf = [0u8; 65536];
    loop {
        let n = resp.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > PANEL_MAX_BYTES {
            return Err(format!(
                "面板包太大（已下载 {received} 字节，上限 {PANEL_MAX_BYTES}）"
            ));
        }
        bytes.extend_from_slice(&buf[..n]);
        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            let _ = app.emit(
                "workshop:progress",
                PanelProgress {
                    phase: "download".into(),
                    received,
                    total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    Ok(bytes)
}

/// 下载进度事件（前端设置页用它画进度条）
#[derive(Clone, Serialize)]
struct PanelProgress {
    phase: String,
    received: u64,
    total: u64,
}

/// 取面板元数据（版本 + sha256 + 体积）。12 秒超时，失败原样抛给调用方。
async fn fetch_panel_meta() -> Result<PanelMeta, String> {
    let meta_bytes = get_bytes(PANEL_META_URL, INDEX_TIMEOUT).await?;
    serde_json::from_slice(&meta_bytes).map_err(|e| format!("panel-meta.json 格式不对：{e}"))
}

/// 下载并安装面板（设置 → 插件 →「插件中心」）。
/// 校验口径与检查更新一致：先取元数据里的 sha256，再逐字节比。
#[tauri::command]
pub async fn workshop_panel_download(app: AppHandle) -> Result<PanelStatus, String> {
    let meta = fetch_panel_meta().await?;
    install_panel_from_meta(&app, &meta).await?;
    Ok(panel_status())
}

/// 自动更新时最多两天查一次面板元数据。元数据只有一百多字节，
/// 但常驻型软件开好几天，按「每次启动都查」算下来就是每天十几次 —— 没必要。
const PANEL_CHECK_TTL_SECS: u64 = 24 * 3600;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 面板自动更新的结果。**失败也走这里**（不当成错误弹窗）——
/// 前端只在 `updated` 为真时提示，其余情况全静默。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanelUpdateOutcome {
    /// 这次是否真的联网查了（关掉开关 / 面板没装 / 24 小时内查过 → false）
    pub checked: bool,
    /// 是否装了新版本
    pub updated: bool,
    /// 更新前的版本
    pub from: Option<String>,
    /// 更新后的版本（`updated` 为真时才有）
    pub to: Option<String>,
    /// 当前生效版本（未更新时等于 `from`）
    pub version: Option<String>,
    /// 失败原因：只写 diag，不弹窗
    pub error: Option<String>,
}

/// 面板自动更新：查 meta → 比版本 → 新则**静默装**。
///
/// 为什么需要它：面板是独立产物，**面板更新不跟软件发版走**。没有这条自动通道，
/// 用户装完某个版本就永远停在那个版本 —— 设置页在「已安装」状态下只有「打开 / 卸载」，
/// 压根没有「检查更新」这个动作，他连"有新面板"都不会知道。
///
/// 四条闸门（与 `check_update` 同一套口径，缺一条就变成骚扰或偷偷联网）：
///   ① `pluginCenterAutoUpdate === false` → 一次都不查；
///   ② 面板**没装** → 不查也不自动装（用户明确选择过不装，不能替他改主意）；
///   ③ 24 小时内查过 → 跳过（GitHub 匿名 60 次/小时/IP）；
///   ④ 失败一律静默：断网、限流、仓库改名都是常态，自动更新不该制造错误弹窗。
#[tauri::command]
pub async fn workshop_panel_autoupdate(app: AppHandle) -> Result<PanelUpdateOutcome, String> {
    let auto = !matches!(prefs_value("pluginCenterAutoUpdate"), Some(Value::Bool(false)));
    let st = panel_status();
    let mut out = PanelUpdateOutcome {
        checked: false,
        updated: false,
        from: st.version.clone(),
        to: None,
        version: st.version.clone(),
        error: None,
    };
    if !auto || !st.installed {
        return Ok(out);
    }
    let now = unix_now();
    if let Some(last) = prefs_value("panelUpdateCheckedAt").and_then(|v| v.as_u64()) {
        if now.saturating_sub(last) < PANEL_CHECK_TTL_SECS {
            return Ok(out);
        }
    }
    out.checked = true;

    let meta = match fetch_panel_meta().await {
        Ok(m) => m,
        Err(e) => {
            crate::diag::log(&format!("[workshop] 面板自动更新：取元数据失败 {e}"));
            out.error = Some(e);
            return Ok(out);
        }
    };
    let remote = meta.version.clone().unwrap_or_default();
    // 本机版本记录缺失/损坏时按「需要更新」处理：宁可重装一次面板，也不要卡在旧版。
    let newer = match (
        crate::update::parse_version(&remote),
        st.version.as_deref().and_then(crate::update::parse_version),
    ) {
        (Some(r), Some(cur)) => r > cur,
        (Some(_), None) => true,
        _ => false,
    };
    if !newer {
        let _ = set_prefs("panelUpdateCheckedAt", json!(now));
        return Ok(out);
    }

    match install_panel_from_meta(&app, &meta).await {
        Ok(v) => {
            let _ = set_prefs("panelUpdateCheckedAt", json!(now));
            out.updated = true;
            out.to = Some(v.clone());
            out.version = Some(v.clone());
            // 面板窗口多半处于「藏着」的状态（失焦即 hide），里面跑的还是旧 JS：
            // 直接关掉，下次点入口重新加载新资产。不关的话用户会看到「更新完了界面没变」。
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window(PANEL_LABEL) {
                    let _ = win.close();
                }
            }
            crate::diag::log(&format!(
                "[workshop] 面板已自动更新：v{} → {v}",
                st.version.as_deref().unwrap_or("?")
            ));
            Ok(out)
        }
        Err(e) => {
            // 装失败不写 `panelUpdateCheckedAt`：下次启动再试一次，
            // 免得一次网络抖动让面板卡在旧版一整天。
            crate::diag::log(&format!("[workshop] 面板自动更新失败：{e}"));
            out.error = Some(e);
            Ok(out)
        }
    }
}

/// 真正的下载 + 校验 + 解包 + 写 prefs，返回装好的版本号。
///
/// 抽成函数给「手动下载」与「自动更新」共用：两条路必须走**同一条**校验路径，
/// 否则迟早出现「只有一条带 sha256」这种事故。
async fn install_panel_from_meta(app: &AppHandle, meta: &PanelMeta) -> Result<String, String> {
    let expect_sha = meta
        .sha256
        .as_ref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.len() == 64);
    let expect_size = meta.size.unwrap_or(0);
    // **sha256 是硬门槛**：面板包里是一堆要执行的 JS，缺了校验就是「下载到什么
    // 就装什么」。元数据缺 sha256（或长度不对）时直接拒绝 ——
    // 不接受「先装了再说」。size 是辅助核对，缺了只当未知。
    let Some(expect_sha) = expect_sha else {
        return Err(
            "面板元数据（panel-meta.json）缺少有效的 sha256 —— 拒绝安装未经校验的面板包".into(),
        );
    };

    let _ = app.emit(
        "workshop:progress",
        PanelProgress {
            phase: "download".into(),
            received: 0,
            total: expect_size,
        },
    );
    // 流式下载（阻塞读放在 spawn_blocking 里）
    let download_app = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        download_panel_bytes(PANEL_RELEASE_URL, expect_size, &download_app)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "workshop:progress",
        PanelProgress {
            phase: "download".into(),
            received: bytes.len() as u64,
            total: expect_size,
        },
    );
    if bytes.len() as u64 > PANEL_MAX_BYTES {
        return Err(format!(
            "面板包太大（{} 字节，上限 {PANEL_MAX_BYTES}）",
            bytes.len()
        ));
    }
    if expect_size > 0 && bytes.len() as u64 != expect_size {
        return Err(format!(
            "面板包大小不符（期望 {expect_size}，实际 {}）",
            bytes.len()
        ));
    }
    let got = sha256_hex(&bytes);
    if got != expect_sha {
        return Err(format!(
            "面板包 sha256 校验失败（期望 {expect_sha}，实际 {got}）"
        ));
    }

    let _ = app.emit(
        "workshop:progress",
        PanelProgress {
            phase: "extract".into(),
            received: 0,
            total: expect_size,
        },
    );
    let dir = panel_dir();
    extract_panel_zip(&bytes, &dir)?;

    let version = meta.version.clone().unwrap_or_else(|| "unknown".to_string());
    set_prefs("workshopInstalled", json!(true))?;
    set_prefs("workshopPanelVersion", json!(version))?;
    let _ = app.emit(
        "workshop:progress",
        PanelProgress {
            phase: "done".into(),
            received: bytes.len() as u64,
            total: expect_size,
        },
    );
    crate::diag::log(&format!(
        "[workshop] 插件中心面板已安装：v{version} → {}",
        dir.display()
    ));
    Ok(version)
}

/// 卸载面板：删目录 + 清 prefs（标题栏入口随之消失）
///
/// 必须**同时把面板窗口关掉**：失焦即藏（`close_on_blur`）意味着用户卸载时
/// 窗口对象多半还在（只是藏起来了），不关就会留下一个「目录已删、页面还在内存里」
/// 的僵尸窗口 —— 重新装好再点按钮会 show 出旧页面。
#[tauri::command]
pub fn workshop_panel_uninstall(app: AppHandle) -> Result<PanelStatus, String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        let _ = win.close();
    }
    let dir = panel_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件中心面板目录失败：{e}"))?;
    }
    set_prefs("workshopInstalled", json!(false))?;
    set_prefs("workshopPanelVersion", json!(Value::Null))?;
    Ok(panel_status())
}

/// 面板是否已安装（前端启动时问一次，决定侧栏入口显不显示）
#[tauri::command]
pub fn workshop_panel_status() -> PanelStatus {
    panel_status()
}

/// 解压面板包：只允许 `workshop.html` 与 `assets/` 下的文件
fn extract_panel_zip(bytes: &[u8], dir: &FsPath) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut z = zip::ZipArchive::new(cursor).map_err(|e| format!("面板包不是有效 zip：{e}"))?;
    let staging = dir.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("建目录失败：{e}"))?;
    let mut total: u64 = 0;
    for i in 0..z.len() {
        let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let allowed = name == "workshop.html" || name.starts_with("assets/");
        if !allowed {
            // 面板包里不该有别的东西：直接拒，别「跳过」—— 静默跳过等于装了个残缺的包
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("面板包里有不该有的文件：{name}"));
        }
        if !safe_rel_path(&name) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("面板包里有越界路径，已拒绝：{name}"));
        }
        total += entry.size();
        if total > PANEL_MAX_BYTES {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("面板包解压后超过体积上限".into());
        }
        let out = staging.join(&name);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建目录失败：{e}"))?;
        }
        let mut buf = Vec::with_capacity((entry.size() as usize).min(8 * 1024 * 1024));
        std::io::Read::read_to_end(&mut entry, &mut buf)
            .map_err(|e| format!("读面板包条目失败：{e}"))?;
        std::fs::write(&out, &buf).map_err(|e| format!("写 {} 失败：{e}", out.display()))?;
    }
    if !staging.join("workshop.html").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("面板包里没有 workshop.html".into());
    }
    // 换装：旧目录挪走 → 新目录上位 → 删旧的（失败就回滚）
    let backup = dir.with_extension("old");
    let _ = std::fs::remove_dir_all(&backup);
    if dir.exists() {
        std::fs::rename(&dir, &backup).map_err(|e| format!("替换旧面板失败：{e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, &dir) {
        // 回滚：把旧目录挪回来
        if backup.exists() {
            let _ = std::fs::rename(&backup, &dir);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("安装新面板失败：{e}"));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

// ───────────────────────────── 面板服务 ─────────────────────────────

/// 面板会话状态：一次性 key + 面板目录 + 应用句柄（装/卸插件后广播 `plugins:changed` 用）
struct PanelState {
    key: String,
    dir: PathBuf,
    app: AppHandle,
}

#[derive(Clone)]
struct PanelServerInfo {
    port: u16,
    key: String,
}

static PANEL_SERVER: OnceLock<Mutex<Option<PanelServerInfo>>> = OnceLock::new();

/// 起（并在需要时复用）面板的本地 HTTP 服务：只绑 127.0.0.1，端口随机。
/// 静态文件不带 key（页面自己从 URL 里拿 key 调 API）；三个 API 必须带 key。
///
/// `app` 存进 `PanelState`：面板装/卸插件后要给**主窗口**发 `plugins:changed`，
/// 不然主窗口的插件清单还停在启动时那一份，用户装完看不见（2026-11-15 真机实测）。
fn ensure_panel_server(app: AppHandle, dir: PathBuf) -> Result<PanelServerInfo, String> {
    let cell = PANEL_SERVER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|e| e.to_string())?;
    if let Some(info) = guard.as_ref() {
        return Ok(info.clone());
    }
    let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("绑定 127.0.0.1 失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let key = crate::api::random_hex();
    let state = Arc::new(PanelState {
        key: key.clone(),
        dir,
        app,
    });
    let app = Router::new()
        .route("/", get(panel_index))
        .route("/workshop.html", get(panel_index))
        .route("/assets/{*path}", get(panel_asset))
        .route("/api/plugins", get(api_plugins))
        .route("/api/install", post(api_install))
        .route("/api/uninstall", post(api_uninstall))
        .route("/api/open-url", post(api_open_url))
        .route("/api/tour-done", post(api_tour_done))
        .route("/api/upload-token", get(api_upload_token))
        .route("/api/github/session", get(api_github_session))
        .route("/api/github/device/start", post(api_github_device_start))
        .route("/api/github/device/poll", post(api_github_device_poll))
        .route("/api/github/logout", post(api_github_logout))
        .route("/api/blur-guard", post(api_blur_guard))
        .route(
            "/api/index-cache",
            get(api_index_cache_get).post(api_index_cache_set),
        )
        .route("/api/pick-folders", post(api_pick_folders))
        .route("/api/pick-packages", post(api_pick_packages))
        .with_state(state);
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                crate::diag::log(&format!("[workshop] 监听转换失败：{e}"));
                return;
            }
        };
        if let Err(e) = axum::serve(listener, app).await {
            crate::diag::log(&format!("[workshop] 面板服务退出：{e}"));
        }
    });
    let info = PanelServerInfo { port, key };
    *guard = Some(info.clone());
    crate::diag::log(&format!(
        "[workshop] 面板服务已监听 http://127.0.0.1:{port}/"
    ));
    Ok(info)
}

fn key_ok(st: &PanelState, headers: &axum::http::HeaderMap) -> bool {
    headers
        .get("x-workshop-key")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == st.key)
        .unwrap_or(false)
}

fn json_ok(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

fn json_err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

async fn panel_index(State(st): State<Arc<PanelState>>) -> Response {
    let path = st.dir.join("workshop.html");
    match std::fs::read(&path) {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(e) => json_err(
            StatusCode::NOT_FOUND,
            format!("面板文件不存在（{}）：{e}", path.display()),
        ),
    }
}

fn content_type_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn panel_asset(State(st): State<Arc<PanelState>>, Path(path): Path<String>) -> Response {
    if !safe_rel_path(&path) {
        return json_err(StatusCode::BAD_REQUEST, "非法路径");
    }
    let full = st.dir.join("assets").join(&path);
    match std::fs::read(&full) {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type_for(&path))],
            bytes,
        )
            .into_response(),
        Err(_) => json_err(StatusCode::NOT_FOUND, format!("找不到资源：{path}")),
    }
}

async fn api_plugins(State(st): State<Arc<PanelState>>, headers: axum::http::HeaderMap) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let list: Vec<Value> = crate::plugins::list()
        .into_iter()
        .map(|p| json!({ "id": p.id, "name": p.name, "version": p.version }))
        .collect();
    // 解释器探活：面板只在**确实缺**解释器时才提示「需要 Python 运行时」
    let mut python = false;
    let mut node = false;
    for r in crate::plugins::runtimes_status() {
        let ready = r.bundled_version.is_some() || r.system_version.is_some();
        match r.kind.as_str() {
            "python" => python = ready,
            "node" => node = ready,
            _ => {}
        }
    }
    json_ok(json!({
        "plugins": list,
        "runtimes": { "python": python, "node": node },
        // 主程序版本：面板用它判断插件要求的最低版本（minAppVersion）
        "appVersion": env!("CARGO_PKG_VERSION"),
        // 本地 API 开关（设置 → 插件 → 本地 API）。插件全靠它拿数据：
        // 关着的时候插件装了也跑不起来，面板要**提醒用户去手动打开**。
        // 这里只报告状态 —— 绝不替用户打开（那是用户在设置页的决定）。
        "apiEnabled": prefs_value("apiEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        // 首次导览看过了没有。**存在 prefs 而不是面板的 localStorage**：
        // 面板窗口每次打开都是 127.0.0.1 的**随机端口**，origin 一变
        // localStorage 就换了一份，导览会每次都弹（2026-11-15 实测）。
        "tourDone": prefs_value("workshopTourDone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }))
}

/// 面板发来的安装请求
#[derive(Deserialize)]
struct InstallBody {
    id: String,
    /// "official" = release zip 直链；"community" = 逐文件清单
    kind: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    files: Vec<WorkshopFile>,
    /// index.json 里这个插件声称的权限清单。安装时要和插件包内 plugin.json
    /// 实际申请的逐一对上 —— index.json 是远程可写的，「声称的」和「实际要的」
    /// 必须一致，不然面板展示的权限就是假的（2026-11-15 加的第三道闸）。
    #[serde(default)]
    permissions: Vec<String>,
}

async fn api_install(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<InstallBody>,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let result = if body.kind == "official" {
        match body.url.as_deref() {
            Some(url) => install_official(url).await,
            None => Err("官方件缺少下载地址".into()),
        }
    } else {
        let dir = body
            .dir
            .clone()
            .unwrap_or_else(|| format!("{}__anonymous", body.id));
        install_community(&body.id, &dir, body.files, &body.permissions).await
    };
    match result {
        Ok(outcome) => {
            // 从老 ID 升上来的（`com.fontmanager.font-sync` → `FM-FONT-SYNC`）：
            // 安装是**原地覆盖**老目录（见 plugins::existing_dir_with_id），但老实例
            // 还在内存里跑着，它注册的右键菜单会和新装的那份同时出现 —— 停掉它。
            // 没在运行会返回 Err，忽略即可。
            for old in crate::plugins::legacy_ids_for(&outcome.id) {
                let _ = crate::plugins::disable(old);
            }
            // 主窗口还停在启动时那份插件清单：广播一条变更事件让它立刻重拉，
            // 「装完在插件中心看得见、主界面里却搜不到」就是这么来的。
            let _ = st.app.emit("plugins:changed", ());
            crate::diag::log(&format!(
                "[workshop] 已安装插件：{} v{} → {}",
                outcome.id, outcome.version, outcome.dir
            ));
            json_ok(serde_json::to_value(outcome).unwrap_or(json!({})))
        }
        Err(e) => json_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct IdBody {
    id: String,
}

async fn api_uninstall(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<IdBody>,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    // id 也过一遍白名单：不构成路径逃逸（目录是逐个比对、不 join），
    // 但 `插件未安装：{id}` 会把原始 id 回显给面板 —— 别让面板能把任意字符串
    // 塞进错误信息（控制字符 / 换行）。
    let id = match crate::plugins::sanitize_plugin_id(&body.id) {
        Ok(v) => v,
        Err(e) => return json_err(StatusCode::BAD_REQUEST, e),
    };
    match uninstall_plugin(&id) {
        Ok(()) => {
            // 卸载同样要告诉主窗口：不然设置页 / 搜索建议里还挂着这个插件
            let _ = st.app.emit("plugins:changed", ());
            crate::diag::log(&format!("[workshop] 已卸载插件：{id}"));
            json_ok(json!({ "ok": true }))
        }
        Err(e) => json_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct UrlBody {
    url: String,
}

async fn api_open_url(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<UrlBody>,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    if !body.url.starts_with("https://") && !body.url.starts_with("http://") {
        return json_err(StatusCode::BAD_REQUEST, "只允许打开 http/https 地址");
    }
    if body.url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return json_err(StatusCode::BAD_REQUEST, "地址里有空白或控制字符");
    }
    // 主机白名单：面板只该能打开**插件中心相关**的地址（插件仓库页、release 页）。
    // 不加这道闸的话，面板能让主程序用系统浏览器打开任意 http/https 地址 ——
    // 那是个现成的钓鱼面（面板内容来自远程可写的 index.json）。
    if let Err(e) = check_host(&body.url) {
        return json_err(
            StatusCode::BAD_REQUEST,
            format!("这个地址不在插件中心的白名单里：{e}"),
        );
    }
    // 面板页里的外链（插件仓库、release 页）交给系统浏览器打开
    let Some(app) = crate::plugins::app_handle() else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "主程序句柄不可用");
    };
    // 用全限定路径调 trait 方法（与 lib.rs 里的写法一致）：这里如果再
    // `use tauri_plugin_opener::OpenerExt;` 会得到一条 unused import 警告。
    match tauri_plugin_opener::OpenerExt::opener(&app).open_url(&body.url, None::<&str>) {
        Ok(()) => json_ok(json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

/// 记下「首次导览看过了」。
///
/// 为什么不由面板自己写 localStorage：面板窗口每次打开都是 127.0.0.1 的
/// **随机端口**，origin 一变 localStorage 就换一份 —— 导览会每次都弹。
/// 状态放 prefs 才能跨窗口记住（面板本身不碰文件系统，只能让主程序代写）。
async fn api_tour_done(State(st): State<Arc<PanelState>>, headers: axum::http::HeaderMap) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    match set_prefs("workshopTourDone", json!(true)) {
        Ok(()) => json_ok(json!({ "ok": true })),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ───────────────────── 上传令牌（M3）─────────────────────
//
// 上传 = 面板拿用户的 GitHub token 直接调 api.github.com（fork → 建 blob/tree/commit
// → 开 PR）。token 必须**跨面板窗口存活**，又不能放 localStorage ——
// 面板窗口每次打开端口都不同，origin 一变 localStorage 就换一份（导览状态踩过这坑）。
// 所以放主程序这边：加密落盘 + 走带一次性 key 的本地端点取回。
//
// 加密用 Windows DPAPI（当前用户作用域）：别的账号、拷到别的机器都解不开。

fn upload_token_path() -> PathBuf {
    store::app_data_dir().join("workshop-upload-token.bin")
}

/// DPAPI 加解密（`encrypt=false` 为解密）。非 Windows 平台退回原样存 ——
/// 本项目只发 Windows 包，Linux 构建只为 CI 能过，不该因为缺 DPAPI 就编不过。
#[cfg(windows)]
fn dpapi(encrypt: bool, data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };
    /// 不弹任何 UI：面板是后台窗口，弹框会让调用方一直等
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input as *const CRYPT_INTEGER_BLOB,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input as *const CRYPT_INTEGER_BLOB,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(format!(
            "DPAPI 失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    // 出参的缓冲区是系统分配的，拷出来之后必须 LocalFree
    let out = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(out)
}

#[cfg(not(windows))]
fn dpapi(encrypt: bool, data: &[u8]) -> Result<Vec<u8>, String> {
    let _ = encrypt;
    Ok(data.to_vec())
}

fn read_upload_token() -> Option<String> {
    let raw = std::fs::read(upload_token_path()).ok()?;
    let plain = dpapi(false, &raw).ok()?;
    let token = String::from_utf8(plain).ok()?.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn write_upload_token(token: &str) -> Result<(), String> {
    let path = upload_token_path();
    let sealed = dpapi(true, token.as_bytes())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    // 先写临时文件再 rename：中途失败也不会留下半截密文（解不开 = 令牌凭空丢了）
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &sealed).map_err(|e| format!("写令牌失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("落盘令牌失败：{e}"))?;
    Ok(())
}

/// 取回**当前登录用户**的令牌（没有就是 null）。
///
/// 令牌只有一个来源：用户在面板里走完一次 GitHub 设备码登录（见上面那一段）。
/// 面板不能自己收令牌，也不内置任何令牌 —— 2026-11-19 用户口径。
///
/// 这里**把明文回给面板页面**是没办法的事：调 GitHub API 的是页面里的 JS
/// （Rust 侧代调等于再写一遍 fork/PR 那套逻辑）。能读到它的前提是拿到
/// 本次会话的一次性 key —— 那个 key 只出现在主程序开窗时拼的 URL 里。
async fn api_upload_token(State(st): State<Arc<PanelState>>, headers: axum::http::HeaderMap) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    json_ok(json!({ "token": read_upload_token() }))
}

// ── GitHub 账号（Device Flow）────────────────────────────────────────────
//
// **面板不接收、也不内置任何令牌**（2026-11-19 用户口径）：上传能力只来自
// 「用户自己在本机登录一次 GitHub」。流程全部在 Rust 侧完成，页面只看得到
// 8 位设备码、登录名和进度 —— 令牌本身不经过页面 JS。
//
// 为什么不能像 api.github.com 那样直接由页面 fetch：
// `github.com/login/device/code` 与 `/login/oauth/access_token` **不发 CORS 头**
// （只有 api.github.com 发 `Access-Control-Allow-Origin: *`），
// webview 里 fetch 会被浏览器直接拦掉，所以这两步必须由主程序代做。

/// GitHub OAuth App 的 `client_id`（Device Flow 没有 client_secret，可安全内置）。
///
/// **留空 = 未配置**：面板会显示「软件还没有配置 OAuth App」并给出配置步骤，
/// 而不是让用户对着一个 400 猜。申请方式：GitHub → Settings → Developer settings
/// → OAuth Apps → New OAuth App，勾上 **Enable Device Flow**，然后把 client_id
/// 填到这里（`Iv1.` 或 `Ov23li...` 开头，不是 client_secret）。
pub const GITHUB_CLIENT_ID: &str = "Ov23lirUWCuWuZ2B8MGY";

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
/// fork 自己的仓库 + 开 PR 需要写权限：`public_repo` 够用，且碰不到私有仓。
///
/// **不要为了「同步 fork」加 `workflow`**（2026-11-25 讨论后否掉）：上游 main 里有
/// `.github/workflows/*`，缺这个 scope 时 `merge-upstream` 会被拒（回 404/422），
/// 但这**不是**下架失败的原因 —— 下架已经改走 `[takedown]` issue 通道，不碰 fork；
/// 上传也不需要 fork 与上游一致（PR 按 merge-base 算 diff）。
/// 加它等于让每个用户多授权「可管理 Actions」，与最小权限相悖。
const GITHUB_SCOPE: &str = "public_repo";
const GITHUB_TIMEOUT: Duration = Duration::from_secs(20);

/// 一轮设备码登录的中间状态。**只存 device_code，不存令牌** ——
/// 令牌只在拿到那一刻写进 DPAPI 文件，之后连进程内都不保留副本。
struct PendingDevice {
    device_code: String,
    /// 轮询间隔（秒）。GitHub 回 `slow_down` 时要往上加，见 [`apply_slow_down`]。
    interval: u64,
    expires_at: std::time::Instant,
}

static PENDING_DEVICE: OnceLock<Mutex<Option<PendingDevice>>> = OnceLock::new();
/// 当前登录名缓存：面板每次打开都会问一次会话，缓存住就不必每次都打 GitHub。
static SESSION_LOGIN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn pending_device() -> &'static Mutex<Option<PendingDevice>> {
    PENDING_DEVICE.get_or_init(|| Mutex::new(None))
}

fn session_login() -> &'static Mutex<Option<String>> {
    SESSION_LOGIN.get_or_init(|| Mutex::new(None))
}

/// 认证专用客户端：**不复用** [`client`]，因为后者的重定向白名单是为下载资产定的
/// （没有 api.github.com），拿它调 `/user` 会直接被自己的策略拒掉。
fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::net::USER_AGENT)
        .timeout(GITHUB_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// `application/x-www-form-urlencoded` 的一条键值对。
///
/// 没有用 `reqwest` 的 `.form()`：那个方法要开 `form` feature，而我们为省体积
/// 关掉了默认特性。这里手写编码比为一个方法多拖一个 feature 划算 ——
/// 只按 RFC 3986 的 unreserved 集合放行，其余一律 `%XX`（`:` `/` 都在其中，
/// `grant_type` 的值正好需要）。
/// RFC 3986 percent-encoding（只放行 unreserved 集合）。表单与查询串共用一份。
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", pct(k), pct(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 一次轮询的结果。抽成纯函数是为了能单测 —— 这里每个分支都对应一句要给用户看的话。
#[derive(Debug, PartialEq)]
enum PollOutcome {
    Token(String),
    Pending,
    SlowDown,
    Expired,
    Denied,
    Failed(String),
}

fn parse_poll(v: &Value) -> PollOutcome {
    if let Some(tok) = v.get("access_token").and_then(Value::as_str) {
        if !tok.trim().is_empty() {
            return PollOutcome::Token(tok.trim().to_string());
        }
    }
    match v.get("error").and_then(Value::as_str).unwrap_or("") {
        "authorization_pending" => PollOutcome::Pending,
        "slow_down" => PollOutcome::SlowDown,
        "expired_token" => PollOutcome::Expired,
        "access_denied" => PollOutcome::Denied,
        // 剩下这些是配置问题，不是用户操作问题：原样带出去，别让用户以为再试一次就好
        "device_flow_disabled" => {
            PollOutcome::Failed("这个 OAuth App 没启用 Device Flow（GitHub 应用设置里勾上）".into())
        }
        "unauthorized_client" | "incorrect_client_credentials" => {
            PollOutcome::Failed("client_id 不对：填的是 OAuth App 的 client_id，不是 client_secret".into())
        }
        "" => PollOutcome::Failed(format!("GitHub 返回了看不懂的响应：{v}")),
        other => PollOutcome::Failed(
            v.get("error_description")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .map(|d| format!("{other}：{d}"))
                .unwrap_or_else(|| other.to_string()),
        ),
    }
}

/// `slow_down` 之后 GitHub 要求至少多等 5 秒。夹一个 60 秒上限，
/// 免得某个实现一直回 slow_down 把面板的轮询周期拖到分钟级。
fn apply_slow_down(interval: u64) -> u64 {
    (interval + 5).min(60)
}

fn clear_pending() {
    if let Ok(mut g) = pending_device().lock() {
        *g = None;
    }
}

async fn github_whoami(token: &str) -> Result<String, String> {
    let res = github_client()?
        .get(GITHUB_USER_URL)
        .bearer_auth(token)
        .header(header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    v.get("login")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "GitHub 没有返回登录名".to_string())
}

/// 当前会话：`configured=false` 表示软件还没配 client_id（不是用户没登录）。
async fn api_github_session(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    if GITHUB_CLIENT_ID.is_empty() {
        return json_ok(json!({ "configured": false, "login": null }));
    }
    if let Some(login) = session_login().lock().ok().and_then(|g| g.clone()) {
        return json_ok(json!({ "configured": true, "login": login }));
    }
    let Some(token) = read_upload_token() else {
        return json_ok(json!({ "configured": true, "login": null }));
    };
    // 网络抖动不该把用户踢下线：只报「没登录」，不删令牌
    match github_whoami(&token).await {
        Ok(login) => {
            if let Ok(mut g) = session_login().lock() {
                *g = Some(login.clone());
            }
            json_ok(json!({ "configured": true, "login": login }))
        }
        Err(_) => json_ok(json!({ "configured": true, "login": null })),
    }
}

async fn api_github_device_start(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    if GITHUB_CLIENT_ID.is_empty() {
        return json_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "软件还没有配置 OAuth App 的 client_id，暂时无法登录 GitHub",
        );
    }
    let res = match github_client() {
        Ok(c) => c,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
    .post(GITHUB_DEVICE_CODE_URL)
    .header(header::ACCEPT, "application/json")
    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
    .body(form_encode(&[
        ("client_id", GITHUB_CLIENT_ID),
        ("scope", GITHUB_SCOPE),
    ]))
    .send()
    .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return json_err(StatusCode::BAD_GATEWAY, format!("连不上 GitHub：{e}")),
    };
    if !res.status().is_success() {
        return json_err(
            StatusCode::BAD_GATEWAY,
            format!("GitHub 拒绝发起登录（HTTP {}）", res.status().as_u16()),
        );
    }
    let v: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return json_err(StatusCode::BAD_GATEWAY, format!("GitHub 回了非 JSON：{e}")),
    };
    let (Some(code), Some(user_code), Some(uri)) = (
        v.get("device_code").and_then(Value::as_str),
        v.get("user_code").and_then(Value::as_str),
        v.get("verification_uri").and_then(Value::as_str),
    ) else {
        return json_err(
            StatusCode::BAD_GATEWAY,
            "GitHub 的响应里缺 device_code / user_code / verification_uri",
        );
    };
    let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(900);
    let interval = v.get("interval").and_then(Value::as_u64).unwrap_or(5).max(1);
    if let Ok(mut g) = pending_device().lock() {
        *g = Some(PendingDevice {
            device_code: code.to_string(),
            interval,
            expires_at: std::time::Instant::now() + Duration::from_secs(expires_in),
        });
    }
    // 「一按就进」的完整地址：把设备码带在查询串里，浏览器打开时 GitHub 会直接
    // 把它填好（`gh` CLI 就是这么干的）。不这么做的话，用户要在浏览器里手抄
    // 8 位码 —— 那一步是把「能用」变成「不想用」的地方（2026-11-19 用户反馈：
    // 「小白都能用」）。手抄的退路仍然留着：面板上照样把码显示出来。
    let uri_complete = format!("{uri}?user_code={}", pct(user_code));
    json_ok(json!({
        "userCode": user_code,
        "verificationUri": uri,
        "verificationUriComplete": uri_complete,
        "expiresIn": expires_in,
        "interval": interval,
    }))
}

/// 轮询一次。**由面板控制节奏**（每 interval 秒问一次），主程序不自己起后台轮询 ——
/// 用户关掉面板就该立刻停，后台线程反而容易忘记停。
async fn api_github_device_poll(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let Some((code, interval, expired)) = pending_device().lock().ok().and_then(|g| {
        g.as_ref().map(|p| {
            (
                p.device_code.clone(),
                p.interval,
                std::time::Instant::now() >= p.expires_at,
            )
        })
    }) else {
        return json_ok(json!({ "status": "none" }));
    };
    if expired {
        clear_pending();
        return json_ok(json!({ "status": "expired" }));
    }
    let res = match github_client() {
        Ok(c) => c,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
    .post(GITHUB_TOKEN_URL)
    .header(header::ACCEPT, "application/json")
    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
    .body(form_encode(&[
        ("client_id", GITHUB_CLIENT_ID),
        ("device_code", code.as_str()),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
    ]))
    .send()
    .await;
    let v: Value = match res {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => return json_err(StatusCode::BAD_GATEWAY, format!("GitHub 回了非 JSON：{e}")),
        },
        Err(e) => return json_err(StatusCode::BAD_GATEWAY, format!("连不上 GitHub：{e}")),
    };
    match parse_poll(&v) {
        PollOutcome::Token(token) => {
            clear_pending();
            if let Err(e) = write_upload_token(&token) {
                return json_err(StatusCode::INTERNAL_SERVER_ERROR, e);
            }
            match github_whoami(&token).await {
                Ok(login) => {
                    if let Ok(mut g) = session_login().lock() {
                        *g = Some(login.clone());
                    }
                    json_ok(json!({ "status": "ok", "login": login }))
                }
                // 拿到了令牌却读不到登录名：令牌已经落盘，下一次问会话时还能救回来
                Err(e) => json_ok(json!({ "status": "ok", "login": null, "warn": e })),
            }
        }
        PollOutcome::Pending => json_ok(json!({ "status": "pending", "interval": interval })),
        PollOutcome::SlowDown => {
            let next = apply_slow_down(interval);
            if let Ok(mut g) = pending_device().lock() {
                if let Some(p) = g.as_mut() {
                    p.interval = next;
                }
            }
            json_ok(json!({ "status": "slow_down", "interval": next }))
        }
        PollOutcome::Expired => {
            clear_pending();
            json_ok(json!({ "status": "expired" }))
        }
        PollOutcome::Denied => {
            clear_pending();
            json_ok(json!({ "status": "denied" }))
        }
        PollOutcome::Failed(msg) => {
            clear_pending();
            json_ok(json!({ "status": "error", "message": msg }))
        }
    }
}

/// 退出登录：删掉本机的令牌文件 + 清掉会话缓存。
async fn api_github_logout(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    clear_pending();
    if let Ok(mut g) = session_login().lock() {
        *g = None;
    }
    match std::fs::remove_file(upload_token_path()) {
        Ok(()) => json_ok(json!({ "ok": true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json_ok(json!({ "ok": true })),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("删除令牌失败：{e}")),
    }
}

#[derive(serde::Deserialize)]
struct BlurGuardBody {
    #[serde(default)]
    locked: bool,
}

async fn api_blur_guard(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<BlurGuardBody>,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    BLUR_GUARD.store(body.locked, std::sync::atomic::Ordering::Relaxed);
    json_ok(json!({ "ok": true, "locked": body.locked }))
}

/// 清单缓存（本机落盘）：面板首屏先读它，**再**在后台刷新 index.json。
///
/// 为什么必须由主程序存（2026-11-15 用户：「插件中心加载的有点慢」）：
/// 面板每次打开都是一个**新窗口**，服务端口是 `bind(:0)` 随机分配的，
/// 也就是 origin 每次都变 —— localStorage 按 origin 隔离，等于根本没有跨次缓存。
/// 所以「打开面板就等一次 raw.githubusercontent.com」只能在这里解决。
///
/// 存的是面板已经解析过的 entries + fetchedAt（原样 JSON 透传，Rust 不解析语义），
/// 上限 4MB：正常清单几十 KB，超过这个数只可能是异常数据，别把用户数据目录塞爆。
fn index_cache_path() -> PathBuf {
    store::app_data_dir().join("workshop-index-cache.json")
}

const INDEX_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

async fn api_index_cache_get(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let cache = match std::fs::read(index_cache_path()) {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice::<Value>(&bytes).ok(),
        _ => None,
    };
    json_ok(json!({ "ok": true, "cache": cache }))
}

async fn api_index_cache_set(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    if body.len() > INDEX_CACHE_MAX_BYTES {
        return json_err(StatusCode::PAYLOAD_TOO_LARGE, "清单缓存过大，已拒绝写入");
    }
    // 先确认是合法 JSON 再落盘：这个文件下次打开会被直接当数据用，
    // 写进半截内容等于把面板首屏打坏（而坏掉的正是「加载」这条路）。
    if serde_json::from_slice::<Value>(&body).is_err() {
        return json_err(StatusCode::BAD_REQUEST, "缓存内容不是合法 JSON");
    }
    let path = index_cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 先写临时文件再 rename：中途断电/崩溃不会留下半截 JSON
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &body) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("写清单缓存失败：{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("替换清单缓存失败：{e}"),
        );
    }
    json_ok(json!({ "ok": true }))
}

/// 选插件文件夹并**在 Rust 侧把文件读出来**（M3 上传的第一步）。
///
/// 为什么不用网页的 `<input type="file" webkitdirectory>`：
/// ① 面板的既有口径就是「自己碰不到文件系统」（下载、校验、写盘全在 Rust 侧）；
/// ② 目录选择要弹系统对话框，**面板是失焦即藏的**，走网页那条路得靠守位位兜着，
///    而对话框由我们自己拉起时，顺序完全可控；
/// ③ 20MB 的文件在 JS 里再拷一遍没必要。
///
/// 体积上限与校验脚本同口径：单文件 >10MB 就不读内容（前端会按 size 报错），
/// 累计 >20MB 之后也停读 —— 避免有人选了个装着几个 G 字体包的目录把内存打爆。
#[derive(Serialize)]
struct PickedFileOut {
    path: String,
    size: u64,
    /// base64；超过上限的文件留空串（前端据此报「文件太大」）
    content: String,
}

const PICK_MAX_FILE: u64 = 10 * 1024 * 1024;
const PICK_MAX_TOTAL: u64 = 20 * 1024 * 1024;

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 递归列出目录下的普通文件（跳过隐藏项 —— `.git` / `.DS_Store` 之类 registry 也不收）
fn walk_plugin_dir(root: &FsPath, dir: &FsPath, out: &mut Vec<(String, u64)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk_plugin_dir(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            out.push((rel, meta.len()));
        }
        // 符号链接一律不跟：registry 也不收（避免把盘外的东西带进包里）
    }
    Ok(())
}

/// 一次「选目录」的产物：一个插件目录 = 一个 `PickedDirOut`。
///
/// 2026-11-15 用户要求：**可以一次上传多个插件**，不是只能一个。
/// 所以对话框用 `blocking_pick_folders`（系统原生多选），每个目录各读一遍。
#[derive(Serialize)]
struct PickedDirOut {
    dirName: String,
    files: Vec<PickedFileOut>,
}

async fn api_pick_folders(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let app = st.app.clone();
    // 阻塞式对话框必须离开 async runtime 线程：它要等用户操作，卡住的就是整个执行器
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().blocking_pick_folders()
    })
    .await;
    let picked = match picked {
        Ok(v) => v,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("打开对话框失败：{e}")),
    };
    let Some(paths) = picked else {
        // 用户取消：不是错误，前端据此什么也不做
        return json_ok(json!({ "cancelled": true, "dirs": [] }));
    };

    let mut dirs: Vec<PickedDirOut> = Vec::new();
    for file_path in paths {
        let dir = match file_path.into_path() {
            Ok(p) => p,
            Err(e) => {
                return json_err(StatusCode::BAD_REQUEST, format!("这个位置读不了：{e}"))
            }
        };
        let mut listed: Vec<(String, u64)> = Vec::new();
        if let Err(e) = walk_plugin_dir(&dir, &dir, &mut listed) {
            return json_err(StatusCode::BAD_REQUEST, format!("读取目录失败：{e}"));
        }
        listed.sort_by(|a, b| a.0.cmp(&b.0));

        // 体积上限**按插件算**（与校验脚本同口径：单插件 20MB），不是按整批算
        let mut files: Vec<PickedFileOut> = Vec::with_capacity(listed.len());
        let mut total: u64 = 0;
        for (rel, size) in listed {
            let read = size <= PICK_MAX_FILE && total + size <= PICK_MAX_TOTAL;
            let content = if read {
                match std::fs::read(dir.join(&rel)) {
                    Ok(bytes) => {
                        total += bytes.len() as u64;
                        b64_encode(&bytes)
                    }
                    Err(_) => String::new(),
                }
            } else {
                String::new()
            };
            files.push(PickedFileOut {
                path: rel,
                size,
                content,
            });
        }
        dirs.push(PickedDirOut {
            dirName: dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            files,
        });
    }
    json_ok(json!({ "cancelled": false, "dirs": dirs }))
}

/// 解一个插件分发包（zip）成「一个插件目录」的形态，供 `/api/pick-packages` 用。
///
/// 为什么要有这条：插件中心原来只认文件夹，而作者手上通常只有分发包 zip，
/// 得先解压、再找准那一层目录 —— 解压工具默认多套一层
/// （`Adobe套字器-0.3.3/plugin.json`），选错就报「缺 plugin.json」，非常劝退。
/// 这里直接在内存里解开、**剥掉唯一的顶层目录**，前端拿到的结构与「选文件夹」完全一致。
///
/// 三道线：
/// 1. 条目路径必须过 `safe_rel_path`（拒 `..` / 盘符 / 反斜杠 / 绝对路径）—— zip slip
///    是压缩包最常见的攻击面，`zip` crate 自身会清洗一部分，但这里不依赖它，直接拒；
/// 2. 跳过 macOS 打包残留（`__MACOSX/`、`._*`）与点开头的垃圾文件；
/// 3. 体积口径与「选目录」一致：单文件 >10MB 不读内容，累计 >20MB 之后停读。
///
/// `dirName` 取「剥掉的那层顶层目录名」，没有顶层目录就取 zip 文件名（去后缀），
/// 用户在弹窗里看到的名字才和手上的包对得上。
fn read_zip_package(path: &FsPath) -> Result<PickedDirOut, String> {
    use std::io::Read as _;

    let file = std::fs::File::open(path).map_err(|e| format!("打不开这个压缩包：{e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("这不是有效的 zip（或使用了不支持的压缩算法）：{e}"))?;

    // 第一遍只收集名字与大小：读内容要可变借用 archive，不能边遍历边读
    let mut entries: Vec<(usize, String, u64)> = Vec::new();
    for i in 0..zip.len() {
        let e = match zip.by_index(i) {
            Ok(e) => e,
            Err(err) => return Err(format!("读取压缩包条目失败：{err}")),
        };
        if e.is_dir() {
            continue;
        }
        let name = e.name().replace('\\', "/");
        if name.is_empty() || name.starts_with("__MACOSX/") || name.split('/').any(|s| s.starts_with("._"))
        {
            continue;
        }
        // 顶层目录名本身也参与校验：恶意包常用一层 `..%2f` 之类的名字混过去
        if !safe_rel_path(&name) {
            return Err(format!("压缩包里有不安全的路径：{name}"));
        }
        entries.push((i, name, e.size()));
    }
    if entries.is_empty() {
        return Err("压缩包里没有文件".into());
    }

    // 剥顶层目录：所有条目同属一个非根目录、且根级没有 plugin.json 时才剥。
    // 根级已经有 plugin.json 就说明用户是对的内容打包，别动它的结构。
    let has_root_manifest = entries.iter().any(|(_, n, _)| n == "plugin.json");
    let mut prefix: Option<String> = None;
    if !has_root_manifest {
        for (_, name, _) in &entries {
            let top = name.split('/').next().unwrap_or("");
            if !name.contains('/') || top.is_empty() {
                prefix = None;
                break;
            }
            match &prefix {
                None => prefix = Some(top.to_string()),
                Some(p) if p != top => {
                    prefix = None;
                    break;
                }
                _ => {}
            }
        }
    }
    let prefix = prefix.map(|p| p + "/");

    let mut files: Vec<PickedFileOut> = Vec::with_capacity(entries.len());
    let mut total: u64 = 0;
    for (index, name, size) in entries {
        let rel = match &prefix {
            Some(p) if name.starts_with(p) => name[p.len()..].to_string(),
            _ => name,
        };
        if rel.is_empty() {
            continue;
        }
        let read = size <= PICK_MAX_FILE && total + size <= PICK_MAX_TOTAL;
        let content = if read {
            let mut e = zip
                .by_index(index)
                .map_err(|err| format!("读取 {rel} 失败：{err}"))?;
            let mut buf = Vec::with_capacity((size as usize).min(8 * 1024 * 1024));
            e.read_to_end(&mut buf)
                .map_err(|err| format!("解压 {rel} 失败：{err}"))?;
            total += buf.len() as u64;
            b64_encode(&buf)
        } else {
            String::new()
        };
        files.push(PickedFileOut {
            path: rel,
            size,
            content,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let dir_name = prefix
        .as_deref()
        .map(|p| p.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "package".into())
        });
    Ok(PickedDirOut {
        dirName: dir_name,
        files,
    })
}

/// `POST /api/pick-packages`：选 zip 分发包 → 解压 → 与「选文件夹」同形返回。
///
/// 有这条之后上传插件不必先解压：选包、看清单预填、上传，一步到位。
async fn api_pick_packages(
    State(st): State<Arc<PanelState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !key_ok(&st, &headers) {
        return json_err(StatusCode::UNAUTHORIZED, "面板会话已失效，请重新打开插件中心");
    }
    let app = st.app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .add_filter("插件包", &["zip"])
            .blocking_pick_files()
    })
    .await;
    let picked = match picked {
        Ok(v) => v,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("打开对话框失败：{e}")),
    };
    let Some(paths) = picked else {
        return json_ok(json!({ "cancelled": true, "dirs": [] }));
    };

    let mut dirs: Vec<PickedDirOut> = Vec::new();
    for fp in paths {
        let path = match fp.into_path() {
            Ok(p) => p,
            Err(e) => return json_err(StatusCode::BAD_REQUEST, format!("这个位置读不了：{e}")),
        };
        match read_zip_package(&path) {
            Ok(d) => dirs.push(d),
            Err(e) => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "{}：{e}",
                        path.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    ),
                )
            }
        }
    }
    json_ok(json!({ "cancelled": false, "dirs": dirs }))
}

/// 打开插件中心面板窗口：起本地服务 → 拼一次性 URL → 开窗（复用插件面板机制）
///
/// **2026-11-19 起这不是主路径**：用户要求「直接在软件窗口里打开」（与设置面板
/// 同尺寸同位置），前端改用 `workshop_panel_url` + iframe 内嵌。这个命令留着，
/// 一是给「内嵌加载失败」保底（将来可以一键降级成独立窗口），二是老版本面板/脚本
/// 还可能调它。改行为前先确认没有回退路径。
#[tauri::command]
pub fn workshop_open_panel(app: AppHandle, lang: String) -> Result<(), String> {
    let status = panel_status();
    if !status.installed {
        return Err("插件中心面板还没安装（设置 → 插件 → 插件中心）".into());
    }
    // 单例：插件中心**永远只有一个窗口**。用户多次点入口时，这里必须只把已有窗口
    // 唤到前台（显示 / 取消最小化 / 聚焦），不能再建一个 —— 同名 label 会直接
    // 建窗失败，表现为「点了没反应」。
    //
    // 三种状态都要覆盖：可见但在别的窗口后面（set_focus）、被最小化（unminimize）、
    // 以及历史上失焦隐藏留下的 hide 状态（show）。第三种是兼容旧行为，不是主路径。
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        if win.is_visible().unwrap_or(true) {
            // 已经摆在眼前：只是把焦点抢回来
            let _ = win.set_focus();
        } else {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }
    let info = ensure_panel_server(app.clone(), panel_dir())?;
    let theme = panel_theme_str();
    let url = format!(
        "http://127.0.0.1:{}/workshop.html?k={}&lang={}&theme={}",
        info.port,
        info.key,
        urlencoding(&lang),
        theme
    );
    // 诊断日志（2026-11-15 真机白屏排查）：**记下实际开窗用的 URL**（key 打码）
    // 与提交结果。注意：这里只是把建窗**提交**到主线程（`run_on_main_thread`），
    // 真正建没建成看 `[panel/workshop-panel] 面板窗口已创建 / 创建失败` 那条 ——
    // 早先这里写「面板窗口已创建」是**不准确的**（成功失败都会先打这行）。
    crate::diag::log(&format!(
        "[workshop] 打开面板窗口：url=http://127.0.0.1:{}/workshop.html?k=***&lang={}&theme={}",
        info.port,
        urlencoding(&lang),
        theme
    ));
    let opened = crate::plugins::open_panel_window_with_label(
        &app,
        PANEL_LABEL,
        &url,
        panel_window_title(&lang),
        // 2026-11-19 用户改口径：**不再失焦即藏**。以前点主窗口任何地方这个窗口就消失，
        // 用户想对照着主界面里的字体挑插件时非常难用。现在它是一个普通窗口：
        // 只有点 X 才会关；点别处只是失去焦点，窗口留着。
        false,
    );
    match &opened {
        Ok(()) => crate::diag::log("[workshop] 面板窗口创建请求已提交（结果见 [panel/workshop-panel] 那条）"),
        Err(e) => crate::diag::log(&format!("[workshop] 面板窗口创建请求提交失败：{e}")),
    }
    opened
}

/// 面板要用的主题串（与面板前端的约定：`light` / `dark` / `system`）。
///
/// 抽出来是因为现在有两个入口用同一份：内嵌（iframe）与保底的独立窗口。
/// 两处各写一套 match 就会漂 —— 曾经踩过「窗口深色、面板浅色」的错配。
fn panel_theme_str() -> &'static str {
    match crate::plugins::panel_theme() {
        Some(tauri::Theme::Light) => "light",
        Some(tauri::Theme::Dark) => "dark",
        _ => "system",
    }
}

/// 取插件中心面板的地址（**不建窗口**）：起 / 复用回环服务，拼上一次性会话 key。
///
/// 主窗口用 `<iframe src=…>` 内嵌它 —— 面板里的请求全是 `/api/*` 相对路径，
/// 在 iframe 里同源，不需要 postMessage 转发任何东西（也就不必给面板加一套
/// 「宿主桥」，面板仍是可独立更新的产物）。
///
/// **每次打开都要重新取**：key 是进程级的，服务重启后端口和 key 都会变，
/// 缓存下来的旧地址会 401。
#[tauri::command]
pub fn workshop_panel_url(app: AppHandle, lang: String) -> Result<String, String> {
    let status = panel_status();
    if !status.installed {
        return Err("插件中心面板还没安装（设置 → 插件 → 插件中心）".into());
    }
    let info = ensure_panel_server(app, panel_dir())?;
    Ok(format!(
        "http://127.0.0.1:{}/workshop.html?k={}&lang={}&theme={}",
        info.port,
        urlencoding(&info.key),
        urlencoding(&lang),
        panel_theme_str()
    ))
}

/// 面板窗口标题（按界面语言）。**照抄面板 i18n 的 `title` 词条**，
/// 别在 Rust 侧另起一套译名 —— 两处各写一套就会漂。
fn panel_window_title(lang: &str) -> &'static str {
    match lang {
        "zh-CN" | "zh-TW" => "插件中心",
        "en" => "Plugin Center",
        "de" => "Plugin-Center",
        "es" => "Centro de plugins",
        "fr" => "Centre de plugins",
        "ja" => "プラグインセンター",
        "pt-BR" => "Central de Plugins",
        "ru" => "Центр плагинов",
        // 未知语言码回落英文（主包也是这个口径）
        _ => "Plugin Center",
    }
}

/// 极简 URL 编码：面板语言码只可能是 `zh-CN` / `pt-BR` 这类固定串，
/// 但仍要编码 —— 免得哪天传进来带 `&` 就能拼出第二个参数。
fn urlencoding(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 上传令牌靠 DPAPI 存本机：加密→解密的往返必须原样还原，且密文不能等于明文。
    ///
    /// 这条以前没有测试，而它是「粘一次令牌、以后不再问」的唯一支撑 ——
    /// 加密参数写错（比如漏了 `CRYPTPROTECT_UI_FORBIDDEN`）在真机上表现为
    /// 面板弹一个系统框或直接读回空串，用户只会觉得「连不上账号」。
    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_keeps_token_readable() {
        let plain = b"github_pat_FONTMANAGER_SELFTEST_0123456789";
        let enc = dpapi(true, plain).expect("DPAPI 加密失败");
        assert_ne!(enc.as_slice(), plain, "密文不该等于明文");
        let dec = dpapi(false, &enc).expect("DPAPI 解密失败");
        assert_eq!(dec.as_slice(), plain);
        // 乱码输入：只允许返回 Err，不能让进程崩（面板会显示「令牌用不了」）
        assert!(dpapi(false, b"not-a-dpapi-blob").is_err());
    }

    #[test]
    fn rel_path_rejects_escape() {
        assert!(safe_rel_path("assets/app.js"));
        assert!(safe_rel_path("main.py"));
        assert!(!safe_rel_path("../evil.py"));
        assert!(!safe_rel_path("C:/evil.py"));
        assert!(!safe_rel_path("a\\b.py"));
        assert!(!safe_rel_path("/abs.py"));
        assert!(!safe_rel_path(""));
    }

    #[test]
    fn dir_name_is_narrow() {
        assert!(safe_dir_name("font-renamer__alice"));
        assert!(!safe_dir_name("../evil"));
        assert!(!safe_dir_name("a/b"));
        assert!(!safe_dir_name(".hidden"));
        assert!(!safe_dir_name(""));
    }

    #[test]
    fn dir_name_takes_last_segment() {
        // registry 的 dir 是仓库相对路径：只取最后一段
        assert_eq!(
            dir_name_of("plugins/font-renamer__alice"),
            Some("font-renamer__alice")
        );
        assert_eq!(dir_name_of("font-renamer__alice"), Some("font-renamer__alice"));
        assert_eq!(dir_name_of("a/b/c"), Some("c"));
        // 单个点是允许的（`my.plugin__alice` 这种带点的 id 合法）
        assert_eq!(dir_name_of("plugins/my.plugin__alice"), Some("my.plugin__alice"));
        // 空 / 空白 / 末段为空 → 拒
        assert_eq!(dir_name_of(""), None);
        assert_eq!(dir_name_of("   "), None);
        assert_eq!(dir_name_of("plugins/"), None);
        // 末段本身不合法（以点开头、超长、含非法字符）→ 拒
        assert_eq!(dir_name_of("plugins/.hidden"), None);
        assert_eq!(dir_name_of("plugins/a b"), None);
    }

    #[test]
    fn dir_name_rejects_traversal() {
        // 穿越输入一律拒：**不许**把 `plugins/../evil` 悄悄压成 `evil`。
        // registry 是远程可写的清单，压出来的名字等于替攻击者清掉了穿越标记。
        assert_eq!(dir_name_of("plugins/../evil"), None);
        assert_eq!(dir_name_of("../evil"), None);
        assert_eq!(dir_name_of("plugins/../../evil"), None);
        assert_eq!(dir_name_of("plugins/subdir/../../../evil"), None);
        // 当前目录段同样拒（语义不明确）
        assert_eq!(dir_name_of("plugins/./evil"), None);
        assert_eq!(dir_name_of(".."), None);
        assert_eq!(dir_name_of("."), None);
        // Windows 分隔符：混用 `\` 能绕过分段检查，所以整条拒
        assert_eq!(dir_name_of("plugins\\..\\evil"), None);
        assert_eq!(dir_name_of("plugins\\evil"), None);
        // 盘符 / NTFS 数据流：含 `:` 一律拒
        assert_eq!(dir_name_of("C:/evil"), None);
        assert_eq!(dir_name_of("C:\\evil"), None);
        assert_eq!(dir_name_of("evil:stream"), None);
    }

    #[test]
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn host_allow_list() {
        // 清单地址在面板侧（src/workshop/api.ts，拉的是 by-app/fm.json 分片），
        // 这里用同一份字面量守住「raw.githubusercontent.com 在白名单里」这条约束
        assert!(check_host(
            "https://raw.githubusercontent.com/706972745/Manager-Workshop/main/by-app/fm.json"
        )
        .is_ok());
        assert!(check_host(PANEL_RELEASE_URL).is_ok());
        assert!(check_host("http://raw.githubusercontent.com/a").is_err());
        assert!(check_host("https://evil.example/x.zip").is_err());
    }

    #[test]
    fn url_encoding_escapes_separators() {
        assert_eq!(urlencoding("zh-CN"), "zh-CN");
        assert_eq!(urlencoding("a&b"), "a%26b");
    }

    #[test]
    fn content_type_by_extension() {
        assert_eq!(content_type_for("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("a.bin"), "application/octet-stream");
    }

    // ── 面板包解压：zip-slip 与落点 ──────────────────────────────────────

    /// 现场造一个 zip（条目名可以故意写坏，用来测防护）
    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    /// 测试用临时目录（唯一后缀，测完由调用方清）
    fn test_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("fm-{tag}-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn panel_zip_extracts_html_and_assets() {
        let dir = test_dir("panel-zip-ok");
        let bytes = make_zip(&[
            ("workshop.html", b"<html>panel</html>"),
            ("assets/app.js", b"console.log(1)"),
            ("assets/app.css", b"body{}"),
        ]);
        extract_panel_zip(&bytes, &dir).expect("解压应成功");
        assert!(dir.join("workshop.html").is_file());
        assert!(dir.join("assets").join("app.js").is_file());
        assert!(dir.join("assets").join("app.css").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn panel_zip_rejects_zip_slip() {
        // 面板包里只该有 workshop.html 与 assets/ 下的文件；越界的一律拒
        for evil in [
            "../evil.js",
            "assets/../../evil.js",
            "C:/evil.js",
            "assets\\..\\..\\evil.js",
            "assets/evil.txt:stream",
        ] {
            let dir = test_dir("panel-zip-slip");
            let bytes = make_zip(&[(evil, b"evil")]);
            assert!(
                extract_panel_zip(&bytes, &dir).is_err(),
                "应拒绝越界条目：{evil}"
            );
            // 不能有文件落到目标目录之外
            assert!(!dir.join("evil.js").exists(), "{evil} 竟然落盘了");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn panel_zip_requires_workshop_html() {
        // 只有 assets/ 没有 workshop.html → 装完开不了窗，必须拒
        let dir = test_dir("panel-zip-nohtml");
        let bytes = make_zip(&[("assets/app.js", b"x")]);
        assert!(extract_panel_zip(&bytes, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 社区件安装：sha256 硬门槛 + 全有或全无 ────────────────────────────

    fn wf(path: &str, sha: &str) -> WorkshopFile {
        WorkshopFile {
            path: path.to_string(),
            sha256: sha.to_string(),
            url: "https://example.invalid/x".to_string(),
            size: 0,
        }
    }

    #[test]
    fn community_file_sha256_is_a_hard_gate() {
        let data = b"hello";
        let good = sha256_hex(data);
        // 正常值 → 过
        assert!(verify_payload(&wf("main.py", &good), data).is_ok());
        // sha256 留空 → 拒（index.json 远程可写，留空等于放行未校验的代码）
        assert!(verify_payload(&wf("main.py", ""), data).is_err());
        assert!(verify_payload(&wf("main.py", "   "), data).is_err());
        // 不是 64 位 hex → 拒
        assert!(verify_payload(&wf("main.py", "abc"), data).is_err());
        assert!(verify_payload(&wf("main.py", &"z".repeat(64)), data).is_err());
        // 对不上 → 拒
        assert!(verify_payload(&wf("main.py", &"0".repeat(64)), data).is_err());
    }

    #[test]
    fn community_install_is_all_or_nothing() {
        // 第二个文件的 sha256 是错的 → 整个安装失败，且**一个文件都不许落盘**
        let dir = test_dir("community-aon");
        let target = dir.join("plugin");
        let good_data = b"good";
        let files = vec![
            wf("main.py", &sha256_hex(good_data)),
            wf("evil.py", &"0".repeat(64)),
        ];
        let payloads = vec![
            ("main.py".to_string(), good_data.to_vec()),
            ("evil.py".to_string(), b"evil".to_vec()),
        ];
        assert!(verify_and_write(&target, &files, &payloads).is_err());
        let leftovers = std::fs::read_dir(&target)
            .map(|it| it.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "校验失败后不该留下半套文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn community_install_writes_all_files_when_verified() {
        let dir = test_dir("community-ok");
        let target = dir.join("plugin");
        let a = b"aaa";
        let b = b"bbb";
        let files = vec![
            wf("main.py", &sha256_hex(a)),
            wf("sub/lib.py", &sha256_hex(b)),
        ];
        let payloads = vec![
            ("main.py".to_string(), a.to_vec()),
            ("sub/lib.py".to_string(), b.to_vec()),
        ];
        verify_and_write(&target, &files, &payloads).expect("全部校验通过应写盘");
        assert!(target.join("main.py").is_file());
        assert!(target.join("sub").join("lib.py").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 安装状态与窗口标题 ────────────────────────────────────────────────

    #[test]
    fn panel_installed_needs_both_signals() {
        // prefs 说装了 + 文件在 → 装了
        assert!(is_panel_installed(true, true));
        // prefs 说装了但文件没了 → 没装（否则侧栏入口点开是白屏）
        assert!(!is_panel_installed(true, false));
        // 文件在但 prefs 没写 → 没装（让用户重下一次，重下会补写 pref）
        assert!(!is_panel_installed(false, true));
        assert!(!is_panel_installed(false, false));
    }

    #[test]
    fn panel_window_title_follows_ui_language() {
        assert_eq!(panel_window_title("zh-CN"), "插件中心");
        assert_eq!(panel_window_title("zh-TW"), "插件中心");
        assert_eq!(panel_window_title("en"), "Plugin Center");
        assert_eq!(panel_window_title("de"), "Plugin-Center");
        assert_eq!(panel_window_title("es"), "Centro de plugins");
        assert_eq!(panel_window_title("fr"), "Centre de plugins");
        assert_eq!(panel_window_title("ja"), "プラグインセンター");
        assert_eq!(panel_window_title("pt-BR"), "Central de Plugins");
        assert_eq!(panel_window_title("ru"), "Центр плагинов");
        // 未知语言码回落英文
        assert_eq!(panel_window_title("xx"), "Plugin Center");
        assert_eq!(panel_window_title(""), "Plugin Center");
    }

    #[test]
    fn host_allow_list_covers_release_asset_hosts() {
        // release 资产直链会 302 到 release-assets.githubusercontent.com：
        // 它必须在白名单里，否则重定向复检会把正常下载掐断
        assert!(check_host("https://release-assets.githubusercontent.com/x").is_ok());
        assert!(check_host("https://objects.githubusercontent.com/x").is_ok());
        // 白名单外的仍然拒
        assert!(check_host("https://evil.example/x").is_err());
        assert!(check_host("http://raw.githubusercontent.com/x").is_err());
    }

    // ── GitHub 设备码登录 ────────────────────────────────────────────────
    //
    // 这几条守的是「每个分支对应一句人话」：设备码登录最烦的失败模式不是报错，
    // 而是**一直转圈**（pending 永远 pending）或把配置问题说成「再试一次」。

    #[test]
    fn poll_reads_access_token_first() {
        let v = json!({ "access_token": "gho_abc", "token_type": "bearer", "scope": "public_repo" });
        assert_eq!(parse_poll(&v), PollOutcome::Token("gho_abc".into()));
    }

    #[test]
    fn poll_maps_user_waiting_states() {
        assert_eq!(
            parse_poll(&json!({ "error": "authorization_pending" })),
            PollOutcome::Pending,
            "用户还没在浏览器里确认：面板要继续等，不能报错"
        );
        assert_eq!(
            parse_poll(&json!({ "error": "slow_down" })),
            PollOutcome::SlowDown
        );
        assert_eq!(
            parse_poll(&json!({ "error": "expired_token" })),
            PollOutcome::Expired
        );
        assert_eq!(
            parse_poll(&json!({ "error": "access_denied" })),
            PollOutcome::Denied
        );
    }

    #[test]
    fn poll_separates_config_errors_from_user_errors() {
        // 配置问题必须**说清是配置问题**：这三个都不是「再点一次就好」
        let disabled = parse_poll(&json!({ "error": "device_flow_disabled" }));
        assert!(matches!(disabled, PollOutcome::Failed(ref m) if m.contains("Device Flow")));
        let bad = parse_poll(&json!({ "error": "incorrect_client_credentials" }));
        assert!(matches!(bad, PollOutcome::Failed(ref m) if m.contains("client_id")));
        // 空响应 / 未知错误：带上原文，别吞
        assert!(matches!(parse_poll(&json!({})), PollOutcome::Failed(_)));
        assert!(
            matches!(parse_poll(&json!({"error":"boom","error_description":"炸了"})),
                PollOutcome::Failed(ref m) if m.contains("boom") && m.contains("炸了"))
        );
    }

    #[test]
    fn slow_down_never_runs_away() {
        assert_eq!(apply_slow_down(5), 10);
        assert_eq!(apply_slow_down(60), 60, "上限 60 秒：再慢也不能把面板拖到分钟级");
        assert_eq!(apply_slow_down(58), 60);
    }
}
