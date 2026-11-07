//! 插件系统：**进程外插件**（VSCode 同款思路）。
//!
//! 主程序绝不把插件代码 load 进自己的进程：
//! - 插件是独立程序 / 脚本，崩了不影响主程序，任何语言都能写；
//! - 通信只有两条：stdin/stdout 上的 JSON 行（握手 + 调用），以及本地 API（受限令牌）。
//!
//! 目录：`%APPDATA%\FontManager\plugins\<插件目录>\plugin.json`
//! 令牌：每个插件启用时签发一枚**受限令牌**（按 manifest 的 permissions 过滤路由），
//! 停用即撤销 —— 插件永远拿不到主令牌。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read as _, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::store;

// ───────────────────────── 应用内插件面板窗口 ─────────────────────────
// 插件发 {"type":"open-url","url":…,"title":…} → 主程序开一个窗口加载它。
// 安全边界：**只允许本机回环地址**（http://127.0.0.1 或 http://localhost）——
// 插件拿不到任何主程序 UI 能力，最多能请主程序展示它自己 127.0.0.1 上的页面。
static APP: OnceLock<AppHandle> = OnceLock::new();

/// setup 阶段调用一次；拿到句柄之前插件发的 open-url 一律忽略（插件自己有降级开窗）。
pub fn set_app(handle: AppHandle) {
    let _ = APP.set(handle);
}

/// 安全校验：只放行本机回环地址。返回解析好的 URL，供开窗用 —— 单测覆盖。
fn validate_panel_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("URL 解析失败：{e}"))?;
    let host_ok = parsed.host_str() == Some("127.0.0.1")
        || parsed.host_str() == Some("localhost");
    if parsed.scheme() != "http" || !host_ok {
        return Err(format!("只允许本机回环地址（http://127.0.0.1/…），已拒绝：{url}"));
    }
    Ok(parsed)
}

fn open_panel_window(app: &AppHandle, url: &str, title: &str) -> Result<(), String> {
    // URL 先严格解析并校验，这个分支里**绝不 unwrap** —— 插件的数据不可信
    let url = validate_panel_url(url)?;
    let title = title.to_string();
    let app = app.clone();
    // 接收者用临时克隆：闭包要把 app 移进去，而方法调用本身又借用了接收者。
    // run_on_main_thread 的 Result 只在「事件循环已退出」时才有意义，那时主程序
    // 都在退出了，记一条日志即可 —— 不能因为开面板失败把同步/退出流程打断。
    let scheduled = app.clone().run_on_main_thread(move || {
        // build 本身返回 Result；再包一层 catch_unwind —— 任何意外都只记日志，
        // 绝不能带崩主进程（与 api_server 的 catch_unwind 同一模式）
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            WebviewWindowBuilder::new(&app, "plugin-panel", WebviewUrl::External(url.clone()))
                .title(&title)
                .inner_size(1040.0, 900.0)
                .min_inner_size(760.0, 560.0)
                .build()
        }));
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                let msg = e.to_string();
                if msg.contains("exists") || msg.contains("已存在") || msg.contains("label") {
                    crate::diag::log("[plugin] 面板窗口已经开着（关掉旧窗口可再开）");
                } else {
                    crate::diag::log(&format!(
                        "[plugin] 面板窗口创建失败（不影响主程序）：{msg}"
                    ));
                }
            }
            Err(_) => crate::diag::log(
                "[plugin] 面板窗口创建发生 panic，已被 catch_unwind 拦住，主程序不受影响",
            ),
        }
    });
    if let Err(e) = scheduled {
        return Err(format!("run_on_main_thread 失败：{e}"));
    }
    Ok(())
}

// ───────────────────────────── manifest ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// 主程序兼容性判定（当前 API 级别 = 1）
    #[serde(default = "default_api_level")]
    pub api_level: u32,
    pub entry: String,
    /// python / node / exe（留空按 entry 后缀猜）
    #[serde(default)]
    pub interpreter: Option<String>,
    /// 插件**自带**的解释器：相对插件目录的路径（如 "runtime/python.exe"）。
    /// 写了它就不做系统探测 —— 插件自己背环境，主程序只负责拉起和给权限，
    /// 也就永远不用为某种插件单独做适配（2026-11-05 设计口径）。
    #[serde(default)]
    pub interpreter_path: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub menus: Vec<PluginMenu>,
    /// 插件**自己**声明「我有一块设置面板」（1.3.7 起）。
    /// 写了它，设置 → 插件 的那一行会出现一个齿轮；点了主程序就把 `hook` 发过去，
    /// 由插件自己弹面板 —— 插件是独立进程，主程序从不替它画界面。
    #[serde(default)]
    pub settings: Option<PluginSettings>,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_api_level() -> u32 {
    1
}

