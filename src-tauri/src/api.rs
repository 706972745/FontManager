//! 本地 HTTP API：只监听 127.0.0.1，Bearer 令牌鉴权，默认关闭。
//!
//! 设计要点（与路线图 §3 阶段 ② 一致）：
//! - **只绑回环**：局域网 / 外网看不见；端口由系统随机分配，写进
//!   `%APPDATA%\FontManager\api.json`（含端口 + 令牌），外部程序读它发现服务。
//! - **默认关闭**：设置页开关关掉就根本不起监听（`netstat` 查不到）。
//! - **令牌**：主令牌在设置页可看 / 可重置；插件拿到的是**受限令牌**（按 permissions 过滤路由）。
//! - **危险写**（卸载 / 清空 / 覆盖导入）默认拒绝，需在设置里单独勾选。
//! - 所有业务逻辑都走 `crate::services`，不在这里重写一遍。

use crate::adobe;
use crate::services::{self, fonts, snapshot};
use crate::store::{self, Store};
use axum::{
    extract::{DefaultBodyLimit, Extension, Path as AxPath, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::{Arc, Mutex, OnceLock};

// ───────────────────────────── 共享状态 ─────────────────────────────

#[derive(Clone, Debug)]
pub struct Scope {
    pub name: String,
    /// `*` = 全权；其余是细粒度权限，见 [`PERMS`]
    pub perms: Vec<String>,
}

impl Scope {
    pub fn full(name: &str) -> Self {
        Self {
            name: name.into(),
            perms: vec!["*".into()],
        }
    }
    pub fn allow(&self, need: &str) -> bool {
        self.perms.iter().any(|p| p == "*" || p == need)
    }
}

/// 权限名单（插件 manifest 里写这些字符串）
pub const PERMS: &[&str] = &[
    "read:fonts",
    "write:fonts",
    "read:snapshot",
    "write:snapshot",
    "read:curation",
    "write:curation",
    "export",
    "import",
    // 1.9.11：把字体套用到 PS / AI / CDR（会去驱动别人的软件，单列一项）
    "write:apply",
    // 1.9.11：问「现在最近在用的是哪个设计软件」，给插件的「自动」项用
    "read:apps",
];

/// 插件 manifest 申报的权限 → 实际签发的权限（保留项, 被丢掉的原样）。
///
/// 为什么必须过这一道：[`Scope::allow`] 认 `*` 通配（主令牌用它表示全权），而插件令牌
/// 原本是 `manifest.permissions` 原样照抄的 —— 插件在 `plugin.json` 里写
/// `"permissions": ["*"]` 就能拿到整张权限表，分级形同虚设。这里只放行 [`PERMS`]
/// 登记过的名字：`*` 与拼错的名字一律丢掉并回报，由调用方记日志。
///
/// 顺带做去重与 trim，免得 `" read:fonts"` 这种手写空格被当成未知权限。
pub fn sanitize_plugin_perms(declared: &[String]) -> (Vec<String>, Vec<String>) {
    let mut keep: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for raw in declared {
        let p = raw.trim();
        if p == "*" || !PERMS.contains(&p) {
            dropped.push(raw.clone());
            continue;
        }
        if !keep.iter().any(|k| k == p) {
            keep.push(p.to_string());
        }
    }
    (keep, dropped)
}

#[derive(Debug, Clone, Default)]
pub struct Cfg {
    pub enabled: bool,
    pub port: u16,
    /// 用户指定的端口；0 = 自动挑一个空闲端口
    pub want_port: u16,
    pub token: String,
    pub dangerous: bool,
}

pub struct Hub {
    pub store: Store,
    pub cfg: Mutex<Cfg>,
    pub tokens: Mutex<HashMap<String, Scope>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    scan_lock: Mutex<bool>,
}

fn hub_cell() -> &'static OnceLock<Arc<Hub>> {
    static HUB: OnceLock<Arc<Hub>> = OnceLock::new();
    &HUB
}

pub fn hub() -> Option<Arc<Hub>> {
    hub_cell().get().cloned()
}

/// 应用启动时调一次（幂等）：建 Hub、登记主令牌，然后按 prefs 决定要不要起服务。
pub fn init(store: Store) {
    if hub_cell().set(Arc::new(Hub {
        store,
        cfg: Mutex::new(Cfg::default()),
        tokens: Mutex::new(HashMap::new()),
        task: Mutex::new(None),
        scan_lock: Mutex::new(false),
    })).is_err() {
        return;
    }
    apply_prefs();
}

fn prefs_of(hub: &Hub) -> Value {
    hub.store
        .0
        .lock()
        .map(|s| s.prefs.clone())
        .unwrap_or(Value::Null)
}

fn prefs_bool(prefs: &Value, key: &str) -> bool {
    prefs.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 端口口径：0 或缺失 = 自动；超出 1024..=65535 的一律当自动（1024 以下要提权，别答应）
pub fn normalize_port(v: Option<i64>) -> u16 {
    match v {
        Some(n) if (1024..=65535).contains(&n) => n as u16,
        _ => 0,
    }
}

fn prefs_port(prefs: &Value, key: &str) -> u16 {
    normalize_port(prefs.get(key).and_then(|v| v.as_i64()))
}

fn prefs_str(prefs: &Value, key: &str) -> Option<String> {
    prefs
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 读 prefs 决定：起 / 停 / 用新令牌重起。设置页改完、启动时都走这里。
/// 清掉上一个进程留下的 `api.json`。
///
/// 正常退出会走 `RunEvent::Exit` → `stop()` → 删文件；但任务管理器强杀、蓝屏、
/// 断电都走不到那里，文件会带着端口和令牌一直留在 `%APPDATA%` 里。下一个进程
/// 要是没开 API，这份残留就再没人管了，客户端照着它连只会得到「拒绝连接」。
fn cleanup_stale() {
    let path = api_json_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let stale = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v.get("pid").and_then(|p| p.as_u64()) != Some(std::process::id() as u64),
        // 文件坏了也算残留
        Err(_) => true,
    };
    if stale {
        let _ = std::fs::remove_file(&path);
    }
}

pub fn apply_prefs() {
    cleanup_stale();
    let Some(hub) = hub() else { return };
    let prefs = prefs_of(&hub);
    let enabled = prefs_bool(&prefs, "apiEnabled");
    let dangerous = prefs_bool(&prefs, "apiDangerous");
    let want_port = prefs_port(&prefs, "apiPort");
    let token = prefs_str(&prefs, "apiToken").unwrap_or_default();
    let token = if token.is_empty() {
        // 第一次开启：生成一个 32 位十六进制令牌并写回 prefs
        let fresh = new_token();
        if let Ok(mut state) = hub.store.0.lock() {
            if let Some(p) = state.prefs.as_object_mut() {
                p.insert("apiToken".into(), json!(fresh));
            }
            // 只动 prefs：别为了一个令牌把 1.7 MB 的字体库数据重写一遍
            let _ = store::save_prefs(&state);
        }
        fresh
    } else {
        token
    };

    {
        let Ok(mut cfg) = hub.cfg.lock() else { return };
        // 令牌换了 / 开关变了 → 重启监听
        let need_restart =
            cfg.port == 0 || cfg.token != token || cfg.enabled != enabled || cfg.want_port != want_port;
        cfg.enabled = enabled;
        cfg.dangerous = dangerous;
        cfg.want_port = want_port;
        if cfg.token != token {
            cfg.token = token.clone();
        }
        drop(cfg);
        if need_restart {
            stop();
            if enabled {
                // 起不来（端口被占 / 路由写错）不能把整个软件带崩：吞掉 panic，退回关闭态
                let hub_for_start = hub.clone();
                let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    start_server(&hub_for_start)
                }));
                match started {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        crate::diag::log(&format!("[api] 启动失败：{e}"));
                        if let Ok(mut cfg) = hub.cfg.lock() {
                            cfg.enabled = false;
                            cfg.port = 0;
                        }
                    }
                    Err(_) => {
                        crate::diag::log("[api] 启动时 panic，已停用本地 API");
                        if let Ok(mut cfg) = hub.cfg.lock() {
                            cfg.enabled = false;
                            cfg.port = 0;
                        }
                    }
                }
            }
        }
    }
    // 令牌表：主令牌全权（显式 drop 掉 guard：它借的是 hub，别让它活过函数尾）
    let registered = hub.tokens.lock().map(|mut t| t.insert(token, Scope::full("app")));
    drop(registered);
}

