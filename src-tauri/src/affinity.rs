use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Mutex, OnceLock,
};
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::store::{self, Store};

const CANDIDATE_URLS: [&str; 3] = [
    "http://[::1]:6767/sse",
    "http://127.0.0.1:6767/sse",
    "http://localhost:6767/sse",
];

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2024-11-05"];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const STARTUP_GRACE: Duration = Duration::from_secs(20);
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(120);
const QUIET_FAILURES: u32 = 3;
const POLL_EVERY_TICKS: u32 = 15;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(30);

const DOC_FONTS_SCRIPT: &str = r#"const { Document } = require('/document.js');
const out = [];
for (const doc of Document.all) {
    const fonts = [];
    doc.enumerateFontNames((name, isInstalled) => {
        fonts.push({ name: name, isInstalled: !!isInstalled });
        return 0;
    });
    out.push({ title: doc.title, path: doc.path, fonts: fonts });
}
console.log(JSON.stringify({ docs: out }));"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityFontNeed {
    pub name: String,
    #[serde(default)]
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityDoc {
    pub title: String,
    pub path: String,
    #[serde(default)]
    pub fonts: Vec<AffinityFontNeed>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DocFontsResponse {
    #[serde(default)]
    docs: Vec<AffinityDoc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityConnection {
    pub reachable: bool,
    pub version: Option<String>,
    pub doc_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AffinityEvent {
    kind: String,
    #[serde(default)]
    docs: Vec<AffinityDoc>,
    #[serde(default)]
    message: Option<String>,
}

fn drain_frames(buf: &mut Vec<u8>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    loop {
        let end = buf
            .windows(2)
            .position(|w| w == b"\n\n")
            .or_else(|| buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 2));
        let Some(end) = end else { break };
        let raw: Vec<u8> = buf.drain(..end + 2).collect();
        let text = String::from_utf8_lossy(&raw);
        let mut event = "message".to_string();
        let mut data_lines = Vec::new();
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(v) = line.strip_prefix("event:") {
                event = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("data:") {
                data_lines.push(v.trim_start().to_string());
            }
        }
        if !data_lines.is_empty() {
            out.push((event, data_lines.join("\n")));
        }
    }
    out
}

struct Session {
    client: reqwest::Client,
    endpoint: String,
    stream: reqwest::Response,
    buf: Vec<u8>,
    next_id: u64,
}

impl Session {
    async fn open(url: &str) -> Result<(Self, Option<String>), String> {
        let client = reqwest::Client::new();
        let mut stream = client
            .get(url)
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| connect_error(&e.to_string()))?;
        let mut buf = Vec::new();
        let endpoint = tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                let chunk = stream
                    .chunk()
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "MCP stream closed before the endpoint arrived".to_string())?;
                buf.extend_from_slice(&chunk);
                for (event, data) in drain_frames(&mut buf) {
                    if event == "endpoint" {
                        return Ok::<String, String>(join_endpoint(url, &data));
                    }
                }
            }
        })
        .await
        .map_err(|_| connect_error("timed out"))??;
        let mut session = Session {
            client,
            endpoint,
            stream,
            buf,
            next_id: 1,
        };
        let mut version = None;
        let mut accepted = false;
        let mut last_err = String::new();
        for v in ordered_protocols() {
            match session.request("initialize", serde_json::json!({
                "protocolVersion": v,
                "capabilities": {},
                "clientInfo": { "name": "ZFontManager", "version": env!("CARGO_PKG_VERSION") },
            }), CONNECT_TIMEOUT).await {
                Ok(res) => {
                    accepted = true;
                    remember(best_protocol(), v.to_string());
                    version = res
                        .pointer("/serverInfo/version")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        if !accepted {
            let detail = if last_err.is_empty() {
                "no protocol version accepted".to_string()
            } else {
                last_err
            };
            return Err(detail);
        }
        session
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;
        Ok((session, version))
    }

    async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.client
            .post(&self.endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.client
            .post(&self.endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(timeout, async {
            loop {
                let chunk = self
                    .stream
                    .chunk()
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "MCP stream closed while waiting for a response".to_string())?;
                self.buf.extend_from_slice(&chunk);
                for (event, data) in drain_frames(&mut self.buf) {
                    if event != "message" {
                        continue;
                    }
                    let msg: serde_json::Value =
                        serde_json::from_str(&data).map_err(|e| e.to_string())?;
                    if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                        continue;
                    }
                    if let Some(err) = msg.get("error") {
                        return Err(err.to_string());
                    }
                    return msg
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "MCP response had no result".to_string());
                }
            }
        })
        .await
        .map_err(|_| format!("MCP '{method}' timed out"))?
    }
}