fn default_settings_hook() -> String {
    "settings".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettings {
    /// 面板标题：齿轮按钮的 tooltip / 右键菜单里那一行的文字；留空用插件名
    #[serde(default)]
    pub title: Option<String>,
    /// 主程序要调的钩子名，默认 `settings`
    #[serde(default = "default_settings_hook")]
    pub hook: String,
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            title: None,
            hook: default_settings_hook(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMenu {
    pub title: String,
    /// 挂在哪种对象上：`family`（字族右键，默认）/ `plugin`（设置页里那一行插件的右键）。
    /// 1.3.7 新增 `plugin`：给「不用选字体也能跑」的功能一个入口（打开报告目录、
    /// 重新扫描、清理缓存这类），不用再去凑一个字族右键。
    #[serde(default = "default_on")]
    pub on: String,
}

fn default_on() -> String {
    "family".into()
}

pub const API_LEVEL: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub hooks: Vec<String>,
    pub menus: Vec<PluginMenu>,
    /// 插件声明的设置面板（没有就是 None → 界面上不显示齿轮）
    pub settings: Option<PluginSettings>,
    pub dir: String,
    pub enabled: bool,
    pub running: bool,
    /// 启用失败的原因（manifest 坏了 / 解释器找不到 / 版本不兼容）
    pub error: Option<String>,
}

// ───────────────────────────── 运行时 ─────────────────────────────

struct Runtime {
    child: Child,
    stdin: ChildStdin,
    token: String,
}

fn runtimes() -> &'static Mutex<HashMap<String, Runtime>> {
    static RT: OnceLock<Mutex<HashMap<String, Runtime>>> = OnceLock::new();
    RT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 主程序 → 插件的调用（写一行 JSON 到 stdin）
fn send_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("写插件 stdin 失败：{e}"))
}

/// 插件目录（1.3.8 起默认在**软件安装目录**下）。
///
/// 用户原话：「这个插件的目录，如果可以，改为默认在软件安装目录下」——插件是软件的一部分，
/// 跟着安装目录走更符合直觉（整个文件夹拷走就是一套完整的软件，卸载也一起走）。
///
/// 三条规则（与字体库 `scanner::managed_font_dir()` 同一套思路）：
/// 1. 先试 `<exe 所在目录>\plugins`，写探针确认可写（MSI 装到 Program Files 时不可写）；
/// 2. **老用户不搬家**：`%APPDATA%\FontManager\plugins` 里已经有插件、而安装目录下还是空的，
///    就继续用老位置 —— 插件自带运行时，搬目录容易把它自己的相对路径搞坏；
/// 3. 调试构建（跑在 rust-target\debug 下）不进安装目录，直接用老位置，免得污染构建产物。
pub fn plugins_dir() -> PathBuf {
    plugins_dir_cached().clone()
}

/// 1.3.7 及更早版本的插件目录。
pub fn legacy_plugins_dir() -> PathBuf {
    store::app_data_dir().join("plugins")
}

fn plugins_dir_cached() -> &'static PathBuf {
    static CELL: OnceLock<PathBuf> = OnceLock::new();
    CELL.get_or_init(resolve_plugins_dir)
}

fn resolve_plugins_dir() -> PathBuf {
    let legacy = legacy_plugins_dir();
    if cfg!(debug_assertions) {
        return legacy;
    }
    let Some(base) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return legacy;
    };
    let dir = base.join("plugins");
    // 老用户：原位置已经有插件，且安装目录下还没建过 → 原地不动
    if has_plugins(&legacy) && !has_plugins(&dir) {
        crate::diag::log(&format!(
            "[plugin] 沿用旧插件目录 {}（安装目录下还没有插件）",
            legacy.display()
        ));
        return legacy;
    }
    if is_writable_plugins_dir(&dir) {
        return dir;
    }
    crate::diag::log(&format!(
        "[plugin] 安装目录不可写，插件目录回退到 {}",
        legacy.display()
    ));
    legacy
}

fn has_plugins(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().any(|e| e.path().is_dir()))
        .unwrap_or(false)
}

/// 能不能在这个目录里建文件 —— 装到 Program Files 时这里会返回 false。
fn is_writable_plugins_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".zfm-write-test");
    let ok = std::fs::write(&probe, b"1").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("plugin.json")
}

fn read_manifest(dir: &Path) -> Result<PluginManifest, String> {
    let p = manifest_path(dir);
    let text = std::fs::read_to_string(&p)
        .map_err(|e| format!("读不到 {}：{e}", p.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("plugin.json 格式不对：{e}"))
}

// ── 从 ZIP 安装插件（1.4.4）────────────────────────────────────────────
// UX：用户把插件 zip 拖进窗口或用「从 ZIP 安装」按钮选一个包。
// 兼容两种布局：文件在 zip 根级（plugin.json 在根），或只有一个顶层目录
// （font-sync/plugin.json）。数据文件（config/secret/state）永远不进包、
// 也不被包覆盖 —— 更新插件只覆盖代码。

const PLUGIN_DATA_FILES: [&str; 3] = ["config.json", "secret.bin", "state.json"];

/// zip 内容探测：是不是插件包。返回 (root 前缀, id, name, version)。
pub fn probe_zip(zip_path: &Path) -> Result<(String, String, String, String), String> {
    let f = std::fs::File::open(zip_path)
        .map_err(|e| format!("打不开 {}：{e}", zip_path.display()))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("不是有效的 zip：{e}"))?;
    let (root, text) = locate_manifest(&mut z)?;
    let m: PluginManifest = serde_json::from_str(&text)
        .map_err(|e| format!("plugin.json 格式不对：{e}"))?;
    Ok((root, m.id, m.name, m.version))
}

