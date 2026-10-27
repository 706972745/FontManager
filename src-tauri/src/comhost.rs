//! CorelDRAW 的常驻 COM 宿主。
//!
//! 为什么需要它：CorelDRAW 的自动化对象图**第一次被摸到**极慢——实测在同一个
//! PowerShell 进程里，`ActiveDocument` 首次 0.9 秒、`ActiveSelectionRange` 首次
//! 1.0 秒、`shape.Text.Story` 首次 1.7 秒、`story.Font` 首次 0.9 秒，合计约 4.5 秒；
//! 而同一个对象第二次访问只要 20~50 毫秒。也就是说这 4 秒是**每个进程付一次**的
//! 初始化税，不是每次操作都要付。
//!
//! 原来的实现每次应用字体都新起一个 `powershell.exe -EncodedCommand`，于是每次点击
//! 都要把这份税重交一遍（用户感知就是"点一下要等四五秒"）。
//!
//! 这里的做法：起一个长期存活的 `powershell -Sta` 进程，把 CorelDRAW 的 COM 连接
//! 攥在手里，通过 stdin/stdout 收发一行行命令。首次连接的开销由预热点火（应用启动
//! 时后台跑）承担，用户真正点下去时只剩几十毫秒的实际操作。
//!
//! 协议见 `comhost.ps1` 头部注释：每条命令一行，每个回复一行，回复带 `#ZFM#`
//! 前缀 + base64，这样 PowerShell 自身的任何杂音都不会被误当成结果。

use crate::adobe::base64_encode;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROTO_PREFIX: &str = "#ZFM#";
const SCRIPT: &str = include_str!("comhost.ps1");

/// 预热进度：给界面底部那条指示器用。
/// `(百分比, 状态, 耗时毫秒)`，状态取值 idle / connecting / ready / not-running / failed。
static STAGE: Mutex<(u8, &'static str, u32)> = Mutex::new((0, "idle", 0));

fn set_stage(percent: u8, state: &'static str, ms: u32) {
    if let Ok(mut g) = STAGE.lock() {
        *g = (percent, state, ms);
    }
}

/// 外部（预热指示器）读当前 CorelDRAW 的预热进度。
pub fn stage() -> (u8, &'static str, u32) {
    STAGE.lock().map(|g| *g).unwrap_or((0, "idle", 0))
}

/// 宿主出问题时的现场只存在于进程内存里，用户报「超时」我们只能猜。
/// 这里落一份很小的日志（%TEMP%\zfontmanager-comhost.log，超过 256KB 自动重写），
/// 用来区分「宿主没起来 / 握手超时 / CorelDRAW 没响应」这三种完全不同的原因。
pub fn log(msg: &str) {
    #[repr(C)]
    struct LocalTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    extern "system" {
        fn GetLocalTime(out: *mut LocalTime);
    }

    let mut t = LocalTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        millis: 0,
    };
    // SAFETY: GetLocalTime 只写这一个结构体，指针来源于栈上的合法 mut 局部变量。
    unsafe { GetLocalTime(&mut t) };

    let path = std::env::temp_dir().join("zfontmanager-comhost.log");
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let line = format!(
        "{:02}:{:02}:{:02}.{:03} {msg}\n",
        t.hour, t.minute, t.second, t.millis
    );
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 宿主进程本体。`rx` 只收到带前缀的行（已剥掉前缀），其余输出一律丢弃。
struct Host {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    /// 宿主写脚本文件的路径，退出时清掉
    script_path: std::path::PathBuf,
}

impl Drop for Host {
    fn drop(&mut self) {
        // 宿主是靠 stdin 活着的：管道一关它自己就走到 EOF 退出；kill 是兜底
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.script_path);
    }
}

fn slot() -> &'static Mutex<Option<Host>> {
    static SLOT: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn powershell_exe() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let full = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if std::path::Path::new(&full).exists() {
        full
    } else {
        "powershell".to_string()
    }
}