/// 当前实际监听端口；没在跑就是 0
pub fn current_port() -> u16 {
    hub()
        .and_then(|h| h.cfg.lock().ok().map(|c| c.port))
        .unwrap_or(0)
}

pub fn stop() {
    let Some(hub) = hub() else { return };
    if let Ok(mut task) = hub.task.lock() {
        if let Some(h) = task.take() {
            h.abort();
        }
    }
    if let Ok(mut cfg) = hub.cfg.lock() {
        cfg.port = 0;
    }
    let _ = std::fs::remove_file(api_json_path());
}

pub fn is_running() -> bool {
    hub()
        .and_then(|h| h.cfg.lock().ok().map(|c| c.enabled && c.port != 0))
        .unwrap_or(false)
}

/// 随机令牌。
///
/// **不要用 `DefaultHasher`**：它的 key 是编译期固定的，同样的输入永远得到同样的输出，
/// 攻击者只要知道进程 id 和大致启动时间就能枚举出令牌（2026-11-10 审查发现）。
/// `RandomState` 的 key 由操作系统在进程启动时随机播种（Windows 走 `ProcessPrng`），
/// 拿它做两轮哈希、各取 64 位，本地回环鉴权够用，也不必为此引入 rand。
fn random_hex() -> String {
    use std::hash::{BuildHasher, Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        services::now_ms().hash(&mut h);
        std::process::id().hash(&mut h);
        COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut h);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn new_token() -> String {
    random_hex()
}

/// 插件专用的受限令牌（由 `plugins` 模块签发，权限来自 manifest）
pub fn new_plugin_token() -> String {
    random_hex()
}

fn api_json_path() -> std::path::PathBuf {
    store::app_data_dir().join("api.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiDoc<'a> {
    port: u16,
    token: &'a str,
    base: String,
    version: &'a str,
    dangerous: bool,
    started_at: u64,
    /// 写这份文件的进程 id。软件被强杀时 api.json 会留下来，
    /// 客户端（MCP / 插件）可以先对一下 pid 再决定要不要连。
    pid: u32,
}

fn write_api_json(port: u16, token: &str, dangerous: bool) {
    let doc = ApiDoc {
        port,
        token,
        base: format!("http://127.0.0.1:{port}/api/v1"),
        version: env!("CARGO_PKG_VERSION"),
        dangerous,
        started_at: services::now_ms(),
        pid: std::process::id(),
    };
    let _ = std::fs::create_dir_all(store::app_data_dir());
    if let Ok(text) = serde_json::to_string_pretty(&doc) {
        let _ = std::fs::write(api_json_path(), text);
    }
}

// ───────────────────────────── 启停 ─────────────────────────────

fn start_server(hub: &Arc<Hub>) -> Result<u16, String> {
    let (token, dangerous, want_port) = {
        let cfg = hub.cfg.lock().map_err(|e| e.to_string())?;
        (cfg.token.clone(), cfg.dangerous, cfg.want_port)
    };
    // 用户指定了端口就先试那个；被占用（常见：另一个实例、别的开发服务）就退回随机，
    // 宁可端口跟设置里写的不一样，也不能让「开启本地 API」直接失败。
    let bind = |port: u16| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
    let listener = if want_port > 0 {
        match bind(want_port) {
            Ok(l) => l,
            Err(e) => {
                crate::diag::log(&format!(
                    "[api] 端口 {want_port} 绑定失败（{e}），改用随机端口"
                ));
                bind(0).map_err(|e| format!("绑定 127.0.0.1:0 失败：{e}"))?
            }
        }
    } else {
        bind(0).map_err(|e| format!("绑定 127.0.0.1:0 失败：{e}"))?
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    // 后 layer 的更靠外：请求依次经过 auth（认令牌）→ require_perm（查权限）→ handler
    let app = routes()
        .layer(middleware::from_fn(require_perm))
        .layer(middleware::from_fn_with_state(hub.clone(), auth));
    let app = app.with_state(hub.clone());

    let handle = tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                crate::diag::log(&format!("[api] 监听转换失败：{e}"));
                return;
            }
        };
        if let Err(e) = axum::serve(listener, app).await {
            crate::diag::log(&format!("[api] 服务退出：{e}"));
        }
    });

    if let Ok(mut t) = hub.task.lock() {
        *t = Some(handle);
    }
    if let Ok(mut cfg) = hub.cfg.lock() {
        cfg.port = port;
        cfg.enabled = true;
    }
    write_api_json(port, &token, dangerous);
    crate::diag::log(&format!("[api] 已监听 http://127.0.0.1:{port}/api/v1"));
    Ok(port)
}