/// 在 zip 里找 plugin.json。返回 (根前缀, manifest 文本)。
fn locate_manifest<R: std::io::Read + std::io::Seek>(
    z: &mut zip::ZipArchive<R>,
) -> Result<(String, String), String> {
    let names: Vec<String> = (0..z.len())
        .filter_map(|i| z.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    // 根级
    if names.iter().any(|n| n == "plugin.json") {
        let mut f = z.by_name("plugin.json").map_err(|e| e.to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        return Ok((String::new(), s));
    }
    // 唯一顶层目录下的 plugin.json
    let mut tops: Vec<String> = names
        .iter()
        .filter_map(|n| n.split('/').next().map(str::to_string))
        .filter(|t| !t.is_empty())
        .collect();
    tops.sort();
    tops.dedup();
    if tops.len() == 1 {
        let candidate = format!("{}/plugin.json", tops[0]);
        if names.iter().any(|n| *n == candidate) {
            let mut f = z.by_name(&candidate).map_err(|e| e.to_string())?;
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            return Ok((format!("{}/", tops[0]), s));
        }
    }
    Err("zip 里没找到 plugin.json —— 这不是插件包（字体 zip 包请直接拖进字体库安装）".into())
}

/// plugin.json 的 id 只允许安全字符：它要当目录名用。
fn sanitize_plugin_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !id.starts_with('.');
    if ok {
        Ok(id.to_string())
    } else {
        Err(format!("plugin.json 的 id 不合法（只允许字母数字 .-_）：{id:?}"))
    }
}

/// 安装/更新插件 zip 到指定插件根目录（测试可注入 base）。
/// 返回 (id, name, version)。
pub fn install_zip_into(zip_path: &Path, base: &Path) -> Result<(String, String, String), String> {
    let f = std::fs::File::open(zip_path)
        .map_err(|e| format!("打不开 {}：{e}", zip_path.display()))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("不是有效的 zip：{e}"))?;
    let (root, text) = locate_manifest(&mut z)?;
    let m: PluginManifest = serde_json::from_str(&text)
        .map_err(|e| format!("plugin.json 格式不对：{e}"))?;
    if m.api_level > API_LEVEL {
        return Err(format!(
            "插件需要主程序 API 级别 {}，当前软件只支持到 {} —— 请先把 FontManager 升到更新的版本",
            m.api_level, API_LEVEL
        ));
    }
    let id = sanitize_plugin_id(&m.id)?;
    let target = base.join(&id);
    std::fs::create_dir_all(&target).map_err(|e| format!("建目录失败：{e}"))?;
    for i in 0..z.len() {
        let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix(&root) else {
            continue; // 只装 manifest 所在的那一层（多目录 zip 只认插件目录）
        };
        if rel.is_empty() {
            continue;
        }
        // zip-slip 防护：路径必须安全地落在插件目录内
        let rel_path = std::path::Path::new(rel);
        let safe = !rel_path.components().any(|c| {
            matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir)
        })
            && !rel.contains('\\')
            && !rel.contains(':');
        if !safe {
            return Err(format!("zip 里有越界路径，已拒绝安装：{name}"));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(target.join(rel_path))
                .map_err(|e| format!("建目录失败：{e}"))?;
            continue;
        }
        // 数据文件永远不进包，也永远不被包覆盖（更新插件不动用户的配置/令牌/状态）
        if root.is_empty() && PLUGIN_DATA_FILES.contains(&rel) {
            continue;
        }
        let out = target.join(rel_path);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建目录失败：{e}"))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("读 zip 条目失败：{e}"))?;
        std::fs::write(&out, &buf).map_err(|e| format!("写 {} 失败：{e}", out.display()))?;
    }
    Ok((m.id, m.name, m.version))
}

/// 安装到真实插件目录（装完**不**自动重扫 —— 前端装完自己刷清单）。
pub fn install_zip(zip_path: &Path) -> Result<(String, String, String), String> {
    install_zip_into(zip_path, &plugins_dir())
}

