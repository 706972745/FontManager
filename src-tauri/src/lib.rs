mod activation;
mod adobe;
mod affinity;
mod aim;
// 1.3.0：本地 HTTP API（只绑 127.0.0.1）与进程外插件
mod api;
mod plugins;
// 路线 C（2.1.7）：`--installer-ui` / `--uninstall-ui`，安装器/卸载器的界面画在主程序里
mod setup_ui;
#[cfg(target_os = "windows")]
mod comhost;
mod copyright;
mod diag;
#[cfg(target_os = "windows")]
mod file_assoc;
mod file_kind;
// 1.3.7：详情页「全部导出」= 把字体所在文件夹整体压成 zip（含授权/版权说明）
mod folder_export;
mod font_types;
mod fontcache;
mod installer;
mod library_pack;
mod library_marker;
mod net;
mod online;
mod parser;
mod preview_font;
mod thumb;
mod webfonts;
#[cfg(target_os = "windows")]
mod procs;
mod registry;
mod scanner;
mod single_instance;
mod services;
// 2026-11-13：按字形几何判分类（关键词表管不到的「新导入字体」用这一层）
mod shape_class;
mod sound;
#[cfg(target_os = "windows")]
mod warm;
mod store;
// 1.8.1：检查更新（只读版本号，不下载、不执行远端内容）
mod update;
mod watcher;
mod window_dock;
mod window_morph;
#[cfg(target_os = "windows")]
mod window_round;

use font_types::{CharsetStats, FontFace, TrashEntry};
use std::collections::HashMap;
use store::Store;
use tauri::{Emitter, Manager, State};

// ───────────────────────── 启动页（2.1.6，规格书 §5.3）─────────────────────────
//
// 一条铁律：启动页画的是**种子集合**的装载进度（分母几百个族），不是全库 4214 族。
// 种子 = 上次已启用 ∪ 系统字体 ∪ 分组内 ∪ 快照内，它覆盖了用户此刻真正要用的全部字体；
// 这批就绪就开主界面，剩下几千个未启用字体只是「待浏览的库存」。
// 拿全库当分母会让进度条爬到 9% 就长时间不动 —— 那是典型的「假进度」事故。

/// 启动页的进度快照。字段全是计数，没有需要维护的不变量，所以可以直接当
/// `static Mutex` 的初值（`Mutex::new` 是 const fn，usize / bool 都能 const 构造）。
struct SplashState {
    /// 已完成装载的种子**字族**数
    done: usize,
    /// 种子总**字族**数；0 = 分母还没算出来（启动页走不确定态）
    total: usize,
    /// 种子之外还要读多少族（副状态那行的数字）
    rest: usize,
    /// 主界面已经接手（`splash_done` 幂等判据）
    finished: bool,
    /// 启动页**真正 show 出来**的时刻。
    ///
    /// 最短显示时长（1.5s）必须从这里算，不能从进程启动或前端 `performance.now()`
    /// 算：splash 窗口比主窗口的 JS 晚建 200~400ms，按那个原点补足会实际只显示 1.1s
    /// （用户 2026-11-14 明确要求「每次打开都先看到启动页，最少 1.5 秒」）。
    shown_at: Option<std::time::Instant>,
}

static SPLASH: std::sync::Mutex<SplashState> = std::sync::Mutex::new(SplashState {
    done: 0,
    total: 0,
    rest: 0,
    finished: false,
    shown_at: None,
});

/// 取锁，**中毒也照用**。
///
/// 这些数字没有需要维护的不变量，一次 panic 留下来的半截快照只是「进度不准」，
/// 而 `unwrap()` 会让启动页和主界面一起卡在初始化里 —— 那是把一个显示问题
/// 升级成「软件打不开」。
fn splash_lock() -> std::sync::MutexGuard<'static, SplashState> {
    SPLASH.lock().unwrap_or_else(|e| e.into_inner())
}

/// 进程启动时刻。前端用 `performance.now()` 量 420ms 最短显示时长，
/// 两条时间轴（WebView 加载 vs 原生 setup）对不上时，这里是唯一能核对的东西。
static BOOT_AT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn boot_at() -> std::time::Instant {
    *BOOT_AT.get_or_init(std::time::Instant::now)
}

/// 启动页 show 之后打点（见 `SplashState::shown_at`）。
fn splash_mark_shown() {
    let mut st = splash_lock();
    st.shown_at = Some(std::time::Instant::now());
}

/// 启动页最短显示时长（2026-11-14 用户要求「最少 1.5 秒」）。
///
/// 与前端 `App.tsx` 里那个同名常量不是一回事：那边已经把值降到 0，最短显示
/// **只在原生侧生效**——只有一个事实来源，也不会因为两条时间轴对不上而缩水。
const SPLASH_MIN_SHOW: std::time::Duration = std::time::Duration::from_millis(1500);

/// 种子装载进度（由 `UiSink::seed_progress` 逐族推进）。
/// 锁只在这个函数里待几微秒，扫描线程不会被启动页拖慢。
fn splash_seed_progress(done: usize, total: usize) {
    let mut st = splash_lock();
    st.done = done;
    st.total = total;
}

/// 「其余 N 个字族在主界面后台继续读取」里的 N（由 `scan_library` 算好递进来）。
pub(crate) fn splash_rest(rest: usize) {
    let mut st = splash_lock();
    st.rest = rest;
}

/// `splash_state` 的返回体（与前端 `SplashProgress` 一一对应，serde 默认不改名）。
///
/// 启动页只认这一条原生命令加一条 `splash_done`：文案与版本号由前端自己取
/// （`get_prefs` + `@tauri-apps/api/app` 的 `getVersion`），Rust 侧不掺和本地化。
#[derive(serde::Serialize)]
struct SplashProgress {
    done: usize,
    total: usize,
    rest: usize,
    finished: bool,
}

/// 启动页每 100ms 轮询一次这条（见 `src/splash.ts`）。
#[tauri::command]
fn splash_state() -> SplashProgress {
    let st = splash_lock();
    SplashProgress {
        done: st.done,
        total: st.total,
        rest: st.rest,
        finished: st.finished,
    }
}

/// 种子就绪（或 3s 超时 / 失败）→ 打开主界面、关掉启动页。
///
/// 幂等：前端 StrictMode 双调用、种子到达与超时同时触发都会打进来。
/// 重复执行会让主窗口 show 两次、启动页 close 两次（后者在 Windows 上会报错）。
#[tauri::command]
fn splash_done(app: tauri::AppHandle, store: State<Store>) {
    {
        let st = splash_lock();
        // 已经交接完成就别再排一次（StrictMode 双调用 / 种子与超时同时到达）
        if st.finished {
            return;
        }
    }
    // **不在这里置 finished**：最短显示时长还没到，前端靠轮询 `finished` 决定何时淡出。
    // 提早置位会让启动页在 200ms 就消失，用户要的「每次都先看到启动页」就落空了。
    // 以**此刻** store 里的值当权威，不用 setup 时的快照：用户可能在启动过程中
    // 就在托盘菜单里改掉了「启动时最小化」（前端 set_prefs 直接写进 store）。
    let start_minimized = store
        .0
        .lock()
        .map(|st| {
            st.prefs
                .get("startMinimized")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    // 淡出补偿：前端收到 finished 后先降 opacity 120ms，这里再留余量。
    // 必须在新线程里 sleep：同步命令跑在主线程上，睡在这儿会把事件循环一起停住。
    std::thread::spawn(move || {
        // ① 等启动页**真的出现**再开始计时。
        //
        // 热缓存下种子只要 3ms 就绪，前端的 `splash_done` 可能比 splash 窗口
        // （在主线程里建 WebView2，几百毫秒）还早到 —— 那时 `shown_at` 是 None，
        // 直接放行就等于"这一秒没有启动页"（2026-11-14 实测第二次启动就是这样：
        // 日志 `启动后 1214ms` 就交接了，用户根本没看到启动页）。
        // 所以这里最多等 2 秒；2 秒还没等到 = splash 确实建不出来（异常路径，
        // 已有 diag 日志），那时不能再拖，直接放行让主界面出来。
        let wait_deadline = std::time::Instant::now()
            + if start_minimized {
                // 启动时最小化到托盘：本来就不建启动页，没什么可等的
                std::time::Duration::from_millis(0)
            } else {
                std::time::Duration::from_secs(2)
            };
        let shown = loop {
            if let Some(t) = splash_lock().shown_at {
                break Some(t);
            }
            if std::time::Instant::now() > wait_deadline {
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        };
        if shown.is_none() {
            diag::log("[splash] 启动页 2 秒内没有出现，跳过最短显示（主界面直接显示）");
        }
        // ② 补足最短显示（从启动页 show 那一刻算）
        if let Some(t) = shown {
            let elapsed = t.elapsed();
            if elapsed < SPLASH_MIN_SHOW {
                std::thread::sleep(SPLASH_MIN_SHOW - elapsed);
            }
        }
        // ③ 交接（幂等：只有第一个进来的线程能置位）
        {
            let mut st = splash_lock();
            if st.finished {
                return;
            }
            st.finished = true;
        }
        diag::log(&format!(
            "[splash] 最短显示已满（{}ms），开始交接；启动后 {}ms",
            SPLASH_MIN_SHOW.as_millis(),
            boot_at().elapsed().as_millis()
        ));
        // ④ 前端看到 finished 会淡出 120ms，这里等它放完
        std::thread::sleep(std::time::Duration::from_millis(190));
        // ⑤ 严格串行：先关启动页，再显示主界面（用户 2026-11-14 要求）
        if let Some(splash) = app.get_webview_window("splash") {
            let _ = splash.close();
        }
        if !start_minimized {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
        diag::log(&format!(
            "[splash] 启动页已关闭，主界面{}（启动后 {}ms）",
            if start_minimized { "保持隐藏" } else { "随后显示" },
            boot_at().elapsed().as_millis()
        ));
    });
}

/// 扫描字体库。业务逻辑在 `services::scan`，这里只做「后台线程 + 把进度发成前端事件」。
#[tauri::command]
async fn scan_fonts(app: tauri::AppHandle) -> Result<Vec<FontFace>, String> {
    struct UiSink(tauri::AppHandle);
    impl crate::services::scan::ScanSink for UiSink {
        fn progress(&self, done: usize, total: usize) {
            let _ = self.0.emit(
                "scan:progress",
                scanner::ScanProgress { done, total },
            );
        }
        /// 2.1.4：全量批次彻底退出主列表（ADR-06）。
        ///
        /// 以前每 120 面推一批，6170 个文件约 50 批 —— 每批一次 120 条的 JSON 序列化，
        /// 前端还要为每一批重算一次「可见字族」（6000 字面排序 + 过滤），实测就是
        /// 启动时白做 50 次全量计算，用户感知为「越用越慢、扫描像卡住」。
        /// 全量结果本来就要在末尾整体返回一次，中途推送纯属重复劳动。
        /// `ScanSink::batch` 保留：HTTP 侧的 job 表还靠它报「又读完几个」。
        fn batch(&self, _faces: &[FontFace]) {}
        /// 首帧种子：**每进程只发一次**（ADR-05）。
        ///
        /// 守卫必须在这里、不能在 `scan_library` 里：会话中任何 rescan（导入字体、
        /// watcher、改目录）都会再走一遍扫描，若不加守卫，主列表会被种子子集「缩水」；
        /// 而若把守卫放进 `scan_library`，`api.rs` 的 NullSink 先扫一次就会把这一次
        /// 「吃掉」，界面从此永远收不到种子 —— 那是个真 bug，不是理论风险。
        fn seed(&self, faces: &[FontFace]) {
            static UI_SEED_SENT: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if UI_SEED_SENT.swap(true, std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            let _ = self.0.emit("scan:seed", faces);
        }
        /// 种子装载进度 → 启动页（§5.3）。
        ///
        /// **不加一次性守卫**：这里是「当前进度」而不是「一次性事实」，会话中的
        /// rescan 会重新走一遍种子，启动页早已销毁，多写几次状态没有任何副作用。
        fn seed_progress(&self, done: usize, total: usize) {
            splash_seed_progress(done, total);
        }
    }
    let store = app.state::<Store>().inner().clone();
    let sink = UiSink(app.clone());
    let faces = tauri::async_runtime::spawn_blocking(move || {
        crate::services::scan::scan_library(&store, &sink)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 投给服务层的字体快照：本地 API / 插件读它，不必自己重扫
    crate::services::fonts::publish(faces.clone());
    Ok(faces)
}

/// 把「重复字体归置」搬走的文件按清单原路退回（原位已被占用则跳过，不覆盖）。
#[tauri::command]
fn restore_deduped_fonts(store: State<Store>) -> Result<scanner::DedupeReport, String> {
    let library = {
        let st = store.0.lock().map_err(|e| e.to_string())?;
        st.active_library_dir().map(std::path::PathBuf::from)
    };
    let dir = library.unwrap_or_else(scanner::managed_font_dir);
    Ok(scanner::restore_deduped(&dir))
}

/// 把字体库里与系统已安装字体重复的文件归置到 `<库>/_重复字体/`。
/// `dry_run = true` 时只统计不移动 —— 前端先拿它做一次「会动多少个文件」的确认。
#[tauri::command]
fn dedupe_font_library(
    store: State<Store>,
    dry_run: bool,
) -> Result<scanner::DedupeReport, String> {
    let library = {
        let st = store.0.lock().map_err(|e| e.to_string())?;
        st.active_library_dir().map(std::path::PathBuf::from)
    };
    let dir = library.unwrap_or_else(scanner::managed_font_dir);
    Ok(scanner::dedupe_library(&dir, dry_run))
}

#[tauri::command]
fn set_font_active(store: State<Store>, path: String, active: bool) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    // 单族持久启停 = 用户意图，进台账（§5.2 表格）
    activation::sync(&mut state, &path, active, true)?;
    store::save(&state)
}

#[tauri::command]
/**
 * 批量启停放在后台线程：同步命令跑在主线程上，几千个字体时界面会整个「无响应」
 * （GDI 装载 + 注册表写入，实测 5000 级要二三十分钟）。
 */
async fn set_fonts_active(store: State<'_, Store>, paths: Vec<String>, active: bool, no_save: Option<bool>, record: Option<bool>) -> Result<(), String> {
    let total = paths.len();
    let no_save = no_save.unwrap_or(false);
    // 记不记账由调用方说（`Option` 是为了老调用点不用全改）：默认 `true` ——
    // 界面上所有批量启停都是持久意图，只有「启动时恢复上次启用」要显式传 false，
    // 否则每次启动都自我强化写盘，台账永不收敛（PRD §6 最后几行）。
    let record = record.unwrap_or(true);
    let store = store.inner().clone();
    let failed = tauri::async_runtime::spawn_blocking(move || {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        let failed = activation::sync_batch(&mut state, &paths, active, record);
        // 快照切换等大批量场景：中间批次跳过存盘（每次写 2.4MB 的 state.json，
        // 100 批 = 240MB 磁盘 IO），只在最后一批落盘。
        if !no_save {
            store::save(&state)?;
        }
        Ok::<Vec<String>, String>(failed)
    })
    .await
    .map_err(|e| e.to_string())??;
    diag::batch(active, total, failed.len());
    activation::batch_error(&failed, total)
}

/// E2（2026-11-01）：批量启停「进行中」标志。
///
/// 4000+ 族批量启用要 35~45 分钟，中途关主窗口不该把清单打断：
/// 批量进行中收到关闭请求 → 不退出进程，窗口藏进托盘，
/// 前端的分批编排（runBatches）在隐藏的 WebView 里继续逐批跑完。
/// 前端在批量开始/结束时调用置位/复位。
static BATCH_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_batch_running(on: bool) {
    BATCH_RUNNING.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// E2：批量启停断点（`state.pending_batch`）的写入。
/// 前端每 30 秒更新一次「还剩哪些没做」（一次落盘 2.4MB，不能每批都写）；
/// 批量正常结束 / 取消 / 失败时传 `None` 清除断点。
#[tauri::command]
fn batch_checkpoint(
    store: State<Store>,
    cp: Option<crate::store::PendingBatch>,
) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.pending_batch = cp;
    store::save(&state)
}

/// E2：启动时查有没有没做完的批量（有 → 前端弹「继续吗」）
#[tauri::command]
fn batch_checkpoint_get(store: State<Store>) -> Result<Option<crate::store::PendingBatch>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.pending_batch.clone())
}

/// 2.1.4：持久激活台账（`state.activated`）的只读出口。
///
/// 为什么要单开一条命令：启动恢复（`restoreLastActivation`）需要「用户意图」去补启用，
/// 而旧做法用的是 `prefs.lastActivePaths` —— 那是**扫描结果的派生值**，
/// 扫描还没完成时会被写成空数组（PRD §6 点名的问题）。台账与扫描无关，天然可以提前用。
///
/// 排序后返回：前端按同一顺序批量启用，日志与手工比对都稳定（`HashSet` 的迭代顺序
/// 每个进程都不同，直接吐出去会让两次启动的日志看起来完全不一样）。
#[tauri::command]
fn get_active_paths(store: State<Store>) -> Result<Vec<String>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    let mut out: Vec<String> = state.activated.iter().cloned().collect();
    out.sort();
    Ok(out)
}

#[tauri::command]
async fn install_fonts(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    paths: Vec<String>,
    existing: Vec<String>,
    mode: String,
) -> Result<installer::InstallResult, String> {
    let mode = installer::InstallMode::parse(&mode)?;
    let library_dir = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        state.active_library_dir().map(|s| s.to_owned())
    };
    let library = scanner::effective_managed_dir(library_dir.as_deref());
    let library_for_check = library.clone();
    let known: std::collections::HashSet<String> = existing.into_iter().collect();
    let scope_app = app.clone();
    let mut result =
        tauri::async_runtime::spawn_blocking(move || installer::install(&app, paths, &known, mode, &library))
            .await
            .map_err(|e| e.to_string())?;
    let mut auto = false;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut state) = store.0.lock() {
        if mode == installer::InstallMode::Link {
            for face in &result.installed {
                // zip 来源的字体实际已移动进字体库，不属于链接字体
                if !std::path::Path::new(&face.path).starts_with(&library_for_check) {
                    state.linked.insert(face.path.clone());
                }
            }
        }
        auto = state.auto_activate_imports && result.installed.len() < 64;
        for face in &result.installed {
            // 导入后自动启用属于持久状态（PRD §6），进台账
            let _ = activation::sync(&mut state, &face.path, auto, true);
            state.added.insert(face.path.clone(), now);
        }
        let _ = store::save(&state);
    }
    for face in &result.installed {
        let p = std::path::Path::new(&face.path);
        if let Some(parent) = p.parent() {
            allow_dir(&scope_app, parent);
        }
    }
    for face in &mut result.installed {
        face.active = auto;
        face.added_at = Some(now);
    }
    Ok(result)
}

#[tauri::command]
async fn install_online_family(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    paths: Vec<String>,
    existing: Vec<String>,
    family: String,
    license_path: Option<String>,
    source: String,
    license_dirs: Option<Vec<String>>,
) -> Result<installer::InstallResult, String> {
    let library_dir = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        state.active_library_dir().map(|s| s.to_owned())
    };
    let library = scanner::effective_managed_dir(library_dir.as_deref());
    let known: std::collections::HashSet<String> = existing.into_iter().collect();
    let scope_app = app.clone();
    let extra_dirs = license_dirs.unwrap_or_default();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        installer::install_online(
            &app,
            paths,
            &known,
            &family,
            license_path.as_deref(),
            &source,
            &library,
            &extra_dirs,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut auto = false;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut state) = store.0.lock() {
        auto = state.auto_activate_imports && result.installed.len() < 64;
        for face in &result.installed {
            // 同上：在线安装后的自动启用也是持久意图
            let _ = activation::sync(&mut state, &face.path, auto, true);
            state.added.insert(face.path.clone(), now);
        }
        let _ = store::save(&state);
    }
    for face in &result.installed {
        let p = std::path::Path::new(&face.path);
        if let Some(parent) = p.parent() {
            allow_dir(&scope_app, parent);
        }
    }
    for face in &mut result.installed {
        face.active = auto;
        face.added_at = Some(now);
    }
    Ok(result)
}