// ───────────────────────────── 路由 ─────────────────────────────

/// 路径 + 方法 → 这条路由需要的权限（`None` = 只需令牌，不要额外权限）。
///
/// 为什么放在中间件里而不是各 handler 开头：带 `Json<T>` 的 handler，axum 会**先解析
/// body** 再进函数体 —— 没权限的请求会先撞上反序列化错误返回 422，让人以为「参数写错了」，
/// 还会把「接口存在」暴露出去。放在中间件里就是「先鉴权、再解析」。
fn perm_for(method: &str, path: &str) -> Option<&'static str> {
    let p = path.strip_prefix("/api/v1").unwrap_or(path);
    match method {
        _ if p == "/health" => None,
        "GET" if p == "/fonts" || p == "/fonts/families" => Some("read:fonts"),
        // 精确匹配必须排在下面那条前缀规则之前：match 是自上而下取第一条命中的，
        // 反过来写的话 /fonts/apply 会被 starts_with("/fonts/") 吃掉，
        // 拿到 write:fonts 而不是 write:apply（两个权限的分量完全不同）。
        "POST" if p == "/fonts/apply" => Some("write:apply"),
        "POST" if p.starts_with("/fonts/") => Some("write:fonts"),
        "GET" if p == "/apps/active" => Some("read:apps"),
        "GET" if p == "/snapshots" => Some("read:snapshot"),
        _ if p.starts_with("/snapshots") => Some("write:snapshot"),
        "GET" if p == "/curation" => Some("read:curation"),
        _ if p.starts_with("/curation") => Some("write:curation"),
        "POST" if p == "/export/pack" => Some("export"),
        "GET" if p.starts_with("/jobs/") => Some("export"),
        "POST" if p == "/import" => Some("import"),
        _ => None,
    }
}

/// 权限闸门：`auth` 之后跑，handler 之前跑
async fn require_perm(req: Request, next: Next) -> Response {
    let Some(scope) = req.extensions().get::<Scope>().cloned() else {
        // 走到这里说明 auth 没挂上（配置问题），当未授权处理而不是放行
        return fail(StatusCode::UNAUTHORIZED, "缺少有效令牌");
    };
    if let Some(need) = perm_for(req.method().as_str(), req.uri().path()) {
        if !scope.allow(need) {
            return fail(
                StatusCode::FORBIDDEN,
                format!(
                    "令牌「{}」没有「{need}」权限。插件要这项能力，就在它的 plugin.json 的 permissions 里加上",
                    scope.name
                ),
            );
        }
    }
    next.run(req).await
}

fn routes() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/fonts", get(list_fonts))
        .route("/api/v1/fonts/families", get(list_families))
        .route("/api/v1/fonts/activate", post(activate))
        .route("/api/v1/fonts/deactivate", post(deactivate))
        .route("/api/v1/fonts/scan", post(scan))
        // 1.9.11：把字体套用到 PS / AI / CDR（引擎只有一份，在 adobe.rs）
        .route("/api/v1/fonts/apply", post(apply_font))
        // 1.9.11：最近在用的设计软件，给插件「自动」项用
        .route("/api/v1/apps/active", get(active_app))
        .route(
            "/api/v1/snapshots",
            get(list_snapshots).post(create_snapshot),
        )
        .route(
            "/api/v1/snapshots/{name}",
            axum::routing::delete(delete_snapshot),
        )
        .route("/api/v1/snapshots/{name}/apply", post(apply_snapshot))
        .route("/api/v1/curation", get(get_curation))
        .route("/api/v1/curation/rating", put(set_rating))
        .route("/api/v1/curation/favorite", put(set_favorite))
        .route("/api/v1/curation/tags", put(set_tags))
        // 1.9.24：写一个分组的完整成员名单（插件同步分组用；空名单 = 删掉这个分组）
        .route("/api/v1/curation/collection", put(set_collection_api))
        .route("/api/v1/curation/note", put(set_note))
        .route("/api/v1/export/pack", post(export_pack))
        .route("/api/v1/jobs/{id}", get(job_status))
        .route("/api/v1/import", post(import_pack))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

// ───────────────────────────── 鉴权 ─────────────────────────────

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(|s| s.trim().to_string())
}