fn join_endpoint(sse_url: &str, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        return endpoint.to_string();
    }
    match sse_url.find("://") {
        Some(scheme_end) => {
            let after_scheme = &sse_url[scheme_end + 3..];
            let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
            let origin = &sse_url[..scheme_end + 3 + host_end];
            if let Some(path) = endpoint.strip_prefix('/') {
                format!("{origin}/{path}")
            } else {
                format!("{origin}/{endpoint}")
            }
        }
        None => endpoint.to_string(),
    }
}

fn connect_error(detail: &str) -> String {
    let d = detail.to_lowercase();
    if d.contains("refused")
        || d.contains("timed out")
        || d.contains("could not connect")
        || d.contains("connection closed")
        || d.contains("dns")
    {
        "Affinity is not reachable — enable the MCP server in Affinity under Settings > Model Context Protocol, then restart Affinity.".to_string()
    } else {
        format!("Affinity link failed: {detail}")
    }
}

fn pick_script_tool(tools: &[serde_json::Value]) -> Result<(String, String), String> {
    let mut fallback: Option<(&serde_json::Value, String)> = None;
    for tool in tools {
        let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let arg = script_arg_name(tool);
        let Some(arg) = arg else { continue };
        if name == "execute_script" {
            return Ok((name.to_string(), arg));
        }
        if fallback.is_none() && name.contains("script") {
            fallback = Some((tool, arg));
        }
    }
    if let Some((tool, arg)) = fallback {
        let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
        return Ok((name.to_string(), arg));
    }
    Err("the Affinity MCP server exposes no script tool".to_string())
}

fn script_arg_name(tool: &serde_json::Value) -> Option<String> {
    let props = tool.pointer("/inputSchema/properties")?.as_object()?;
    for key in ["script", "code", "source", "content", "text", "javascript"] {
        if props.contains_key(key) {
            return Some(key.to_string());
        }
    }
    let required: HashSet<&str> = tool
        .pointer("/inputSchema/required")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    props
        .iter()
        .filter(|(_, v)| v.get("type").and_then(|t| t.as_str()) == Some("string"))
        .find(|(k, _)| required.contains(k.as_str()))
        .or_else(|| {
            props
                .iter()
                .find(|(_, v)| v.get("type").and_then(|t| t.as_str()) == Some("string"))
        })
        .map(|(k, _)| k.clone())
}

fn result_text(result: &serde_json::Value) -> String {
    result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn extract_json(text: &str) -> Result<serde_json::Value, String> {
    let start = text.find('{').ok_or_else(|| "no JSON in the script result".to_string())?;
    let end = text.rfind('}').ok_or_else(|| "no JSON in the script result".to_string())?;
    serde_json::from_str(&text[start..=end]).map_err(|e| e.to_string())
}

async fn tools_list(session: &mut Session) -> Result<Vec<serde_json::Value>, String> {
    let res = session
        .request("tools/list", serde_json::json!({}), CONNECT_TIMEOUT)
        .await?;
    res.get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .ok_or_else(|| "tools/list returned no tools".to_string())
}

async fn call_tool(
    session: &mut Session,
    name: &str,
    args: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let res = session
        .request(
            "tools/call",
            serde_json::json!({ "name": name, "arguments": args }),
            timeout,
        )
        .await?;
    if res.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(result_text(&res));
    }
    Ok(res)
}

async fn read_preamble(session: &mut Session, tools: &[serde_json::Value]) -> Result<(), String> {
    let has_docs_tool = tools
        .iter()
        .any(|t| t.get("name").and_then(|n| n.as_str()) == Some("read_sdk_documentation_topic"));
    if !has_docs_tool {
        return Ok(());
    }
    call_tool(
        session,
        "read_sdk_documentation_topic",
        serde_json::json!({"filename": "preamble"}),
        CONNECT_TIMEOUT,
    )
    .await
    .map_err(|e| format!("Affinity preamble read failed: {e}"))?;
    Ok(())
}

