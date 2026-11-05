//! 业务层（service 层）。
//!
//! 这里的函数是**给任何入口调用的公共逻辑**：Tauri 命令（WebView）、本地 HTTP API、
//! 插件、以及将来的 CLI 都走同一套实现。规矩只有一条：
//!
//! > **本目录下的代码不允许出现任何 Tauri 类型**（AppHandle / State / Window / Emitter）。
//!
//! 需要通知界面的地方一律用回调参数（crate::services::Progress 之类），由调用方决定
//! 发到哪儿去。命令函数只负责「解参数 → 调本层 → 把结果转回去」，越薄越好。
//!
//! 另外这里还放两个全局小设施：
//! - [`faces`]：最近一次扫描结果的内存快照。API / 插件读它，不必自己重扫（重扫要几秒到几分钟）。
//! - [`jobs`]：长任务（导出整包）的进度表，HTTP 侧靠 job id 轮询。

pub mod curation;
pub mod fonts;
pub mod pack;
pub mod scan;
pub mod snapshot;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 当前 Unix 毫秒
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 当前 Unix 秒
pub fn now_secs() -> u64 {
    now_ms() / 1000
}

// ───────────────────────────── 长任务进度表 ─────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// running / done / failed
    pub status: String,
    /// 0~1
    pub progress: f64,
    /// 人话进度，例如「正在打包字体 3080/5548 个文件 · 56%」
    pub message: String,
    /// 成功时是产物路径（多卷时是第一卷）
    pub result: Option<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

fn job_table() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 新建一个任务并返回 id（`prefix` 只用于肉眼区分，例如 `pack`）
pub fn job_start(prefix: &str) -> String {
    let id = format!("{prefix}-{}-{}", now_secs(), (now_ms() % 1000));
    if let Ok(mut t) = job_table().lock() {
        // 只留最近 20 个，避免长跑之后无限增长
        if t.len() > 20 {
            let mut keys: Vec<String> = t
                .iter()
                .filter(|(_, j)| j.status != "running")
                .map(|(k, _)| k.clone())
                .collect();
            keys.sort();
            for k in keys.into_iter().take(t.len() - 20) {
                t.remove(&k);
            }
        }
        t.insert(
            id.clone(),
            Job {
                id: id.clone(),
                status: "running".into(),
                progress: 0.0,
                message: String::new(),
                result: None,
                error: None,
                started_at: now_ms(),
                finished_at: None,
            },
        );
    }
    id
}

pub fn job_update(id: &str, progress: f64, message: impl Into<String>) {
    if let Ok(mut t) = job_table().lock() {
        if let Some(j) = t.get_mut(id) {
            j.progress = progress.clamp(0.0, 1.0);
            j.message = message.into();
        }
    }
}

pub fn job_finish(id: &str, result: Option<String>, error: Option<String>) {
    if let Ok(mut t) = job_table().lock() {
        if let Some(j) = t.get_mut(id) {
            j.status = if error.is_some() { "failed" } else { "done" }.into();
            j.progress = if error.is_some() { j.progress } else { 1.0 };
            j.result = result;
            j.error = error;
            j.finished_at = Some(now_ms());
        }
    }
}

pub fn job_get(id: &str) -> Option<Job> {
    job_table().lock().ok()?.get(id).cloned()
}

/// 统一的错误包装：外部入口（API / 插件 / Agent）拿到的是人话 + 下一步指引。
pub fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}
