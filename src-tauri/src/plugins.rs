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
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::store;

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
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub menus: Vec<PluginMenu>,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_api_level() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMenu {
    pub title: String,
    /// 挂在哪种对象上：family（字族，默认）
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

pub fn plugins_dir() -> PathBuf {
    store::app_data_dir().join("plugins")
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

/// 扫描插件目录（不启动任何东西）
pub fn list() -> Vec<PluginInfo> {
    let root = plugins_dir();
    let mut out = Vec::new();
    let running: Vec<String> = runtimes()
        .lock()
        .map(|r| r.keys().cloned().collect())
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
                let err = if m.api_level > API_LEVEL {
                    Some(format!(
                        "这个插件要求 API 级别 {}，当前软件只支持 {API_LEVEL}，请升级软件",
                        m.api_level
                    ))
                } else {
                    None
                };
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

fn command_for(dir: &Path, m: &PluginManifest) -> Result<Command, String> {
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
    let mut cmd = match kind.as_str() {
        "python" => {
            let mut c = Command::new("python");
            c.arg(&entry);
            c
        }
        "node" => {
            let mut c = Command::new("node");
            c.arg(&entry);
            c
        }
        _ => Command::new(&entry),
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
    Ok(cmd)
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

    let mut cmd = command_for(&dir, &m)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动插件进程失败（解释器没装？）：{e}"))?;
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
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(text) {
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
                            _ => {}
                        }
                    }
                    Err(_) => crate::diag::log(&format!("[plugin:{pid}] {text}")),
                }
            }
            crate::diag::log(&format!("[plugin:{pid}] stdout 结束，插件可能已退出"));
        });
    }
    if let Some(err) = child.stderr.take() {
        let pid = m.id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok).take(200) {
                crate::diag::log(&format!("[plugin:{pid}] stderr: {line}"));
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
    Ok(list().into_iter().find(|p| p.id == m.id).unwrap_or(PluginInfo {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        permissions: m.permissions,
        hooks: m.hooks,
        menus: m.menus,
        dir: dir.to_string_lossy().into_owned(),
        enabled: true,
        running: true,
        error: None,
    }))
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