/// 单个文件的「移到回收站」本体：**不落盘**。
///
/// C8：以前 `uninstall_font` 每处理一个文件就 `store::save` 一次整份 state，
/// 而 `state.json` 已有 2.27 MB —— 2026-11-01 那次误触发的 4020 个链接字体，
/// 实测写盘 **9.0 GB**（4020 × 2.27 MB ≈ 9.1 GB，完全对得上）。
/// 所以把「干什么」和「什么时候落盘」拆开：这里的调用者负责在合适的时候存一次。
/// 这个路径是不是躺在「字体库」目录里（大小写不敏感，Windows 语义）。
/// `path` 是否在 `dir` 这个目录里（大小写不敏感，Windows 语义）。
fn path_under(dir: &std::path::Path, path: &str) -> bool {
    let mut prefix = dir.to_string_lossy().to_lowercase();
    if prefix.is_empty() {
        return false;
    }
    // 补目录分隔符，否则库目录叫「字体库」时，隔壁「字体库2」也会被判成库内
    if !prefix.ends_with('\\') && !prefix.ends_with('/') {
        prefix.push('\\');
    }
    path.to_lowercase().starts_with(&prefix)
}

fn path_in_library(library_dir: Option<&str>, path: &str) -> bool {
    path_under(&scanner::effective_managed_dir(library_dir), path)
}

/// 换字体库时，把停在旧库里的 `linked` / `added` 登记退场，返回退场条数。
///
/// 为什么需要（2026-11-03 用户报障「换字体库地址以后，上一个库的字体还留在软件里」）：
/// `state.linked` 里既有导入时选「链接」的库外字体，也有扫描自动收编的**库内**字体
/// （`scan_fonts` 里的 fresh 分支，见 store 注释）。换库只改了 `library_dir` 这个设置，
/// 这些登记还指着旧库路径；`scan_fonts` 又会把 `linked` 里所有 is_file() 的路径
/// 逐个解析进结果 —— 于是旧库字体照旧出现在列表里，跟换库这个动作完全脱节。
///
/// 只动登记表，**不碰注册表、不碰文件**：旧库字体在系统里该启用的仍启用，
/// 只是不再属于「当前这个库」。旧库以外的链接字体（用户从别处链进来的）保持不动。
fn retire_old_library(
    state: &mut store::AppState,
    old_dir: &std::path::Path,
    new_dir: &std::path::Path,
) -> usize {
    if old_dir == new_dir {
        return 0;
    }
    let stale = |p: &str| path_under(old_dir, p) && !path_under(new_dir, p);
    let before = state.linked.len();
    state.linked.retain(|p| !stale(p));
    state.added.retain(|p, _| !stale(p));
    before - state.linked.len()
}

fn uninstall_one(
    state: &mut store::AppState,
    path: &str,
    family: &str,
) -> Result<TrashEntry, String> {
    if state.deactivated.contains(path) {
        // 先把它重新启用，否则文件搬走后注册表里留一条指向空路径的值。
        // 这是删除流程的内部补偿（文件马上就没），不能记成「用户想启用它」。
        activation::sync(state, path, true, false)?;
    }
    // `state.linked` 不能单独当「这是库外链接字体」的判据：
    // 扫描的「自动收编」会把**库内**新发现的字体也写进 linked（lib.rs 里的 fresh 分支），
    // 于是「导入 → 重启（重扫）→ 删除」会走成 unlink：只写一条 link 记录、文件原地不动，
    // 用户下次重扫又看到它回来了（2026-11-01 修：删 12 个测试族，10 个只删了记录，
    // 文件还在库里；`link-*.zfmtrash` 的 trashedPath 就等于 originalPath）。
    // 库目录内的字体必须走真正的「搬到回收站」。
    let in_library = path_in_library(state.active_library_dir(), path);
    if state.linked.contains(path) && !in_library {
        activation::drop_linked_alias(state, path);
        let entry = installer::unlink_quiet(path, family)?;
        state.linked.remove(path);
        state.added.remove(path);
        // 台账也要撤：文件已经不在了，留着只会让下次启动为它算一条永远装不上的种子
        // （PRD §6「删除字族 / 移入回收站 → 记录 remove」）。
        state.record_activated(path, false);
        return Ok(entry);
    }
    // 真删同样要清登记表：扫描的「自动收编」会把库内字体写进 linked/added，
    // 不清就留下指向空路径的死记录（linked 会在下次扫描被 retain 掉，added 不会）。
    state.linked.remove(path);
    state.added.remove(path);
    let entry = installer::uninstall_quiet(path, family)?;
    state.record_activated(path, false);
    Ok(entry)
}

#[tauri::command]
fn uninstall_font(store: State<Store>, path: String, family: String) -> Result<TrashEntry, String> {
    let entry = {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        let entry = uninstall_one(&mut state, &path, &family)?;
        store::save(&state)?;
        entry
    };
    installer::refresh_system_font_cache();
    Ok(entry)
}

/// 批量「移到回收站」的一条请求。
#[derive(serde::Deserialize)]
struct TrashRequest {
    path: String,
    family: String,
}

/// 批量结果：成功的条目 + 逐个失败的说明（前端汇总成一条 toast）。
#[derive(serde::Serialize)]
struct TrashBatchResult {
    entries: Vec<TrashEntry>,
    errors: Vec<String>,
}

/// 批量「移到回收站」：**一次加锁、一次落盘、一次广播**（C8）。
///
/// 前端以前是 `for (const f of names) void uninstallFamily(f)`，每个族再逐个文件调
/// `uninstall_font`，于是 4020 个文件 = 4020 次整份 state 落盘 + 4020 次 WM_FONTCHANGE
/// 广播 + 4213 个并发 Promise（内存飙到 1 GB 也是这么来的）。
#[tauri::command]
async fn uninstall_fonts(
    store: State<'_, Store>,
    items: Vec<TrashRequest>,
) -> Result<TrashBatchResult, String> {
    // 走 spawn_blocking：4213 个族、上万次文件搬运放在主线程会把界面卡死（同时批量
    // 启停 `set_fonts_active` 也是这么处理的）。
    let store = store.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        {
            let mut state = match store.0.lock() {
                Ok(s) => s,
                Err(e) => {
                    return TrashBatchResult {
                        entries,
                        errors: vec![e.to_string()],
                    };
                }
            };
            for it in &items {
                match uninstall_one(&mut state, &it.path, &it.family) {
                    Ok(entry) => entries.push(entry),
                    Err(e) => errors.push(format!("{}: {e}", it.family)),
                }
            }
            // 整批只在这里落盘一次；一个都没成功就不必写
            if !entries.is_empty() {
                if let Err(e) = store::save(&state) {
                    errors.push(format!("保存状态失败：{e}"));
                }
            }
        }
        // 广播也只在最后做一次（原来每个文件一次）
        if !entries.is_empty() {
            installer::refresh_system_font_cache();
        }
        // 留一条可核对的痕迹：批量删除以前每个文件都写一遍整份 state，
        // 这里记下「多少个文件、一次落盘、花了多久」，复测时能直接对写盘量。
        crate::diag::log(&format!(
            "trash batch: {} item(s), {} ok, {} failed, saved once, {} ms",
            items.len(),
            entries.len(),
            errors.len(),
            started.elapsed().as_millis()
        ));
        TrashBatchResult { entries, errors }
    })
    .await
    .unwrap_or_else(|e| TrashBatchResult {
        entries: Vec::new(),
        errors: vec![e.to_string()],
    }))
}

#[tauri::command]
fn list_trash() -> Vec<TrashEntry> {
    installer::list_trash()
}

#[tauri::command]
async fn affinity_connection() -> Result<affinity::AffinityConnection, String> {
    Ok(affinity::connection().await)
}

/// 底部预热指示条：三个目标软件各自「现在热不热」。
/// 只读快照，真正的探测在后台线程里做，这里不会被 COM 拖住。
#[tauri::command]
fn app_warm_state() -> Vec<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
        warm::snapshot()
            .into_iter()
            .filter_map(|w| serde_json::to_value(w).ok())
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn affinity_link() -> Option<affinity::AffinityConnection> {
    affinity::last_link()
}

#[tauri::command]
fn affinity_session_activate(
    store: State<Store>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let total = paths.len();
    let mut failed = Vec::new();
    let mut activated = Vec::with_capacity(total);
    for path in paths {
        // 亲和软件的会话级启用（退出即撤销）：不进台账（§5.2 表格）
        match activation::sync(&mut state, &path, true, false) {
            Ok(()) => activated.push(path),
            Err(e) => failed.push(e),
        }
    }
    store::save(&state)?;
    diag::batch(true, total, failed.len());
    affinity::note_activated(activated.clone());
    activation::batch_error(&failed, total).map(|()| activated)
}

/** 改版权后的结果：成功改了几个目录、哪些目录没改成、哪些字体改名后没能重新启用。 */
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyrightSyncResult {
    renamed: usize,
    /// 没改成的目录（人话描述，直接给 toast 用）
    errors: Vec<String>,
    /// 目录改好了但字体没能重新启用（路径列表）：这些字体在界面上会显示为未启用
    reactivate_failed: Vec<String>,
}

/**
 * 把应用里改过的版权状态同步回字体库目录：目录名后缀跟着改（"Lora（商用免费）"）。
 * status 为 auto 时按「版权信息文件 > 文件夹备注 > 字体自带信息」重新判定；
 * 返回实际改名的目录数量。
 *
 * 目录里已启用的字体必须先停用再改名：Windows 的字体注册指向原文件路径，
 * 带着注册改名会让字体失效（注册表里留着一条指向不存在文件的记录）。
 *
 * 改名失败必须回报给前端：以前只写日志，用户看到的是「改了版权，字体全不见了」，
 * 却不知道是改名没成功（原因通常是文件被 Photoshop / 预览缓存占着）。
 */
#[tauri::command]
fn sync_family_copyright(
    store: State<'_, Store>,
    family: String,
    status: String,
) -> Result<CopyrightSyncResult, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let library = scanner::effective_managed_dir(state.active_library_dir());
    let dirs = copyright::family_dirs_for(&library, &family);
    let mut renamed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut reactivate_failed: Vec<String> = Vec::new();
    for dir in dirs {
        let class = copyright::class_from_status(&status)
            .unwrap_or_else(|| copyright::classify_dir(&dir));
        let target = dir
            .parent()
            .unwrap_or(library.as_path())
            .join(copyright::family_dir_name(&family, class));
        if target == dir {
            continue;
        }
        match rename_family_dir(&mut state, &dir, &target) {
            Ok(failed) => {
                renamed += 1;
                reactivate_failed.extend(failed);
            }
            Err(e) => {
                crate::diag::log(&format!(
                    "copyright: 改名失败 {} → {}：{e}",
                    dir.display(),
                    target.display()
                ));
                // 带上具体哪个目录（用户 2026-11-13）：状态已记，但文件夹名没改成，
                // 用户得知道是哪一个族卡住了（多半是字体文件正被 Photoshop 占用）
                errors.push(format!("{}：{e}", dir.display()));
            }
        }
    }
    if renamed > 0 {
        installer::refresh_system_font_cache();
        store::save(&state)?;
    }
    Ok(CopyrightSyncResult {
        renamed,
        errors,
        reactivate_failed,
    })
}

