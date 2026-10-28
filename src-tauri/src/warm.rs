//! 「在 Photoshop / Illustrator / CorelDRAW 中应用」的预热进度。
//!
//! 用户的原话：想在下边看到这三个软件的百分比——到 100% 时替换字体就不用等，
//! 也能看出还要等多久、或者根本连不上。
//!
//! 三个软件的就绪方式不一样：
//! - CorelDRAW：常驻 COM 宿主（`comhost`），进度来自它真实的连接阶段；
//! - Photoshop / Illustrator：没有常驻连接，每次应用都要临时起一个 PowerShell 去接 COM。
//!   所以这里测的是「接一次要多少毫秒」，那个数字就是用户点击后要等的时间。
//!
//! 探测一律在后台线程做，界面每 2 秒读一次快照，不会因为探测卡住 UI。

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::adobe::{self, Target};
use crate::procs;

/// 探测结果缓存多久算「新鲜」。超过就重新测，避免显示过期的幻觉。
const FRESH_FOR: Duration = Duration::from_secs(90);
/// 探测失败后隔多久再试（连不上时别每 2 秒都去撞一次）。
const RETRY_AFTER_FAIL: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Probing,
    Ready,
    Failed,
    NotRunning,
}

#[derive(Clone, Copy)]
struct Slot {
    state: State,
    percent: u8,
    ms: u32,
    checked: Option<Instant>,
}

impl Default for Slot {
    fn default() -> Self {
        Slot { state: State::Idle, percent: 0, ms: 0, checked: None }
    }
}

fn slots() -> &'static Mutex<HashMap<&'static str, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<&'static str, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(serde::Serialize)]
pub struct AppWarm {
    /// photoshop / illustrator / coreldraw
    pub id: &'static str,
    pub running: bool,
    /// 0~100
    pub percent: u8,
    /// managed / idle / probing / ready / failed / not-running
    pub state: &'static str,
    /// 接一次测量的耗时（毫秒）；0 表示还没测过
    pub ms: u32,
}

fn state_name(s: State) -> &'static str {
    match s {
        State::Idle => "idle",
        State::Probing => "probing",
        State::Ready => "ready",
        State::Failed => "failed",
        State::NotRunning => "not-running",
    }
}

/// 界面读的快照：不阻塞、不触发探测。
pub fn snapshot() -> Vec<AppWarm> {
    let ps_running = procs::photoshop_running();
    let ai_running = procs::illustrator_running();
    let cdr_running = procs::coreldraw_running();

    // CorelDRAW 走常驻宿主，进度直接问 comhost
    let (cdr_percent, cdr_state, cdr_ms) = crate::comhost::stage();
    let cdr = if !cdr_running {
        AppWarm { id: "coreldraw", running: false, percent: 0, state: "not-running", ms: 0 }
    } else {
        AppWarm {
            id: "coreldraw",
            running: true,
            percent: cdr_percent,
            state: cdr_state,
            ms: cdr_ms,
        }
    };

    let guard = slots().lock().ok();
    let pick = |id: &'static str, running: bool| -> AppWarm {
        if !running {
            return AppWarm { id, running: false, percent: 0, state: "not-running", ms: 0 };
        }
        let slot = guard
            .as_ref()
            .and_then(|g| g.get(id).copied())
            .unwrap_or_default();
        AppWarm {
            id,
            running: true,
            percent: slot.percent,
            state: state_name(slot.state),
            ms: slot.ms,
        }
    };

    vec![
        pick("photoshop", ps_running),
        pick("illustrator", ai_running),
        cdr,
    ]
}

/// 后台心跳：每 400ms 走一次，真正发起探测有节流。
pub fn tick() {
    let ps = procs::photoshop_running();
    let ai = procs::illustrator_running();
    maybe_probe("photoshop", Target::Photoshop, ps);
    maybe_probe("illustrator", Target::Illustrator, ai);
}

/// 刚刚跟目标软件打过一次真实的 COM 交道（应用字体成功）。
///
/// 心跳探测的「新鲜期」是 90 秒，但应用字体本身就要占用一次外部进程 + COM，
/// 两边撞在一起时探测容易超时 → 底部预热条先跳到「探测中」再变红，看起来像被我们弄坏了。
/// 这里把这次操作算作「刚刚探测过」，让心跳安静一个新鲜期；顺便把失败态清掉
/// ——既然应用成功，说明对象模型是通的。
pub fn note_activity(id: &'static str) {
    let now = Instant::now();
    let Ok(mut guard) = slots().lock() else { return };
    let slot = guard.entry(id).or_default();
    slot.checked = Some(now);
    if matches!(slot.state, State::Failed) {
        slot.state = State::Ready;
        slot.percent = 100;
    }
}

fn maybe_probe(id: &'static str, target: Target, running: bool) {
    let now = Instant::now();
    let start = {
        let Ok(mut guard) = slots().lock() else { return };
        let slot = guard.entry(id).or_default();
        if !running {
            *slot = Slot { state: State::NotRunning, percent: 0, ms: 0, checked: Some(now) };
            return;
        }
        match slot.state {
            State::Probing => return,
            State::Ready => {
                if slot.checked.map(|t| now.duration_since(t) < FRESH_FOR).unwrap_or(false) {
                    return;
                }
            }
            State::Failed => {
                if slot.checked.map(|t| now.duration_since(t) < RETRY_AFTER_FAIL).unwrap_or(false) {
                    return;
                }
            }
            _ => {}
        }
        slot.state = State::Probing;
        slot.percent = 50;
        true
    };
    if !start {
        return;
    }

    // 探测本身几百毫秒到几秒，丢到独立线程里，别拖住心跳
    std::thread::spawn(move || {
        let result = adobe::probe(target);
        let now = Instant::now();
        if let Ok(mut guard) = slots().lock() {
            let slot = guard.entry(id).or_default();
            slot.checked = Some(now);
            match result {
                Ok((true, ms)) => {
                    slot.state = State::Ready;
                    slot.percent = 100;
                    slot.ms = ms;
                }
                Ok((false, ms)) => {
                    // 进程在，但 COM 接不上（还在启动 / 卡在对话框）
                    slot.state = State::Failed;
                    slot.percent = 0;
                    slot.ms = ms;
                }
                Err(_) => {
                    slot.state = State::Failed;
                    slot.percent = 0;
                }
            }
        }
    });
}
