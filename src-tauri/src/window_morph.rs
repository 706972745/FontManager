//! 窗口形变（速览 ↔ 完整界面切换时的平滑过渡）。
//!
//! 前端只负责把起止几何算好，真正的插值放在原生线程里跑：
//! 切进速览时前端要渲染上千张字体卡片，主线程会被占住几百毫秒到数秒，
//! 如果动画跑在 `requestAnimationFrame` 上就会被一起堵住——表现是「点了没反应，
//! 然后窗口一下子跳到位」。放在这里则窗口立刻开始动，内容随后填进来。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// 窗口几何（物理像素）。
/// x / y 是外框左上角（与 outer_position / set_position 一致），
/// width / height 是客户区（与 inner_size / set_size 一致）。
#[derive(serde::Deserialize, Clone, Copy)]
pub struct MorphRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 上一次形变的取消标志：新的形变开始时先把旧的停掉，避免两个循环同时改窗口几何。
static ACTIVE_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Windows 窗口动画（最大化 / 还原 / 贴靠）用的标准曲线：起步不猛冲、中段最快、
/// 收尾极缓。等价于 CSS 的 `cubic-bezier(0.4, 0, 0.2, 1)`。
/// 之前用的是纯缓出 `1 - (1-t)^3`——起步那一帧就已经是最高速度，观感是「猛地一冲」，
/// 收尾又偏急，和窗口本身的运动不对味。
const EASE_X1: f64 = 0.4;
const EASE_Y1: f64 = 0.0;
const EASE_X2: f64 = 0.2;
const EASE_Y2: f64 = 1.0;

/// 三次贝塞尔在某一轴上的取值（端点固定为 0 和 1）
fn bezier_axis(t: f64, a1: f64, a2: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * t * a1 + 3.0 * mt * t * t * a2 + t * t * t
}

fn bezier_slope(t: f64, a1: f64, a2: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * a1 + 6.0 * mt * t * (a2 - a1) + 3.0 * t * t * (1.0 - a2)
}

fn ease_standard(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // 先牛顿迭代解 t（Bx(t) = x），收敛不了再二分兜底
    let mut t = x;
    for _ in 0..8 {
        let err = bezier_axis(t, EASE_X1, EASE_X2) - x;
        if err.abs() < 1e-5 {
            return bezier_axis(t, EASE_Y1, EASE_Y2);
        }
        let d = bezier_slope(t, EASE_X1, EASE_X2);
        if d.abs() < 1e-6 {
            break;
        }
        t -= err / d;
        if !(0.0..=1.0).contains(&t) {
            break;
        }
    }
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    t = x;
    for _ in 0..24 {
        let v = bezier_axis(t, EASE_X1, EASE_X2);
        if (v - x).abs() < 1e-5 {
            break;
        }
        if v < x {
            lo = t;
        } else {
            hi = t;
        }
        t = (lo + hi) * 0.5;
    }
    bezier_axis(t, EASE_Y1, EASE_Y2)
}

fn cancel_previous() -> Arc<AtomicBool> {
    let mut guard = ACTIVE_CANCEL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = guard.take() {
        prev.store(true, Ordering::SeqCst);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *guard = Some(cancel.clone());
    cancel
}

/// 结束一次形变：把标志位清掉（如果还在跑就留着，由线程自己收尾）。
fn clear_if_current(cancel: &Arc<AtomicBool>) {
    let mut guard = ACTIVE_CANCEL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cur) = guard.as_ref() {
        if Arc::ptr_eq(cur, cancel) {
            *guard = None;
        }
    }
}

/// 把窗口从 `from` 平滑推到 `to`（尺寸 + 位置同时插值），`ms` 为时长，0 表示直接落位。
#[tauri::command]
pub fn morph_window(window: WebviewWindow, from: MorphRect, to: MorphRect, ms: u64) {
    let apply = |r: MorphRect| {
        let _ = window.set_size(PhysicalSize::new(r.width.max(1), r.height.max(1)));
        let _ = window.set_position(PhysicalPosition::new(r.x, r.y));
    };

    // 无需动画：直接落到终点。
    // 但必须先把上一段动画取消——否则那个线程下一帧还会按旧轨迹把窗口拖走，
    // 看起来就是「已经落位了又自己动起来」（§5 第 17 条）。
    let cancel = cancel_previous();
    if ms == 0
        || (from.x == to.x && from.y == to.y && from.width == to.width && from.height == to.height)
    {
        apply(to);
        return;
    }

    // 线程要拥有自己的窗口句柄（WebviewWindow 可以廉价克隆，内部是共享的派发器）
    let win = window.clone();
    thread::spawn(move || {
        let apply = |r: MorphRect| {
            let _ = win.set_size(PhysicalSize::new(r.width.max(1), r.height.max(1)));
            let _ = win.set_position(PhysicalPosition::new(r.x, r.y));
        };
        let start = Instant::now();
        let total = ms as f64;
        // 起点先落一帧，避免第一帧之前窗口还停在旧几何上造成「先跳一下再动」
        apply(from);
        // 按 deadline 排帧而不是「睡固定时长」：每帧的调用开销会累积成漂移，
        // 让 300ms 的动画实际跑成 330ms，收尾那几帧看起来就拖了一下。
        let frame = Duration::from_micros(11_000);
        let mut next = start + frame;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let t = (start.elapsed().as_secs_f64() * 1000.0 / total).min(1.0);
            let e = ease_standard(t);
            apply(MorphRect {
                x: (from.x as f64 + (to.x - from.x) as f64 * e).round() as i32,
                y: (from.y as f64 + (to.y - from.y) as f64 * e).round() as i32,
                width: (from.width as f64 + (to.width as f64 - from.width as f64) * e)
                    .round()
                    .max(1.0) as u32,
                height: (from.height as f64 + (to.height as f64 - from.height as f64) * e)
                    .round()
                    .max(1.0) as u32,
            });
            if t >= 1.0 {
                break;
            }
            let now = Instant::now();
            if next > now {
                thread::sleep(next - now);
            }
            next += frame;
            // 主线程卡顿时别补一堆帧：直接跳到当前时间线，动画还是按时长走完
            if next < now {
                next = now + frame;
            }
        }
        clear_if_current(&cancel);
    });
}

