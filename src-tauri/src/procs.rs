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

/// 任意一个候选 exe 名（不含路径，大小写不敏感）在跑就返回 true。
pub fn any_running(names: &[&str]) -> bool {
    if names.is_empty() {
        return false;
    }
    let wanted: Vec<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    // SAFETY: 快照句柄只在本次调用内使用，返回前一定关闭；entry 是栈上的合法结构体。
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap as isize == INVALID_HANDLE_VALUE || snap.is_null() {
            return false;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut found = false;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if wanted.iter().any(|w| *w == exe_of(&entry)) {
                    found = true;
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

/// 三个目标软件各自的可执行文件名。
pub fn photoshop_running() -> bool {
    any_running(&["photoshop.exe"])
}

pub fn illustrator_running() -> bool {
    any_running(&["illustrator.exe"])
}

pub fn coreldraw_running() -> bool {
    any_running(&["coreldrw.exe", "coreldrw.exe.exe"])
}