/** 按**证据**重算字族目录名（v7 迁移工具）。
 *
 * 为什么要有这个命令：v7 之前，目录名后缀既当输出又当输入（软件写出去、又读回来
 * 当最权威的证据）。改成「目录名只做展示」之后，老库里那些按错误口径写下的后缀
 * 就成了纯噪音 —— 用户看到的还是「商用免费」，而证据根本不支持。
 *
 * 但**不能自动跑**：批量改名是破坏性操作，库里的目录名也可能是用户自己整理的。
 * 所以这里默认 `dry_run = true`，只报不改；只有明确传 false 才动文件。
 *
 * 规则只有一条：**证据给出明确分类才改名，判不出来的一个字都不动。**
 * 不给无证据的目录乱贴标签 —— 那正是旧版干的事。
 */
#[derive(serde::Serialize)]
pub struct LabelResyncItem {
    pub from: String,
    pub to: String,
    pub class: String,
}

#[derive(serde::Serialize)]
pub struct LabelResyncReport {
    pub dry_run: bool,
    pub checked: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub no_evidence: usize,
    pub errors: Vec<String>,
    pub items: Vec<LabelResyncItem>,
}

/// 库里所有「装着字体的目录」（最多两层，跳过根）。
fn collect_family_dirs(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        let mut has_font = false;
        let mut subs = Vec::new();
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                if depth < 2 {
                    subs.push(p);
                }
            } else if crate::parser::is_font_file(&p) {
                has_font = true;
            }
        }
        if has_font && depth > 0 {
            out.push(d.clone());
        }
        for s in subs {
            stack.push((s, depth + 1));
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn resync_library_labels(
    app: tauri::AppHandle,
    dry_run: bool,
) -> Result<LabelResyncReport, String> {
    let store: State<Store> = app.state();
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let library = scanner::effective_managed_dir(state.active_library_dir());
    let mut report = LabelResyncReport {
        dry_run,
        checked: 0,
        changed: 0,
        unchanged: 0,
        no_evidence: 0,
        errors: Vec::new(),
        items: Vec::new(),
    };
    for dir in collect_family_dirs(&library) {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let family = copyright::family_of_dir_name(&name).to_string();
        if family.is_empty() {
            continue;
        }
        report.checked += 1;
        // 目录级判定：授权文档 + 字体自带信息（目录名已不在证据链里）
        let found = copyright::inspect_dir(&dir);
        if found.class == copyright::CopyrightClass::Unknown {
            // 没证据就别动 —— 保持用户原来的名字
            report.no_evidence += 1;
            continue;
        }
        if copyright::suffix_class(&name) == Some(found.class) {
            report.unchanged += 1;
            continue;
        }
        let Some(parent) = dir.parent() else { continue };
        let target = parent.join(copyright::family_dir_name(&family, found.class));
        if target == dir {
            report.unchanged += 1;
            continue;
        }
        let item = LabelResyncItem {
            from: name.clone(),
            to: target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
            class: found.class.as_str().to_string(),
        };
        if dry_run {
            report.changed += 1;
            report.items.push(item);
            continue;
        }
        match rename_family_dir(&mut state, &dir, &target) {
            Ok(_) => {
                report.changed += 1;
                report.items.push(item);
            }
            Err(e) => report.errors.push(format!("{name}: {e}")),
        }
    }
    crate::diag::log(&format!(
        "[copyright] 目录名重算（{}）：检查 {} / 改 {} / 不变 {} / 无证据 {} / 失败 {}",
        if dry_run { "预演" } else { "执行" },
        report.checked,
        report.changed,
        report.unchanged,
        report.no_evidence,
        report.errors.len()
    ));
    Ok(report)
}

/** 一次问一批字面「有没有中文字形」。
 *
 * 用途：字体里没汉字时，应用到 PS / AI / CDR 之后中文会原样不变或变成方块，
 * 用户容易以为是软件坏了。界面在展开字重、打开详情、以及真正应用前会先问一下，
 * 没有汉字就明确提示一句，而不是让用户对着没反应的文档猜。
 *
 * 入参是 (路径, 字面序号) 的数组，返回同序的布尔数组。
 */
#[tauri::command]
async fn font_cjk(
    probes: Vec<(String, u32)>,
) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| parser::face_has_cjk(std::path::Path::new(&path), index))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 汉字覆盖的三档结论（"none" / "sparse" / "full"）。
 *
 * 比 `font_cjk` 多一档：卡片上要说清「一个汉字都没有」和「只有几百个字、排不了正文」
 * 是两回事。同族版本提示也用它——只有 full 的兄弟版本才值得推荐过去。
 */
#[tauri::command]
async fn font_han_coverage(
    probes: Vec<(String, u32)>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| {
                parser::face_han_coverage(std::path::Path::new(&path), index)
                    .as_str()
                    .to_string()
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 精确统计字符集构成（详情面板用）。
 *
 * 和扫描时用的抽样判定分开：这里要枚举全部码位，单个 8MB 中文字体要 2~5ms，
 * 5000 个字面全做会让启动慢十几秒。只在打开详情面板时对当前这个字面调一次。
 */
#[tauri::command]
async fn font_charset(probes: Vec<(String, u32)>) -> Result<Vec<CharsetStats>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| parser::face_charset_stats(std::path::Path::new(&path), index))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 备用预览字体：浏览器打不开这个字面时，让后端修一份能加载的副本。
 *
 * 两类字体在 WebView2 里必定加载失败，卡片上就只剩「这种格式暂时无法预览」：
 * `.ttc` 字体集合（OTS 拒收 ttcf 容器）和 cmap 只有旧编码子表的老字体
 * （Big5 / GBK / ShiftJIS，OTS 报 no supported subtables）。详见 preview_font。
 *
 * 返回缓存文件的绝对路径；浏览器本来就能打开、或修不出来时返回 null。
 * 只有加载失败才会调到这儿，正常字体不受影响。
 */
#[tauri::command]
async fn font_preview_file(
    app: tauri::AppHandle,
    path: String,
    face_index: u32,
    level: Option<u8>,
) -> Result<Option<String>, String> {
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        preview_font::ensure_preview_font(std::path::Path::new(&path), face_index, level.unwrap_or(0)).map(|p| {
            // 单独放行这一份（目录级放行在启动时做过，这里兜住运行期新建的文件）
            let _ = scope.allow_file(&p);
            p.to_string_lossy().into_owned()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/** 列表预览用的字体副本（只含目标字符）。
 *
 * `bytes` 是**产物**大小，不是原文件大小 —— 前端 LRU 按它记账。
 */
#[derive(serde::Serialize)]
struct ListPreview {
    path: String,
    bytes: u64,
}

/** 给卡片 / 速览条目生成「只含这些字符」的字体副本，让解码成本跟屏幕内容走。
 *
 * 与 `font_preview_file` 的分工是硬的：
 *   - 这个**只给列表预览**用（卡片主预览、速览条目、字重行）；
 *   - 详情 GlyphMap、OpenType 特性、可变字体、specimen 导出继续吃完整字体，
 *     因为它们要看的是**全部**字形，塞子集会直接变成缺字。
 *
 * 返回 `None` 表示这条路不适用于这份字体（CFF / TTC / 可变字体 / 体积小 /
 * 目标字符不命中），前端据此回退 `useFontCss` 的完整链路。
 */
#[tauri::command]
async fn list_preview_font(
    app: tauri::AppHandle,
    path: String,
    face_index: u32,
    chars: String,
) -> Result<Option<ListPreview>, String> {
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        preview_font::ensure_list_subset_font(std::path::Path::new(&path), face_index, &chars).map(
            |(p, bytes)| {
                let _ = scope.allow_file(&p);
                ListPreview {
                    path: p.to_string_lossy().into_owned(),
                    bytes,
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/** 缩略图索引：目录 + 已有 key。
 *
 * 前端启动时拉一次放进内存 Set，卡片就能**同步**判断有没有图 ——
 * 异步查会让首帧渲染成文字、随后切成图片，用户看到的就是闪烁。
 */
#[derive(serde::Serialize)]
struct ThumbIndex {
    dir: String,
    keys: Vec<String>,
}

#[tauri::command]
async fn thumb_index() -> Result<ThumbIndex, String> {
    tauri::async_runtime::spawn_blocking(move || match thumb::root() {
        Some(dir) => ThumbIndex {
            dir: dir.to_string_lossy().into_owned(),
            keys: thumb::list(),
        },
        None => ThumbIndex {
            dir: String::new(),
            keys: Vec::new(),
        },
    })
    .await
    .map_err(|e| e.to_string())
}

/** 落盘一张缩略图（前端 canvas 渲染好的 PNG）。返回最终路径。 */
#[tauri::command]
async fn thumb_put(app: tauri::AppHandle, key: String, data: Vec<u8>) -> Result<Option<String>, String> {
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        thumb::put(&key, &data).map(|p| {
            let _ = scope.allow_file(&p);
            p.to_string_lossy().into_owned()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/** 逐字符查字形覆盖：问一批字面「`chars` 里每个字符有没有字形」。
 *
 * 顶栏示例文字会先判出用到哪些书写系统（汉字 / 假名 / 拉丁 …），把各系统的探针
 * 拼成一条串发过来；返回同序的布尔矩阵，前端据此在卡片和字重行上标
 * 「无中文 / 无日文 …」。
 */
#[tauri::command]
async fn font_coverage(
    probes: Vec<(String, u32)>,
    chars: String,
) -> Result<Vec<Vec<bool>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list: Vec<char> = chars.chars().collect();
        probes
            .into_iter()
            .map(|(path, index)| parser::face_glyph_hits(std::path::Path::new(&path), index, &list))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 把字族目录整体搬到新名字（含所有字体与版权信息文件），返回 旧路径 → 新路径。
///
/// 优先用「整目录改名」：同一分区上这是一步原子操作，要么整个目录换了名字，
/// 要么一个文件都没动。以前的实现是逐个文件 `fs::rename`，只要有一个字体被
/// PS / 预览缓存 / 杀软占着，就会搬到一半报错 —— 字族被劈成「旧目录一半、新目录一半」，
/// 这才是「改完版权之后有些字体找不到」的真正来源。
fn move_dir_contents(
    dir: &std::path::Path,
    target: &std::path::Path,
) -> Result<Vec<(String, String)>, String> {
    use std::fs;

    // 目标不存在时先试整目录改名（最快最安全）
    if !target.exists() && fs::rename(dir, target).is_ok() {
        let mut moved = Vec::new();
        collect_dir_pairs(dir, target, &mut moved);
        return Ok(moved);
    }

    // 目标已存在（同名目录合并）或整目录改不动：退化成逐个文件搬，但失败就整批回滚
    // 错误里带上目标目录（用户 2026-11-13：toast 要能说出是哪个文件夹没改成）
    fs::create_dir_all(target).map_err(|e| format!("创建目录失败 {}：{e}", target.display()))?;
    let mut moved: Vec<(String, String)> = Vec::new();
    let attempt = (|| -> Result<(), String> {
        let mut stack: Vec<(std::path::PathBuf, std::path::PathBuf)> =
            vec![(dir.to_path_buf(), target.to_path_buf())];
        while let Some((src_dir, dst_dir)) = stack.pop() {
            let entries = fs::read_dir(&src_dir).map_err(|e| e.to_string())?;
            for entry in entries.filter_map(|e| e.ok()) {
                let src = entry.path();
                let name = entry.file_name();
                if src.is_dir() {
                    let sub = dst_dir.join(&name);
                    fs::create_dir_all(&sub).map_err(|e| e.to_string())?;
                    stack.push((src, sub));
                    continue;
                }
                let mut dst = dst_dir.join(&name);
                let mut n = 1;
                while dst.exists() {
                    dst = dst_dir.join(format!("{n}-{}", name.to_string_lossy()));
                    n += 1;
                }
                fs::rename(&src, &dst)
                    .map_err(|e| format!("{}：{e}", src.display()))?;
                moved.push((
                    src.to_string_lossy().into_owned(),
                    dst.to_string_lossy().into_owned(),
                ));
            }
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        // 已经搬过去的搬回来：宁可这次改名不成功（目录名保持旧的样子），
        // 也不要留下一个半新半旧的字族
        for (old, new) in moved.iter().rev() {
            let _ = fs::rename(new, old);
        }
        // 清掉刚建出来、现在已经空了的目录
        let _ = fs::remove_dir(target);
        return Err(e);
    }

    // 目录里已经没有文件了，清掉空壳（有残留文件说明搬漏了，保留不动）
    let leftover = fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
    if leftover == 0 {
        let _ = fs::remove_dir_all(dir);
    }
    Ok(moved)
}

/// 整目录改名成功后，把新目录里的文件列成「旧路径 → 新路径」。
/// 目录已经整体搬过去了，旧路径按相同的相对路径从旧根拼出来。
fn collect_dir_pairs(
    old_root: &std::path::Path,
    new_root: &std::path::Path,
    out: &mut Vec<(String, String)>,
) {
    let mut stack = vec![new_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(new_root) else {
                continue;
            };
            out.push((
                old_root.join(rel).to_string_lossy().into_owned(),
                path.to_string_lossy().into_owned(),
            ));
        }
    }
}

/// 这个路径对应的字体当前是不是启用状态。
/// Windows 上启用 = 注册表里有它（字体库里"没被停用"不等于已注册，刚复制进去的字体就没注册），
/// 只有真的注册过才需要在改名前后停用 / 重新启用。
fn is_activated(state: &crate::store::AppState, path: &str) -> bool {
    if state.deactivated.contains(path) || state.parked.contains_key(path) {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        !crate::registry::user_entries_for(path).is_empty()
            || crate::registry::is_machine_registered(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        true
    }
}

/// 改字族目录名：先停用该目录里已启用的字体 → 搬文件 → 用新路径重新启用，
/// 同时把 state 里按路径记录的信息（停用集合 / 入库时间 / 链接集合 / 注册表备份）改到新路径。
///
/// 返回「改好了但没能重新启用」的字体路径：这些字体在界面上是未启用状态，
/// 必须回报给用户，否则又是一次「字体凭空消失」。
fn rename_family_dir(
    state: &mut crate::store::AppState,
    dir: &std::path::Path,
    target: &std::path::Path,
) -> Result<Vec<String>, String> {
    let active: Vec<String> = {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            if let Ok(entries) = std::fs::read_dir(&d) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let p = entry.path();
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    if !crate::parser::is_font_file(&p) {
                        continue;
                    }
                    let key = p.to_string_lossy().into_owned();
                    if is_activated(state, &key) {
                        out.push(key);
                    }
                }
            }
        }
        out.sort();
        out
    };
    for p in &active {
        // 内部动作：路径马上要变，旧路径进台账只会留下一条指向不存在文件的记录
        let _ = activation::sync(state, p, false, false);
    }
    match move_dir_contents(dir, target) {
        Ok(moved) => {
            for (old, new) in &moved {
                if let Some(ts) = state.added.remove(old) {
                    state.added.insert(new.clone(), ts);
                }
                if state.deactivated.remove(old) {
                    state.deactivated.insert(new.clone());
                }
                if let Some(v) = state.parked.remove(old) {
                    state.parked.insert(new.clone(), v);
                }
                // 链接字体（外部目录单独挂进来的）也按路径记着，不跟着改就会变成悬空项
                if state.linked.remove(old) {
                    state.linked.insert(new.clone());
                }
                for (_name, path) in state.registry_backup.iter_mut() {
                    if path == old {
                        *path = new.clone();
                    }
                }
            }
            // 用新路径恢复原来的启用状态
            let renames: std::collections::HashMap<&str, &str> = moved
                .iter()
                .map(|(o, n)| (o.as_str(), n.as_str()))
                .collect();
            let mut failed = Vec::new();
            for old in &active {
                let Some(new) = renames.get(old.as_str()) else {
                    continue;
                };
                // 刚搬完的文件可能还被系统字体缓存放着，重试几次再算失败
                let mut ok = false;
                for attempt in 0..3 {
                    // 用户原本就启用，只是换了路径：意图没变，台账要跟着搬到新路径
                    if activation::sync(state, new, true, true).is_ok() {
                        ok = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(120 * (attempt + 1)));
                }
                if !ok {
                    crate::diag::log(&format!("copyright: 改名后没能重新启用 {new}"));
                    failed.push(new.to_string());
                }
            }
            Ok(failed)
        }
        Err(e) => {
            // 搬失败了就把字体恢复成原来的启用状态，别让用户的字体凭空消失
            for p in &active {
                // 回滚到原状态：旧路径仍在台账里，这里不记账
                let _ = activation::sync(state, p, true, false);
            }
            Err(e)
        }
    }
}

#[tauri::command]
async fn online_catalogue(store: State<'_, Store>, force: bool) -> Result<online::CatalogueResponse, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::fontsource::catalogue(&client, force).await
}

#[tauri::command]
async fn online_family(store: State<'_, Store>, id: String) -> Result<online::FamilyDetail, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::github::detail(&client, &id).await
}

#[tauri::command]
async fn online_download(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    id: String,
    files: Option<Vec<String>>,
    license: Option<bool>,
) -> Result<online::DownloadResult, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::github::download(&app, &client, &id, files.as_deref(), license.unwrap_or(true)).await
}

#[tauri::command]
async fn online_preview(app: tauri::AppHandle, store: State<'_, Store>, id: String) -> Result<String, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    let path = online::github::preview(&client, &id).await?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        allow_dir(&app, parent);
    }
    Ok(path)
}

#[tauri::command]
fn online_clear_staging(id: String) {
    online::github::clear_staging(&id);
}

#[tauri::command]
fn online_hosts() -> Vec<String> {
    net::ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseSaved {
    family: String,
    file_name: String,
    license_name: String,
    license_url: String,
    /// 匹配依据（命中的 PostScript 名），让用户能核对为什么算同一款字体
    postscript: String,
    written: Vec<String>,
}

/// 按字体身份（族名 + PostScript 名双严格）到上游反查许可证，命中后写进字体目录。
/// 任何一个条件对不上都返回 None，绝不猜。
#[tauri::command]
async fn font_license_fetch(
    store: State<'_, Store>,
    family: String,
    postscripts: Vec<String>,
    dirs: Vec<String>,
) -> Result<Option<LicenseSaved>, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    // 先用在线目录做快速否定：目录里压根没有这个族名，就不必去上游挨个试 6 次
    // （商业字体点「搜索」应该立刻得到「没找到」，而不是等半分钟）
    let want = family.trim().to_lowercase();
    let listed = match online::fontsource::read_cache() {
        Some(cat) if !cat.families.is_empty() => Some(cat.families),
        _ => online::fontsource::catalogue(&client, false)
            .await
            .ok()
            .map(|c| c.families),
    };
    if let Some(families) = &listed {
        if !families.iter().any(|f| f.family.trim().to_lowercase() == want) {
            crate::diag::log(&format!("license: {family} 不在在线目录里 → 直接判定没搜到"));
            return Ok(None);
        }
    }
    let Some(hit) = online::github::search_license(&client, &family, &postscripts).await? else {
        return Ok(None);
    };
    let mut written: Vec<String> = Vec::new();
    for dir in &dirs {
        let path = std::path::Path::new(dir);
        if path.is_dir() && std::fs::write(path.join(&hit.file_name), &hit.text).is_ok() {
            written.push(dir.clone());
        }
    }
    if written.is_empty() {
        return Err("no writable font directory".to_string());
    }
    crate::diag::log(&format!(
        "license: {} 命中（族名一致 + PostScript {}），写入 {} 个目录",
        hit.family,
        hit.postscript,
        written.len()
    ));
    Ok(Some(LicenseSaved {
        family: hit.family,
        file_name: hit.file_name,
        license_name: hit.license_name,
        license_url: hit.license_url,
        postscript: hit.postscript,
        written,
    }))
}

/// 用系统默认程序打开字库里的某个文件（详情面板「版权文件」那一行点一下就开）。
///
/// 路径来自字面所在目录的扫描结果，不是前端随便拼的字符串；但仍然校验一次
/// 「是不是真实存在的文件」，避免把任意路径交给系统外壳去打开。
#[tauri::command]
fn open_local_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("file not found: {path}"));
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}


/// 记录或摘掉「软件里预览不出来」的标记。
///
/// 前端在两档修复都失败时调（`on = true`），成功加载时摘掉（`on = false`）。
/// 只写 state、不做文件移动 —— 浏览器拒收可能是瞬时的，不能据此动用户的文件。
#[tauri::command]
fn set_unpreviewable(app: tauri::AppHandle, ids: Vec<String>, on: bool) -> Result<(), String> {
    let store: State<Store> = app.state();
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if on {
        state.unpreviewable.extend(ids.iter().cloned());
    } else {
        for id in &ids {
            state.unpreviewable.remove(id);
        }
    }
    // 字体列表在前端，这里只持久化名单；前端拿到结果后自己刷新那一批字面。
    // 落盘失败要如实上报 —— 吞掉的话「不可预览」标记就静默丢了（2026-11-05 调试轮修复）。
    crate::store::save(&state)?;
    Ok(())
}

/// 列出给定目录里的版权信息类文件（非递归）。
/// 在线栏目判断"字库是否已完整收录"时需要知道字族目录是否带版权文件。
#[tauri::command]
fn info_files(dirs: Vec<String>) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for dir in dirs {
        let path = std::path::Path::new(&dir);
        let Ok(entries) = std::fs::read_dir(path) else {
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if !p.is_file() || !installer::is_info_file(&p) {
                continue;
            }
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                names.push(name.to_string());
            }
        }
        if !names.is_empty() {
            names.sort();
            out.insert(dir, names);
        }
    }
    out
}

#[tauri::command]
fn restore_from_trash(store: State<Store>, entry_id: String) -> Result<(), String> {
    match installer::restore(&entry_id)? {
        installer::RestoreOutcome::Moved => Ok(()),
        installer::RestoreOutcome::Relinked(path) => {
            let mut state = store.0.lock().map_err(|e| e.to_string())?;
            state.linked.insert(path);
            store::save(&state)
        }
    }
}

#[tauri::command]
fn delete_trash_entry(entry_id: String) -> Result<(), String> {
    installer::delete_trash_entry(&entry_id)
}

#[tauri::command]
fn empty_trash() -> Result<(), String> {
    installer::empty_trash()
}

#[tauri::command]
fn get_tags(store: State<Store>) -> Result<HashMap<String, Vec<String>>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.tags.clone())
}

#[tauri::command]
fn set_tags(store: State<Store>, family: String, tags: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if tags.is_empty() {
        state.tags.remove(&family);
    } else {
        state.tags.insert(family, tags);
    }
    store::save(&state)
}

#[tauri::command]
fn get_collections(store: State<Store>) -> Result<HashMap<String, Vec<String>>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.collections.clone())
}

