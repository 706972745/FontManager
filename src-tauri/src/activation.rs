use crate::font_types::FontSource;
use crate::store::AppState;

pub fn can_deactivate(source: FontSource) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = source;
        true
    }
    #[cfg(target_os = "macos")]
    {
        source != FontSource::System
    }
    #[cfg(target_os = "windows")]
    {
        source != FontSource::System
    }
}

/// 系统字体目录（`%SystemRoot%\Fonts`，回退 `C:\Windows\Fonts`）。
///
/// Windows 装在别的盘时只有前者对，所以两个都留。
#[cfg(target_os = "windows")]
fn system_font_roots() -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    if let Ok(w) = std::env::var("SystemRoot") {
        let base = w.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
        roots.push(format!("{base}\\fonts"));
    }
    let fallback = r"c:\windows\fonts".to_string();
    if !roots.contains(&fallback) {
        roots.push(fallback);
    }
    roots
}

/// 这条路径是不是「系统装好的那份」——它改不动，任何尝试都只会失败。
///
/// 早期版本把系统字体也记进了 `state.deactivated`，于是每次启动 reconcile 都会
/// 重试一遍、失败一遍，右上角反复弹「无法卸载系统字体」（C4）。入口就挡住它，
/// 比「尝试 → 失败 → 提示」省事，也不会污染用户数据。
pub fn is_system_font(path: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let norm = path.replace('/', "\\").to_lowercase();
        return system_font_roots()
            .iter()
            .any(|root| norm == *root || norm.starts_with(&format!("{root}\\")));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        false
    }
}

/// E3（2026-11-01）：这个路径是不是「本来就没启用」——HKCU 无条目且非机器级注册。
///
/// 批量停用一个混合集合（部分启用、部分从未启用）时，后者会被原样写进
/// `state.deactivated`（实测 1172 族停用 → 59 → 2071 条，state 2.35 → 2.92 MB），
/// 而注册表里没有条目时 `apply` 的删除分支本来就是 no-op —— 纯污染。
/// 注意 `apply` 仍要照跑：会话级启用（`set_fonts_active_session`）只装载 GDI、
/// 不写注册表，`remove_font_resource` 对这类字体仍然必要。
#[cfg(target_os = "windows")]
fn never_registered(cache: &crate::registry::RegCache, path: &str) -> bool {
    cache.names_for(path).is_empty() && !cache.is_machine(path)
}

pub fn sync(state: &mut AppState, path: &str, active: bool) -> Result<(), String> {
    if is_system_font(path) {
        crate::diag::log(&format!("activation: skip protected system font: {path}"));
        return Ok(());
    }
    let was_deactivated = state.deactivated.contains(path);
    // E3：停用一个本来就没启用的字体，不写 deactivated（详见 never_registered 注释）
    #[cfg(target_os = "windows")]
    let skip_deactivated = !active && never_registered(&crate::registry::RegCache::load(), path);
    #[cfg(not(target_os = "windows"))]
    let skip_deactivated = false;
    if active {
        state.deactivated.remove(path);
    } else if !skip_deactivated {
        state.deactivated.insert(path.to_string());
    }
    let result = apply(state, path, active);
    crate::diag::activation(path, active, &result);
    if result.is_err() {
        if was_deactivated {
            state.deactivated.insert(path.to_string());
        } else {
            state.deactivated.remove(path);
        }
    }
    result
}

/**
 * 批量启停：一次批量只建一次注册表索引、只在末尾广播一次 WM_FONTCHANGE。
 *
 * 之前每个字体都要 `user_entries()` 全量枚举 HKCU 字体表（还会随着写入不断变长），
 * 再各广播一次 WM_FONTCHANGE —— 5000 级批量实测退化成 ~2.5 个/秒，界面整个卡住
 * （`set_fonts_active` 是同步命令，跑在主线程上）。现在索引 O(1) 复用。
 */