/// 扫描插件目录（不启动任何东西）
pub fn list() -> Vec<PluginInfo> {
    let root = plugins_dir();
    let mut out = Vec::new();
    let running: Vec<String> = runtimes()
        .lock()
        .map(|r| r.keys().cloned().collect())
        .unwrap_or_default();
    // 「上次开着、这次没起来」要能一眼看出来：否则界面上就是个关着的开关，
    // 用户以为自己关过，其实是解释器没找到（1.3.0 的踩坑）。
    let wanted = crate::api::hub()
        .map(|a| remembered(&a.store))
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        match read_manifest(&dir) {
            Ok(m) => {
                let mut err = if m.api_level > API_LEVEL {
                    Some(format!(
                        "这个插件要求 API 级别 {}，当前软件只支持 {API_LEVEL}，请升级软件",
                        m.api_level
                    ))
                } else {
                    None
                };
                if err.is_none() && wanted.contains(&m.id) && !running.contains(&m.id) {
                    err = Some("上次是启用状态，这次没能启动（多半是缺解释器），重新打开一次试试".into());
                }
                out.push(PluginInfo {
                    enabled: running.contains(&m.id),
                    running: running.contains(&m.id),
                    id: m.id,
                    name: m.name,
                    version: m.version,
                    description: m.description,
                    permissions: m.permissions,
                    hooks: m.hooks,
                    menus: m.menus,
                    settings: m.settings,
                    dir: dir.to_string_lossy().into_owned(),
                    error: err,
                });
            }
            Err(e) => out.push(PluginInfo {
                id: dir
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                name: dir
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                version: String::new(),
                description: None,
                permissions: Vec::new(),
                hooks: Vec::new(),
                menus: Vec::new(),
                settings: None,
                dir: dir.to_string_lossy().into_owned(),
                enabled: false,
                running: false,
                error: Some(e),
            }),
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn find_dir(id: &str) -> Option<PathBuf> {
    let root = plugins_dir();
    let entries = std::fs::read_dir(&root).ok()?;
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        if let Ok(m) = read_manifest(&dir) {
            if m.id == id {
                return Some(dir);
            }
        }
    }
    None
}

// ───────────────────── 解释器发现（1.3.1） ─────────────────────
//
// 以前直接 `Command::new("python")`，两个坑一起踩：
// 1. 从资源管理器/开始菜单启动时，软件拿到的是**系统 PATH**，
//    Python 装没装、装在哪，跟用户在自己的终端里能不能跑 python 是两回事；
// 2. Windows 的 `python.exe` 在 `...\WindowsApps\` 下只是个**商店下载引导**，
//    能「启动成功」，然后立刻退出并打印 "Python was not found"——
//    插件于是显示已启用、界面却什么都没有（1.3.0 就是这么坏的）。
//
// 所以：把候选逐个**探活**（真跑一句 `print` 看版本），跳过 WindowsApps 桩；
// 都找不到就让用户在设置里手动指定。

fn probe(program: &str, extra: &[String], kind: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    for a in extra {
        cmd.arg(a);
    }
    if kind == "python" {
        cmd.arg("-c").arg("import sys;print(sys.version.split()[0])");
    } else {
        cmd.arg("--version");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                if let Some(mut s) = child.stdout.take() {
                    use std::io::Read;
                    let _ = s.read_to_string(&mut out);
                }
                let line = out.lines().next().unwrap_or("").trim();
                let v = line.trim_start_matches('v').trim().to_string();
                return if v.is_empty() { None } else { Some(v) };
            }
            Ok(None) => {
                if start.elapsed() > std::time::Duration::from_millis(3000) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

/// 扫一层子目录里的可执行文件（Python3xx\python.exe、node\versions\*\node.exe…）
fn scan_dir(base: &Path, exe: &str, out: &mut Vec<(String, Vec<String>)>) {
    if base.join(exe).is_file() {
        out.push((base.join(exe).to_string_lossy().into_owned(), vec![]));
    }
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.reverse(); // 新版本排前面
    for d in dirs {
        let exe_path = d.join(exe);
        if exe_path.is_file() {
            let s = exe_path.to_string_lossy().into_owned();
            if !s.contains("WindowsApps") {
                out.push((s, vec![]));
            }
        }
    }
}

fn candidates(kind: &str, override_path: Option<&str>) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(p) = override_path {
        if !p.trim().is_empty() {
            out.push((p.trim().to_string(), vec![]));
        }
    }
    match kind {
        "python" => {
            out.push(("python".into(), vec![]));
            out.push(("python3".into(), vec![]));
            out.push(("py".into(), vec!["-3".into()]));
            if let Some(local) = env_path("LOCALAPPDATA") {
                scan_dir(&local.join("Programs").join("Python"), "python.exe", &mut out);
            }
            if let Some(pf) = env_path("ProgramFiles") {
                scan_dir(&pf, "python.exe", &mut out);
            }
            if let Some(home) = env_path("USERPROFILE") {
                scan_dir(&home, "python.exe", &mut out);
                // 便携/免费版常被丢在用户目录下（含 WorkBuddy 自带的那份）
                scan_dir(
                    &home.join(".workbuddy").join("binaries").join("python").join("versions"),
                    "python.exe",
                    &mut out,
                );
            }
        }
        "node" => {
            out.push(("node".into(), vec![]));
            if let Some(pf) = env_path("ProgramFiles") {
                scan_dir(&pf.join("nodejs"), "node.exe", &mut out);
            }
            if let Some(local) = env_path("LOCALAPPDATA") {
                scan_dir(&local.join("Programs").join("nodejs"), "node.exe", &mut out);
                scan_dir(&local.join("nvm"), "node.exe", &mut out);
            }
            if let Some(home) = env_path("USERPROFILE") {
                for sub in [".nvm/versions/node", ".volta/bin", ".workbuddy/binaries/node/versions"] {
                    scan_dir(&home.join(sub), "node.exe", &mut out);
                }
            }
        }
        _ => {}
    }
    out
}

fn resolved_cache() -> &'static Mutex<HashMap<String, Option<(String, Vec<String>, String)>>> {
    static C: OnceLock<Mutex<HashMap<String, Option<(String, Vec<String>, String)>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 找到某个解释器的**真实**可执行文件：返回 (路径, 额外参数, 版本)。
fn resolve(kind: &str, override_path: Option<&str>) -> Option<(String, Vec<String>, String)> {
    let key = format!("{kind}|{}", override_path.unwrap_or(""));
    if let Ok(c) = resolved_cache().lock() {
        if let Some(hit) = c.get(&key) {
            return hit.clone();
        }
    }
    let mut found = None;
    for (prog, extra) in candidates(kind, override_path) {
        if let Some(version) = probe(&prog, &extra, kind) {
            found = Some((prog, extra, version));
            break;
        }
    }
    if let Ok(mut c) = resolved_cache().lock() {
        c.insert(key, found.clone());
    }
    if let Some((p, _, v)) = &found {
        crate::diag::log(&format!("[plugin] {kind} 解释器 → {p}（{v}）"));
    } else {
        crate::diag::log(&format!("[plugin] 没找到 {kind} 解释器"));
    }
    found
}

/// 主程序内置的共享 Python 运行时（1.4.4，随安装包分发，Python 3.13 + Pillow + fontTools）。
/// 安装后位于 exe 旁（NSIS 装到 %LOCALAPPDATA%，MSI 装到 Program Files 的资源目录）；
/// 开发期 cargo run 直接用源码树里那份。找不到返回 None（回退系统解释器）。
fn shared_python_runtime() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(base) = exe.parent() {
            cands.push(base.join("python-runtime").join("python.exe"));
            cands.push(base.join("resources").join("python-runtime").join("python.exe"));
        }
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("python-runtime")
            .join("python.exe"),
    );
    cands.into_iter().find(|p| p.is_file())
}