#[tauri::command]
fn set_collection(store: State<Store>, name: String, families: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.collections.insert(name, families);
    store::save(&state)
}

#[tauri::command]
fn delete_collection(store: State<Store>, name: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.collections.remove(&name);
    store::save(&state)
}

#[tauri::command]
fn rename_collection(store: State<Store>, from: String, to: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if state.collections.contains_key(&to) {
        return Err(format!("a collection named \"{to}\" already exists"));
    }
    let families = state
        .collections
        .remove(&from)
        .ok_or_else(|| format!("collection \"{from}\" not found"))?;
    state.collections.insert(to, families);
    store::save(&state)
}

#[tauri::command]
fn get_snapshots(store: State<Store>) -> Result<Vec<store::Snapshot>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.snapshots.clone())
}

#[tauri::command]
fn save_snapshot(store: State<Store>, snapshot: store::Snapshot) -> Result<Vec<store::Snapshot>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.save_snapshot(snapshot)?; // 新建超上限（5 个）直接报错，前端弹提醒
    store::save(&state)?;
    Ok(state.snapshots.clone())
}

#[tauri::command]
fn delete_snapshot(store: State<Store>, name: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.snapshots.retain(|s| s.name != name);
    store::save(&state)
}

/// 薄壳：逻辑在 `services::snapshot::rename`（trim 校验 + 中文错误）。
/// 以前这里自己抄了一遍实现，service 层那份一直没人调（双胞胎，2026-11-05 并轨）。
#[tauri::command]
fn rename_snapshot(store: State<Store>, from: String, to: String) -> Result<(), String> {
    services::snapshot::rename(&store, &from, &to).map(|_| ())
}

#[tauri::command]
fn play_sound(kind: String, level: String) {
    sound::play(&kind, &level);
}

#[tauri::command]
fn get_notes(store: State<Store>) -> Result<HashMap<String, String>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.notes.clone())
}

#[tauri::command]
fn set_note(store: State<Store>, family: String, note: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if note.trim().is_empty() {
        state.notes.remove(&family);
    } else {
        state.notes.insert(family, note);
    }
    store::save(&state)
}

#[derive(serde::Deserialize)]
struct LicenseNoteSeed {
    family: String,
    note: String,
}

/// 把扫描时从授权文档摘出的「哪些渠道能 / 不能商用」原话写进备注。
///
/// 只在「这个字族还没有备注，且从没自动写过」时写一次：
/// 用户改过备注不会被覆盖，用户主动删掉也不会下次启动又冒出来。
#[tauri::command]
fn seed_license_notes(store: State<Store>, items: Vec<LicenseNoteSeed>) -> Result<Vec<String>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let mut seeded = Vec::new();
    for it in items {
        let family = it.family.trim().to_string();
        let note = it.note.trim().to_string();
        if family.is_empty() || note.is_empty() {
            continue;
        }
        if state.notes.contains_key(&family) || state.note_seeded.contains(&family) {
            continue;
        }
        state.notes.insert(family.clone(), note);
        state.note_seeded.insert(family.clone());
        seeded.push(family);
    }
    if !seeded.is_empty() {
        store::save(&state)?;
    }
    Ok(seeded)
}

#[tauri::command]
fn get_favorites(store: State<Store>) -> Result<Vec<String>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.favorites.iter().cloned().collect())
}

#[tauri::command]
fn set_favorite(store: State<Store>, family: String, favorite: bool) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if favorite {
        state.favorites.insert(family);
    } else {
        state.favorites.remove(&family);
    }
    store::save(&state)
}

const DESIGN_W: f64 = 1280.0;
const DESIGN_H: f64 = 820.0;
const SCALE_STEPS: [f64; 4] = [0.8, 0.85, 0.9, 1.0];

fn auto_ui_scale(avail_w: f64, avail_h: f64) -> f64 {
    let raw = (avail_w / DESIGN_W).min(avail_h / DESIGN_H);
    let mut chosen = SCALE_STEPS[0];
    for step in SCALE_STEPS {
        if step <= raw + 0.0001 {
            chosen = step;
        }
    }
    chosen
}

fn fit_window(window: &tauri::WebviewWindow, scale_pref: Option<f64>) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        if let Some(scale) = scale_pref {
            let _ = window.set_zoom(scale);
        }
        return;
    };
    let dpi = monitor.scale_factor();
    if !(dpi > 0.0) {
        return;
    }
    let work = monitor.work_area();
    let avail_w = work.size.width as f64 / dpi;
    let avail_h = work.size.height as f64 / dpi;
    if !(avail_w > 0.0) || !(avail_h > 0.0) {
        return;
    }

    if let Ok(size) = window.inner_size() {
        let cur_w = size.width as f64 / dpi;
        let cur_h = size.height as f64 / dpi;
        let w = cur_w.min(avail_w);
        let h = cur_h.min(avail_h);
        if w < cur_w - 0.5 || h < cur_h - 0.5 {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
        }
        let x = work.position.x as f64 / dpi + (avail_w - w).max(0.0) / 2.0;
        let y = work.position.y as f64 / dpi + (avail_h - h).max(0.0) / 2.0;
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    let scale = scale_pref.unwrap_or_else(|| auto_ui_scale(avail_w, avail_h));
    let _ = window.set_zoom(scale);
}

#[tauri::command]
fn set_ui_scale(window: tauri::WebviewWindow, scale: Option<f64>) -> Result<f64, String> {
    let clamped = scale.map(|s| s.clamp(0.5, 2.0));
    fit_window_scale_only(&window, clamped)
}

fn fit_window_scale_only(window: &tauri::WebviewWindow, scale_pref: Option<f64>) -> Result<f64, String> {
    let resolved = match scale_pref {
        Some(s) => s,
        None => {
            let monitor = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("no monitor")?;
            let dpi = monitor.scale_factor();
            let work = monitor.work_area();
            auto_ui_scale(
                work.size.width as f64 / dpi,
                work.size.height as f64 / dpi,
            )
        }
    };
    window.set_zoom(resolved).map_err(|e| e.to_string())?;
    Ok(resolved)
}

#[tauri::command]
async fn fonts_with_char(paths: Vec<String>, codepoint: u32) -> Result<Vec<String>, String> {
    let Some(ch) = char::from_u32(codepoint) else {
        return Err("not a Unicode character".into());
    };
    tauri::async_runtime::spawn_blocking(move || sweep_charset(&paths, ch))
        .await
        .map_err(|e| e.to_string())
}

fn sweep_charset(paths: &[String], ch: char) -> Vec<String> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
        .max(1);
    let chunk = paths.len().div_ceil(workers).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|group| {
                scope.spawn(move || {
                    let mut found = Vec::new();
                    for path in group {
                        let Ok(data) = std::fs::read(path) else {
                            continue;
                        };
                        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
                        let covered = (0..count).any(|i| {
                            ttf_parser::Face::parse(&data, i)
                                .map(|f| f.glyph_index(ch).is_some())
                                .unwrap_or(false)
                        });
                        if covered {
                            found.push(path.clone());
                        }
                    }
                    found
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .flatten()
            .collect::<Vec<String>>()
    })
}

#[tauri::command]
fn get_charset(path: String, face_index: u32) -> Result<Vec<u32>, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let face = ttf_parser::Face::parse(&data, face_index).map_err(|e| e.to_string())?;
    let mut cps: Vec<u32> = Vec::new();
    if let Some(cmap) = face.tables().cmap {
        for sub in cmap.subtables {
            if !sub.is_unicode() {
                continue;
            }
            sub.codepoints(|cp| {
                if cp > 0x20 && cp != 0x7f {
                    cps.push(cp);
                }
            });
        }
    }
    cps.sort_unstable();
    cps.dedup();
    cps.truncate(4096);
    Ok(cps)
}