async fn run_doc_fonts_script(session: &mut Session) -> Result<Vec<AffinityDoc>, String> {
    let tools = tools_list(session).await?;
    read_preamble(session, &tools).await?;
    let (tool_name, arg_name) = pick_script_tool(&tools)?;
    let mut args = serde_json::Map::new();
    args.insert(arg_name, serde_json::Value::String(DOC_FONTS_SCRIPT.to_string()));
    let res = call_tool(session, &tool_name, serde_json::Value::Object(args), SCRIPT_TIMEOUT)
        .await
        .map_err(|e| format!("Affinity script failed: {e}"))?;
    let parsed = extract_json(&result_text(&res))?;
    let resp: DocFontsResponse =
        serde_json::from_value(parsed).map_err(|e| format!("unexpected script result: {e}"))?;
    Ok(resp.docs)
}

async fn open_any() -> Result<(Session, Option<String>), String> {
    let mut last_err = String::new();
    for url in ordered_urls() {
        match Session::open(url).await {
            Ok(opened) => {
                remember(best_url(), url.to_string());
                return Ok(opened);
            }
            Err(e) => last_err = e,
        }
    }
    forget_endpoint();
    Err(last_err)
}

pub async fn doc_fonts() -> Result<(Option<String>, Vec<AffinityDoc>), String> {
    let (mut session, version) = open_any().await?;
    let docs = run_doc_fonts_script(&mut session).await?;
    Ok((version, docs))
}

pub async fn connection() -> AffinityConnection {
    match doc_fonts().await {
        Ok((version, docs)) => AffinityConnection {
            reachable: true,
            version,
            doc_count: docs.len(),
            error: None,
        },
        Err(e) => AffinityConnection {
            reachable: false,
            version: None,
            doc_count: 0,
            error: Some(e),
        },
    }
}

static AFFINITY_SESSION: Mutex<Vec<String>> = Mutex::new(Vec::new());
static WAS_RUNNING: AtomicBool = AtomicBool::new(false);
static KNOWN_DOCS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static TICK: AtomicU32 = AtomicU32::new(0);
static PRIMED: AtomicBool = AtomicBool::new(false);
static LINK: OnceLock<Mutex<Option<AffinityConnection>>> = OnceLock::new();
static BEST_URL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn link() -> &'static Mutex<Option<AffinityConnection>> {
    LINK.get_or_init(|| Mutex::new(None))
}

fn set_link(value: Option<AffinityConnection>) {
    if let Ok(mut c) = link().lock() {
        *c = value;
    }
}

pub fn last_link() -> Option<AffinityConnection> {
    link().lock().ok().and_then(|c| c.clone())
}
static BEST_PROTOCOL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn best_url() -> &'static Mutex<Option<String>> {
    BEST_URL.get_or_init(|| Mutex::new(None))
}

fn best_protocol() -> &'static Mutex<Option<String>> {
    BEST_PROTOCOL.get_or_init(|| Mutex::new(None))
}

fn remember<T: Clone>(cell: &'static Mutex<Option<T>>, value: T) {
    if let Ok(mut c) = cell.lock() {
        *c = Some(value);
    }
}

fn forget_endpoint() {
    if let Ok(mut c) = best_url().lock() {
        *c = None;
    }
    if let Ok(mut c) = best_protocol().lock() {
        *c = None;
    }
}

fn ordered_urls() -> Vec<&'static str> {
    let preferred = best_url().lock().ok().and_then(|c| c.clone());
    let mut out: Vec<&'static str> = Vec::with_capacity(CANDIDATE_URLS.len());
    if let Some(p) = preferred.as_deref() {
        if let Some(hit) = CANDIDATE_URLS.iter().find(|u| **u == p) {
            out.push(hit);
        }
    }
    for u in CANDIDATE_URLS {
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn ordered_protocols() -> Vec<&'static str> {
    let preferred = best_protocol().lock().ok().and_then(|c| c.clone());
    let mut out: Vec<&'static str> = Vec::with_capacity(PROTOCOL_VERSIONS.len());
    if let Some(p) = preferred.as_deref() {
        if let Some(hit) = PROTOCOL_VERSIONS.iter().find(|v| **v == p) {
            out.push(hit);
        }
    }
    for v in PROTOCOL_VERSIONS {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}
static FAILURES: AtomicU32 = AtomicU32::new(0);
static GATE: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();

fn gate() -> &'static Mutex<Option<std::time::Instant>> {
    GATE.get_or_init(|| Mutex::new(None))
}

