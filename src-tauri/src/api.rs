//! 本地 HTTP API：只监听 127.0.0.1，Bearer 令牌鉴权，默认关闭。
//!
//! 设计要点（与路线图 §3 阶段 ② 一致）：
//! - **只绑回环**：局域网 / 外网看不见；端口由系统随机分配，写进
//!   `%APPDATA%\FontManager\api.json`（含端口 + 令牌），外部程序读它发现服务。
//! - **默认关闭**：设置页开关关掉就根本不起监听（`netstat` 查不到）。
//! - **令牌**：主令牌在设置页可看 / 可重置；插件拿到的是**受限令牌**（按 permissions 过滤路由）。
//! - **危险写**（卸载 / 清空 / 覆盖导入）默认拒绝，需在设置里单独勾选。
//! - 所有业务逻辑都走 `crate::services`，不在这里重写一遍。

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
];

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
            let _ = store::save(&state);
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

/// 随机令牌：不引 rand，用时间 + 进程 + 地址 + 计数器打散，本地回环够用
fn random_hex() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    services::now_ms().hash(&mut h);
    std::process::id().hash(&mut h);
    (&h as *const _ as usize).hash(&mut h);
    format!("{:016x}{:016x}", h.finish(), services::now_ms().rotate_left(7))
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
        "POST" if p.starts_with("/fonts/") => Some("write:fonts"),
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

async fn auth(State(hub): State<Arc<Hub>>, mut req: Request, next: Next) -> Response {
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
        "families": fonts::families().len(),
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

async fn scan(State(hub): State<Arc<Hub>>, Extension(scope): Extension<Scope>) -> Response {
    if let Err(r) = need(&scope, "write:fonts") {
        return r;
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
}