/// 系统窗口动画的方向。隐藏与显示必须显式指定，不能只靠坐标猜——
/// 最大化还原、跨显示器等情况下，起止坐标不一定能代表当前要播哪一段。
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransitionPhase {
    Hide,
    Show,
}

#[cfg(windows)]
mod system_transition {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AnimateWindow, AW_ACTIVATE, AW_HIDE, AW_SLIDE, AW_VER_NEGATIVE, AW_VER_POSITIVE,
    };

    pub const fn flags(hide: bool) -> u32 {
        if hide {
            // 从当前位置向上滑出，结束后由系统隐藏窗口。
            AW_HIDE | AW_SLIDE | AW_VER_NEGATIVE
        } else {
            // 在最终位置从屏幕上沿落回；只激活显示段，隐藏段不能带 AW_ACTIVATE。
            AW_ACTIVATE | AW_SLIDE | AW_VER_POSITIVE
        }
    }

    /// 必须留在窗口所属的 UI 线程调用。Tauri 的同步命令默认就在主线程执行，
    /// 不能像旧的手工插值那样再丢进 worker——AnimateWindow 会拒绝非所有者线程。
    pub fn play(raw_hwnd: *mut std::ffi::c_void, ms: u64, hide: bool) -> Result<(), String> {
        let ok = unsafe {
            AnimateWindow(
                raw_hwnd as HWND,
                ms.min(u32::MAX as u64) as u32,
                flags(hide),
            )
        };
        if ok == 0 {
            // 文档明确说明：线程不拥有窗口时也可能返回 FALSE，但 GetLastError=ERROR_SUCCESS，
            // 所以这里只报告方向，不拼一个可能误导人的系统错误码。
            return Err(format!(
                "AnimateWindow 拒绝了{}动画",
                if hide { "隐藏" } else { "显示" }
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn hide_and_show_use_the_matching_system_slide() {
            let hide = flags(true);
            assert_ne!(hide & AW_HIDE, 0);
            assert_ne!(hide & AW_SLIDE, 0);
            assert_ne!(hide & AW_VER_NEGATIVE, 0);
            assert_eq!(hide & AW_ACTIVATE, 0);

            let show = flags(false);
            assert_eq!(show & AW_HIDE, 0);
            assert_ne!(show & AW_SLIDE, 0);
            assert_ne!(show & AW_VER_POSITIVE, 0);
            assert_ne!(show & AW_ACTIVATE, 0);
        }
    }
}

/// 用 Windows 原生 `AnimateWindow` 播放「滑出 → 隐藏换装 → 落回」的一段。
///
/// 与上面的手工形变是两条独立通道：速览自身的悬停展开 / 收起仍走旧实现；
/// 完整界面 ↔ 速览改走这里。命令返回时系统动画已经播完，前端不需要再按计时器猜终点。
/// 系统拒绝时退化成直接隐藏 / 显示并落到最终几何，让每一次调用都停在确定的阶段状态。
#[tauri::command]
pub fn transition_window(
    window: WebviewWindow,
    from: MorphRect,
    to: MorphRect,
    ms: u64,
    phase: TransitionPhase,
) -> Result<(), String> {
    let hide = phase == TransitionPhase::Hide;
    let apply = |r: MorphRect| {
        let _ = window.set_size(PhysicalSize::new(r.width.max(1), r.height.max(1)));
        let _ = window.set_position(PhysicalPosition::new(r.x, r.y));
    };

    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        if hide {
            if ms > 0 {
                // 隐藏段从当前完整尺寸开始，动画结束后才允许换装。
                apply(from);
                if let Err(e) = system_transition::play(hwnd.0 as *mut std::ffi::c_void, ms, true) {
                    eprintln!("[transition] {e}，退化为直接隐藏");
                }
            }
            let _ = window.hide();
            // 隐藏后再落到屏幕外，下一段显示动画不会把旧界面重新带出来。
            apply(to);
        } else {
            // AnimateWindow 的显示段要求窗口先处于隐藏状态；最终几何要在播放前落好，
            // 系统负责把最终这块窗口从顶部滑入，而不是我们再逐帧搬它。
            let _ = window.hide();
            apply(to);
            if ms > 0 {
                if let Err(e) = system_transition::play(hwnd.0 as *mut std::ffi::c_void, ms, false)
                {
                    eprintln!("[transition] {e}，退化为直接显示");
                }
            }
            apply(to);
            let _ = window.show();
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        // 项目目前只发 Windows 包；保留可移植兜底，避免其它目标编译后没有切换能力。
        let _ = from;
        if hide {
            let _ = window.hide();
            apply(to);
        } else {
            apply(to);
            let _ = window.show();
        }
        Ok(())
    }
}