#[tauri::command]
fn export_font(src: String, dest: String) -> Result<(), String> {
    std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file is too large to be a library export".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 按文件内容判断导出物类型（不看后缀）。双击文件打开时，前端先问这一句再决定
/// 该解包、合并整理数据还是导入快照。
#[tauri::command]
fn detect_file_kind(path: String) -> String {
    file_kind::detect(std::path::Path::new(&path)).to_string()
}

/// 「双击导出文件启动本程序」时暂存的待导入路径。前端 init 完成后来取，只给一次。
static PENDING_OPEN_FILE: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

#[tauri::command]
fn take_pending_open_file() -> Option<String> {
    PENDING_OPEN_FILE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// 命令行第一个存在的文件 = 资源管理器双击传进来的导出文件。
/// 注册表里的 `shell\open\command` 写成 `"exe" "%1"`，所以路径就是 argv[1]。
fn startup_file_arg() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .filter_map(|a| a.into_string().ok())
        .find(|a| std::path::Path::new(a).is_file())
}

/// 本次运行里由「启用直到关闭」打开的字体文件，退出时统一还原。
///
/// 用 `HashSet` 而不是 `Vec`：同一路径反复「启用直到关闭 → 停用 → 再启用」时，
/// `Vec::extend` 会不停 append 同一批路径，清单和内存都跟着涨，退出时还要对同一批
/// 文件重复停用（BUG-8）。`HashSet` 天然幂等。
/// 用 OnceLock 而不是 `Mutex::new(HashSet::new())`：后者不是 const fn，不能当 static 初始化。
static SESSION_ACTIVATED: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::OnceLock::new();

fn session_activated() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    SESSION_ACTIVATED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

#[tauri::command]
fn set_fonts_active_session(store: State<Store>, paths: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let total = paths.len();
    let mut failed = Vec::new();
    let mut activated = Vec::with_capacity(total);
    for path in paths {
        // 「启用至关闭」是临时试用：退出即撤销，绝不能进台账
        // （PRD US-5：长期状态不该被试用行为污染）
        match activation::sync(&mut state, &path, true, false) {
            Ok(()) => activated.push(path),
            Err(e) => failed.push(e),
        }
    }
    store::save(&state)?;
    diag::batch(true, total, failed.len());
    if let Ok(mut session) = session_activated().lock() {
        // 重复的路径只会占一份
        session.extend(activated);
    }
    activation::batch_error(&failed, total)
}

fn revert_session_activations(app: &tauri::AppHandle) {
    use tauri::Manager;
    let paths: Vec<String> = match session_activated().lock() {
        Ok(mut s) => std::mem::take(&mut *s).into_iter().collect(),
        Err(_) => return,
    };
    if paths.is_empty() {
        return;
    }
    let store = app.state::<Store>();
    let mut guard = match store.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    for p in &paths {
        // 会话撤销只是在纠正注册表，不代表用户改主意
        let _ = activation::sync(&mut guard, p, false, false);
    }
    affinity::revert_session(&mut guard);
    let _ = store::save(&guard);
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_features(path: String, face_index: u32) -> Result<Vec<String>, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let face = ttf_parser::Face::parse(&data, face_index).map_err(|e| e.to_string())?;
    let mut tags: Vec<String> = Vec::new();
    let mut collect = |table: Option<ttf_parser::opentype_layout::LayoutTable>| {
        if let Some(t) = table {
            for f in t.features {
                tags.push(String::from_utf8_lossy(&f.tag.to_bytes()).into_owned());
            }
        }
    };
    collect(face.tables().gsub);
    collect(face.tables().gpos);
    tags.sort_unstable();
    tags.dedup();
    Ok(tags)
}

#[tauri::command]
fn export_fonts(paths: Vec<String>, dest_dir: String) -> Result<u32, String> {
    let dir = std::path::Path::new(&dest_dir);
    if !dir.is_dir() {
        return Err("destination is not a directory".into());
    }
    let mut n = 0;
    for p in paths {
        let src = std::path::Path::new(&p);
        let name = src.file_name().ok_or("invalid font path")?;
        std::fs::copy(src, dir.join(name)).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

/// 「全部导出」：把这个字体所在的文件夹整体压成 zip（1.3.7）。
///
/// 文件夹里除了各字重的字体文件，还常躺着作者的授权书 / 说明文档 —— 只复制字体文件
/// 发给别人，对方就不知道能不能商用。打包在本机做（`zip` crate），不依赖 7-Zip 之类。
/// 字体在字体库根目录时只打包本字族（见 `folder_export` 的约束 3）。
/// 走阻塞线程池：几百 MB 的目录不至于把界面顶住。
#[tauri::command]
async fn export_font_folder(
    font_path: String,
    dest: String,
    family_paths: Vec<String>,
) -> Result<folder_export::FolderExportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        folder_export::export_folder(
            std::path::Path::new(&font_path),
            std::path::Path::new(&dest),
            &family_paths,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 打包「整理数据 + 字体文件」。`dest` 是用户选的文件名（单卷直接用，多卷自动加 `-partN`）。
/// 全在阻塞线程池里跑，界面只靠 `pack:progress` 事件更新底部进度条。
#[tauri::command]
async fn export_library_pack(
    app: tauri::AppHandle,
    dest: String,
    curation: String,
    created_at: String,
) -> Result<library_pack::PackExportReport, String> {
    use tauri::Manager;
    let library = {
        let store: State<Store> = app.state();
        let state = store.0.lock().map_err(|e| e.to_string())?;
        scanner::effective_managed_dir(state.active_library_dir())
    };
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library_pack::export_pack(
            &library,
            std::path::Path::new(&dest),
            &curation,
            &created_at,
            &|p| {
                let _ = emitter.emit("pack:progress", p);
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取消正在跑的整包导出（用户 2026-11-10）。
/// 这里只置标志；真正的磁盘清理在后端循环里做（删 `.writing` 与已生成的卷），
/// 所以取消后前端会先看到进度条消失，文件删除要等循环走到下一个文件。
#[tauri::command]
fn cancel_export_pack() {
    library_pack::request_pack_cancel();
}

/// 解包 .FontManager：字体铺回字库（重复的跳过），整理数据原样交回前端合并。
#[tauri::command]
async fn import_library_pack(
    app: tauri::AppHandle,
    src: String,
) -> Result<library_pack::PackImportReport, String> {
    use tauri::Manager;
    let library = {
        let store: State<Store> = app.state();
        let state = store.0.lock().map_err(|e| e.to_string())?;
        scanner::effective_managed_dir(state.active_library_dir())
    };
    let emitter = app.clone();
    let src = std::path::PathBuf::from(src);
    tauri::async_runtime::spawn_blocking(move || {
        library_pack::import_pack(&library, &src, &|p| {
            let _ = emitter.emit("pack:progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    extra_dirs: Vec<String>,
    watch_enabled: bool,
    auto_activate_imports: bool,
    library_dir: Option<String>,
    /// 保存过的库地址清单（最多 store::MAX_LIBRARY_DIRS 个），供设置页一键切换
    #[serde(default)]
    library_dirs: Vec<String>,
    library_dir_enabled: bool,
    affinity_enabled: bool,
    affinity_deactivate_on_quit: bool,
    online_fonts_enabled: bool,
}

/// 把「当前库 + 库清单」理成一致状态：
/// - 去掉空串与重复项，保持用户添加顺序；
/// - 当前库一定在清单里（老版本 state 只有 library_dir，这里顺手补上）；
/// - 清单非空但当前库为空、且启用了自定义库时，取清单第一个。
///
/// 超过上限时**保留前 MAX_LIBRARY_DIRS 个**（前端已经拦了，这里是兜底）。
fn normalize_library_dirs(
    current: Option<String>,
    dirs: Vec<String>,
    enabled: bool,
) -> (Option<String>, Vec<String>) {
    let current = current
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    // 当前库排第一，其余按用户添加顺序去重
    let mut list: Vec<String> = Vec::new();
    if let Some(c) = current.as_ref() {
        list.push(c.clone());
    }
    for d in dirs {
        let d = d.trim().to_string();
        if !d.is_empty() && !list.contains(&d) {
            list.push(d);
        }
    }
    list.truncate(store::MAX_LIBRARY_DIRS);

    let current = match current {
        Some(c) if list.contains(&c) => Some(c),
        _ if enabled => list.first().cloned(),
        _ => None,
    };
    (current, list)
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Result<Settings, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    let (library_dir, library_dirs) = normalize_library_dirs(
        state.library_dir.clone(),
        state.library_dirs.clone(),
        state.library_dir_enabled,
    );
    Ok(Settings {
        extra_dirs: state.extra_dirs.clone(),
        watch_enabled: state.watch_enabled,
        auto_activate_imports: state.auto_activate_imports,
        library_dir,
        library_dirs,
        library_dir_enabled: state.library_dir_enabled,
        affinity_enabled: state.affinity_enabled,
        affinity_deactivate_on_quit: state.affinity_deactivate_on_quit,
        online_fonts_enabled: state.online_fonts_enabled,
    })
}

#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    store: State<Store>,
    settings: Settings,
) -> Result<(), String> {
    let (library_dir, library_dirs) = normalize_library_dirs(
        settings.library_dir.clone(),
        settings.library_dirs.clone(),
        settings.library_dir_enabled,
    );
    let before_change = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        state.active_library_dir().map(|s| s.to_owned())
    };
    let library_changed;
    {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        state.extra_dirs = settings.extra_dirs.clone();
        state.watch_enabled = settings.watch_enabled;
        state.auto_activate_imports = settings.auto_activate_imports;
        state.library_dir = library_dir.clone();
        state.library_dirs = library_dirs;
        state.library_dir_enabled = settings.library_dir_enabled;
        state.affinity_enabled = settings.affinity_enabled;
        state.affinity_deactivate_on_quit = settings.affinity_deactivate_on_quit;
        state.online_fonts_enabled = settings.online_fonts_enabled;
        // 换库（含「关掉自定义文件夹」回到默认目录）→ 旧库里登记的链接/新增记录必须退场，
        // 否则 `scan_fonts` 还会顺着 linked 把旧库字体扫回来，用户看到「库没换干净」。
        let new_library = state.active_library_dir().map(|s| s.to_owned());
        library_changed = before_change != new_library;
        if library_changed {
            let old_managed = scanner::effective_managed_dir(before_change.as_deref());
            let new_managed = scanner::effective_managed_dir(new_library.as_deref());
            let retired = retire_old_library(&mut state, &old_managed, &new_managed);
            if retired > 0 {
                crate::diag::log(&format!(
                    "[store] 字体库目录变更：{} → {}，{} 条旧库登记已退场",
                    old_managed.display(),
                    new_managed.display(),
                    retired
                ));
            }
            // 旧库目录上挂着我们加的图标和 desktop.ini，换走以后要摘掉，
            // 否则那个文件夹看起来还是「库」。摘的是显示层，失败只记日志。
            if let Err(e) = library_marker::retire(&old_managed.to_string_lossy()) {
                crate::diag::log(&format!("[store] 旧库图标复原失败：{e}"));
            }
        }
        store::save(&state)?;
    }
    // 换库时把「库文件夹图标」挂到新库上（图标跟着库走）。
    // 只在库地址真的变了才动盘：每次保存设置（比如只是关个动效）都去重写用户目录里的
    // desktop.ini、再给目录加只读，既没必要也容易让人以为文件被改了。
    // 启动时另有一次补挂，覆盖「用户手动删了 desktop.ini」的情况。
    // 图标只是显示层的东西：失败只记日志，不影响换库。
    if library_changed && settings.library_dir_enabled {
        if let Some(dir) = library_dir.as_deref() {
            if let Err(e) = library_marker::apply(dir) {
                crate::diag::log(&format!("[store] 库文件夹图标应用失败：{e}"));
            }
        }
    }
    allow_dir(
        &app,
        &scanner::effective_managed_dir(
            settings
                .library_dir_enabled
                .then(|| library_dir.as_deref())
                .flatten(),
        ),
    );
    allow_previews(&app, &settings.extra_dirs);
    apply_watch(&app, settings.watch_enabled, &settings.extra_dirs)
}

/// 单独给某个目录挂库图标（设置页「应用图标」入口，以及换库时的补挂）。
#[tauri::command]
fn apply_library_folder_icon(dir: String) -> Result<(), String> {
    library_marker::apply(&dir)
}

#[tauri::command]
fn default_library_dir() -> String {
    scanner::managed_font_dir().to_string_lossy().into_owned()
}

/// 在资源管理器里**打开这个文件夹本身**（进去，看到里面的内容）。
///
/// 不要用 `explorer /select` 或 plugin-opener 的 `revealItemInDir`：那两个都是
/// 「打开父目录并选中它」。也不要直接 `spawn("explorer.exe", path)`：explorer 的
/// 命令行解析很怪，本机实测会被忽略、落到「文档」。走 ShellExecuteW 的 "open"
/// 动词，才会真的进到目标目录里。
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        // SW_SHOWNORMAL
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        // ShellExecute 的返回值 <= 32 都是错误码，> 32 才算成功
        if ret as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW failed: {}", ret as isize))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
    }
}

/// activation.log 的完整路径（2.1.5 起跟着数据根走，默认 `<安装目录>\data\activation.log`；
/// 装到不可写目录时会落到 `%LOCALAPPDATA%\FontManager\data`，最后才兜底 `%APPDATA%\FontManager`）。
///
/// 界面上「查看日志」按钮先问它要路径，再交给 [`open_file`] 打开。
/// 只返回路径、不保证文件存在：首次启动还没写过日志时前端仍能把话说全。
#[tauri::command]
fn log_file_path() -> Result<String, String> {
    Ok(diag::log_path().to_string_lossy().into_owned())
}

/// 用系统默认程序打开**一个文件**（现在只有 activation.log 用）。
///
/// 与 [`open_folder`] 的区别：那个要求是目录，这个要求是文件，路径不存在就报错。
/// 同样走 ShellExecuteW 的 "open" 动词 —— 用户机器上大概率没有绑定 `.log`
/// 关联程序时，Windows 会自己弹「选择打开方式」，比我们猜编辑器靠谱。
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        // SW_SHOWNORMAL
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        // ShellExecute 的返回值 <= 32 都是错误码，> 32 才算成功
        if ret as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW failed: {}", ret as isize))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
    }
}

fn allow_dir(app: &tauri::AppHandle, dir: &std::path::Path) {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
}

fn allow_previews(app: &tauri::AppHandle, extra: &[String]) {
    let scope = app.asset_protocol_scope();
    for (dir, _) in scanner::all_dirs(extra) {
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        let _ = scope.allow_directory(&dir, true);
    }
}

fn apply_watch(app: &tauri::AppHandle, enabled: bool, extra: &[String]) -> Result<(), String> {
    let handle: State<watcher::WatchHandle> = app.state();
    let mut slot = handle.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    if enabled {
        let dirs = scanner::all_dirs(extra).into_iter().map(|(d, _)| d).collect();
        *slot = Some(watcher::start(app.clone(), dirs)?);
    }
    Ok(())
}

fn close_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<Store>()
        .and_then(|store| {
            store
                .0
                .lock()
                .ok()
                .and_then(|s| s.prefs.get("closeToTray").and_then(|v| v.as_bool()))
        })
        .unwrap_or(false)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // 托盘抢跑：种子还没就绪时用户就从托盘（或「启动时最小化」模式）把主界面叫出来，
    // 启动页是 alwaysOnTop，会一直盖在屏幕中心的主界面上。关掉它 ——
    // `splash_done` 那边的时序一行都不用动：它后面 `get_webview_window("splash")`
    // 拿到 None 就直接跳过 close。
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Show FontManager", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::InvalidIcon(std::io::Error::other("no bundled window icon")))?
        .clone();

    let builder = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("FontManager")
        .menu(&menu);

    let builder = if cfg!(target_os = "windows") {
        builder.show_menu_on_left_click(false)
    } else {
        builder
    };

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_prefs(store: State<Store>) -> Result<serde_json::Value, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.prefs.clone())
}

#[tauri::command]
fn set_prefs(store: State<Store>, prefs: serde_json::Value) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    // ⚠️ 必须**合并**而不是整体赋值：前端 persistPrefs 只发 UI 偏好白名单，
    // 直接 `state.prefs = prefs` 会把后端写的 pluginsEnabled / apiEnabled /
    // pluginRuntime 这些键一起抹掉 —— 插件「关了设置就变关闭」「API 莫名其妙关了」
    // 就是这么来的（2026-11-05 真机抓到：state.json 里插件与 API 的键全没了）。
    match (prefs.as_object(), state.prefs.as_object_mut()) {
        (Some(incoming), Some(current)) => {
            for (k, v) in incoming {
                current.insert(k.clone(), v.clone());
            }
        }
        _ => state.prefs = prefs,
    }
    // 只动 prefs：这个命令会被 600ms 防抖的偏好同步频繁调用，
    // 每次重写 1.7 MB 的字体库数据纯属浪费（见 store::save_prefs）
    store::save_prefs(&state)?;
    drop(state);
    // 本地 API 的开关 / 令牌 / 危险操作授权都存在 prefs 里：存完立刻生效，不必重启
    crate::api::apply_prefs();
    Ok(())
}

// ───────────────── 本地 API / 插件（1.3.0） ─────────────────

#[tauri::command]
fn api_status() -> serde_json::Value {
    match crate::api::hub() {
        Some(hub) => {
            let cfg = hub.cfg.lock().map(|c| c.clone()).unwrap_or_default();
            // json! 里塞不了带 let 的块，先算好
            let mut allow_list: Vec<String> = cfg.allow.iter().cloned().collect();
            allow_list.sort();
            serde_json::json!({
                "enabled": cfg.enabled,
                "running": crate::api::is_running(),
                "port": cfg.port,
                "requestedPort": cfg.want_port,
                "token": cfg.token,
                "dangerous": cfg.dangerous,
                "dangerousAllow": allow_list,
                "base": if cfg.port == 0 { String::new() } else { format!("http://127.0.0.1:{}/api/v1", cfg.port) },
                "version": env!("CARGO_PKG_VERSION"),
            })
        }
        None => serde_json::json!({ "enabled": false, "running": false, "port": 0 }),
    }
}

/// 开 / 关本地 API。写进 prefs 并立刻生效（不用重启软件）。
#[tauri::command]
fn api_set_enabled(enabled: bool) -> Result<(), String> {
    let Some(hub) = crate::api::hub() else {
        return Err("本地 API 还没初始化".into());
    };
    {
        let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
        if let Some(p) = state.prefs.as_object_mut() {
            p.insert("apiEnabled".into(), serde_json::json!(enabled));
        } else {
            state.prefs = serde_json::json!({ "apiEnabled": enabled });
        }
        store::save_prefs(&state)?;
    }
    crate::api::apply_prefs();
    Ok(())
}

/// 允许 / 禁止「危险写」（导入、覆盖类操作）。默认禁止。
/// 设置监听的端口。0 = 自动；1024 以下要提权，一律拒绝。
/// 存进 prefs 后立刻按新配置重启监听（在跑就换端口，没开就只记下）。
#[tauri::command]
fn api_set_port(port: u16) -> Result<u16, String> {
    let Some(hub) = crate::api::hub() else {
        return Err("本地 API 还没初始化".into());
    };
    if port != 0 && port < 1024 {
        return Err("端口要大于 1023；1024 以下需要管理员权限".into());
    }
    {
        let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
        let want = crate::api::normalize_port(if port == 0 { None } else { Some(port as i64) });
        if let Some(p) = state.prefs.as_object_mut() {
            p.insert("apiPort".into(), serde_json::json!(want));
        } else {
            state.prefs = serde_json::json!({ "apiPort": want });
        }
        store::save_prefs(&state)?;
    }
    crate::api::apply_prefs();
    Ok(crate::api::current_port())
}

#[tauri::command]
fn api_set_dangerous(on: bool) -> Result<(), String> {
    let Some(hub) = crate::api::hub() else {
        return Err("本地 API 还没初始化".into());
    };
    {
        let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
        if let Some(p) = state.prefs.as_object_mut() {
            p.insert("apiDangerous".into(), serde_json::json!(on));
        }
        store::save_prefs(&state)?;
    }
    crate::api::apply_prefs();
    Ok(())
}

/// 单独授权 / 收回某个客户端做「重大操作」。
///
/// 客户端标识：`api`（本地 API 脚本）、`mcp`、或插件 id（插件令牌的名字就是 id）。
/// 总开关关着时这里怎么勾都没用 —— 两道闸是「与」的关系。
#[tauri::command]
fn api_set_dangerous_allow(client: String, on: bool) -> Result<(), String> {
    let Some(hub) = crate::api::hub() else {
        return Err("本地 API 还没初始化".into());
    };
    let who = client.trim().to_ascii_lowercase();
    if who.is_empty() {
        return Err("客户端标识不能为空".into());
    }
    {
        let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
        let mut list: Vec<String> = state
            .prefs
            .get("apiDangerousAllow")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .map(|x| x.trim().to_ascii_lowercase())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        list.retain(|x| x != &who);
        if on {
            list.push(who);
        }
        list.sort();
        list.dedup();
        if let Some(p) = state.prefs.as_object_mut() {
            p.insert("apiDangerousAllow".into(), serde_json::json!(list));
        } else {
            state.prefs = serde_json::json!({ "apiDangerousAllow": list });
        }
        store::save_prefs(&state)?;
    }
    crate::api::apply_prefs();
    Ok(())
}

/// 重置访问令牌（旧令牌当场失效，插件需重新启用才会拿到新的）
#[tauri::command]
fn api_reset_token() -> Result<String, String> {
    let Some(hub) = crate::api::hub() else {
        return Err("本地 API 还没初始化".into());
    };
    let fresh = crate::api::new_plugin_token();
    {
        let mut state = hub.store.0.lock().map_err(|e| e.to_string())?;
        if let Some(p) = state.prefs.as_object_mut() {
            p.insert("apiToken".into(), serde_json::json!(fresh));
        }
        store::save_prefs(&state)?;
    }
    crate::api::apply_prefs();
    Ok(fresh)
}

/// 检查更新（1.8.1）。只读版本号与发布说明，**不下载、不解压、不执行**任何远端内容。
///
/// `force = true` 是用户在设置里手点的；`false` 是启动时的静默检查。
/// 两层节流都别省：后端 10 分钟缓存 + 前端按 `updateLastCheck` 做 24 小时判断，
/// 因为 GitHub 匿名接口限额是 60 次/小时/IP，多开几个实例很容易撞上。
#[tauri::command]
async fn check_update(store: State<'_, Store>, force: bool) -> Result<serde_json::Value, String> {
    let inner = store.0.clone();
    // 静默检查（force=false）由后端自己再挡一道：前端漏判也不会真的发请求出去。
    // 用户手点（force=true）不受这个开关影响 —— 明确点了就给他查。
    if !force {
        let allowed = inner
            .lock()
            .map(|s| {
                s.prefs
                    .get("updateCheck")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true)
            })
            .unwrap_or(true);
        if !allowed {
            return Err("自动检查更新已在设置里关闭".into());
        }
    }
    let info = crate::update::check(force).await?;
    let mut doc = serde_json::to_value(&info).map_err(|e| e.to_string())?;
    if let Ok(mut state) = inner.lock() {
        let skipped = state
            .prefs
            .get("updateSkipped")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if let Some(obj) = doc.as_object_mut() {
            // 「这个版本我不想再被提醒」—— 由前端写 prefs，这里只负责回报是否已跳过
            obj.insert("skipped".into(), serde_json::json!(skipped == info.latest));
        }
        if let Some(prefs) = state.prefs.as_object_mut() {
            prefs.insert(
                "updateLastCheck".into(),
                serde_json::json!(crate::services::now_ms()),
            );
            // 老用户的 state.json 里没有这个键：默认开启（只发一次匿名 GET，不带任何本机信息）
            prefs
                .entry("updateCheck".to_string())
                .or_insert(serde_json::json!(true));
        }
        let _ = store::save_prefs(&state);
    }
    Ok(doc)
}

/// 下载新版本安装包（1.8.4；1.9.1 起多通道接力）。下载完核对 SHA-256，对不上就删掉，**不会执行**。
///
/// 走 `spawn_blocking`：几 MB 的包在网络差时要几十秒，同步命令会把界面卡住。
/// 进度通过 `update:progress` 事件推给前端（download / verify / ready / error）。
/// `asset_id` 是 Release Asset 的数字 id，给 `api.github.com` 兜底通道用（0 = 没有兜底）。
#[tauri::command]
async fn update_download(
    app: tauri::AppHandle,
    url: String,
    name: String,
    sha256: String,
    asset_id: u64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::update::download_setup(&app, &url, &name, &sha256, asset_id)
    })
    .await
    .map_err(|e| format!("下载任务异常：{e}"))?
}

