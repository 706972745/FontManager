//! 字体解析结果缓存。
//!
//! 启动时慢的根源不在「找文件」，而在「把每个字体文件都重新解析一遍」：
//! 几千个字体要逐个读 name 表、算字形数、判版权，实测是秒级到十几秒的量级，
//! 而其中 99% 的文件从上一次启动到现在根本没动过。
//!
//! 这里按「路径 + 修改时间 + 大小」记住每个文件的解析结果，下次扫描直接复用，
//! 只对新增 / 改过的文件真正走解析。字体库越大，收益越明显。
//!
//! 注意：`active` / `added_at` 是运行时状态（每次扫描由 lib.rs 重新合并），
//! 缓存里的这两个字段是旧值，但会被覆盖，不影响正确性。

use crate::font_types::{FontFace, FontSource};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// 缓存格式版本：字段结构变了就加一，老缓存自动作废（不兼容就重新解析，绝不会出错）
///
/// v2：`scripts` 里原来的 `cjk`（要求汉字 + 假名同时存在）拆成 `han` / `kana`，
/// 并改成按汉字抽样覆盖率判定。老缓存里纯中文字体根本没有 `cjk` 标记，
/// 无法就地迁移，只能作废重解析——代价是升级后第一次启动要重扫一遍字体库。
// v5：目录判定加了「文件名与后缀矛盾」守卫 + 「企业授权」系关键词，旧缓存结论要重算
const CACHE_VERSION: u32 = 5;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// 文件修改时间（Unix 毫秒）
    mtime: u64,
    /// 文件大小（字节）
    size: u64,
    /// 扫描时的来源：改了「字体库目录」会让同一路径的来源变化，必须一起校验
    source: FontSource,
    faces: Vec<FontFace>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

fn cache_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZFontManager")
        .join("font-cache.json")
}

/// 一次扫描期间的缓存句柄：`get` 命中就复用，未命中就解析后 `put`，
/// 扫描结束 `finish` 时把这一轮没见到的条目清掉并异步落盘。
pub struct FontCache {
    path: PathBuf,
    entries: HashMap<String, Entry>,
    seen: HashSet<String>,
    hits: usize,
    misses: usize,
}

impl FontCache {
    pub fn load() -> Self {
        let path = cache_path();
        let entries = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<CacheFile>(&text) {
                Ok(file) if file.version == CACHE_VERSION => file.entries,
                _ => HashMap::new(),
            },
            Err(_) => HashMap::new(),
        };
        Self {
            path,
            entries,
            seen: HashSet::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// 取一个文件的解析结果；文件被改过（时间 / 大小 / 来源不一致）就返回 None
    pub fn get(
        &mut self,
        path: &str,
        mtime: u64,
        size: u64,
        source: FontSource,
    ) -> Option<Vec<FontFace>> {
        self.seen.insert(path.to_string());
        let entry = self.entries.get(path)?;
        if entry.mtime != mtime || entry.size != size || entry.source != source {
            return None;
        }
        self.hits += 1;
        Some(entry.faces.clone())
    }

    pub fn put(
        &mut self,
        path: &str,
        mtime: u64,
        size: u64,
        source: FontSource,
        faces: &[FontFace],
    ) {
        self.seen.insert(path.to_string());
        self.misses += 1;
        self.entries.insert(
            path.to_string(),
            Entry {
                mtime,
                size,
                source,
                faces: faces.to_vec(),
            },
        );
    }

    /// 收尾：丢掉这轮没出现的路径（删掉的字体 / 换掉的目录），后台线程落盘。
    /// 落盘放后台，扫描结果先交给界面——写几 MB 的 JSON 不该占用启动时间。
    pub fn finish(mut self) {
        let hits = self.hits;
        let misses = self.misses;
        if hits + misses > 0 {
            eprintln!("[cache] 字体解析缓存命中 {hits}，重新解析 {misses}");
        }
        // 一条都没命中、也没有新文件：说明缓存和现状完全一致，连写盘都省了
        if misses == 0 && hits > 0 {
            return;
        }
        self.entries.retain(|k, _| self.seen.contains(k));
        // 合并写：扫描目录和链接字体是两次独立的扫描，各自只知道自己见过的路径，
        // 直接覆盖会把对方那一半条目抹掉（下次又要全部重新解析）。先读盘上现有的再合并。
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            if let Ok(existing) = serde_json::from_str::<CacheFile>(&text) {
                if existing.version == CACHE_VERSION {
                    for (k, v) in existing.entries {
                        self.entries.entry(k).or_insert(v);
                    }
                }
            }
        }
        let file = CacheFile {
            version: CACHE_VERSION,
            entries: self.entries,
        };
        let path = self.path;
        std::thread::spawn(move || {
            let Some(dir) = path.parent() else { return };
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
            match serde_json::to_vec(&file) {
                Ok(bytes) => {
                    let _ = std::fs::write(&path, bytes);
                }
                Err(e) => eprintln!("[cache] 序列化字体缓存失败: {e}"),
            }
        });
    }
}