/// Host 头白名单：只认回环写法。
///
/// 挡的是 **DNS rebinding**：恶意网页把自己的域名解析到 127.0.0.1，然后
/// `fetch("http://evil.example:端口/api/v1/...")` —— 请求真的会打到本机服务上。
/// 令牌挡住了绝大部分，但「Host 不是本地」这条本来就该先拒掉，不该只靠令牌一道闸。
fn host_allowed(headers: &HeaderMap) -> bool {
    let Some(raw) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        // HTTP/1.0 或手写 socket 的本地客户端可能不带 Host：放行（回环 + 令牌仍是硬门槛）
        return true;
    };
    let host = raw.trim().to_ascii_lowercase();
    // 去掉端口：`127.0.0.1:51482` → `127.0.0.1`，`[::1]:51482` → `[::1]`
    let name = if let Some(end) = host.find(']') {
        host[..=end].to_string()
    } else {
        host.rsplit_once(':')
            .map(|(h, _)| h.to_string())
            .unwrap_or_else(|| host.clone())
    };
    matches!(name.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

async fn auth(State(hub): State<Arc<Hub>>, mut req: Request, next: Next) -> Response {
    if !host_allowed(req.headers()) {
        return fail(
            StatusCode::FORBIDDEN,
            "只接受来自本机的请求（Host 必须是 127.0.0.1 / localhost）",
        );
    }
    let Some(token) = bearer(req.headers()) else {
        return fail(StatusCode::UNAUTHORIZED, "缺少 Authorization: Bearer <token>；令牌在设置 → 本地 API 里看（或读 %APPDATA%\\FontManager\\api.json）");
    };
    let scope = hub.tokens.lock().ok().and_then(|t| t.get(&token).cloned());
    match scope {
        Some(s) => {
            req.extensions_mut().insert(s);
            next.run(req).await
        }
        None => fail(
            StatusCode::UNAUTHORIZED,
            "令牌不对。设置 → 本地 API 里可以查看 / 重置令牌；插件请用自己的受限令牌",
        ),
    }
}

fn fail(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

/// 这个路径算不算「我们认识的字体」—— 启用/停用只认这一类。
///
/// 三条判据，任一成立即可：
///   ① 落在某个字体库目录（`library_dir` / `library_dirs`）下面；
///   ② 在 `state.linked` 里登记过（链接字体本来就允许放在库外）；
///   ③ 落在系统字体目录里（这些之后会被下游按「系统字体不可改」跳过，不会真的被动手）。
///
/// 比较前一律 `canonicalize`：`..`、符号链接、Windows 8.3 短名都能绕开朴素的前缀判断。
fn path_in_library(store: &Store, path: &str) -> bool {
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(state) = store.0.lock() else {
        return false;
    };
    if state.linked.iter().any(|l| {
        let lp = std::path::Path::new(l);
        // Windows 的 canonicalize 会加 `\\?\` 前缀，而 state.linked 里存的是普通路径：
        // 两边都 canonicalize 再比，光比字符串会漏掉所有链接字体。
        std::fs::canonicalize(lp).map(|c| c == real).unwrap_or(false)
            || lp == real.as_path()
            || lp
                .to_string_lossy()
                .eq_ignore_ascii_case(real.to_string_lossy().as_ref())
    }) {
        return true;
    }
    let mut roots: Vec<std::path::PathBuf> = state
        .library_dirs
        .iter()
        .map(std::path::PathBuf::from)
        .collect();
    if let Some(d) = state.library_dir.as_deref() {
        roots.push(std::path::PathBuf::from(d));
    }
    roots.extend(crate::scanner::system_font_dirs());
    roots.into_iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|r| real.starts_with(&r))
            .unwrap_or(false)
    })
}

fn need(scope: &Scope, perm: &str) -> Result<(), Response> {
    if scope.allow(perm) {
        Ok(())
    } else {
        Err(fail(
            StatusCode::FORBIDDEN,
            format!("这个令牌没有「{perm}」权限；插件需要在 plugin.json 的 permissions 里声明"),
        ))
    }
}

fn map_err(e: String) -> Response {
    // 业务错误一律 400 + 人话（Agent 会把这句话直接转给用户）
    fail(StatusCode::BAD_REQUEST, e)
}

// ───────────────────────────── 处理器 ─────────────────────────────

async fn health(State(hub): State<Arc<Hub>>, Extension(scope): Extension<Scope>) -> impl IntoResponse {
    let cfg = hub.cfg.lock().map(|c| c.clone()).unwrap_or_default();
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "port": cfg.port,
        "dangerous": cfg.dangerous,
        "faces": fonts::face_count(),
        // 用缓存的字族数：这个接口会被插件面板高频轮询，现算一次要克隆五千多个字符串
        "families": fonts::family_count(),
        // 当前**这枚令牌**的权限（不是全局清单）：插件据此就知道自己能干什么
        "permissions": scope.perms,
        "tokenName": scope.name,
        "allPermissions": PERMS,
    }))
}

async fn list_fonts(
    Extension(scope): Extension<Scope>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = need(&scope, "read:fonts") {
        return r;
    }
    let query = q.get("q").map(String::as_str);
    let family = q.get("family").map(String::as_str);
    let license = q.get("license").map(String::as_str);
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
        .min(2000);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut faces = fonts::query(query, family, None, 0);
    if let Some(want) = license {
        let want = want.to_lowercase();
        faces.retain(|f| f.copyright_class.as_deref().map(str::to_lowercase).as_deref() == Some(want.as_str()));
    }
    let total = faces.len();
    let page: Vec<_> = faces.into_iter().skip(offset).take(limit).collect();
    Json(json!({ "total": total, "offset": offset, "limit": limit, "faces": page })).into_response()
}

async fn list_families(Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "read:fonts") {
        return r;
    }
    let fams = fonts::families();
    Json(json!({ "total": fams.len(), "families": fams })).into_response()
}

// ─────────────────── 1.9.11：套用字体 / 当前设计软件 ───────────────────

/// `POST /api/v1/fonts/apply` 的请求体（camelCase，与整张 API 一个口径）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyFontBody {
    /// `photoshop` / `illustrator` / `coreldraw`
    app: String,
    postscript_name: String,
    /// 提示文案用的名字（「族名 字重」）。空则回退成 `family`
    #[serde(default)]
    label: String,
    family: String,
    /// 本地化族名候选（CorelDRAW 认中文名，只给英文名会成片找不到）
    #[serde(default)]
    aliases: Vec<String>,
}