fn arm_gate(after: Duration) {
    if let Ok(mut g) = gate().lock() {
        *g = Some(std::time::Instant::now() + after);
    }
}

fn gate_open() -> bool {
    match gate().lock() {
        Ok(g) => g.map(|t| std::time::Instant::now() >= t).unwrap_or(true),
        Err(_) => true,
    }
}

fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(1u32 << failures.min(5))
        .min(RETRY_MAX)
}

fn reset_watch_state() {
    PRIMED.store(false, Ordering::SeqCst);
    FAILURES.store(0, Ordering::SeqCst);
    forget_endpoint();
    set_link(None);
    if let Ok(mut g) = gate().lock() {
        *g = None;
    }
}

fn known_docs() -> &'static Mutex<HashSet<String>> {
    KNOWN_DOCS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn note_activated(paths: Vec<String>) {
    if let Ok(mut session) = AFFINITY_SESSION.lock() {
        for p in paths {
            if !session.contains(&p) {
                session.push(p);
            }
        }
    }
}

fn session_empty() -> bool {
    AFFINITY_SESSION.lock().map(|s| s.is_empty()).unwrap_or(true)
}

pub fn revert_session(state: &mut crate::store::AppState) -> usize {
    let paths: Vec<String> = match AFFINITY_SESSION.lock() {
        Ok(mut s) => std::mem::take(&mut *s),
        Err(_) => return 0,
    };
    let mut n = 0;
    for p in &paths {
        if crate::activation::sync(state, p, false).is_ok() {
            n += 1;
        }
    }
    let _ = store::save(state);
    n
}

fn is_affinity_running() -> bool {
    static SYS: OnceLock<Mutex<sysinfo::System>> = OnceLock::new();
    let lock = SYS.get_or_init(|| Mutex::new(sysinfo::System::new()));
    let Ok(mut sys) = lock.lock() else {
        return false;
    };
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        n == "affinity" || n == "affinity.exe" || n == "affinity.real" || n == "affinity.real.exe"
    })
}

fn emit(app: &tauri::AppHandle, kind: &str, docs: Vec<AffinityDoc>, message: Option<String>) {
    let _ = app.emit(
        "affinity:event",
        AffinityEvent {
            kind: kind.to_string(),
            docs,
            message,
        },
    );
}

fn settings_snapshot(app: &tauri::AppHandle) -> Option<(bool, bool)> {
    let store = app.state::<Store>();
    let state = store.0.lock().ok()?;
    Some((state.affinity_enabled, state.affinity_deactivate_on_quit))
}