/// 静默安装刚下好的包（1.8.4）：再校验一次 → 起一段等待脚本 → 本进程 1.2 秒后退出。
///
/// 退出是必须的：Windows 不允许覆盖正在运行的 exe。脚本会等我们消失再 `/S` 安装，
/// 装完把新版启动起来。
/// 静默安装刚下好的包（1.8.4）：再校验一次 → 起一段等待脚本 → 本进程 1.2 秒后退出。
///
/// 退出是必须的：Windows 不允许覆盖正在运行的 exe。脚本会等我们消失再 `/S` 安装，
/// 装完把新版启动起来。`version` 是这次要装的版本号，只用于**装完核对**
/// （写进 apply-update.log：`/S` 失败时旧 exe 还在原位，不核对就看不出「装了但没换」）。
#[tauri::command]
fn update_install(
    app: tauri::AppHandle,
    path: String,
    sha256: String,
    version: Option<String>,
) -> Result<(), String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::update::install_setup(&app, &path, &sha256, version.as_deref().unwrap_or(""))
    }))
    .unwrap_or_else(|_| Err("安装出错（已拦下，软件继续运行）；详情见日志".into()))
}#[tauri::command]
async fn plugins_list() -> Vec<crate::plugins::PluginInfo> {
    tauri::async_runtime::spawn_blocking(crate::plugins::list)
        .await
        .unwrap_or_default()
}#[tauri::command]
fn plugin_set_enabled(store: State<Store>, id: String, enabled: bool) -> Result<(), String> {
    if enabled {
        crate::plugins::enable(&id).map(|_| ())?;
    } else {
        // 插件可能自己先退了（解释器不对 / 崩了）：这时候关开关不该报错，
        // 用户的本意就是「别再让它开」，记住这个选择就行。
        let _ = crate::plugins::disable(&id);
    }
    // 记住这次选择：下次启动照着开回来（不然每次开机都要手动点一遍）
    crate::plugins::remember(store.inner(), &id, enabled);
    let state = store.0.lock().map_err(|e| e.to_string())?;
    store::save_prefs(&state)
}

#[tauri::command]
fn plugin_invoke(id: String, hook: String, payload: serde_json::Value) -> Result<(), String> {
    // 插件这条路上任何 panic 都不该把主界面带走：拦下来换成一条错误返回前端。
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::plugins::invoke(&id, &hook, payload)
    })) {
        Ok(r) => r,
        Err(_) => Err("插件调用出错了（已拦下，软件继续运行）；详情见日志".into()),
    }
}

/// 打开插件目录（不存在就先建一个，用户往里放同名文件夹即可）
#[tauri::command]
fn plugins_open_dir() -> Result<(), String> {    let dir = crate::plugins::plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    open_folder(dir.to_string_lossy().into_owned())
}

/// 拖入的 zip 是不是插件包（1.4.4）：是 → 前端走安装；不是 → 走字体安装原流程
#[tauri::command]
fn plugin_probe_zip(path: String) -> Result<serde_json::Value, String> {
    let (root, id, name, version) = crate::plugins::probe_zip(std::path::Path::new(&path))?;
    Ok(serde_json::json!({ "isPlugin": true, "root": root, "id": id, "name": name, "version": version }))
}

/// 从 zip 安装/更新插件（1.4.4）。更新时只覆盖代码，config/secret/state 原样保留。
#[tauri::command]
fn plugin_install_zip(path: String) -> Result<serde_json::Value, String> {
    // 插件数据不可信：任何 panic 都换成错误返回，主界面不受影响
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (id, name, version) = crate::plugins::install_zip(std::path::Path::new(&path))?;
        // 关键：更新不能只换文件 —— 正在运行的插件进程还抱着旧代码，
        // 新面板页调新端点会被旧服务回 unknown endpoint。装完立即热重启。
        let restarted = crate::plugins::restart_if_running(&id);
        Ok(serde_json::json!({ "id": id, "name": name, "version": version, "restarted": restarted }))
    }))
    .unwrap_or_else(|_| Err("安装插件包时出错了（已拦下，软件继续运行）；详情见日志".into()))
}

/// 插件运行时状态清单（1.4.11）：内置/系统版本、占用、被哪些插件使用
///
/// 走 `spawn_blocking`（2026-11-11）：里面要 spawn 解释器探版本、递归统计运行时目录，
/// 同步命令会直接在 UI 线程上跑 —— 设置面板一打开就"卡一下"就是它。
#[tauri::command]
async fn runtimes_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            serde_json::to_value(crate::plugins::runtimes_status()).map_err(|e| e.to_string())
        }))
        .unwrap_or_else(|_| Err("运行时状态查询出错了（已拦下，软件继续运行）".into()))
    })
    .await
    .unwrap_or_else(|_| Err("运行时状态查询出错了（已拦下，软件继续运行）".into()))
}

/// 删除内置插件运行时（1.4.11）。正在运行的插件占用 exe 会先被拦。
#[tauri::command]
fn runtime_delete(kind: String) -> Result<(), String> {
    crate::plugins::runtime_delete(&kind)
}

/// 从 GitHub release 下载运行时补全（1.4.11）。进度走 `runtime:progress` 事件。
#[tauri::command]
fn runtime_download(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    crate::plugins::runtime_download(app, &kind)
}

/// 界面不再展示解释器（插件自带 runtime/ 或软件静默探测），但 set_runtime /
/// runtimes_json 保留：prefs `pluginRuntime` 手工指定仍是隐藏的兜底出口。

/// 用系统浏览器打开一个网页链接。
///
/// **不要再用 `cmd /C start`**（2026-11-10 审查）：cmd.exe 会把参数再解析一遍命令行，
/// 一个带 `&` 的 URL（`https://x/&calc.exe`）就等于在用户机器上执行了第二条命令。
/// 现在统一交给 `opener` 插件走 `ShellExecute`，不经过任何 shell。
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("refusing to open non-web URL: {url}"));
    }
    // 控制字符会让日志和参数传递变得不可预测，直接拒
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("refusing to open URL with whitespace or control chars".into());
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn adobe_available() -> bool {
    adobe::available()
}

#[tauri::command]
async fn apply_font_in_app(
    app: String,
    postscript_name: String,
    label: String,
    family_name: String,
    aliases: Option<Vec<String>>,
) -> Result<String, String> {
    let aliases = aliases.unwrap_or_default();
    let target = adobe::Target::parse(&app)?;
    let warm_id = match target {
        adobe::Target::Photoshop => Some("photoshop"),
        adobe::Target::Illustrator => Some("illustrator"),
        adobe::Target::CorelDraw => None,
    };
    // family_name 是 PostScript 名认不出时的回退名（真正的字族名）；
    // label 只用于提示文案（字重级时是「族名 字重」）。
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        adobe::apply(target, &postscript_name, &label, &family_name, &aliases)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 成功应用之后让预热心跳安静一会儿：否则它紧接着去探测，很容易和应用时的
    // COM 调用撞在一起超时，底部那条预热状态就「刷新」一下甚至变红。
    if let Some(id) = warm_id {
        if outcome.starts_with("applied:") || outcome == "created" {
            warm::note_activity(id);
        }
    }
    Ok(outcome)
}

