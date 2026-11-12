//! 极小的进程探测：只回答「某个 exe 现在有没有在跑」。
//!
//! 为什么不走 PowerShell / tasklist：这个检测每 2 秒就要跑一次（底部预热指示条），
//! 起子进程的成本比答案本身高两个数量级。Toolhelp32 是一次快照，几毫秒。

#![cfg(target_os = "windows")]

use std::ffi::c_void;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const MAX_PATH: usize = 260;
const INVALID_HANDLE_VALUE: isize = -1;

#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; MAX_PATH],
}

extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

fn exe_of(entry: &ProcessEntry32W) -> String {
    let len = entry
        .sz_exe_file
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(MAX_PATH);
    String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_ascii_lowercase()
}

/// 按 PID 反查进程名（小写 exe 文件名）。
///
/// 为什么用 Toolhelp 快照而不是 `OpenProcess` + `QueryFullProcessImageNameW`：
/// 目标软件常以管理员权限运行，普通权限拿不到它的进程句柄（OpenProcess 直接失败），
/// 但进程快照是系统级枚举，不需要对目标进程有任何权限 —— 我们只要一个文件名。
pub fn exe_of_pid(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: 快照句柄只在本次调用内使用，返回前一定关闭；entry 是栈上的合法结构体。
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap as isize == INVALID_HANDLE_VALUE || snap.is_null() {
            return None;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut found: Option<String> = None;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if entry.th32_process_id == pid {
                    found = Some(exe_of(&entry));
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found
    }
}

/// 三个目标软件**一次快照查完**：返回 (photoshop, illustrator, coreldraw)。
///
/// 调用方（`warm::tick` 每 400ms、`warm::snapshot` 每 2 秒）原来每个软件各拍一份
/// 全系统进程快照，合计平均每秒 ~3 份；Toolhelp 快照要把全部进程枚举一遍，
/// 在进程多的机器上这是一项稳定的后台 CPU 消耗（2026-11-11 同事反馈卡顿排查时发现）。
/// 合并后每秒只剩 ~1.5 份，行为不变 —— 三个答案本来就来自同一时刻，
/// 放同一份快照里反而更一致。
pub fn targets_running() -> (bool, bool, bool) {
    const PS: &str = "photoshop.exe";
    const AI: &str = "illustrator.exe";
    const CDR: [&str; 2] = ["coreldrw.exe", "coreldrw.exe.exe"];
    // SAFETY: 快照句柄只在本次调用内使用，返回前一定关闭；entry 是栈上的合法结构体。
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap as isize == INVALID_HANDLE_VALUE || snap.is_null() {
            return (false, false, false);
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let (mut ps, mut ai, mut cdr) = (false, false, false);
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let exe = exe_of(&entry);
                if !ps && exe == PS {
                    ps = true;
                } else if !ai && exe == AI {
                    ai = true;
                } else if !cdr && CDR.iter().any(|w| *w == exe) {
                    cdr = true;
                }
                if (ps && ai && cdr) || Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        (ps, ai, cdr)
    }
}