/// 用户在设置里手动指定的解释器路径（prefs: pluginRuntime = {python: ..., node: ...}）
fn override_for(kind: &str) -> Option<String> {    let api = crate::api::hub()?;
    let st = api.store.0.lock().ok()?;
    st.prefs
        .get("pluginRuntime")
        .and_then(|v| v.get(kind))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn command_for(dir: &Path, m: &PluginManifest) -> Result<(Command, String), String> {
    let entry = dir.join(&m.entry);
    if !entry.is_file() {
        return Err(format!("入口文件不存在：{}", entry.display()));
    }
    let kind = m
        .interpreter
        .clone()
        .unwrap_or_else(|| match entry.extension().and_then(|s| s.to_str()).unwrap_or("") {
            "py" => "python".into(),
            "js" | "mjs" | "cjs" => "node".into(),
            _ => "exe".into(),
        });
    let (mut cmd, how) = match kind.as_str() {
        "python" | "node" => {
            // 插件自带解释器：路径相对插件目录，直接用，不做任何系统探测。
            // 这是「插件按规则开发、主程序不做适配」的关键出口 —— 环境由插件自己背。
            if let Some(rel) = m
                .interpreter_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let bundled = dir.join(rel);
                if !bundled.is_file() {
                    return Err(format!(
                        "plugin.json 的 interpreterPath 指向的文件不存在：{}",
                        bundled.display()
                    ));
                }
                let mut c = Command::new(&bundled);
                // 让子进程也用 UTF-8：中文 Windows 下 python 默认按 cp936 写管道，
                // 主程序这边按 UTF-8 解析，两边编码不一致就会把 JSON 读坏
                if kind == "python" {
                    c.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
                }
                c.arg(&entry);
                // 这里**绝对不能**提前 return：下面那段（stdin/stdout/stderr 全部 piped +
                // CREATE_NO_WINDOW）是「自带解释器」和「系统解释器」两条路共用的。
                // 1.4.1 及以前在这里 return，后果是自带运行时的插件：
                // stdio 继承控制台（弹一个黑窗，插件的 JSON 日志哗哗打到窗口里）、
                // 主程序 take() 不到 stdin → 启用失败，只报一句「插件进程没有 stdin」。
                (c, format!("{}（插件自带）", bundled.display()))
            } else {
                let ov = override_for(&kind);
                // 主程序内置共享运行时（1.4.4）：没装 Python 的电脑也能跑标准库插件。
                // 只兜 python；node 插件继续走系统探测。插件自带（interpreterPath）优先级最高。
                let shared = if kind == "python" && !cfg!(test) {
                    shared_python_runtime().map(|p| {
                        (
                            p.to_string_lossy().into_owned(),
                            Vec::<String>::new(),
                            "主程序内置".to_string(),
                        )
                    })
                } else {
                    None
                };
                let (prog, extra, version) =
                    shared.or_else(|| resolve(&kind, ov.as_deref())).ok_or_else(|| {
                        format!(
                            "没找到可用的 {} 解释器 —— 装上它，或在设置 → 插件 →「插件解释器」里点「选择」指过去",
                            if kind == "python" { "Python" } else { "Node.js" }
                        )
                    })?;
                let mut c = Command::new(&prog);
                for a in &extra {
                    c.arg(a);
                }
                // 让子进程也用 UTF-8：中文 Windows 下 python 默认按 cp936 写管道，
                // 主程序这边按 UTF-8 解析，两边编码不一致就会把 JSON 读坏
                if kind == "python" {
                    c.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
                }
                c.arg(&entry);
                (c, format!("{} {}", prog, version))
            }
        }
        _ => (Command::new(&entry), entry.display().to_string()),
    };
    cmd.current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok((cmd, how))
}