/// panic 钩子从这里落盘（main.rs 里 set_hook 调它）。
/// 发布版没有控制台，闪退现场只剩这一条线索 —— 别删。
pub fn log_panic(msg: &str) {
    crate::diag::log(&format!("[panic] {msg}"));
    eprintln!("[panic] {msg}");
}

/// 旧标识 → 新标识：把 `old` 整个搬到 `new`，`new` 已存在时什么都不做。
///
/// 抽出来是为了能单测（`migrate_webview_data_dir` 本身要读 `%LOCALAPPDATA%`，没法在测试里造）。
fn move_dir_if_absent(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<bool> {
    if !old.is_dir() || new.exists() {
        return Ok(false);
    }
    std::fs::rename(old, new)?;
    Ok(true)
}

/// 应用标识从 `com.theholyonez.fontmanager` 换成 `com.iieozo.fontmanager`（1.9.8）。
///
/// WebView2 的用户数据目录名跟着标识走（`%LOCALAPPDATA%\<identifier>\EBWebView`）。
/// 换标识却不搬目录，老用户第一次打开时会「界面回到初始状态」（主题、缩放、面板布局
/// 都存在这里）。所以**建窗口之前**先把旧目录整目录改名。
///
/// 失败就算了：最坏是界面回默认，不能因为搬目录把程序卡在启动。
/// 为什么值得换：标识会出现在 `%LOCALAPPDATA%`、注册表与通知身份里，带着上一个项目的
/// 作者名，和现在的署名（IIEOzo）对不上。
#[cfg(windows)]
fn migrate_webview_data_dir() {
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let base = std::path::PathBuf::from(base);
    let old = base.join("com.theholyonez.fontmanager");
    let new = base.join("com.iieozo.fontmanager");
    match move_dir_if_absent(&old, &new) {
        Ok(true) => crate::diag::log("[migrate] WebView 数据目录已搬到 com.iieozo.fontmanager"),
        Ok(false) => {}
        Err(e) => crate::diag::log(&format!(
            "[migrate] WebView 数据目录改名失败（界面会回默认）：{e}"
        )),
    }
}

#[cfg(not(windows))]
fn migrate_webview_data_dir() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 路线 C（2.1.7）：`--installer-ui` / `--uninstall-ui` 走一条**完全独立**的启动路径，
    // 见 setup_ui.rs 的模块注释。没有这两个参数时 dispatch() 只扫一遍 argv 就返回 false，
    // 下面主程序启动路径一个字都没变（不加载 store、不会多开线程）。
    //
    // Context 只生成一次再分给两条路径：`generate_context!()` 会把前端产物按文件
    // `include_bytes!` 进二进制，调两次有把 dist 存两遍的风险——体积是我们这条线最在意的事。
    let context = tauri::generate_context!();
    if setup_ui::dispatch() {
        setup_ui::run_window(context);
        return;
    }
    run_main(context);
}

fn run_main(context: tauri::Context<tauri::Wry>) {
    // 启动计时原点：启动页要报「种子就绪花了多久」，这是唯一可信的起点
    let _ = boot_at();
    // 应用标识换了名字（1.9.8），WebView2 的数据目录跟着标识走，必须**在建窗口之前**搬过去
    migrate_webview_data_dir();
    // 资源管理器双击 `.S-/.P-/.L-FontManager` 时，Windows 会把文件路径当 argv[1] 传进来。
    let opened_file = startup_file_arg();
    // 已经有一个实例在跑：把它正开着的那个窗口（哪怕正收在屏幕顶端一根细线里）
    // 叫回完整界面，并把双击的文件路径一并递过去，然后自己退出。
    if !single_instance::acquire(opened_file.as_deref()) {
        return;
    }
    // 自己是首实例：暂存路径，等前端 init 完成后用 take_pending_open_file 取走导入。
    // 不能用 emit —— setup 阶段 WebView 还没开始监听，事件会丢。
    if let Some(path) = opened_file {
        if let Ok(mut slot) = PENDING_OPEN_FILE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
        {
            *slot = Some(path);
        }
    }

    let mut state = store::load();
    diag::session_start();
    activation::reconcile(&mut state);

    let watch_enabled = state.watch_enabled;
    let ui_scale_pref = state
        .prefs
        .get("uiScale")
        .and_then(|v| v.as_f64())
        .map(|s| s.clamp(0.5, 2.0));
    // 速览快捷键：默认 Alt + `，用户可以在设置里改（存 prefs.quickbarHotkey）
    let quickbar_hotkey = state
        .prefs
        .get("quickbarHotkey")
        .and_then(|v| serde_json::from_value::<window_dock::HotkeySpec>(v.clone()).ok())
        .unwrap_or_default();
    let extra_dirs = state.extra_dirs.clone();
    // 「启动时最小化到托盘」：是的话就别急着把窗口亮出来
    let start_minimized = state
        .prefs
        .get("startMinimized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let library_dir = state.active_library_dir().map(|s| s.to_owned());
    let linked_dirs: Vec<String> = state.linked.iter().cloned().collect();
    // 上次运行学到「raw.githubusercontent.com 在本机不通」的话，这次直接走镜像，
    // 不用让用户在第一次下载/搜索版权时先等 10 秒超时
    net::seed_raw_unreachable(state.raw_unreachable);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Store(std::sync::Arc::new(std::sync::Mutex::new(state))))
        .manage(watcher::WatchHandle(std::sync::Mutex::new(None)))
        .setup(move |app| {
            // 本地 API / 插件：先建 Hub 再按 prefs 决定起不起监听。
            // 默认关闭，开关在设置 → 本地 API 里（prefs.apiEnabled）。
            if let Some(store) = app.try_state::<Store>() {
                crate::api::init(store.inner().clone());
            }
            // 上次开着的插件：等 API 监听就绪再拉起来（插件要拿 apiBase 和受限令牌）。
            // 放线程里跑，manifest 多、解释器慢都不挡首屏。
            crate::plugins::set_app(app.handle().clone());
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(300));
                crate::plugins::start_enabled();
            });
            // 网络层学到的「原始地址不可达」要跨重启记住：每次翻转才写盘一次，开销可忽略
            {
                let handle = app.handle().clone();
                net::set_persist_hook(Box::new(move |unreachable| {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        let Some(store) = handle.try_state::<Store>() else { return };
                        let Ok(mut st) = store.0.lock() else { return };
                        if st.raw_unreachable != unreachable {
                            st.raw_unreachable = unreachable;
                            let _ = store::save(&st);
                        }
                    });
                }));
            }
            // 首实例：等「再点一次图标」的信号，收到就通知前端把完整界面叫出来
            single_instance::watch(app.handle().clone());
            // 库里那份 `.zfm-folder.ico` 是随二进制走的：换版本（比如 1.2.6 把图标
            // 重画成和软件内一致）后要重新盖一次，否则资源管理器还显示旧图。
            // 图标只是显示层，失败只记日志，不挡启动。
            #[cfg(target_os = "windows")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let Some(store) = handle.try_state::<Store>() else { return };
                    let dir = {
                        let Ok(st) = store.0.lock() else { return };
                        st.active_library_dir().map(|s| s.to_owned())
                    };
                    if let Some(dir) = dir {
                        if let Err(e) = library_marker::apply(&dir) {
                            diag::log(&format!("[startup] 库文件夹图标应用失败：{e}"));
                        }
                    }
                });
            }
            // 三种导出扩展名各注册专属图标 + 双击用本程序打开导入。
            // 只写 HKCU，后台跑，失败也不影响启动。
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| match file_assoc::ensure_associations() {
                Ok(true) => eprintln!("[file-assoc] S/P/L-FontManager associations registered"),
                Ok(false) => {}
                Err(e) => eprintln!("[file-assoc] skipped: {e}"),
            });
            // 系统级 Alt + `：注册成全局热键，任何软件在前台时都能把速览拉下来
            window_dock::start_hotkey_listener(app.handle().clone(), quickbar_hotkey);
            if let Some(window) = app.get_webview_window("main") {
                fit_window(&window, ui_scale_pref);
                // 圆角不再用 DWM（DWMWCP_ROUND 自带一圈窗口阴影，用户要求完整界面
                // 也不要阴影）：完整界面和速览的圆角统一由前端 CSS 画（--qb-radius）。
                // set_window_rounded 命令保留，只用于把系统圆角关死。
                //
                // 2.1.6 起主窗口**不在这里 show**：改由 `splash_done`（种子就绪 /
                // 3s 超时）打开。原来是「立刻 show + 骨架屏」，但骨架屏终究是个空壳，
                // 而种子只要几百毫秒 —— 先给一屏「正在装载真实的字体」再进界面，
                // 用户不用先看一眼假卡片。fit_window 必须留着：缩放与居中要在
                // 首次可见之前算好，否则窗口会先按 100% 闪一下再缩。
            }
            // 启动页（2.1.6）：不在 tauri.conf.json 里配，改在这里手动建。
            //
            // 【为什么挪出 config】2.1.6 安装版在部分机器上双击启动必 panic
            // （0x8007139F = ERROR_INVALID_STATE，WebView2 把它描述成「没有注册类」）。
            // 对照实验已排除机器环境：2.1.5（单窗口）同一台机器同一时刻正常启动。
            // 根因是 config 的 windows 数组里两个窗口共享同一个 WebView2 user data
            // folder，第二个 environment 的创建存在竞态/不一致，一失败整个应用跟着
            // panic（Tauri issue #8196：多窗口在部分机器必挂）。官方 workaround 是给
            // 多出来的窗口一个**独立的 data_directory**——而 config 窗口的
            // dataDirectory 字段只接受相对路径（相对 $LOCALDATA\<label> 拼接），
            // 不如直接在 Rust 侧建窗，路径、时机、失败策略全部自己握住。
            //
            // 【为什么绝不能 panic】启动页只是「增强体验」：建不出来（理论上不该
            // 发生）最多损失一屏进度条，下面的 15 秒兜底闸门会把主界面强制亮出来。
            // 2.1.6 的教训恰恰是 WebView 创建失败 panic 让整个应用打不开——
            // 这里所有错误一律记 diag::log 后继续，禁止 expect/unwrap。
            if !start_minimized {
                // splash 的 WebView2 数据目录独立于 main（`<LOCALDATA>\<identifier>\
                // splash-webview`）：不再与主窗口共享浏览器进程，environment 之间
                // 彻底解耦，竞态无从谈起（tauri#8196 官方 workaround）。
                // 建目录要提前做：WebView2 不会替我们建 user data folder。
                let splash_data_dir = match app.path().app_local_data_dir() {
                    Ok(dir) => {
                        let dir = dir.join("splash-webview");
                        // 目录建不出来（磁盘满 / 权限被杀软拦）时不给 splash 配独立
                        // 目录、退回默认行为：宁可冒一次与 main 共享的风险，也不能
                        // 因为建目录失败就把启动页整个放弃或让应用崩掉。
                        if std::fs::create_dir_all(&dir).is_ok() {
                            Some(dir)
                        } else {
                            diag::log("[splash] 独立 WebView 数据目录创建失败，退回默认数据目录");
                            None
                        }
                    }
                    Err(e) => {
                        diag::log(&format!("[splash] 取 app_local_data_dir 失败（退回默认数据目录）：{e}"));
                        None
                    }
                };
                let mut builder = tauri::WebviewWindowBuilder::new(
                    app,
                    "splash",
                    tauri::WebviewUrl::App("splash.html".into()),
                )
                .title("FontManager")
                // 与 main 窗口的 additionalBrowserArgs **一个字符都不能差**：
                // WebView2 对共享 user data folder 的 WebView 要求 environment
                // options 完全一致；给 splash 独立目录后这里保持一致，纯粹是为了
                // 渲染行为（无 UI 弹层、无 SmartScreen、无障碍树）与主界面对齐。
                .additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-renderer-accessibility",
                )
                // 以下属性逐项复刻原 config 里 splash 的字段。尺寸是**逻辑像素**：
                // 2.1.7 起从 560×380 整体放大一倍到 1120×760（用户要求「启动页扩大
                // 一倍」），splash.html 里的图标/字号/进度条同步 ×2，两处必须一起改。
                .inner_size(1120.0, 760.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .center()
                .always_on_top(true)
                .skip_taskbar(true)
                // 原 config 的 dragDropEnabled: false = 关掉 Tauri 自己的拖放拦截，
                // 交给 HTML5 原生拖放（启动页没有拖放交互，与原语义一致）
                .disable_drag_drop_handler()
                .visible(false);
                // 独立数据目录是本修复的核心，目录拿不到时才不设（见上面的兜底说明）
                if let Some(dir) = splash_data_dir {
                    builder = builder.data_directory(dir);
                }
                match builder.build() {
                    Ok(splash) => {
                        let _ = splash.show();
                        let _ = splash.set_focus();
                        // 最短显示 1.5 秒的起点 = 这一行（见 `splash_mark_shown` 的注释）
                        splash_mark_shown();
                    }
                    Err(e) => {
                        // 启动页创建失败不 panic（理由见上面的块注释）：
                        // 记日志，主界面由 15 秒兜底闸门强制显示
                        diag::log(&format!("[splash] 启动页创建失败（主界面走 15 秒兜底）：{e}"));
                    }
                }
            } else {
                // 「启动时最小化到托盘」（开机自启场景）：那一秒里不该有任何窗口闪一下。
                // 2.1.5 的做法是 config 窗口建好再立刻 close；现在窗口由我们手动建，
                // 直接**不建**——省一次 WebView2 environment 的创建，语义不变
                // （`splash_done` / 15 秒兜底里 `get_webview_window("splash")`
                // 拿到 None 会自然跳过，无需任何配合改动）。
            }
            // 兜底闸门：前端 JS 挂了（语法错、WebView 崩溃、种子监听没注册上）时
            // `splash_done` 永远不会来，用户会对着启动页一直等。15 秒后无论如何把
            // 主界面亮出来 —— 一个能用的界面远好过一个永远转圈的启动页。
            // 启动时最小化模式下不插手：那种模式下用户本来就不等窗口。
            {
                let handle = app.handle().clone();
                let skip = start_minimized;
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    if skip {
                        return;
                    }
                    let Some(main) = handle.get_webview_window("main") else {
                        return;
                    };
                    if main.is_visible().unwrap_or(false) {
                        return;
                    }
                    let _ = main.show();
                    if let Some(splash) = handle.get_webview_window("splash") {
                        let _ = splash.close();
                    }
                    diag::log("[splash] 15 秒内主界面没被打开（前端可能挂了），已强制显示");
                });
            }
            let tray_ok = build_tray(app.handle()).is_ok();
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // E2：批量启停进行中 → 无论「关闭即最小化到托盘」开没开，
                        // 都不退出（藏进托盘，WebView 里的分批编排继续跑）。
                        // 托盘没建成的极端情况不拦：断点（state.pending_batch）兜底，
                        // 下次启动会问用户要不要续做。
                        let busy =
                            BATCH_RUNNING.load(std::sync::atomic::Ordering::Relaxed);
                        if tray_ok && (busy || close_to_tray_enabled(&handle)) {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            allow_previews(app.handle(), &extra_dirs);
            allow_dir(
                app.handle(),
                &scanner::effective_managed_dir(library_dir.as_deref()),
            );
            for path in &linked_dirs {
                if let Some(parent) = std::path::Path::new(path).parent() {
                    allow_dir(app.handle(), parent);
                }
            }
            // 预览修复缓存也要能被 asset 协议读到：它不在字体库目录里，
            // 配置里的 $APPDATA 指向的是带应用标识的目录，覆盖不到这里。
            // 2.1.5 起它跟着数据根走（`<安装目录>\data\preview-cache`）——
            // **不需要改 CSP / scope 配置**，因为这两处 allow_dir 拿的就是缓存目录本身，
            // 路径自动跟随（0.9.4 的 os error 3 就是漏了这一层）。
            if let Some(dir) = preview_font::cache_root() {
                allow_dir(app.handle(), &dir);
            }
            // 缩略图目录同理：它也在数据根下，asset scope 覆盖不到
            if let Some(dir) = thumb::root() {
                allow_dir(app.handle(), &dir);
            }
            if watch_enabled {
                let _ = apply_watch(app.handle(), true, &extra_dirs);
            }
            if !cfg!(target_os = "linux") {
                let affinity_app = app.handle().clone();
                std::thread::spawn(move || loop {
                    affinity::tick(&affinity_app);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                });
            }
            // CorelDRAW 的 COM 首次连接要 4~5 秒（详见 comhost.rs），放在后台点火，
            // 这样用户第一次点「在 CorelDRAW 中应用」时只剩几十毫秒的实际操作。
            // CorelDRAW 没开时 Attach 会立刻返回 not-running（宿主进程仍然留着复用），
            // 所以多试几轮几乎没有成本——原来只试 4 分钟，用户 10 分钟后才用就必然冷启动。
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                for _ in 0..40 {
                    if matches!(comhost::warm().as_deref(), Ok("ok")) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
            });

            // 底部预热指示器的心跳：只做进程探测（几毫秒），真正连 COM 的探针
            // 由 warm 模块自己在后台线程里发起，这里不会被拖慢。
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| loop {
                warm::tick();
                std::thread::sleep(std::time::Duration::from_millis(400));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_file_kind,
            take_pending_open_file,
            splash_state,
            splash_done,
            set_autostart,
            get_autostart,
            resync_library_labels,
            dedupe_font_library,
            restore_deduped_fonts,
            scan_fonts,
            set_font_active,
            set_fonts_active,
            set_fonts_active_session,
            set_batch_running,
            batch_checkpoint,
            batch_checkpoint_get,
            get_active_paths,
            install_fonts,
            install_online_family,
            uninstall_font,
            uninstall_fonts,
            list_trash,
            affinity_connection,
            app_warm_state,
            affinity_link,
            affinity_session_activate,
            online_catalogue,
            online_family,
            online_download,
            online_preview,
            online_clear_staging,
            online_hosts,
            info_files,
            open_local_file,
            set_unpreviewable,
            font_license_fetch,
            restore_from_trash,
            delete_trash_entry,
            empty_trash,
            get_tags,
            set_tags,
            get_collections,
            set_collection,
            delete_collection,
            rename_collection,
            get_snapshots,
            save_snapshot,
            delete_snapshot,
            rename_snapshot,
            export_font,
            export_fonts,
            export_font_folder,
            export_library_pack,
            cancel_export_pack,
            import_library_pack,
            write_text_file,
            read_text_file,
            write_binary_file,
            get_features,
            sync_family_copyright,
            font_cjk,
            font_han_coverage,
            font_charset,
            font_coverage,
            font_preview_file,
            list_preview_font,
            thumb_index,
            thumb_put,
            get_favorites,
            set_favorite,
            get_notes,
            set_note,
            seed_license_notes,
            play_sound,
            get_charset,
            fonts_with_char,
            set_ui_scale,
            get_prefs,
            set_prefs,
            api_status,
            api_set_enabled,
            api_set_dangerous,
            api_set_dangerous_allow,
            api_set_port,
            api_reset_token,
            check_update,
            update_download,
            update_install,
            plugins_list,
            plugin_set_enabled,
            plugin_invoke,
            plugins_open_dir,
            plugin_probe_zip,
            plugin_install_zip,
            runtimes_status,
            runtime_delete,
            runtime_download,
            get_settings,
            set_settings,
            default_library_dir,
            open_folder,
            log_file_path,
            open_file,
            apply_library_folder_icon,
            open_url,
            adobe_available,
            apply_font_in_app,
            window_dock::set_quickbar_mode,
            window_dock::set_dock_sensor,
            window_round::set_window_rounded,
            window_dock::set_quickbar_hotkey,
            window_dock::focus_quickbar,
            window_dock::set_window_transitions,
            window_morph::morph_window
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 插件是独立进程，不显式收会留在后台；API 监听也一起关掉
                plugins::stop_all();
                api::stop();
                revert_session_activations(app);
                // 常驻 COM 宿主是独立进程，必须显式收掉，否则会留在后台
                #[cfg(target_os = "windows")]
                comhost::shutdown();
            }
        });
}