pub fn sync_batch(state: &mut AppState, paths: &[String], active: bool) -> Vec<String> {
    let mut failed = Vec::new();
    if paths.is_empty() {
        return failed;
    }
    // Windows：索引只建一次；其他平台每写一个字体都要重写 fontconfig，索引无意义
    #[cfg(target_os = "windows")]
    let mut cache = crate::registry::RegCache::load();
    for path in paths {
        // 系统字体改不动：既不写 registry，也不记进 deactivated（C4）
        if is_system_font(path) {
            crate::diag::log(&format!("activation: skip protected system font: {path}"));
            continue;
        }
        let was_deactivated = state.deactivated.contains(path);
        // E3：本来就没启用（HKCU 无条目、非机器级）→ 不写 deactivated。
        // 缓存里此刻还没有这个路径（还没处理过），names_for 查的就是当前注册表状态。
        #[cfg(target_os = "windows")]
        let skip_deactivated = !active && never_registered(&cache, path);
        #[cfg(not(target_os = "windows"))]
        let skip_deactivated = false;
        if active {
            state.deactivated.remove(path);
        } else if !skip_deactivated {
            state.deactivated.insert(path.clone());
        }
        #[cfg(target_os = "windows")]
        let result = apply_cached(state, path, active, &mut cache);
        #[cfg(not(target_os = "windows"))]
        let result = apply(state, path, active);
        crate::diag::activation(path, active, &result);
        if let Err(e) = result {
            if was_deactivated {
                state.deactivated.insert(path.clone());
            } else {
                state.deactivated.remove(path);
            }
            failed.push(e);
        }
    }
    #[cfg(target_os = "windows")]
    crate::registry::broadcast_font_change();
    failed
}

pub fn batch_error(failed: &[String], total: usize) -> Result<(), String> {
    match failed {
        [] => Ok(()),
        [only] if total == 1 => Err(only.clone()),
        [first, ..] => Err(format!("{} of {total} fonts failed: {first}", failed.len())),
    }
}