/// 起一个新宿主并等它打出 `ready`。
fn spawn() -> Result<Host, String> {
    set_stage(10, "connecting", 0);
    let script_path = std::env::temp_dir()
        .join(format!("zfontmanager-comhost-{}.ps1", std::process::id()));
    // PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解释，脚本里只要有中文就会乱码。
    let mut body = Vec::with_capacity(SCRIPT.len() + 3);
    body.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    body.extend_from_slice(SCRIPT.as_bytes());
    std::fs::write(&script_path, body).map_err(|e| format!("write comhost script: {e}"))?;

    let mut child = Command::new(powershell_exe())
        .args([
            "-NoProfile",
            "-NonInteractive",
            // CorelDRAW 是单线程套间 COM 服务器，STA 才能正常操纵它的对象模型
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 直接丢弃：宿主脚本自己把所有错误都变成一行结果，留着管道反而可能写满阻塞
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_file(&script_path);
            format!("spawn comhost: {e}")
        })?;

    let stdin = child.stdin.take().ok_or("comhost: no stdin")?;
    let stdout = child.stdout.take().ok_or("comhost: no stdout")?;
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Some(rest) = line.strip_prefix(PROTO_PREFIX) else { continue };
            if tx.send(rest.trim().to_string()).is_err() {
                break;
            }
        }
        // 管道关闭 = 宿主没了，唤醒所有等待者
        let _ = tx.send(String::new());
    });

    let host = Host { child, stdin, rx, script_path };

    // 等握手。脚本加载 + PowerShell 自身启动通常 300~600ms，给足余量。
    let started = Instant::now();
    let deadline = started + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            log(&format!("spawn: handshake timeout after {}ms", started.elapsed().as_millis()));
            return Err("comhost: handshake timeout".to_string());
        }
        match host.rx.recv_timeout(left) {
            // 空行是读取线程在管道关闭时注入的哨兵（宿主进程已经没了）
            Ok(line) if line.is_empty() => {
                log("spawn: exited during handshake");
                return Err("comhost: exited during handshake".to_string());
            }
            // 宿主的每一行回复都是 base64（见 comhost.ps1 的 Send），必须先解码再比对。
            // 0.8.25/0.8.26 这里直接拿 base64 文本跟 "ready" 比，永远不相等，
            // 于是每次握手都干等满 10 秒超时——预热指示灯永远停在 0%，应用字体也退化成一
            // 次性脚本（用户看到的「一直链接不上」「点一下要等好几秒」都是这个引起的）。
            Ok(line) => match decode(&line).as_deref() {
                Some("ready") => {
                    log(&format!("spawn: ready in {}ms", started.elapsed().as_millis()));
                    set_stage(35, "connecting", started.elapsed().as_millis() as u32);
                    return Ok(host);
                }
                // 理论上不会有别的，忽略
                _ => continue,
            },
            Err(RecvTimeoutError::Timeout) => {
                log(&format!("spawn: handshake timeout after {}ms", started.elapsed().as_millis()));
                return Err("comhost: handshake timeout".to_string());
            }
            Err(RecvTimeoutError::Disconnected) => {
                log("spawn: disconnected during handshake");
                return Err("comhost: exited during handshake".to_string())
            }
        }
    }
}

fn try_spawn() -> Result<(), String> {
    let mut guard = slot().lock().map_err(|_| "comhost: lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    *guard = Some(spawn()?);
    Ok(())
}

/// 发一条命令并等一行结果。超时 / 管道断开都会把宿主丢掉，下次调用重新起一个。
fn request(cmd: &str, timeout: Duration) -> Result<String, String> {
    try_spawn()?;
    let mut guard = slot().lock().map_err(|_| "comhost: lock poisoned".to_string())?;
    let outcome = match guard.as_mut() {
        Some(host) => drive(host, cmd, timeout),
        None => Err("comhost: unavailable".to_string()),
    };
    // 任何失败都意味着这条管道已经不可信，直接丢掉；下次 try_spawn 会重建
    if outcome.is_err() {
        *guard = None;
    }
    outcome
}

fn drive(host: &mut Host, cmd: &str, timeout: Duration) -> Result<String, String> {
    let mut line = String::with_capacity(cmd.len() + 1);
    line.push_str(cmd);
    line.push('\n');
    if let Err(e) = host.stdin.write_all(line.as_bytes()).and_then(|_| host.stdin.flush()) {
        return Err(format!("comhost: write failed: {e}"));
    }

    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("comhost: timeout".to_string());
        }
        match host.rx.recv_timeout(left) {
            // 空行是读取线程在管道关闭时注入的哨兵
            Ok(raw) if raw.is_empty() => return Err("comhost: exited".to_string()),
            Ok(raw) => {
                return decode(&raw).ok_or_else(|| "comhost: bad reply encoding".to_string())
            }
            Err(RecvTimeoutError::Timeout) => return Err("comhost: timeout".to_string()),
            Err(RecvTimeoutError::Disconnected) => return Err("comhost: exited".to_string()),
        }
    }
}