#[cfg(test)]
mod session_tests {
    use super::*;

    /// BUG-8 回归：同一路径反复「启用直到关闭」只应占一份。
    /// 原来用 `Vec::extend`，同一路径会被 append 多次，退出时重复停用同一批文件。
    #[test]
    fn session_activation_dedupes_paths() {
        let gate = session_activated();
        gate.lock().unwrap().clear();

        {
            let mut session = gate.lock().unwrap();
            session.extend(vec![
                "C:/Fonts/a.ttf".to_string(),
                "C:/Fonts/a.ttf".to_string(),
                "C:/Fonts/b.ttf".to_string(),
            ]);
            // 再走一轮「停用 → 又启用」
            session.extend(vec!["C:/Fonts/a.ttf".to_string()]);
        }

        assert_eq!(gate.lock().unwrap().len(), 2, "同一路径只应占一份");
        gate.lock().unwrap().clear();
    }

    /// 「导入 → 重启（重扫写进 linked）→ 删除」不能退化成 unlink。
    /// 2026-11-01 实测：删 12 个测试族，10 个只写了一条 `link-*.zfmtrash`，
    /// 文件原地不动，重扫就回来。
    #[test]
    fn library_paths_never_take_the_unlink_branch() {
        let lib = r"E:\Users\someone\字体库";
        // 库内：即使被扫描「收编」进 linked，也必须走真删
        assert!(path_in_library(Some(lib), r"E:\Users\someone\字体库\Roboto\Roboto-Regular.ttf"));
        // 大小写不敏感
        assert!(path_in_library(Some(lib), r"e:\users\someone\字体库\a.ttf"));
        // 库外：链接语义（只删登记、文件留着）
        assert!(!path_in_library(Some(lib), r"D:\downloads\a.ttf"));
        // 前缀相同但不是同一个目录（库目录叫「字体库」，隔壁叫「字体库2」）
        assert!(!path_in_library(Some(lib), r"E:\Users\someone\字体库2\a.ttf"));
        // 没配库目录 → 用默认 managed 目录，外部路径一律不算库内
        assert!(!path_in_library(None, r"D:\downloads\a.ttf"));
    }

    /// 应用标识换名（1.9.8）时的目录搬家：旧目录在、新目录不在 → 搬过去；
    /// 新目录已存在（已经搬过 / 用户自己建过）→ 一个字节都不动。
    #[test]
    fn webview_data_dir_is_moved_once_and_never_overwritten() {
        let root = std::env::temp_dir().join(format!("zfm-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("com.theholyonez.fontmanager");
        let new = root.join("com.iieozo.fontmanager");
        std::fs::create_dir_all(old.join("EBWebView")).unwrap();
        std::fs::write(old.join("EBWebView").join("marker.txt"), b"keep me").unwrap();

        assert_eq!(move_dir_if_absent(&old, &new).unwrap(), true);
        assert!(!old.exists() && new.join("EBWebView").join("marker.txt").is_file());

        // 再跑一次：旧目录已经没了，无事可做
        assert_eq!(move_dir_if_absent(&old, &new).unwrap(), false);

        // 旧、新同时存在（比如用户先跑了新版又回了旧版）：不许覆盖新目录
        std::fs::create_dir_all(old.join("EBWebView")).unwrap();
        std::fs::write(new.join("EBWebView").join("keep.txt"), b"new").unwrap();
        assert_eq!(move_dir_if_absent(&old, &new).unwrap(), false);
        assert!(new.join("EBWebView").join("keep.txt").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod uninstall_tests {
    use super::*;

    /// 卸载 / 移到回收站**不许动用户的标签**（策展数据保护，2.1.7）。
    ///
    /// 为什么是「函数体文本断言」而不是行为测试：`uninstall_one` 真正干活的是
    /// `activation::sync` 与 `installer::uninstall_quiet` —— 前者改注册表、后者搬文件，
    /// 而 `store::AppState` 没有脱离文件系统的轻量构造（`load()` 直接读 state.json）。
    /// 想「造一条 tags、调用一次、断言 tags 还在」，跑起来就会是一条真的去动注册表的测试，
    /// 在开发机和 CI 上都不该发生（同目录的 `library_switch_tests` 能动，是因为
    /// `retire_old_library` 只碰内存里的登记表）。所以退化成本测试：
    /// 编译期读回 lib.rs 源码，切出 `uninstall_one` 的函数体，断言里面一个标签写操作都没有。
    ///
    /// 它守的是这条具体的回归：**有人重新把「顺手清掉这个族的标签」加回卸载流程就会红**。
    /// 以前这件事只靠 `uninstall_one` 里的一句源码注释提醒，注释删掉就没人拦得住了。
    /// 语义边界：删掉的字体不再出现在列表里，但用户打过 / 拒绝过的标签必须留在 state.json ——
    /// 重新导入同一族时标签要能回来，用户也不该因为「删过一次」就丢掉自己的整理结果。
    #[test]
    fn uninstall_one_keeps_curation_tags() {
        let src = include_str!("lib.rs");
        let sig = "fn uninstall_one(";
        let start = src
            .find(sig)
            .unwrap_or_else(|| panic!("源码里找不到 `{sig}`，本测试的切片规则需要跟着改"));

        // 函数体直到下一个**顶格** `}`：函数内部所有块的收尾都是缩进的，
        // 所以 `\n}` 只可能命中 `uninstall_one` 自己的结尾。
        let rest = &src[start..];
        let end = rest
            .find("\n}")
            .unwrap_or_else(|| panic!("`uninstall_one` 的函数体没有找到顶格结尾 `}}`"));
        let body = &rest[..end];

        // 切片自检：切空 / 切错时下面的断言会「空着通过」，那等于没写这条测试。
        assert!(
            body.contains("installer::uninstall_quiet"),
            "切出来的不是 `uninstall_one` 的函数体：\n{body}"
        );

        for bad in [
            "tags.remove",
            "tags.clear",
            "tags.retain",
            "tags.insert",
            "state.tags",
            "remove_tags",
            "clear_tags",
        ] {
            assert!(
                !body.contains(bad),
                "`uninstall_one` 里出现了 `{bad}`：卸载字体不能删用户的标签。\
                 字体可以移走，标签（含「不再建议」的否决记录）必须留在 state.json 里。"
            );
        }
    }
}

#[cfg(test)]
mod library_switch_tests {
    use super::*;

    /// 换字体库必须让旧库的登记退场（2026-11-03 报障：换库后旧库字体还留在软件里）。
    /// 只退「旧库目录里、且不在新库目录里」的；库外链入的、新库自己的、前缀相同的隔壁目录都得留着。
    #[test]
    fn switching_library_retires_only_old_library_entries() {
        let mut state = store::AppState::default();
        let old = std::path::PathBuf::from(r"E:\Users\me\字体库A");
        let new = std::path::PathBuf::from(r"E:\Users\me\字体库B");
        let stale = r"E:\Users\me\字体库A\Roboto\Roboto-Regular.ttf";
        let neighbour = r"E:\Users\me\字体库A2\隔壁.ttf";
        let linked_outside = r"D:\downloads\linked.ttf";
        let in_new = r"E:\Users\me\字体库B\Inter\Inter.ttf";
        for p in [stale, neighbour, linked_outside, in_new] {
            state.linked.insert(p.to_string());
        }
        state.added.insert(stale.to_string(), 1);
        state.added.insert(linked_outside.to_string(), 2);

        assert_eq!(retire_old_library(&mut state, &old, &new), 1);
        assert!(!state.linked.contains(stale), "旧库里的登记要退场");
        assert!(!state.added.contains_key(stale), "added 登记也要一起退场");
        assert!(state.linked.contains(neighbour), "「字体库A2」不是旧库");
        assert!(state.linked.contains(linked_outside), "库外链入的字体不受换库影响");
        assert!(state.linked.contains(in_new), "新库自己的登记不能删");
        assert!(state.added.contains_key(linked_outside));
    }

    /// 「关掉自定义文件夹」= 从自定义库回到默认目录，同样要退场（用户截图里就是这个操作）。
    #[test]
    fn disabling_custom_library_also_retires() {
        let mut state = store::AppState::default();
        let custom = std::path::PathBuf::from(r"E:\Users\Administrator\Desktop\字体库");
        let default_dir = scanner::managed_font_dir();
        let stale = r"E:\Users\Administrator\Desktop\字体库\思源黑体\SourceHanSans-Regular.otf";
        state.linked.insert(stale.to_string());
        assert_eq!(retire_old_library(&mut state, &custom, &default_dir), 1);
        assert!(state.linked.is_empty());
    }

    /// 同一个目录（只是别的设置变了）不能误删登记。
    #[test]
    fn same_library_keeps_entries() {
        let mut state = store::AppState::default();
        let dir = std::path::PathBuf::from(r"E:\Users\me\字体库");
        let p = r"E:\Users\me\字体库\a.ttf";
        state.linked.insert(p.to_string());
        assert_eq!(retire_old_library(&mut state, &dir, &dir), 0);
        assert!(state.linked.contains(p));
    }
}

/// 真机核对用：把整个字库按新口径跑一遍，输出「目录名标注 → 证据判定」的对照表。
/// **只读，不改任何文件。**
///
///   ZFM_LIB_DIR="E:\...\新建文件夹 (2)" cargo test --lib lib_label_probe -- --ignored --nocapture
#[cfg(test)]
mod lib_label_probe {
    use super::*;

    #[test]
    #[ignore]
    fn lib_label_probe() {
        let Ok(root) = std::env::var("ZFM_LIB_DIR") else {
            return;
        };
        let dirs = collect_family_dirs(std::path::Path::new(&root));
        println!("目录总数: {}", dirs.len());
        let mut tally: std::collections::BTreeMap<String, usize> = Default::default();
        let mut changed: Vec<String> = Vec::new();
        let mut no_evidence = 0usize;
        for d in &dirs {
            let name = d
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let old = copyright::suffix_class(&name);
            let found = copyright::inspect_dir(d);
            let key = format!(
                "{}  ->  {}",
                old.map(|c| c.as_str()).unwrap_or("(无后缀)"),
                found.class.as_str()
            );
            *tally.entry(key).or_default() += 1;
            if found.class == copyright::CopyrightClass::Unknown {
                no_evidence += 1;
            } else if old != Some(found.class) {
                changed.push(format!("{name}  =>  {}", found.class.as_str()));
            }
        }
        for (k, v) in &tally {
            println!("  {v:>5}  {k}");
        }
        println!("无证据（保持原名）: {no_evidence}");
        println!("有证据且与现名不同: {}", changed.len());
        for c in changed.iter().take(40) {
            println!("    {c}");
        }
    }
}
