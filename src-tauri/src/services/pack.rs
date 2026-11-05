//! 整包导出 / 导入（`.P-FontManager`，可含字体文件、2 GiB 分卷）。
//!
//! 真正的实现仍在 `crate::library_pack`；这里只负责「库目录从哪来 + 进度往哪报」。
//! 进度用回调，界面发事件、HTTP 侧写 job 表，两不干扰。

use crate::library_pack::{self, PackExportReport, PackImportReport, PackProgress};
use crate::scanner;
use crate::store::Store;
use std::path::{Path, PathBuf};

/// 当前生效的库目录（没设自定义库时是默认库）
pub fn library_dir(store: &Store) -> Result<PathBuf, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(scanner::effective_managed_dir(state.active_library_dir()))
}

pub fn export(
    store: &Store,
    dest: &Path,
    curation: &str,
    created_at: &str,
    on_progress: &dyn Fn(PackProgress),
) -> Result<PackExportReport, String> {
    let library = library_dir(store)?;
    if !library.is_dir() {
        return Err(format!(
            "字体库目录不存在：{}；先在设置里确认字体库地址",
            library.display()
        ));
    }
    library_pack::export_pack(&library, dest, curation, created_at, on_progress)
}

pub fn import(
    store: &Store,
    src: &Path,
    on_progress: &dyn Fn(PackProgress),
) -> Result<PackImportReport, String> {
    if !src.is_file() {
        return Err(format!("文件不存在：{}", src.display()));
    }
    let library = library_dir(store)?;
    library_pack::import_pack(&library, src, on_progress)
}