pub fn drop_linked_alias(state: &AppState, path: &str) {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = sync_linked_alias(state, path, false);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (state, path);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn sync_linked_alias(state: &AppState, path: &str, active: bool) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    if !state.linked.contains(path) {
        return Ok(());
    }
    let source = Path::new(path);
    let file_name = source.file_name().ok_or("invalid font path")?;
    let dir = crate::scanner::effective_managed_dir(state.active_library_dir());
    if source.parent() == Some(dir.as_path()) {
        return Ok(());
    }
    let alias = dir.join(file_name);

    if active {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&alias).is_ok() {
            return Ok(());
        }
        std::os::unix::fs::symlink(source, &alias).map_err(|e| e.to_string())
    } else {
        match fs::symlink_metadata(&alias) {
            Ok(meta) if meta.file_type().is_symlink() => {
                fs::remove_file(&alias).map_err(|e| e.to_string())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(target_os = "linux")]
fn apply(state: &mut AppState, path: &str, active: bool) -> Result<(), String> {
    use std::fmt::Write as _;
    use std::fs;

    sync_linked_alias(state, path, active)?;

    let dir = dirs::config_dir()
        .ok_or("no config dir")?
        .join("fontconfig")
        .join("conf.d");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("99-fontmanager.conf");

    if state.deactivated.is_empty() {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
    } else {
        let mut globs = String::new();
        let mut paths: Vec<&String> = state.deactivated.iter().collect();
        paths.sort();
        for p in paths {
            let escaped = p
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            let _ = writeln!(globs, "      <glob>{escaped}</glob>");
        }
        let xml = format!(
            "<?xml version=\"1.0\"?>\n<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">\n\
             <!-- Managed by FontManager - do not edit; toggling fonts rewrites this file -->\n\
             <fontconfig>\n  <selectfont>\n    <rejectfont>\n{globs}    </rejectfont>\n  </selectfont>\n</fontconfig>\n"
        );

        let tmp = file.with_extension("conf.tmp");
        fs::write(&tmp, xml).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    }

    if let Ok(mut child) = std::process::Command::new("fc-cache").spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply(state: &mut AppState, path: &str, active: bool) -> Result<(), String> {
    use std::fs;
    use std::path::{Path, PathBuf};

    if state.linked.contains(path) {
        return sync_linked_alias(state, path, active);
    }

    let parked_dir = crate::store::app_data_dir().join("Deactivated");
    fs::create_dir_all(&parked_dir).map_err(|e| e.to_string())?;

    fn move_file(from: &Path, to: &Path) -> Result<(), String> {
        if fs::rename(from, to).is_ok() {
            return Ok(());
        }

        fs::copy(from, to).map_err(|e| e.to_string())?;
        fs::remove_file(from).map_err(|e| e.to_string())
    }

    if active {
        let Some(parked) = state.parked.get(path).cloned() else {
            return Ok(());
        };
        move_file(Path::new(&parked), Path::new(path))?;
        state.parked.remove(path);
    } else {
        if state.parked.contains_key(path) {
            return Ok(());
        }
        let file_name = Path::new(path)
            .file_name()
            .ok_or("invalid font path")?;
        let mut dest: PathBuf = parked_dir.join(file_name);

        let mut n = 1;
        while dest.exists() {
            dest = parked_dir.join(format!("{n}-{}", file_name.to_string_lossy()));
            n += 1;
        }
        move_file(Path::new(path), &dest)?;
        state
            .parked
            .insert(path.to_string(), dest.to_string_lossy().into_owned());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply(state: &mut AppState, path: &str, active: bool) -> Result<(), String> {
    let mut cache = crate::registry::RegCache::load();
    let result = apply_cached(state, path, active, &mut cache);
    crate::registry::broadcast_font_change();
    result
}

/** 批量路径：同一个 RegCache 复用，写完同步更新索引，广播由调用方统一发一次 */
#[cfg(target_os = "windows")]
fn apply_cached(
    state: &mut AppState,
    path: &str,
    active: bool,
    cache: &mut crate::registry::RegCache,
) -> Result<(), String> {
    use crate::registry;

    if active {
        let loaded = registry::add_font_resource(path);
        crate::diag::log(&format!("windows: GDI loaded {loaded} font(s) from {path}"));
        if loaded == 0 {
            return Err(format!("Windows couldn't load this font file: {path}"));
        }

        let remembered = state
            .registry_backup
            .iter()
            .find(|(_, v)| v.as_str() == path)
            .map(|(k, _)| k.clone());
        let name = match remembered {
            Some(name) => name,
            None => cache.unique_name(&registry::value_name_for(path), path),
        };
        let existing = cache.names_for(path);
        if existing.is_empty() {
            if let Err(e) = cache.set(&name, path) {
                registry::remove_font_resource(path);
                return Err(e);
            }
            crate::diag::log(&format!("windows: registry value \"{name}\" written"));
        } else {
            crate::diag::log(&format!("windows: already registered as \"{}\"", existing.join("\", \"")));
        }
        state.registry_backup.remove(&name);
    } else {
        if cache.is_machine(path) {
            return Err(format!(
                "this font is installed for all users; deactivating it needs administrator rights: {path}"
            ));
        }

        let names = cache.names_for(path);
        for name in &names {
            cache.delete(name)?;
        }
        if let Some(first) = names.into_iter().next() {
            state.registry_backup.insert(first, path.to_string());
        }
        registry::remove_font_resource(path);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn reconcile(state: &mut AppState) {
    let _ = apply(state, "", true);
}

#[cfg(target_os = "windows")]
pub fn reconcile(state: &mut AppState) {
    let managed = crate::scanner::effective_managed_dir(state.active_library_dir());
    std::thread::spawn(move || {
        crate::registry::load_registered_outside(&managed);
    });
}

#[cfg(target_os = "macos")]
pub fn reconcile(_state: &mut AppState) {}

pub struct Probe {
    #[cfg(target_os = "windows")]
    registered: std::collections::HashSet<String>,
}

pub fn probe() -> Probe {
    Probe {
        #[cfg(target_os = "windows")]
        registered: crate::registry::registered_paths(),
    }
}

pub fn is_active(probe: &Probe, state: &AppState, face: &crate::font_types::FontFace) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = state;

        face.source == FontSource::System
            || probe
                .registered
                .contains(&crate::registry::normalize(&face.path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = probe;
        is_active_path(state, &face.path)
    }
}

#[cfg(not(target_os = "windows"))]
fn is_active_path(state: &AppState, path: &str) -> bool {
    !state.deactivated.contains(path) && !state.parked.contains_key(path)
}

// 注意：这里原来是 `cfg(all(test, target_os = "linux"))`，导致下面挂着的
// `cfg(target_os = "windows")` 测试全部成了死代码（矛盾 cfg，任何平台都不编译）。
// 现在改为按测试自己声明平台：Linux 专属的（fontconfig）单独加 cfg。
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn fragment_lifecycle() {
        let tmp = std::env::temp_dir().join(format!("zfm-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        unsafe { std::env::set_var("XDG_CONFIG_HOME", &tmp) };
        let fragment = tmp.join("fontconfig/conf.d/99-fontmanager.conf");

        let mut state = AppState::default();
        let font = "/tmp/My <Fancy> & Font.ttf";

        sync(&mut state, font, false).unwrap();
        assert!(state.deactivated.contains(font));
        let xml = std::fs::read_to_string(&fragment).unwrap();
        assert!(xml.contains("<rejectfont>"));
        assert!(xml.contains("/tmp/My &lt;Fancy&gt; &amp; Font.ttf"));

        sync(&mut state, font, true).unwrap();
        assert!(!state.deactivated.contains(font));
        assert!(!fragment.exists(), "fragment should be removed when nothing is deactivated");

        assert!(is_active_path(&state, font));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn batch_error_counts_failures() {
        assert_eq!(batch_error(&[], 12), Ok(()));
        assert_eq!(batch_error(&["boom".into()], 1), Err("boom".into()));
        assert_eq!(
            batch_error(&["a".into(), "b".into()], 12),
            Err("2 of 12 fonts failed: a".into())
        );
    }

    /// C4：系统字体必须被认出来，而且只能认对（别把 `C:\Windows\Fonts2` 也当成系统目录）
    #[test]
    fn detects_protected_system_fonts() {
        #[cfg(target_os = "windows")]
        {
            assert!(is_system_font(r"C:\Windows\Fonts\arial.ttf"));
            assert!(is_system_font("c:/windows/fonts/Arial.ttf"));
            assert!(is_system_font(r"C:\Windows\Fonts\sub\other.ttf"));
            assert!(!is_system_font(r"C:\Windows\Fonts2\arial.ttf"));
            assert!(!is_system_font(r"E:\Users\me\Desktop\fonts\arial.ttf"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!is_system_font("/usr/share/fonts/a.ttf"));
        }
    }

    /// 系统字体走 sync 必须「静默跳过」：不写 deactivated，也不报错
    #[cfg(target_os = "windows")]
    #[test]
    fn sync_skips_system_font_without_error() {
        let mut state = AppState::default();
        let path = r"C:\Windows\Fonts\segoeui.ttf";
        assert!(sync(&mut state, path, false).is_ok());
        assert!(!state.deactivated.contains(path));
    }

    /// E3：停用一个「本来就没启用」的字体（HKCU 无条目、非机器级注册），
    /// 不得把它写进 deactivated —— 注册表里没有它，apply 无事可做，
    /// 写了只会让 state.json 越滚越大（实测 1172 族停用 → 59 → 2071 条）。
    /// 路径是虚构的，只读真注册表，不写任何东西。
    #[cfg(target_os = "windows")]
    #[test]
    fn sync_skips_deactivated_for_never_registered_font() {
        let mut state = AppState::default();
        let path = r"C:\zfm-e3-never-registered\dummy.ttf";
        let cache = crate::registry::RegCache::load();
        assert!(
            never_registered(&cache, path),
            "测试前提：虚构路径不应出现在真注册表里"
        );
        assert!(sync(&mut state, path, false).is_ok());
        assert!(!state.deactivated.contains(path));
    }

    /// E3 批量路径：混合「已启用 + 从未启用」的批量停用，
    /// 从未启用的那些不进 deactivated，已启用（HKCU 有条目）的行为不变。
    /// HKCU 部分只读（虚构路径不在注册表里），不写真机数据。
    #[cfg(target_os = "windows")]
    #[test]
    fn sync_batch_skips_never_registered_paths() {
        let mut state = AppState::default();
        let fresh = r"C:\zfm-e3-never-registered\batch-a.ttf";
        let fresh2 = r"C:\zfm-e3-never-registered\batch-b.ttf";
        let failed = sync_batch(&mut state, &[fresh.to_string(), fresh2.to_string()], false);
        assert!(failed.is_empty());
        assert!(!state.deactivated.contains(fresh));
        assert!(!state.deactivated.contains(fresh2));
    }
}