/// 启用插件：签发受限令牌 → 拉起进程 → 握手（stdin 收到 init）。
pub fn enable(id: &str) -> Result<PluginInfo, String> {
    if runtimes().lock().map(|r| r.contains_key(id)).unwrap_or(false) {
        return Err("这个插件已经在运行".into());
    }
    let dir = find_dir(id).ok_or_else(|| format!("没找到插件「{id}」；目录：{}", plugins_dir().display()))?;
    let m = read_manifest(&dir)?;
    if m.api_level > API_LEVEL {
        return Err(format!(
            "插件要求 API 级别 {}，当前软件只支持 {API_LEVEL}",
            m.api_level
        ));
    }
    let api = crate::api::hub().ok_or_else(|| "本地 API 还没初始化（重启软件试试）".to_string())?;
    let (port, enabled) = {
        let cfg = api.cfg.lock().map_err(|e| e.to_string())?;
        (cfg.port, cfg.enabled)
    };
    if !enabled || port == 0 {
        return Err("插件依赖本地 API，但「本地 API」现在是关的。请先在设置 → 本地 API 里打开".into());
    }
    // 受限令牌：只有 manifest 声明的权限
    let token = format!("plugin-{}", crate::api::new_plugin_token());
    if let Ok(mut t) = api.tokens.lock() {
        t.insert(
            token.clone(),
            crate::api::Scope {
                name: format!("plugin:{}", m.id),
                perms: m.permissions.clone(),
            },
        );
    }

    let (mut cmd, how) = command_for(&dir, &m)?;
    crate::diag::log(&format!(
        "[plugin] {} 工作目录 {}，入口 {}",
        m.id,
        dir.display(),
        dir.join(&m.entry).display()
    ));
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动插件进程失败（{}）：{e}", how))?;
    crate::diag::log(&format!("[plugin] {} 用解释器 {how}", m.id));
    let mut stdin = child.stdin.take().ok_or("插件进程没有 stdin")?;
    send_line(
        &mut stdin,
        &json!({
            "type": "init",
            "pluginId": m.id,
            "apiLevel": API_LEVEL,
            "apiBase": format!("http://127.0.0.1:{port}/api/v1"),
            "apiToken": token,
        }),
    )?;

    // stdout：插件说 ready / log / toast 都记日志（插件不直接画界面）
    if let Some(out) = child.stdout.take() {
        let pid = m.id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(out);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                // 插件可能按系统编码（中文 Windows 上是 cp936）写，一律宽松解码 ——
                // 严格按 UTF-8 读会让迭代器在第一行就结束，看起来像插件自己退了
                let text = String::from_utf8_lossy(&buf).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => {
                        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match kind {
                            "log" => crate::diag::log(&format!(
                                "[plugin:{pid}] {}",
                                v.get("message").and_then(|x| x.as_str()).unwrap_or("")
                            )),
                            "toast" => crate::diag::log(&format!(
                                "[plugin:{pid}] toast: {}",
                                v.get("message").and_then(|x| x.as_str()).unwrap_or("")
                            )),
                            "open-url" => {
                                // 0.8.0 插件：请主程序开应用内设置窗口。防御式处理，
                                // 解析/校验/开窗任何一步失败都只记日志
                                let url = v
                                    .get("url")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                let title = v
                                    .get("title")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.chars().take(60).collect::<String>())
                                    .unwrap_or_else(|| "插件面板".to_string());
                                match APP.get() {
                                    None => crate::diag::log(&format!(
                                        "[plugin:{pid}] open-url 被忽略（应用句柄未就绪，插件应自行降级开窗）"
                                    )),
                                    Some(app) => match open_panel_window(app, &url, &title) {
                                        Ok(()) => crate::diag::log(&format!(
                                            "[plugin:{pid}] 已请求主程序打开面板窗口"
                                        )),
                                        Err(e) => crate::diag::log(&format!(
                                            "[plugin:{pid}] open-url 被拒绝：{e}"
                                        )),
                                    },
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(_) => crate::diag::log(&format!("[plugin:{pid}] {text}")),
                }
            }
            crate::diag::log(&format!("[plugin:{pid}] stdout 结束，插件可能已退出"));
            retire_dead(&pid);
        });
    }
    if let Some(err) = child.stderr.take() {
        let pid = m.id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(err);
            let mut buf: Vec<u8> = Vec::new();
            let mut count = 0;
            while count < 200 {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if line.is_empty() {
                    continue;
                }
                crate::diag::log(&format!("[plugin:{pid}] stderr: {line}"));
                count += 1;
            }
        });
    }

    if let Ok(mut rt) = runtimes().lock() {
        rt.insert(
            m.id.clone(),
            Runtime {
                child,
                stdin,
                token: token.clone(),
            },
        );
    }
    crate::diag::log(&format!("[plugin] 已启用 {} v{}", m.id, m.version));
    // 启动后 1 秒做一次体检：很多插件（尤其解释器不对时）会「起来了又立刻退出」，
    // 界面上只看到开关弹回去。这里把退出码写进日志，省得靠猜。
    {
        let id = m.id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let state = runtimes().lock().ok().map(|mut rt| {
                rt.get_mut(&id)
                    .map(|r| r.child.try_wait().ok().flatten())
            });
            match state {
                Some(Some(Some(st))) => crate::diag::log(&format!(
                    "[plugin:{id}] 启动 1 秒内就退出了（exit={:?}）",
                    st.code()
                )),
                Some(Some(None)) => crate::diag::log(&format!("[plugin:{id}] 启动 1 秒后仍在运行")),
                _ => crate::diag::log(&format!("[plugin:{id}] 启动 1 秒后运行时表里已经没它了")),
            }
        });
    }
    Ok(list().into_iter().find(|p| p.id == m.id).unwrap_or(PluginInfo {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        permissions: m.permissions,
        hooks: m.hooks,
        menus: m.menus,
        settings: m.settings,
        dir: dir.to_string_lossy().into_owned(),
        enabled: true,
        running: true,
        error: None,
    }))
}