/// base64 → UTF-8。只在协议回复上使用，输入非法就返回 None。
fn decode(s: &str) -> Option<String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    let mut out: Vec<u8> = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for b in s.bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' {
            continue;
        }
        let v = lookup[b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    String::from_utf8(out).ok()
}

/// 后台预热：起宿主 + 让 CorelDRAW 的 COM 连接完成首次对象访问。
/// 返回的是 Attach 的状态：`ok` / `not-running` / `launch-timeout`。
pub fn warm() -> Result<String, String> {
    let started = Instant::now();
    let result = request("WARM", Duration::from_secs(30))
        .map(|reply| reply.strip_prefix("warm:").unwrap_or(&reply).to_string());
    let ms = started.elapsed().as_millis() as u32;
    log(&format!(
        "warm -> {} ({}ms)",
        match &result {
            Ok(v) => v.as_str(),
            Err(e) => e.as_str(),
        },
        ms
    ));
    match result.as_deref() {
        Ok("ok") => set_stage(100, "ready", ms),
        Ok("not-running") => set_stage(0, "not-running", ms),
        // launch-timeout / 其它：CorelDRAW 在跑但没能接上
        Ok(_) => set_stage(0, "failed", ms),
        Err(_) => set_stage(0, "failed", ms),
    }
    result
}

/// 应用字体。`fonts` 是候选字体名（显示名优先，其次 PostScript 名）。
/// 返回的 token 与原来一次性方案保持一致（`applied:N` / `created` / `font-rejected` ...）。
pub fn apply(label: &str, fonts: &[String]) -> Result<String, String> {
    let payload = serde_json::json!({ "label": label, "fonts": fonts });
    let text = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let cmd = format!("APPLY {}", base64_encode(text.as_bytes()));
    // 热宿主只要 0.2~0.7 秒；冷宿主（CorelDRAW 刚被打开）最多 ~6 秒。
    // 12 秒还没回 = 连接卡住了，交给上层丢掉宿主重建重试，别让用户干等 25 秒。
    let started = Instant::now();
    let result = request(&cmd, Duration::from_secs(12));
    let ms = started.elapsed().as_millis() as u32;
    log(&format!(
        "apply[{label}] -> {} ({}ms)",
        match &result {
            Ok(v) => v.as_str(),
            Err(e) => e.as_str(),
        },
        ms
    ));
    match &result {
        Ok(_) => set_stage(100, "ready", ms),
        Err(_) => set_stage(0, "failed", ms),
    }
    result
}

/// 丢掉 COM 连接但保留宿主进程（用户关掉 CorelDRAW 后调用，避免攥着失效引用）。
#[allow(dead_code)]
pub fn release() {
    if let Ok(mut guard) = slot().lock() {
        if let Some(host) = guard.as_mut() {
            let _ = host.stdin.write_all(b"RELEASE\n");
            let _ = host.stdin.flush();
            // 吃掉回复，别让它污染下一次请求
            let _ = host.rx.recv_timeout(Duration::from_millis(500));
        }
    }
}

/// 退出前调用：结束宿主进程、删掉临时脚本。
pub fn shutdown() {
    if let Ok(mut guard) = slot().lock() {
        *guard = None; // Drop 负责 kill + 清理
    }
    set_stage(0, "idle", 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for s in ["applied:1", "warm:ok", "ps-error:中文 消息", "", "x"] {
            let enc = base64_encode(s.as_bytes());
            assert_eq!(decode(&enc).as_deref(), Some(s), "roundtrip failed for {s:?}");
        }
    }

    #[test]
    fn base64_rejects_garbage() {
        assert!(decode("这不是base64").is_none());
        assert!(decode("!!!!").is_none());
    }

    #[test]
    fn base64_padding() {
        // PS 侧一律带填充；解码要能容忍尾部 '='
        assert_eq!(decode("YQ==").as_deref(), Some("a"));
        assert_eq!(decode("YWI=").as_deref(), Some("ab"));
        assert_eq!(decode("YWJj").as_deref(), Some("abc"));
    }
}