/// 把字体套用到目标软件。
///
/// 为什么要开这个端点：插件的「右键 → 套用到 PS/AI/CDR」如果自己写 COM / JSX，
/// 就等于把 `adobe.rs` 那套（启用检查、CJK 提醒、CorelDRAW 常驻宿主、9 种 outcome）
/// 复制一遍，两边必然跑偏。插件只负责触发，引擎永远只有一份。
async fn apply_font(
    Extension(scope): Extension<Scope>,
    Json(body): Json<ApplyFontBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:apply") {
        return r;
    }
    // 参数校验一律 400 + 人话：插件会把这句话直接转给用户
    let target = match adobe::Target::parse(&body.app) {
        Ok(t) => t,
        Err(_) => {
            return fail(
                StatusCode::BAD_REQUEST,
                format!(
                    "app「{}」不认识，只能是 photoshop / illustrator / coreldraw",
                    body.app
                ),
            )
        }
    };
    let postscript = body.postscript_name.trim().to_string();
    if postscript.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "postscriptName 不能为空");
    }
    let family = body.family.trim().to_string();
    if family.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "family 不能为空");
    }
    // label 只用于提示文案；缺省回退族名，绝不能让它是空串（文案会变成「已应用「」到…」）
    let label = if body.label.trim().is_empty() {
        family.clone()
    } else {
        body.label
    };
    let aliases = body.aliases;

    // 必须 spawn_blocking：apply 内部会起 PowerShell / 常驻宿主进程并轮询等待，
    // PS/AI 最多 30 秒、CorelDRAW 最多 60 秒。直接在 async handler 里跑会把
    // axum 的工作线程占死，整个本地 API 跟着没响应。
    let res = tauri::async_runtime::spawn_blocking(move || {
        adobe::apply(target, &postscript, &label, &family, &aliases)
    })
    .await;
    match res {
        // outcome 原样透传（applied:N / created / no-text-selected / font-not-found /
        // no-document / not-running / app-no-response / launch-timeout / ps-error:…），
        // 翻译成人话是调用方（插件 / Agent）的事 —— 这里翻译就等于多一份口径。
        Ok(Ok(outcome)) => Json(json!({ "outcome": outcome })).into_response(),
        Ok(Err(e)) => map_err(e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/v1/apps/active`：最近在用的设计软件（插件「自动」项用）。
///
/// 没有目标时也返回 200 + `{"app":null,"exe":""}`：这是**正常状态**（用户没开 PS），
/// 不是错误 —— 让调用方按 4xx 处理反而要多写一层分支。
async fn active_app(Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "read:apps") {
        return r;
    }
    match crate::aim::active_target() {
        Some((app, exe)) => Json(json!({ "app": app, "exe": exe })).into_response(),
        None => Json(json!({ "app": null, "exe": "" })).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateBody {
    #[serde(default)]
    families: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
}

async fn activate(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<ActivateBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:fonts") {
        return r;
    }
    set_active(hub, body, true).await
}

async fn deactivate(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<ActivateBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:fonts") {
        return r;
    }
    set_active(hub, body, false).await
}

async fn set_active(hub: Arc<Hub>, body: ActivateBody, active: bool) -> Response {
    let store = hub.store.clone();
    // paths 来自请求体（插件写的），不能想激活什么就激活什么（2026-11-10 审查）：
    // 只允许「字体库目录里的文件」和「已登记的链接字体」，其余一律拒绝。
    // 否则持有 write:fonts 的插件能把任意路径的文件注册进系统字体表。
    if !body.paths.is_empty() {
        let bad: Vec<String> = body
            .paths
            .iter()
            .filter(|p| !path_in_library(&store, p))
            .cloned()
            .collect();
        if !bad.is_empty() {
            return fail(
                StatusCode::FORBIDDEN,
                format!(
                    "这些路径不在字体库里，不允许启用/停用：{}。字体库之外的字体请走「链接字体」",
                    bad.iter().take(3).cloned().collect::<Vec<_>>().join("、")
                ),
            );
        }
    }
    let work = tokio::task::spawn_blocking(move || {
        if !body.paths.is_empty() {
            return fonts::set_paths_active(&store, &body.paths, active);
        }
        let mut faces = 0usize;
        let mut skipped = 0usize;
        for fam in &body.families {
            let r = fonts::set_family_active(&store, fam, active)?;
            faces += r.faces;
            skipped += r.skipped_system;
        }
        Ok::<_, String>(fonts::ActivateReport {
            faces,
            skipped_system: skipped,
        })
    })
    .await;
    match work {
        Ok(Ok(rep)) => Json(json!({
            "ok": true, "active": active,
            "faces": rep.faces, "skippedSystem": rep.skipped_system
        }))
        .into_response(),
        Ok(Err(e)) => map_err(e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `/fonts/scan` 的最小间隔（2026-11-10 审查）。
///
/// 全盘扫描要几秒到几十秒、吃满一个核。本机任何进程拿到令牌后都能循环调它 ——
/// 界面上的「刷新」按钮本来就有一层防抖，API 这边也该有。
const SCAN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

fn scan_clock() -> &'static Mutex<Option<std::time::Instant>> {
    static T: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

async fn scan(State(hub): State<Arc<Hub>>, Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "write:fonts") {
        return r;
    }
    {
        // 先看节流，再看「有没有在跑」：两条都过才真的扫
        let Ok(last) = scan_clock().lock() else {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "扫描计时器坏了，重启软件");
        };
        if let Some(at) = *last {
            let elapsed = at.elapsed();
            if elapsed < SCAN_MIN_INTERVAL {
                let wait = (SCAN_MIN_INTERVAL - elapsed).as_secs() + 1;
                return fail(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!("扫描太频繁了，{wait} 秒后再试（全盘扫描开销很大）"),
                );
            }
        }
    }
    {
        let Ok(mut busy) = hub.scan_lock.lock() else {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "扫描状态锁坏了，重启软件");
        };
        if *busy {
            return fail(StatusCode::CONFLICT, "已经有一次扫描在跑，等它结束（或用 GET /health 看 faces 数）");
        }
        *busy = true;
    }
    // 计时从「真的开始扫」算起：上面被 409 挡回来的重试不该把节流窗口一起吃掉
    if let Ok(mut last) = scan_clock().lock() {
        *last = Some(std::time::Instant::now());
    }
    struct NullSink;
    impl services::scan::ScanSink for NullSink {
        fn progress(&self, _done: usize, _total: usize) {}
        fn batch(&self, _faces: &[crate::font_types::FontFace]) {}
    }
    let store = hub.store.clone();
    let res = tokio::task::spawn_blocking(move || services::scan::scan_library(&store, &NullSink)).await;
    if let Ok(mut busy) = hub.scan_lock.lock() {
        *busy = false;
    }
    match res {
        Ok(Ok(faces)) => {
            let n = faces.len();
            fonts::publish(faces);
            Json(json!({ "ok": true, "faces": n })).into_response()
        }
        Ok(Err(e)) => map_err(e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_snapshots(State(hub): State<Arc<Hub>>, Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "read:snapshot") {
        return r;
    }
    match snapshot::list(&hub.store) {
        Ok(list) => Json(json!({ "snapshots": list })).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct CreateSnapshotBody {
    name: String,
    #[serde(default)]
    families: Vec<String>,
}

async fn create_snapshot(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<CreateSnapshotBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:snapshot") {
        return r;
    }
    let fams = if body.families.is_empty() {
        None
    } else {
        Some(body.families.as_slice())
    };
    match snapshot::create(&hub.store, &body.name, fams) {
        Ok(list) => Json(json!({ "ok": true, "snapshots": list })).into_response(),
        Err(e) => map_err(e),
    }
}

async fn delete_snapshot(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    AxPath(name): AxPath<String>,
) -> Response {
    if let Err(r) = need(&scope, "write:snapshot") {
        return r;
    }
    match snapshot::remove(&hub.store, &name) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => map_err(e),
    }
}

async fn apply_snapshot(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    AxPath(name): AxPath<String>,
) -> Response {
    if let Err(r) = need(&scope, "write:snapshot") {
        return r;
    }
    let store = hub.store.clone();
    let res = tokio::task::spawn_blocking(move || snapshot::apply(&store, &name)).await;
    match res {
        Ok(Ok(rep)) => Json(json!({ "ok": true, "report": rep })).into_response(),
        Ok(Err(e)) => map_err(e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_curation(State(hub): State<Arc<Hub>>, Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "read:curation") {
        return r;
    }
    match services::curation::get(&hub.store) {
        Ok(c) => Json(c).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct RatingBody {
    family: String,
    stars: u8,
}

async fn set_rating(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<RatingBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:curation") {
        return r;
    }
    match services::curation::set_rating(&hub.store, &body.family, body.stars) {
        Ok(stars) => Json(json!({ "ok": true, "family": body.family, "stars": stars })).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct FavoriteBody {
    family: String,
    favorite: bool,
}

async fn set_favorite(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<FavoriteBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:curation") {
        return r;
    }
    match services::curation::set_favorite(&hub.store, &body.family, body.favorite) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct TagsBody {
    family: String,
    #[serde(default)]
    tags: Vec<String>,
}

async fn set_tags(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<TagsBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:curation") {
        return r;
    }
    match services::curation::set_tags(&hub.store, &body.family, &body.tags) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct CollectionBody {
    /// 分组名
    name: String,
    /// 这个分组的**完整**成员名单（空 = 删掉分组）。
    /// 为什么要整份而不是「加一个 / 删一个」：插件那边是「本地 ∪ 远端」算出来的，
    /// 整份写回才不会把别人刚加的成员漏掉；代价是同一分组并发写会后者覆盖前者。
    #[serde(default)]
    families: Vec<String>,
}

async fn set_collection_api(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<CollectionBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:curation") {
        return r;
    }
    match services::curation::set_collection(&hub.store, &body.name, &body.families) {
        Ok(()) => Json(json!({ "ok": true, "name": body.name, "families": body.families.len() }))
            .into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
struct NoteBody {
    family: String,
    #[serde(default)]
    note: String,
}

async fn set_note(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<NoteBody>,
) -> Response {
    if let Err(r) = need(&scope, "write:curation") {
        return r;
    }
    match services::curation::set_note(&hub.store, &body.family, &body.note) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => map_err(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportBody {
    /// 目标文件名（`.P-FontManager`）；不传就用时间戳命名落到「文档」
    dest: Option<String>,
    /// 整理数据（前端导出的 JSON 字符串）。不传就只打包字体 + 一份空整理数据
    curation: Option<String>,
}

async fn export_pack(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<ExportBody>,
) -> Response {
    if let Err(r) = need(&scope, "export") {
        return r;
    }
    let dest = body.dest.clone().unwrap_or_else(|| {
        let stamp = chrono_like_stamp();
        dirs::document_dir()
            .unwrap_or_else(|| store::app_data_dir())
            .join(format!("FontManager-{stamp}.P-FontManager"))
            .to_string_lossy()
            .into_owned()
    });
    let curation = body.curation.unwrap_or_else(|| {
        // 没传整理数据时，用服务层现取一份（标签 / 分组 / 收藏 / 备注 / 评分）
        services::curation::get(&hub.store)
            .ok()
            .and_then(|c| serde_json::to_string(&c).ok())
            .unwrap_or_else(|| "null".into())
    });
    let job = services::job_start("pack");
    let job_id = job.clone();
    let job_for_task = job.clone();
    let store = hub.store.clone();
    let dest_for_task = dest.clone();
    tauri::async_runtime::spawn(async move {
        let res = tokio::task::spawn_blocking(move || {
            let created = "".to_string();
            services::pack::export(&store, std::path::Path::new(&dest_for_task), &curation, &created, &|p| {
                if p.total > 0 {
                    let frac = p.done as f64 / p.total as f64;
                    services::job_update(
                        &job_for_task,
                        frac,
                        format!("正在{}：{}/{}", p.phase, p.done, p.total),
                    );
                }
            })
        })
        .await;
        match res {
            Ok(Ok(rep)) => services::job_finish(
                &job,
                rep.paths.first().cloned(),
                None,
            ),
            Ok(Err(e)) => services::job_finish(&job, None, Some(e)),
            Err(e) => services::job_finish(&job, None, Some(e.to_string())),
        }
    });
    Json(json!({ "ok": true, "job": job_id, "dest": dest })).into_response()
}

async fn job_status(
    Extension(scope): Extension<Scope>,
    AxPath(id): AxPath<String>,
) -> Response {
    if let Err(r) = need(&scope, "export") {
        return r;
    }
    match services::job_get(&id) {
        Some(j) => Json(j).into_response(),
        None => fail(StatusCode::NOT_FOUND, format!("没有这个任务：{id}")),
    }
}

#[derive(Deserialize)]
struct ImportBody {
    path: String,
}

async fn import_pack(
    State(hub): State<Arc<Hub>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<ImportBody>,
) -> Response {
    if let Err(r) = need(&scope, "import") {
        return r;
    }
    if !body.path.is_empty() && !hub.cfg.lock().map(|c| c.dangerous).unwrap_or(false) {
        return fail(
            StatusCode::FORBIDDEN,
            "导入会往字体库里写文件，属于「危险写」。先在设置 → 本地 API 里勾选「允许危险操作」",
        );
    }
    let store = hub.store.clone();
    let src = std::path::PathBuf::from(&body.path);
    let res = tokio::task::spawn_blocking(move || services::pack::import(&store, &src, &|_p| {})).await;
    match res {
        Ok(Ok(rep)) => Json(json!({ "ok": true, "report": rep })).into_response(),
        Ok(Err(e)) => map_err(e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn chrono_like_stamp() -> String {
    // 不引 chrono：用系统时间戳够了（文件名只求不重名）
    let secs = services::now_secs();
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端口口径：0 / 缺失 / 越界一律当自动，1024..=65535 原样保留
    #[test]
    fn port_normalization_bounds() {
        assert_eq!(normalize_port(None), 0);
        assert_eq!(normalize_port(Some(0)), 0);
        assert_eq!(normalize_port(Some(80)), 0, "1024 以下要提权，不接受");
        assert_eq!(normalize_port(Some(1023)), 0);
        assert_eq!(normalize_port(Some(1024)), 1024);
        assert_eq!(normalize_port(Some(51482)), 51482);
        assert_eq!(normalize_port(Some(65535)), 65535);
        assert_eq!(normalize_port(Some(65536)), 0);
        assert_eq!(normalize_port(Some(-1)), 0);
    }

    /// 激活接口的路径闸门：库内放行、库外拒绝、显式登记的链接字体放行（S8）
    #[test]
    fn activation_path_gate() {
        let root = std::env::temp_dir().join(format!("zfm-api-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("lib")).unwrap();
        let inside = root.join("lib").join("A.ttf");
        let outside = root.join("B.ttf");
        let linked = root.join("C.ttf");
        for p in [&inside, &outside, &linked] {
            std::fs::write(p, b"x").unwrap();
        }
        let mut st = crate::store::AppState::default();
        st.library_dir = Some(root.join("lib").to_string_lossy().into_owned());
        st.linked.insert(linked.to_string_lossy().into_owned());
        let store = Store(std::sync::Arc::new(std::sync::Mutex::new(st)));

        let p = |x: &std::path::Path| x.to_string_lossy().into_owned();
        assert!(path_in_library(&store, &p(&inside)), "库内字体必须放行");
        assert!(!path_in_library(&store, &p(&outside)), "库外任意文件必须拒绝");
        assert!(path_in_library(&store, &p(&linked)), "链接字体在库外也要放行");
        assert!(!path_in_library(&store, &p(&root.join("missing.ttf"))), "不存在的路径拒绝");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Host 白名单：只认回环写法，挡住 DNS rebinding（S3）
    #[test]
    fn host_gate_rejects_remote_hosts() {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::HOST, "127.0.0.1:51482".parse().unwrap());
        assert!(host_allowed(&h));
        h.insert(axum::http::header::HOST, "localhost".parse().unwrap());
        assert!(host_allowed(&h));
        h.insert(axum::http::header::HOST, "[::1]:8080".parse().unwrap());
        assert!(host_allowed(&h));
        h.insert(axum::http::header::HOST, "evil.example:51482".parse().unwrap());
        assert!(!host_allowed(&h));
    }

    /// 插件权限收敛：`*` 与拼错的名字必须被丢掉，否则一行 manifest 就能绕过整张权限表
    #[test]
    fn plugin_perms_are_whitelisted() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();

        let (keep, drop) = sanitize_plugin_perms(&s(&["*"]));
        assert!(keep.is_empty(), "`*` 绝不能换来全权，实际 {:?}", keep);
        assert_eq!(drop, s(&["*"]));

        let (keep, drop) = sanitize_plugin_perms(&s(&["read:fonts", "*", "read:font"]));
        assert_eq!(keep, s(&["read:fonts"]));
        assert_eq!(drop, s(&["*", "read:font"]), "未知权限名要回报，插件作者才知道自己拼错了");

        // 去重 + 去空白，但顺序保持申报顺序（日志/界面读起来和 manifest 一致）
        let (keep, drop) = sanitize_plugin_perms(&s(&[" write:curation ", "read:fonts", "write:curation"]));
        assert_eq!(keep, s(&["write:curation", "read:fonts"]));
        assert!(drop.is_empty());

        // 全表都认得
        let all = PERMS.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let (keep, drop) = sanitize_plugin_perms(&all);
        assert_eq!(keep.len(), PERMS.len());
        assert!(drop.is_empty());
    }

    /// 从源码里抠出 `.route(路径, 方法(...))`：路径 = 第一个字符串字面量，
    /// 方法 = 括号内的 `get(` / `post(` / `put(` / `delete(` / `patch(` 等。
    fn parse_routes(src: &str) -> Vec<(String, String)> {
        // 拼出来是为了让本文件里不出现会被自己匹配到的字面量
        let marker = concat!(".", "route(");
        let bytes = src.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(pos) = src[i..].find(marker) {
            let start = i + pos + marker.len();
            let mut depth = 1usize;
            let mut j = start;
            while j < bytes.len() {
                match bytes[j] {
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            let call = &src[start..j];
            i = j;
            let Some(q0) = call.find('"') else { continue };
            let Some(q1) = call[q0 + 1..].find('"').map(|x| x + q0 + 1) else {
                continue;
            };
            let path = &call[q0 + 1..q1];
            for m in ["get", "post", "put", "delete", "patch", "head", "options"] {
                if call[q1..].contains(&format!("{m}(")) {
                    out.push((m.to_uppercase(), path.to_string()));
                }
            }
        }
        out
    }

    /// 1.9.11 的两条新路由：权限必须是精确的那一项，不能被前缀规则吃掉。
    ///
    /// `/fonts/apply` 撞的是 `"POST" if p.starts_with("/fonts/")` 那条 —— match 自上而下
    /// 取第一条命中，顺序写反了它就会拿到 `write:fonts`（能改系统字体表的权限），
    /// 等于把一个「驱动别人软件」的动作混进了「启用/停用」里。这条单测钉住顺序。
    #[test]
    fn apply_and_active_use_their_own_perm() {
        assert_eq!(perm_for("POST", "/api/v1/fonts/apply"), Some("write:apply"));
        assert_eq!(perm_for("GET", "/api/v1/apps/active"), Some("read:apps"));
        // 相邻的既有路由不能被新规则带偏
        assert_eq!(perm_for("POST", "/api/v1/fonts/activate"), Some("write:fonts"));
        assert_eq!(perm_for("POST", "/api/v1/fonts/deactivate"), Some("write:fonts"));
        // 两个新权限本身必须在名单里，否则插件永远申请不到
        assert!(PERMS.contains(&"write:apply"));
        assert!(PERMS.contains(&"read:apps"));
    }

    /// 1.9.11 的两个 handler：不起 HTTP 服务也能验「闸门 + 参数校验 + 响应形状」。
    ///
    /// 为什么不走真 HTTP：那要先开本地 API、拿令牌、还要能起 PowerShell 真去驱动 PS。
    /// 这三条测试都在**进入 adobe::apply 之前**返回，所以跑起来是毫秒级、不碰任何外部软件。
    #[test]
    fn apply_font_gates_and_validates() {
        let body = |app: &str, ps: &str, family: &str| ApplyFontBody {
            app: app.into(),
            postscript_name: ps.into(),
            label: String::new(),
            family: family.into(),
            aliases: Vec::new(),
        };

        // ① 权限不够 → 403，而且必须发生在参数校验之前（中间件口径：先鉴权再解析）
        let weak = Scope {
            name: "p".into(),
            perms: vec!["read:fonts".into()],
        };
        let res = tauri::async_runtime::block_on(apply_font(
            Extension(weak),
            Json(body("notepad", "X-Reg", "X")),
        ));
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // ② app 不认识 → 400
        let res = tauri::async_runtime::block_on(apply_font(
            Extension(Scope::full("test")),
            Json(body("notepad", "X-Reg", "X")),
        ));
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // ③ 缺 postscriptName / family → 400
        for (ps, family) in [("", "X"), ("X-Reg", "")] {
            let res = tauri::async_runtime::block_on(apply_font(
                Extension(Scope::full("test")),
                Json(body("photoshop", ps, family)),
            ));
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "ps={ps:?} family={family:?}");
        }
    }

    /// `/apps/active` 永远 200：没有目标时返回 `{"app":null,"exe":""}` 是**正常状态**，
    /// 不是错误。这条钉住「形状不会变」—— 插件的「自动」项按这个形状解包。
    #[test]
    fn active_app_always_answers_200_with_shape() {
        let res = tauri::async_runtime::block_on(active_app(Extension(Scope::full("test"))));
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = tauri::async_runtime::block_on(axum::body::to_bytes(res.into_body(), 4096))
            .expect("读响应体失败");
        let v: Value = serde_json::from_slice(&bytes).expect("响应不是 JSON");
        assert!(v.get("app").is_some(), "缺 app 字段：{v}");
        assert!(v.get("exe").is_some(), "缺 exe 字段：{v}");
        // app 要么是三个标识之一，要么是 null；不能是别的字符串
        match v.get("app") {
            Some(Value::Null) => {}
            Some(Value::String(s)) => {
                assert!(
                    ["photoshop", "illustrator", "coreldraw"].contains(&s.as_str()),
                    "app 返回了意料外的值：{s}"
                );
            }
            other => panic!("app 字段类型不对：{other:?}"),
        }

        // 权限不够 → 403（同样先于任何窗口探测）
        let weak = Scope {
            name: "p".into(),
            perms: vec!["read:fonts".into()],
        };
        let res = tauri::async_runtime::block_on(active_app(Extension(weak)));
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    /// 每条路由都必须落在权限表里（或显式豁免名单里）。
    ///
    /// `perm_for` 末尾的 `_ => None` 是**默认放行**：以后加接口忘了登记，就是一条无声的
    /// 越权通道 —— 受限令牌照样能打通。这条单测直接读本文件源码里的路由声明，
    /// 新增端点不写权限会立刻变红，不需要人去记「记得同步权限表」。
    #[test]
    fn every_route_is_gated() {
        // 只需令牌、不需要额外权限的路由（目前只有探活）
        const EXEMPT: &[(&str, &str)] = &[("GET", "/api/v1/health")];

        let routes = parse_routes(include_str!("api.rs"));
        assert!(
            routes.len() >= 16,
            "只解析到 {} 条路由，解析器大概失效了（源码写法变了？）",
            routes.len()
        );
        assert!(
            routes.iter().any(|(_, p)| p == "/api/v1/import"),
            "解析器没抓到 /import，说明它已经不可信了"
        );

        for (method, path) in routes {
            // 路径模板 → 一个具体路径，喂给 perm_for 判断
            let concrete = path.replace("{name}", "x").replace("{id}", "1");
            let exempt = EXEMPT.iter().any(|(m, p)| *m == method && *p == path);
            match perm_for(&method, &concrete) {
                Some(perm) => assert!(
                    PERMS.contains(&perm),
                    "{method} {path} 要的权限「{perm}」不在 PERMS 名单里，插件永远申请不到它"
                ),
                None => assert!(
                    exempt,
                    "{method} {path} 没有登记权限 —— perm_for 会默认放行，受限令牌也能打通。\
                     要么在 perm_for 里补一条，要么显式加进 EXEMPT"
                ),
            }
        }
    }
}