// ───────────────────── 启用状态的记忆（重启后自动恢复） ─────────────────────

pub const PREFS_KEY: &str = "pluginsEnabled";

/// 用户在设置里开过哪些插件 —— 存在 prefs 里，下次启动照着开回来。
/// 只记 id，不记令牌：令牌每次启用现签，旧的下次启动本来也失效了。
pub fn remembered(store: &store::Store) -> Vec<String> {
    store
        .0
        .lock()
        .ok()
        .and_then(|st| st.prefs.get(PREFS_KEY).cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 记住 / 忘掉一个插件的启用状态（调用方负责 save）
pub fn remember(store: &store::Store, id: &str, on: bool) {
    let Ok(mut st) = store.0.lock() else { return };
    let mut list = st
        .prefs
        .get(PREFS_KEY)
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if on {
        if !list.iter().any(|x| x == id) {
            list.push(id.to_string());
        }
    } else {
        list.retain(|x| x != id);
    }
    if let Some(obj) = st.prefs.as_object_mut() {
        obj.insert(PREFS_KEY.into(), json!(list));
    }
}

/// 启动时把上次开着的插件拉起来。失败只记日志 —— 插件是附加物，
/// 缺个解释器、manifest 写坏了，都不该挡住软件启动。
pub fn start_enabled() {
    let Some(api) = crate::api::hub() else { return };
    let ids = remembered(&api.store);
    if ids.is_empty() {
        return;
    }
    for id in ids {
        match enable(&id) {
            Ok(p) => crate::diag::log(&format!("[plugin] 按上次的状态自动启用：{} v{}", p.id, p.version)),
            Err(e) => crate::diag::log(&format!("[plugin] 自动启用「{id}」失败：{e}")),
        }
    }
}

/// 插件进程已经没了（崩溃 / 自己退出 / 被任务管理器结束）：
/// 把运行时表和它的令牌一起收掉。
///
/// 不收的话界面会一直显示「已启用」，用户再点开关还会被告知「已经在运行」——
/// 明明什么都没在跑。收掉之后 `list()` 会如实显示未启用，点一下就能重新拉起。
fn retire_dead(id: &str) {
    let dead = runtimes().lock().ok().and_then(|mut r| r.remove(id));
    let Some(mut rt) = dead else { return };
    match rt.child.try_wait() {
        Ok(Some(st)) => crate::diag::log(&format!(
            "[plugin:{id}] 进程自己退出了（exit={:?}）",
            st.code()
        )),
        _ => {
            let _ = rt.child.kill();
        }
    }
    if let Some(api) = crate::api::hub() {
        if let Ok(mut t) = api.tokens.lock() {
            t.remove(&rt.token);
        }
    }
    crate::diag::log(&format!("[plugin:{id}] 进程已退出，运行时与令牌已回收"));
}

/// 停用插件：杀进程 + 撤销令牌
pub fn disable(id: &str) -> Result<(), String> {
    let Some(mut rt) = runtimes().lock().ok().and_then(|mut r| r.remove(id)) else {
        return Err("这个插件没在运行".into());
    };
    let _ = rt.child.kill();
    let _ = rt.child.wait();
    if let Some(api) = crate::api::hub() {
        if let Ok(mut tokens) = api.tokens.lock() {
            tokens.remove(&rt.token);
        }
    }
    crate::diag::log(&format!("[plugin] 已停用 {id}"));
    Ok(())
}

/// 调用钩子：往插件 stdin 写一条 invoke。插件要回什么就走 API。
pub fn invoke(id: &str, hook: &str, payload: Value) -> Result<(), String> {
    let mut rt = runtimes().lock().map_err(|e| e.to_string())?;
    let runtime = rt.get_mut(id).ok_or_else(|| "插件没在运行".to_string())?;
    send_line(
        &mut runtime.stdin,
        &json!({ "type": "invoke", "hook": hook, "payload": payload }),
    )
}

/// 应用退出时全部停掉
pub fn stop_all() {
    let ids: Vec<String> = runtimes()
        .lock()
        .map(|r| r.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = disable(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(entry: &str, interpreter_path: Option<&str>) -> PluginManifest {
        PluginManifest {
            id: "t".into(),
            name: "t".into(),
            version: "0.0.0".into(),
            api_level: 1,
            entry: entry.into(),
            interpreter: Some("python".into()),
            interpreter_path: interpreter_path.map(str::to_string),
            permissions: vec!["read:fonts".into()],
            hooks: vec![],
            menus: vec![],
            settings: None,
            description: None,
        }
    }

    /// 自带解释器的分支必须走「公共收尾」：program 是插件内的解释器、参数是入口。
    ///
    /// 1.4.1 及以前这一支是 `return Ok((c, …))`，把后面的
    /// `stdin/stdout/stderr = piped` + `CREATE_NO_WINDOW` 一起跳过了：
    /// 插件进程继承控制台（弹黑窗、JSON 日志全打到窗口里），主程序
    /// `child.stdin.take()` 拿到 None，启用直接失败并只报「插件进程没有 stdin」。
    /// 自带运行时的插件（现在所有插件都是）全都装不上。
    ///
    /// 单测只能验到「分支选择 + 命令行拼装」，stdio 是否 piped 由 `command_for`
    /// 的尾部统一设置，改结构时别再把 return 插回去（见上一段注释）。
    #[test]
    fn bundled_interpreter_is_used_as_program() {
        let dir = std::env::temp_dir().join(format!("zfm-plugin-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("runtime")).unwrap();
        std::fs::write(dir.join("main.py"), b"print(1)").unwrap();
        std::fs::write(dir.join("runtime").join("python.exe"), b"").unwrap();

        let (cmd, how) =
            command_for(&dir, &manifest("main.py", Some("runtime/python.exe"))).unwrap();
        assert!(how.contains("插件自带"), "应该走自带解释器分支：{how}");
        let prog = cmd.get_program().to_string_lossy().into_owned();
        assert!(prog.ends_with("python.exe"), "程序应该是插件自带的解释器：{prog}");
        assert!(prog.contains("runtime"), "不能退回系统解释器：{prog}");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|a| a.ends_with("main.py")), "入口没传进去：{args:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn panel_url_gate_only_loopback_http() {
        // 放行：本机回环 http
        assert!(super::validate_panel_url("http://127.0.0.1:52100/?k=abc&tab=account").is_ok());
        assert!(super::validate_panel_url("http://localhost:1234/").is_ok());
        // 拒绝：外网、https、垃圾输入
        assert!(super::validate_panel_url("https://127.0.0.1:52100/").is_err(), "https 也不放");
        assert!(super::validate_panel_url("http://evil.example.com/x").is_err());
        assert!(super::validate_panel_url("http://192.168.1.5:80/").is_err(), "局域网也不放");
        assert!(super::validate_panel_url("file:///C:/Windows/System32").is_err());
        assert!(super::validate_panel_url("not a url").is_err());
        assert!(super::validate_panel_url("").is_err());
    }
    #[test]
    fn install_zip_flat_layout() {
        let tmp = tempfile_dir("zfm-zip-flat");
        let zip_path = tmp.join("p.zip");
        write_test_zip(&zip_path, &[
            ("plugin.json", br#"{"id":"demo","name":"Demo","version":"1.2","apiLevel":1,"entry":"main.py","permissions":[]}"#),
            ("main.py", b"print('hi')"),
            ("state.json", br#"{"evil": true}"#),
        ]);
        let base = tmp.join("plugins");
        let (id, name, ver) = super::install_zip_into(&zip_path, &base).unwrap();
        assert_eq!((id.as_str(), name.as_str(), ver.as_str()), ("demo", "Demo", "1.2"));
        assert!(base.join("demo").join("main.py").is_file());
        // 数据文件不进包：即使 zip 里带了，也不落盘
        assert!(!base.join("demo").join("state.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn install_zip_nested_layout_and_update_keeps_data() {
        let tmp = tempfile_dir("zfm-zip-nested");
        let zip_path = tmp.join("p.zip");
        write_test_zip(&zip_path, &[
            ("font-sync/plugin.json", br#"{"id":"font-sync","name":"FS","version":"0.8.0","apiLevel":1,"entry":"main.py","permissions":[]}"#),
            ("font-sync/main.py", b"print('v2')"),
        ]);
        let base = tmp.join("plugins");
        let dir = base.join("font-sync");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), br#"{"keep": 1}"#).unwrap();
        super::install_zip_into(&zip_path, &base).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("main.py")).unwrap(), "print('v2')");
        // 更新：代码覆盖，用户数据原样保留
        assert_eq!(std::fs::read(dir.join("state.json")).unwrap(), br#"{"keep": 1}"#);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn install_zip_rejects_slip_and_bad_id() {
        let tmp = tempfile_dir("zfm-zip-slip");
        // 越界路径
        let z1 = tmp.join("slip.zip");
        write_test_zip(&z1, &[
            ("plugin.json", br#"{"id":"ok","name":"O","version":"1","apiLevel":1,"entry":"main.py","permissions":[]}"#),
            ("../evil.txt", b"x"),
        ]);
        assert!(super::install_zip_into(&z1, &tmp.join("p1")).is_err(), "zip-slip 必须被拒");
        // id 带路径字符
        let z2 = tmp.join("badid.zip");
        write_test_zip(&z2, &[
            ("plugin.json", br#"{"id":"../evil","name":"O","version":"1","apiLevel":1,"entry":"main.py","permissions":[]}"#),
            ("main.py", b"x"),
        ]);
        assert!(super::install_zip_into(&z2, &tmp.join("p2")).is_err(), "非法 id 必须被拒");
        // 不是插件包（没有 plugin.json）
        let z3 = tmp.join("notplugin.zip");
        write_test_zip(&z3, &[("a.ttf", b"x")]);
        assert!(super::install_zip_into(&z3, &tmp.join("p3")).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试辅助：往 zip 里写若干 (名字, 内容) 条目
    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        for (name, data) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    fn tempfile_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}