pub fn tick(app: &tauri::AppHandle) {
    let Some((enabled, deactivate_on_quit)) = settings_snapshot(app) else {
        return;
    };
    if !enabled {
        WAS_RUNNING.store(false, Ordering::SeqCst);
        reset_watch_state();
        if !session_empty() {
            if let Some(store) = app.try_state::<Store>() {
                if let Ok(mut state) = store.0.lock() {
                    revert_session(&mut state);
                }
            }
            emit(app, "deactivated", Vec::new(), None);
        }
        if let Ok(mut known) = known_docs().lock() {
            known.clear();
        }
        return;
    }

    let running = is_affinity_running();
    let was = WAS_RUNNING.swap(running, Ordering::SeqCst);

    if running && !was {
        reset_watch_state();
        arm_gate(STARTUP_GRACE);
    } else if running && was {
        if !gate_open() {
            return;
        }
        if !PRIMED.load(Ordering::SeqCst) {
            match tauri::async_runtime::block_on(doc_fonts()) {
                Ok((version, docs)) => {
                    PRIMED.store(true, Ordering::SeqCst);
                    FAILURES.store(0, Ordering::SeqCst);
                    set_link(Some(AffinityConnection {
                        reachable: true,
                        version,
                        doc_count: docs.len(),
                        error: None,
                    }));
                    if let Ok(mut known) = known_docs().lock() {
                        *known = docs.iter().map(|d| d.path.clone()).collect();
                    }
                    emit(app, "needs", docs, None);
                }
                Err(e) => {
                    let n = FAILURES.fetch_add(1, Ordering::SeqCst) + 1;
                    forget_endpoint();
                    arm_gate(retry_delay(n));
                    set_link(Some(AffinityConnection {
                        reachable: false,
                        version: None,
                        doc_count: 0,
                        error: Some(e.clone()),
                    }));
                    if n == QUIET_FAILURES {
                        emit(app, "error", Vec::new(), Some(e));
                    }
                }
            }
            return;
        }
        let n = TICK.fetch_add(1, Ordering::SeqCst);
        if n % POLL_EVERY_TICKS == 0 {
            if let Ok((version, docs)) = tauri::async_runtime::block_on(doc_fonts()) {
                set_link(Some(AffinityConnection {
                    reachable: true,
                    version,
                    doc_count: docs.len(),
                    error: None,
                }));
                let fresh: Vec<AffinityDoc> = match known_docs().lock() {
                    Ok(mut known) => {
                        let fresh: Vec<AffinityDoc> = docs
                            .iter()
                            .filter(|d| !known.contains(&d.path))
                            .cloned()
                            .collect();
                        *known = docs.iter().map(|d| d.path.clone()).collect();
                        fresh
                    }
                    Err(_) => Vec::new(),
                };
                if !fresh.is_empty() {
                    emit(app, "needs", fresh, None);
                }
            }
        }
    } else if !running && was {
        reset_watch_state();
        if let Ok(mut known) = known_docs().lock() {
            known.clear();
        }
        if deactivate_on_quit && !session_empty() {
            if let Some(store) = app.try_state::<Store>() {
                if let Ok(mut state) = store.0.lock() {
                    revert_session(&mut state);
                }
            }
            emit(app, "deactivated", Vec::new(), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backs_off_and_caps() {
        assert_eq!(retry_delay(1), Duration::from_secs(10));
        assert_eq!(retry_delay(2), Duration::from_secs(20));
        assert_eq!(retry_delay(3), Duration::from_secs(40));
        assert_eq!(retry_delay(4), Duration::from_secs(80));
        assert_eq!(retry_delay(5), RETRY_MAX);
        assert_eq!(retry_delay(99), RETRY_MAX);
    }

    #[test]
    fn gate_holds_until_the_grace_window_passes() {
        arm_gate(Duration::from_secs(30));
        assert!(!gate_open());
        arm_gate(Duration::from_millis(0));
        assert!(gate_open());
    }

    #[test]
    fn cached_endpoint_and_protocol_are_tried_first() {
        forget_endpoint();
        assert_eq!(ordered_urls(), CANDIDATE_URLS.to_vec());
        assert_eq!(ordered_protocols(), PROTOCOL_VERSIONS.to_vec());

        remember(best_url(), CANDIDATE_URLS[2].to_string());
        remember(best_protocol(), PROTOCOL_VERSIONS[2].to_string());

        let urls = ordered_urls();
        assert_eq!(urls[0], CANDIDATE_URLS[2]);
        assert_eq!(urls.len(), CANDIDATE_URLS.len());
        for u in CANDIDATE_URLS {
            assert!(urls.contains(&u));
        }

        let vs = ordered_protocols();
        assert_eq!(vs[0], PROTOCOL_VERSIONS[2]);
        assert_eq!(vs.len(), PROTOCOL_VERSIONS.len());
        for v in PROTOCOL_VERSIONS {
            assert!(vs.contains(&v));
        }

        forget_endpoint();
        assert_eq!(ordered_urls(), CANDIDATE_URLS.to_vec());
    }

    #[test]
    fn polling_is_not_aggressive() {
        assert!(POLL_EVERY_TICKS >= 10);
    }

    #[test]
    fn grace_is_long_enough_to_clear_startup() {
        assert!(STARTUP_GRACE >= Duration::from_secs(15));
        assert!(QUIET_FAILURES >= 2);
    }
}
