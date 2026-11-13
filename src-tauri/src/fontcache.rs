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
// v6：分类判定重写（中文字体名字优先、PANOSE 与 OS/2 分歧用名字破平）——
// 分类是烤进缓存字面的，旧缓存里 SimHei=mono、Century Gothic=serif 这类错值要重算
// v8：name 表改成自己解析，支持 GBK / Big5 / ShiftJIS / Wansung / Mac Roman 编码，
// 并跳过畸形记录继续读；族名还做了字重后缀归并（Barmeno-Bold → Barmeno）。
// 旧缓存里那批「长城美黑体」「文鼎胡子体」的族名是文件名顶上的假名，必须重算。
// v9：localizedNames 从「有 nameID 16 就丢掉 nameID 1」改成两组取并集 ——
// 一批中文字体的中文名只写在 legacy 记录里，之前整个丢了（显示英文名、搜中文名搜不到）。
// 名字是烤进缓存字面的，旧缓存必须重解析一次。
// v10：分类判定重做（2026-11-13）—— 名字优先、逐层短路、判不出兜底成「展示」，
// 不再产出 Unknown。`classification` 是烤进缓存字面的，v9 及以前的缓存里
// 存着 2371 个字面的 Unknown（还有 迷你简综艺=script 这类错值），必须整库重算。
const CACHE_VERSION: u32 = 10;

#[derive(Serialize, Deserialize, Clone)]
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
        .join("FontManager")
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
        // 这一轮没见到的路径（删掉的字体 / 换掉的目录）先记下来，再从缓存里清掉。
        let pruned: HashSet<String> = self
            .entries
            .keys()
            .filter(|k| !self.seen.contains(*k))
            .cloned()
            .collect();
        self.entries.retain(|k, _| self.seen.contains(k));
        // 合并写：扫描目录和链接字体是两次独立的扫描，各自只知道自己见过的路径，
        // 直接覆盖会把对方那一半条目抹掉（下次又要全部重新解析）。先读盘上现有的再合并。
        //
        // 但刚刚 prune 掉的路径不能从盘上捡回来——否则 retain 等于白做，删掉的字体
        // 每次扫描都会复活，缓存里永远留着指向已不存在文件的条目（1.4.0 实测 104 条）。
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            if let Ok(existing) = serde_json::from_str::<CacheFile>(&text) {
                if existing.version == CACHE_VERSION {
                    for (k, v) in existing.entries {
                        if pruned.contains(&k) {
                            continue;
                        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zfm-cache-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("font-cache.json")
    }

    fn entry() -> Entry {
        Entry {
            mtime: 1,
            size: 2,
            source: FontSource::Managed,
            faces: Vec::new(),
        }
    }

    fn cache_at(path: PathBuf) -> FontCache {
        FontCache {
            path,
            entries: HashMap::new(),
            seen: HashSet::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// 删掉的字体不能在合并写里复活：prune 掉的路径必须真的从盘上消失。
    ///
    /// 反例（1.4.0 之前的行为）：retain 先清掉，合并写又从盘上把同一条读回来，
    /// 于是扫一次复活一次，缓存里永久留着 104 条指向已不存在文件的条目。
    #[test]
    fn pruned_entries_do_not_come_back_from_disk() {
        let path = blank_path("prune");
        let mut old = HashMap::new();
        old.insert("kept.ttf".to_string(), entry());
        old.insert("gone.ttf".to_string(), entry());
        std::fs::write(
            &path,
            serde_json::to_vec(&CacheFile {
                version: CACHE_VERSION,
                entries: old,
            })
            .unwrap(),
        )
        .unwrap();

        let mut cache = cache_at(path.clone());
        cache.entries = match serde_json::from_str::<CacheFile>(
            &std::fs::read_to_string(&path).unwrap(),
        ) {
            Ok(f) => f.entries,
            Err(_) => HashMap::new(),
        };
        // 这一轮只看见 kept.ttf（命中），并新解析了一个 new.ttf
        assert!(cache.get("kept.ttf", 1, 2, FontSource::Managed).is_some());
        cache.put("new.ttf", 3, 4, FontSource::Managed, &[]);
        cache.finish();

        // 落盘在后台线程，轮询等它写出来
        let mut saved: Option<CacheFile> = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(f) = serde_json::from_str::<CacheFile>(&text) {
                    if f.entries.contains_key("new.ttf") {
                        saved = Some(f);
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let saved = saved.expect("缓存没写出来");
        let mut keys: Vec<&str> = saved.entries.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["kept.ttf", "new.ttf"], "gone.ttf 被复活了");
    }

    /// 合并写仍要保住「另一条扫描链」的条目：不在这轮 seen 里、但盘上有的要留下。
    #[test]
    fn merge_keeps_entries_this_session_never_saw() {
        let path = blank_path("merge");
        let mut old = HashMap::new();
        old.insert("other-chain.ttf".to_string(), entry());
        std::fs::write(
            &path,
            serde_json::to_vec(&CacheFile {
                version: CACHE_VERSION,
                entries: old,
            })
            .unwrap(),
        )
        .unwrap();

        // 这一轮只加载到「已经没有任何条目」，等同于另一条链的条目不在 entries 里
        let mut cache = cache_at(path.clone());
        cache.put("mine.ttf", 5, 6, FontSource::Managed, &[]);
        cache.finish();

        let mut saved: Option<CacheFile> = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(f) = serde_json::from_str::<CacheFile>(&text) {
                    if f.entries.contains_key("mine.ttf") {
                        saved = Some(f);
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let saved = saved.expect("缓存没写出来");
        assert!(
            saved.entries.contains_key("other-chain.ttf"),
            "合并写把另一条链的条目抹掉了"
        );
        assert!(saved.entries.contains_key("mine.ttf"));
    }
}
