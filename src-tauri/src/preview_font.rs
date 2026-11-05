//! 「让 WebView2 认得」的预览字体。
//!
//! **原字体文件只读**：本模块只会 `fs::read` 源文件，任何写操作都落在缓存目录里。
//!
//! 有一批字体在库里明明有字，卡片上却只显示「这种格式暂时无法预览」：
//!
//! 1. `.ttc / .otc` 字体集合：Chromium 的 OTS 直接拒收 ttcf 容器
//!    （`OTS parsing error: Invalid TTC version`），哪怕里面每个字面都正常；
//! 2. `cmap` 只有旧编码子表的老字体：Big5 / GBK / ShiftJIS / Mac Roman …
//!    OTS 只认 (0,*) 平台和 (3,0)/(3,1)/(3,10)，其余一律
//!    `cmap: no supported subtables were found`；
//! 3. cmap 里有指到 `numGlyphs` 之外的脏映射；`maxp` 的 maxZones 写成 7；
//!    `head` / `hhea` 版本号写成 2；`post` 版本非法；零长度表；`vmtx` 覆盖不全。
//!
//! 这里按需（前端加载失败时才调）把单个字面抽出来，用系统的代码页把旧编码翻成
//! Unicode，重建一份 (3,1) format 4 + (3,10) format 12 的 cmap，顺手纠正上面那几个
//! 字段，写到缓存目录。字体本身不动，只写缓存副本。
//!
//! 缓存按「目录总大小」封顶，超了删最久没用的那份（按 mtime，用到了会主动 touch）。

use std::fs;
use std::path::{Path, PathBuf};

/// 缓存在 `%APPDATA%/FontManager/preview-cache`
const CACHE_DIR: &str = "preview-cache";
/// 缓存上限。老中文字体单个字面几 MB，给到 384 MB 够用又不会把硬盘吃掉
const CACHE_LIMIT: u64 = 384 * 1024 * 1024;
/// 修复算法的版本号。改了重建逻辑就加一，老的缓存文件自动失效
const CACHE_TAG: &str = "v5";
/// 列表子集算法的版本号。子集的「字符闭包 / loca 布局 / cmap 重建」任何一处变了就加一，
/// 老产物自动失效（缓存 key 里编了它）。
/// S1 → S2：post 降级成 3.0（丢掉按 gid 排的字形名数组，产物小 60%）。
const SUBSET_TAG: &str = "S6";
/// 小于这个体积不走子集：解码本来就快，做子集只是多一次 IPC + 一次磁盘写。
/// 库内 >8MB 的字体有 218 个，它们才是真痛点。
const SUBSET_MIN_BYTES: u64 = 1 << 20;

// ───────────────────────── 二进制读工具 ─────────────────────────

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    let b = d.get(o..o + 2)?;
    Some(u16::from_be_bytes([b[0], b[1]]))
}

fn i16_at(d: &[u8], o: usize) -> Option<i16> {
    let b = d.get(o..o + 2)?;
    Some(i16::from_be_bytes([b[0], b[1]]))
}

fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    let b = d.get(o..o + 4)?;
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn tag_at(d: &[u8], o: usize) -> Option<[u8; 4]> {
    let b = d.get(o..o + 4)?;
    Some([b[0], b[1], b[2], b[3]])
}

/// 字体里的一张表
struct TableRec {
    tag: [u8; 4],
    offset: usize,
    len: usize,
}

/// 读出某个字面（ttc 里第 index 个 sfnt）的表目录
fn tables_of(data: &[u8], sfnt: usize) -> Option<Vec<TableRec>> {
    let count = u16_at(data, sfnt + 4)? as usize;
    if count == 0 || count > 512 {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let rec = sfnt + 12 + i * 16;
        let tag = tag_at(data, rec)?;
        let offset = u32_at(data, rec + 8)? as usize;
        let len = u32_at(data, rec + 12)? as usize;
        if offset.checked_add(len)? > data.len() {
            return None;
        }
        out.push(TableRec { tag, offset, len });
    }
    Some(out)
}

/// 字体里每个字面的 sfnt 偏移。普通字体只有一个，ttc 有多个
fn face_offsets(data: &[u8]) -> Option<Vec<usize>> {
    if data.len() < 12 {
        return None;
    }
    if &data[0..4] == b"ttcf" {
        let count = u32_at(data, 8)? as usize;
        if count == 0 || count > 1024 || 12 + count * 4 > data.len() {
            return None;
        }
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let off = u32_at(data, 12 + i * 4)? as usize;
            if off + 12 > data.len() {
                return None;
            }
            out.push(off);
        }
        Some(out)
    } else {
        Some(vec![0])
    }
}

// ───────────────────────── cmap 读取 ─────────────────────────

struct Subtable {
    platform: u16,
    encoding: u16,
    format: u16,
    offset: usize,
}

fn cmap_subtables(data: &[u8], cmap: usize) -> Vec<Subtable> {
    let mut out = Vec::new();
    let Some(count) = u16_at(data, cmap + 2) else {
        return out;
    };
    for i in 0..count as usize {
        let rec = cmap + 4 + i * 8;
        let (Some(platform), Some(encoding), Some(rel)) = (
            u16_at(data, rec),
            u16_at(data, rec + 2),
            u32_at(data, rec + 4),
        ) else {
            continue;
        };
        let offset = cmap + rel as usize;
        let Some(format) = u16_at(data, offset) else {
            continue;
        };
        out.push(Subtable {
            platform,
            encoding,
            format,
            offset,
        });
    }
    out
}

/// OTS 认的子表：Mac 的 Unicode 平台全收，Windows 平台只收 0 / 1 / 10
fn is_supported(platform: u16, encoding: u16) -> bool {
    platform == 0 || (platform == 3 && matches!(encoding, 0 | 1 | 10))
}

/// 能直接当 Unicode 用的子表优先级，越靠前越完整。
///
/// 注意 `(0,5)` / format 14 是「变体选择器」，里面没有任何字符→字形映射，
/// 而且常常排在 cmap 的第一个——现代 Windows 字体（Yu Gothic / MS Gothic / 新細明體）
/// 都是这个顺序，必须跳过，否则会误判成「这块字体没有映射」。
fn unicode_rank(platform: u16, encoding: u16, format: u16) -> Option<u8> {
    if matches!(format, 8 | 10 | 14) {
        return None;
    }
    match (platform, encoding) {
        (3, 10) => Some(0),
        (3, 1) => Some(1),
        (0, 6) => Some(2),
        (0, 4) => Some(3),
        (0, 3) => Some(4),
        (0, 1) | (0, 0) => Some(5),
        (0, 2) => Some(6),
        (3, 0) => Some(7),
        _ => None,
    }
}

/// 旧编码子表在这份字体里的优先级（越靠前越可信）
fn subtable_rank(platform: u16, encoding: u16) -> Option<u8> {
    match (platform, encoding) {
        (3, 3) => Some(0),  // Windows PRC (GBK)
        (3, 4) => Some(1),  // Windows Big5
        (3, 2) => Some(2),  // Windows ShiftJIS
        (3, 5) => Some(3),  // Windows Wansung
        (3, 6) => Some(4),  // Windows Johab
        (1, 2) => Some(5),  // Mac 繁体中文
        (1, 25) => Some(6), // Mac 简体中文
        (1, 1) => Some(7),  // Mac 日文
        (1, 0) => Some(8),  // Mac Roman
        _ => None,
    }
}

/// 把子表解成 (原始编码, 字形号)。格式 0/2/4/6/12/13 覆盖了实际会遇到的旧字体
fn parse_subtable(data: &[u8], sub: &Subtable) -> Vec<(u32, u16)> {
    let off = sub.offset;
    let mut out: Vec<(u32, u16)> = Vec::new();
    match sub.format {
        0 => {
            for code in 0u32..256 {
                let Some(&gid) = data.get(off + 6 + code as usize) else {
                    continue;
                };
                if gid != 0 {
                    out.push((code, gid as u16));
                }
            }
        }
        2 => {
            // 高字节映射表：CJK 老字体最常见的格式。
            // subHeaderKeys[高字节] 给出该高字节对应的 SubHeader 序号（单位是 8 字节），
            // 序号 0 表示这个码是单字节（低字节直接就是码值）。
            let keys_at = off + 6;
            let sub_base = keys_at + 512;
            for hi in 0..256usize {
                let Some(k) = u16_at(data, keys_at + hi * 2) else {
                    continue;
                };
                let k = k as usize / 8;
                let head = sub_base + k * 8;
                let (Some(first), Some(count), Some(delta), Some(range_off)) = (
                    u16_at(data, head),
                    u16_at(data, head + 2),
                    i16_at(data, head + 4),
                    u16_at(data, head + 6),
                ) else {
                    continue;
                };
                // idRangeOffset 是相对「本 SubHeader 的 idRangeOffset 字段」的偏移
                let glyph_at = head + 6 + range_off as usize;
                for j in 0..count as u32 {
                    let lo = first as u32 + j;
                    if lo >= 256 {
                        break;
                    }
                    let code = if k == 0 { lo } else { ((hi as u32) << 8) | lo };
                    let gid = if range_off == 0 {
                        (lo as i32 + delta as i32) as u32 & 0xFFFF
                    } else {
                        match u16_at(data, glyph_at + j as usize * 2) {
                            Some(0) | None => 0,
                            Some(g) => ((g as i32 + delta as i32) as u32) & 0xFFFF,
                        }
                    };
                    if gid != 0 {
                        out.push((code, gid as u16));
                    }
                }
            }
        }
        4 => {
            let Some(seg_x2) = u16_at(data, off + 6) else {
                return out;
            };
            let seg = seg_x2 as usize / 2;
            let end_at = off + 14;
            let start_at = end_at + seg_x2 as usize + 2;
            let delta_at = start_at + seg_x2 as usize;
            let range_at = delta_at + seg_x2 as usize;
            for i in 0..seg {
                let (Some(end), Some(start), Some(delta), Some(range)) = (
                    u16_at(data, end_at + i * 2),
                    u16_at(data, start_at + i * 2),
                    i16_at(data, delta_at + i * 2),
                    u16_at(data, range_at + i * 2),
                ) else {
                    continue;
                };
                if start > end {
                    continue;
                }
                for code in start..=end {
                    let gid = if range == 0 {
                        (code as i32 + delta as i32) as u32 & 0xFFFF
                    } else {
                        let p = range_at + i * 2 + range as usize + (code - start) as usize * 2;
                        match u16_at(data, p) {
                            Some(0) | None => 0,
                            Some(g) => ((g as i32 + delta as i32) as u32) & 0xFFFF,
                        }
                    };
                    if gid != 0 {
                        out.push((code as u32, gid as u16));
                    }
                }
            }
        }
        6 => {
            let (Some(first), Some(count)) = (u16_at(data, off + 6), u16_at(data, off + 8)) else {
                return out;
            };
            for j in 0..count as usize {
                let Some(gid) = u16_at(data, off + 10 + j * 2) else {
                    continue;
                };
                if gid != 0 {
                    out.push((first as u32 + j as u32, gid));
                }
            }
        }
        12 | 13 => {
            let Some(groups) = u32_at(data, off + 12) else {
                return out;
            };
            for g in 0..groups.min(100_000) as usize {
                let p = off + 16 + g * 12;
                let (Some(start), Some(end), Some(gid)) =
                    (u32_at(data, p), u32_at(data, p + 4), u32_at(data, p + 8))
                else {
                    continue;
                };
                if end < start || end - start > 0x10FFFF {
                    continue;
                }
                for code in start..=end {
                    let g = if sub.format == 12 {
                        gid + (code - start)
                    } else {
                        gid
                    };
                    if g != 0 && g <= 0xFFFF {
                        out.push((code, g as u16));
                    }
                }
            }
        }
        _ => {}
    }
    out
}

// ───────────────────────── 旧编码 → Unicode ─────────────────────────

#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    extern "system" {
        /// 系统代码页转换。返回写入的 UTF-16 码元数，0 表示这个码页不支持或字节无效
        pub fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            src: *const u8,
            src_len: i32,
            dst: *mut u16,
            dst_len: i32,
        ) -> i32;
    }
}

fn code_page_for(platform: u16, encoding: u16) -> Option<u32> {
    match (platform, encoding) {
        (3, 2) => Some(932),   // ShiftJIS
        (3, 3) => Some(936),   // GBK
        (3, 4) => Some(950),   // Big5
        (3, 5) => Some(949),   // Wansung
        (3, 6) => Some(1361),  // Johab
        (1, 0) => Some(10000), // Mac Roman
        (1, 1) => Some(10001), // Mac 日文（系统不认识就整体跳过）
        (1, 2) => Some(10002), // Mac 繁体中文
        (1, 25) => Some(10008), // Mac 简体中文
        _ => None,
    }
}

/// 旧编码的码值换成 Unicode 码点；码值 ≤ 0xFF 按单字节，否则按双字节
fn legacy_to_unicode(cp: u32, code: u32) -> Option<u32> {
    #[cfg(windows)]
    {
        let (bytes, len) = if code <= 0xFF {
            ([code as u8, 0u8], 1i32)
        } else {
            ([(code >> 8) as u8, (code & 0xFF) as u8], 2i32)
        };
        let mut out = [0u16; 4];
        let n = unsafe {
            sys::MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, out.as_mut_ptr(), 4)
        };
        // 只接受「一个字符」的映射，多字符（组合字符）和失败都丢掉
        if n == 1 {
            Some(out[0] as u32)
        } else {
            None
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (cp, code);
        None
    }
}

// ───────────────────────── 新 cmap 生成 ─────────────────────────

fn push_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_be_bytes());
}

fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}

/// format 4：只放 BMP。连续码点成段，段内字形连续就用 idDelta，否则挂字形数组
fn build_format4(pairs: &[(u32, u16)]) -> Vec<u8> {
    let bmp: Vec<(u32, u16)> = pairs.iter().copied().filter(|(c, _)| *c < 0xFFFF).collect();

    // 先切段：码点连续的算一段
    let mut segs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < bmp.len() {
        let mut j = i;
        while j + 1 < bmp.len() && bmp[j + 1].0 == bmp[j].0 + 1 {
            j += 1;
        }
        segs.push((i, j));
        i = j + 1;
    }
    let seg_count = segs.len() + 1; // 末尾 0xFFFF 哨兵

    // 每段：能用 idDelta 就用，不行就记下要放进字形数组的范围
    let mut deltas: Vec<(u16, u16, u16, Option<(usize, usize)>)> = Vec::new();
    for &(a, b) in &segs {
        let delta = (bmp[a].1 as i32 - bmp[a].0 as i32) & 0xFFFF;
        let uniform = (a..=b).all(|k| ((bmp[k].1 as i32 - bmp[k].0 as i32) & 0xFFFF) == delta);
        deltas.push((
            bmp[a].0 as u16,
            bmp[b].0 as u16,
            delta as u16,
            if uniform { None } else { Some((a, b)) },
        ));
    }
    deltas.push((0xFFFF, 0xFFFF, 1, None));

    let head_len = 16 + seg_count * 8;
    // 先算出每个字形数组块的绝对位置（相对子表开头）
    let mut glyph_ids: Vec<u16> = Vec::new();
    let mut range_offsets: Vec<u16> = Vec::new();
    for (_, _, _, arr) in &deltas {
        match arr {
            Some((a, b)) => {
                let target = head_len + glyph_ids.len() * 2;
                range_offsets.push(target as u16);
                for k in *a..=*b {
                    glyph_ids.push(bmp[k].1);
                }
            }
            None => range_offsets.push(0),
        }
    }

    let mut out = Vec::with_capacity(head_len + glyph_ids.len() * 2);
    let length = (head_len + glyph_ids.len() * 2) as u16;
    let mut entry_selector = 0u16;
    while (1u16 << (entry_selector + 1)) <= seg_count as u16 {
        entry_selector += 1;
    }
    let search_range = (1u16 << entry_selector) * 2;
    push_u16(&mut out, 4);
    push_u16(&mut out, length);
    push_u16(&mut out, 0);
    push_u16(&mut out, (seg_count * 2) as u16);
    push_u16(&mut out, search_range);
    push_u16(&mut out, entry_selector);
    push_u16(&mut out, (seg_count * 2) as u16 - search_range);

    for (_, end, _, _) in &deltas {
        push_u16(&mut out, *end);
    }
    push_u16(&mut out, 0); // reservedPad
    for (start, _, _, _) in &deltas {
        push_u16(&mut out, *start);
    }
    for (_, _, delta, _) in &deltas {
        push_u16(&mut out, *delta);
    }
    // idRangeOffset 是「相对本字段地址」的偏移
    let ro_start = out.len();
    for (i, target) in range_offsets.iter().enumerate() {
        let value = if *target == 0 {
            0u16
        } else {
            (*target).wrapping_sub((ro_start + i * 2) as u16)
        };
        push_u16(&mut out, value);
    }
    for gid in glyph_ids {
        push_u16(&mut out, gid);
    }
    out
}

/// format 12：覆盖全部码点，只按「码点连续且字形连续」分组，组数少、体积小
fn build_format12(pairs: &[(u32, u16)]) -> Vec<u8> {
    let mut groups: Vec<(u32, u32, u32)> = Vec::new();
    let mut i = 0;
    while i < pairs.len() {
        let mut j = i;
        while j + 1 < pairs.len()
            && pairs[j + 1].0 == pairs[j].0 + 1
            && pairs[j + 1].1 == pairs[j].1 + 1
        {
            j += 1;
        }
        groups.push((pairs[i].0, pairs[j].0, pairs[i].1 as u32));
        i = j + 1;
    }
    let mut out = Vec::with_capacity(16 + groups.len() * 12);
    push_u16(&mut out, 12);
    push_u16(&mut out, 0);
    push_u32(&mut out, (16 + groups.len() * 12) as u32);
    push_u32(&mut out, 0);
    push_u32(&mut out, groups.len() as u32);
    for (start, end, gid) in groups {
        push_u32(&mut out, start);
        push_u32(&mut out, end);
        push_u32(&mut out, gid);
    }
    out
}

fn build_cmap(pairs: &[(u32, u16)]) -> Vec<u8> {
    let f4 = build_format4(pairs);
    // format 4 的长度字段只有 16 位；字多到放不下就只留 (3,10) format 12，
    // 硬塞会被 OTS 判「bad glyph id offset」整份拒掉
    let has4 = f4.len() <= 0xFFFF;
    let slots = if has4 { 2u16 } else { 1 };
    let mut out = Vec::with_capacity(4 + slots as usize * 8 + f4.len() + 64);
    push_u16(&mut out, 0); // version
    push_u16(&mut out, slots);
    let mut cursor = 4 + slots as usize * 8;
    if has4 {
        push_u16(&mut out, 3);
        push_u16(&mut out, 1);
        push_u32(&mut out, cursor as u32);
        cursor += f4.len();
    }
    let f12 = build_format12(pairs);
    push_u16(&mut out, 3);
    push_u16(&mut out, 10);
    push_u32(&mut out, cursor as u32);
    if has4 {
        out.extend_from_slice(&f4);
    }
    out.extend_from_slice(&f12);
    out
}

// ───────────────────────── 字体重建 ─────────────────────────

/// 把字体的 cmap 归一成「Unicode 码点 → gid」。
///
/// 优先 Unicode 子表；没有就按旧编码子表 + 系统代码页翻。脏映射（gid 越界 / 0）
/// 一律滤掉 —— OTS 会因为 `cmap: Range glyph reference too high` 整份拒收。
///
/// 修复通道和列表子集通道都用它，两边的「认字集」必须完全一致，否则会出现
/// 「卡片能预览但子集里查不到这个字」的分裂。
fn unicode_pairs(
    data: &[u8],
    tables: &[TableRec],
) -> Option<std::collections::BTreeMap<u32, u16>> {
    let cmap_rec = tables.iter().find(|t| &t.tag == b"cmap")?;
    let subs = cmap_subtables(data, cmap_rec.offset);
    if subs.is_empty() {
        return None;
    }
    // 挑一个子表：有 Unicode 子表就直接用（码值就是码点），
    // 否则挑一个旧编码子表，靠系统代码页翻成 Unicode。
    let mut pick: Option<(&Subtable, Option<u32>)> = None;
    let mut best_rank = u8::MAX;
    for sub in &subs {
        if let Some(rank) = unicode_rank(sub.platform, sub.encoding, sub.format) {
            if rank < best_rank {
                best_rank = rank;
                pick = Some((sub, None));
            }
        }
    }
    if pick.is_none() {
        let mut best: Option<&Subtable> = None;
        for sub in &subs {
            let Some(rank) = subtable_rank(sub.platform, sub.encoding) else {
                continue;
            };
            match best {
                Some(b) if subtable_rank(b.platform, b.encoding).unwrap_or(99) <= rank => {}
                _ => best = Some(sub),
            }
        }
        if let Some(best) = best {
            // 认不出对应代码页就别硬当 Unicode 用，那会得到一表乱码
            if let Some(cp) = code_page_for(best.platform, best.encoding) {
                pick = Some((best, Some(cp)));
            }
        }
    }
    let (sub, code_page) = pick?;
    let raw = parse_subtable(data, sub);
    if raw.is_empty() {
        return None;
    }
    let num_glyphs = tables
        .iter()
        .find(|t| &t.tag == b"maxp")
        .and_then(|t| u16_at(data, t.offset + 4))
        .unwrap_or(u16::MAX);
    // 多个旧编码可能落到同一个 Unicode，必须去重，否则重建的 cmap 段会重叠
    let mut map: std::collections::BTreeMap<u32, u16> = std::collections::BTreeMap::new();
    for (code, gid) in raw {
        if gid == 0 || gid >= num_glyphs {
            continue;
        }
        let unicode = match code_page {
            Some(cp) => match legacy_to_unicode(cp, code) {
                Some(u) => u,
                None => continue,
            },
            None => code,
        };
        if unicode <= 0x10FFFF && !map.contains_key(&unicode) {
            map.insert(unicode, gid);
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

fn checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut i = 0;
    while i < data.len() {
        let mut word = [0u8; 4];
        let take = (data.len() - i).min(4);
        word[..take].copy_from_slice(&data[i..i + take]);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
        i += 4;
    }
    sum
}

/// 用给定的 cmap 重新拼一个单字面的 sfnt。
///
/// `overrides`：按 tag 整表替换（列表子集路线用它换掉 glyf / loca / head）。
/// `None` 时行为与 0.9.9 系列完全一致。
fn rebuild(
    data: &[u8],
    sfnt: usize,
    tables: &[TableRec],
    new_cmap: Option<&[u8]>,
    strip_hinting: bool,
    overrides: Option<&std::collections::HashMap<[u8; 4], Vec<u8>>>,
) -> Option<Vec<u8>> {
    // 收表：丢掉 DSIG（老字体的签名表经常是坏的，OTS 会因此整份拒收）、
    // 零长度表、竖向度量表（OTS 会检查 vmtx 是否覆盖全部字形，老字体常常对不上；
    // 横向预览完全用不到），cmap 换成新的
    // 修 loca / post 要用到：字形数与 loca 的条目宽度
    let num_glyphs = tables
        .iter()
        .find(|t| &t.tag == b"maxp")
        .and_then(|t| u16_at(data, t.offset + 4))
        .unwrap_or(0);
    // head 可能被 overrides 换掉（列表子集在 loca 切成 long 时改 indexToLocFormat），
    // 必须认替换后的那份，否则下面按旧格式算 loca 期望长度会把新 loca 截断。
    let loca_long = match overrides.and_then(|m| m.get(b"head")) {
        Some(h) => i16_at(h, 50).unwrap_or(0) != 0,
        None => {
            tables
                .iter()
                .find(|t| &t.tag == b"head")
                .and_then(|t| i16_at(data, t.offset + 50))
                .unwrap_or(0)
                != 0
        }
    };
    let mut items: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    let mut saw_cmap = false;
    for t in tables {
        if &t.tag == b"DSIG" || &t.tag == b"vmtx" || &t.tag == b"vhea" || &t.tag == b"VORG" {
            continue;
        }
        // 第二档修复：连提示程序一起丢掉。有的老字体 fpgm/prep 里是一堆坏字节码，
        // OTS 不报具体原因就是整份拒收（652-CAI978 那类），去掉提示完全不影响预览。
        if strip_hinting && matches!(&t.tag, b"fpgm" | b"prep" | b"cvt ") {
            continue;
        }
        if t.len == 0 {
            continue;
        }
        if &t.tag == b"cmap" {
            saw_cmap = true;
            match new_cmap {
                Some(c) => items.push((t.tag, c.to_vec())),
                None => items.push((t.tag, data[t.offset..t.offset + t.len].to_vec())),
            }
            continue;
        }
        // 列表子集路线：整表替换（glyf / loca / head）。放在 cmap 之后，
        // 因为 cmap 有自己的 new_cmap 通道。
        if let Some(ov) = overrides.and_then(|m| m.get(&t.tag)) {
            items.push((t.tag, ov.clone()));
            continue;
        }
        items.push((t.tag, data[t.offset..t.offset + t.len].to_vec()));
    }
    if !saw_cmap {
        items.push((*b"cmap", new_cmap?.to_vec()));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let count = items.len();
    let mut entry_selector = 0u16;
    while (1u16 << (entry_selector + 1)) <= count as u16 {
        entry_selector += 1;
    }
    let search_range = (1u16 << entry_selector) * 16;

    let mut dir: Vec<([u8; 4], u32, u32, u32)> = Vec::with_capacity(count);
    let mut body: Vec<u8> = Vec::with_capacity(data.len().min(64 * 1024 * 1024));
    let mut pos = 12 + count * 16;
    let mut head_rel: Option<usize> = None;
    for (tag, raw) in items.iter_mut() {
        if tag == b"head" && raw.len() >= 12 {
            // head 的 checkSumAdjustment 先清零，整份拼完再补
            raw[8..12].copy_from_slice(&[0, 0, 0, 0]);
        }
        if tag == b"post" {
            // post 版本只有 1.0 / 2.0 / 2.5 / 3.0 合法，写成 0x03000000 这类会被 OTS 拒收。
            // 但 OTS 要求 post 必须存在，所以不能删，换成最小的 3.0（32 字节，无字形名）。
            let version = if raw.len() >= 4 {
                u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
            } else {
                0
            };
            // 2.0 还要求「字形名数量 == maxp.numGlyphs」，老字体经常对不上
            // （330-CAI978 写成 251、实际 232 个字形），OTS 直接拒收。
            // 预览用不到字形名，统一降级成 3.0 最稳。
            let bad_count = version == 0x0002_0000
                && u16_at(raw, 32).map(|n| n as u32 != num_glyphs as u32).unwrap_or(true);
            if bad_count || !matches!(version, 0x0001_0000 | 0x0002_0000 | 0x0002_5000 | 0x0003_0000)
            {
                let mut minimal = vec![0u8; 32];
                // version 0x00030000：只留 32 字节固定头，没有字形名
                minimal[1] = 3;
                *raw = minimal;
            }
        }
        if tag == b"head" && raw.len() >= 54 {
            // 老字体里 head 的版本号/魔数/unitsPerEm 都可能是脏的，OTS 会因此拒收；
            // 这三个字段与字形数据无关，纠正成规范值即可。
            raw[0..2].copy_from_slice(&1u16.to_be_bytes());
            if raw[12..16] != [0x5F, 0x0F, 0x3C, 0xF5] {
                raw[12..16].copy_from_slice(&[0x5F, 0x0F, 0x3C, 0xF5]);
            }
            let upem = u16::from_be_bytes([raw[18], raw[19]]);
            if !(16..=16384).contains(&upem) {
                raw[18..20].copy_from_slice(&1024u16.to_be_bytes());
            }
        }
        if tag == b"hhea" && raw.len() >= 36 {
            // hhea 的 majorVersion 同样有写成 2 的老字体，OTS 会拒收
            raw[0..2].copy_from_slice(&1u16.to_be_bytes());
        }
        if tag == b"hhea" && raw.len() >= 36 {
            // hhea 的 majorVersion 同样有写成 2 的老字体，OTS 会拒收
            raw[0..2].copy_from_slice(&1u16.to_be_bytes());
        }
        if tag == b"loca" && num_glyphs > 0 {
            // OTS 要求 loca 长度恰好是 (numGlyphs+1) × 2/4；多出来的字节会让它整份拒收
            let expect = (num_glyphs as usize + 1) * if loca_long { 4 } else { 2 };
            if raw.len() != expect {
                raw.resize(expect, 0);
            }
        }
        if tag == b"cvt " && raw.len() % 2 != 0 {
            // OTS 按 u16 读 cvt，奇数长度报错
            raw.pop();
        }
        if tag == b"maxp" && raw.len() >= 16 && raw[0..4] == [0, 1, 0, 0] {
            // 有些老 MS 字体把 maxZones 写成 7（规范只允许 1 / 2），OTS 直接判
            // 「maxp: Bad maxZones」把整份字体拒掉。这个字段只是光栅化提示，改成 1 无害。
            let zones = u16::from_be_bytes([raw[14], raw[15]]);
            if zones > 2 {
                raw[14..16].copy_from_slice(&1u16.to_be_bytes());
            }
        }
        let cs = checksum(raw);
        if tag == b"head" {
            head_rel = Some(pos);
        }
        dir.push((*tag, cs, pos as u32, raw.len() as u32));
        body.extend_from_slice(raw);
        let pad = (4 - raw.len() % 4) % 4;
        body.extend(std::iter::repeat(0u8).take(pad));
        pos += raw.len() + pad;
    }

    let mut out = Vec::with_capacity(12 + count * 16 + body.len());
    out.extend_from_slice(&data[sfnt..sfnt + 4]);
    push_u16(&mut out, count as u16);
    push_u16(&mut out, search_range);
    push_u16(&mut out, entry_selector);
    push_u16(&mut out, count as u16 * 16 - search_range);
    for (tag, cs, offset, len) in &dir {
        out.extend_from_slice(tag);
        push_u32(&mut out, *cs);
        push_u32(&mut out, *offset);
        push_u32(&mut out, *len);
    }
    out.extend_from_slice(&body);

    if let Some(rel) = head_rel {
        let total = checksum(&out);
        let adj = 0xB1B0_AFBAu32.wrapping_sub(total);
        let at = rel + 8;
        if at + 4 <= out.len() {
            out[at..at + 4].copy_from_slice(&adj.to_be_bytes());
        }
    }
    Some(out)
}

// ───────────────────────── 对外入口 ─────────────────────────

fn fnv1a(seed: u64, bytes: &[u8]) -> u64 {
    let mut h = seed;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// 预览缓存的目录（启动时要用它给 asset 协议放行）
pub fn cache_root() -> Option<PathBuf> {
    cache_dir()
}

fn cache_dir() -> Option<PathBuf> {
    let dir = dirs::data_dir()?.join("FontManager").join(CACHE_DIR);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 超出上限就删最久没用的缓存文件（用到了会 touch mtime，所以等价于 LRU）
fn trim_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for e in entries.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let modified = md.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += md.len();
        files.push((modified, md.len(), e.path()));
    }
    if total <= CACHE_LIMIT {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

fn touch(path: &Path) {
    if let Ok(f) = fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// 这个字面浏览器是不是自己就能打开（普通字体 + cmap 有受支持的子表）
/// OTS 一定会拒收、但**从表目录上看不出来**的结构问题。
///
/// 这些字体在库里能解析、字形也在，卡片上却只显示「这种格式暂时无法预览」——
/// 因为 `browser_can_load` 原来只检查 cmap 子表平台，认为「浏览器能加载」，
/// 于是根本不走修复流程，最后 WebView2 的 OTS 把它们整份拒掉。
///
/// 已经踩实的三种（0.9.8-1）：
///   1. `loca` 长度和「字形数 × 2/4」对不上（101PUPS.TTF 多 2 字节）；
///   2. `post` 是 2.0 但字形名数量和 maxp.numGlyphs 不符（330-CAI978：251 vs 232）；
///   3. `cvt ` 长度是奇数（OTS 按 u16 读，奇数长度直接报错）。
pub fn structural_problem(data: &[u8]) -> Option<&'static str> {
    let sfnt = 0usize;
    if data.len() < 12 {
        return None;
    }
    let tables = tables_of(data, sfnt)?;
    let find = |tag: &[u8; 4]| tables.iter().find(|t| &t.tag == tag);
    let num_glyphs = find(b"maxp")
        .and_then(|t| u16_at(data, t.offset + 4))
        .unwrap_or(0);
    if num_glyphs == 0 {
        return None;
    }
    // loca：长度必须恰好是 (numGlyphs + 1) * (2 或 4)
    if let (Some(head), Some(loca)) = (find(b"head"), find(b"loca")) {
        let long_fmt = i16_at(data, head.offset + 50).unwrap_or(0) != 0;
        let expect = (num_glyphs as usize + 1) * if long_fmt { 4 } else { 2 };
        if loca.len as usize != expect {
            return Some("loca 长度与字形数不符");
        }
    }
    // post 2.0：字形名数量必须等于 numGlyphs
    if let Some(post) = find(b"post") {
        let version = u32::from_be_bytes([
            data.get(post.offset).copied().unwrap_or(0),
            data.get(post.offset + 1).copied().unwrap_or(0),
            data.get(post.offset + 2).copied().unwrap_or(0),
            data.get(post.offset + 3).copied().unwrap_or(0),
        ]);
        if version == 0x0002_0000 {
            if let Some(names) = u16_at(data, post.offset + 32) {
                if names != num_glyphs {
                    return Some("post 字形名数量与字形数不符");
                }
            }
        }
    }
    // cvt：OTS 按 u16 读，长度必须是偶数
    if let Some(cvt) = find(b"cvt ") {
        if cvt.len % 2 != 0 {
            return Some("cvt 表长度是奇数");
        }
    }
    None
}

/// 这份字体**能不能**被修复成浏览器认得的副本。
///
/// 判据就是修复流程自己能不能走通：表目录读得出来、cmap 里至少有一个能用
/// （Unicode 子表，或者认得出代码页的旧编码子表）。
/// 修不好 = 在软件里永远显示不出来，才算「真损坏」。
pub fn repairable(data: &[u8]) -> bool {
    let Some(tables) = tables_of(data, 0) else {
        return false;
    };
    let Some(cmap) = tables.iter().find(|t| &t.tag == b"cmap") else {
        return false;
    };
    let subs = cmap_subtables(data, cmap.offset);
    subs.iter()
        .any(|s| unicode_rank(s.platform, s.encoding, s.format).is_some())
        || subs
            .iter()
            .any(|s| code_page_for(s.platform, s.encoding).is_some())
}

fn browser_can_load(data: &[u8], sfnt: usize, is_collection: bool) -> bool {
    if is_collection {
        return false;
    }
    // 结构有问题的一律送去修复（修不了就当普通字体，行为跟以前一致）
    if structural_problem(data).is_some() {
        return false;
    }
    let Some(tables) = tables_of(data, sfnt) else {
        return true; // 读不出来就别多事，保持原样
    };
    let Some(cmap) = tables.iter().find(|t| &t.tag == b"cmap") else {
        return true;
    };
    let subs = cmap_subtables(data, cmap.offset);
    if subs.is_empty() {
        return true;
    }
    subs.iter().any(|s| is_supported(s.platform, s.encoding))
}

/// 给这个字面准备一份浏览器能加载的副本；不需要 / 做不到时返回 None
/// `level`：0 = 只在「浏览器明显认不了」时修（默认）；1 = 强制重建；
/// 2 = 强制重建并去掉提示程序（fpgm / prep / cvt）—— 兜住 OTS 不说明原因的拒收。
pub fn ensure_preview_font(path: &Path, face_index: u32, level: u8) -> Option<PathBuf> {
    // 先按 mtime + 大小算缓存名，命中就直接返回——TTC 动辄上百 MB，能省一次整读
    let md = fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key = fnv1a(0xCBF2_9CE4_8422_2325, path.to_string_lossy().as_bytes());
    let key = fnv1a(key, &mtime.to_be_bytes());
    let key = fnv1a(key, &md.len().to_be_bytes());
    let key = fnv1a(key, &(face_index as u64).to_be_bytes());
    let dir = cache_dir()?;
    for ext in ["ttf", "otf"] {
        let hit = dir.join(format!("{CACHE_TAG}-L{level}-{key:016x}.{ext}"));
        if hit.exists() {
            touch(&hit);
            return Some(hit);
        }
    }

    let data = fs::read(path).ok()?;
    let offsets = face_offsets(&data)?;
    let index = (face_index as usize).min(offsets.len().saturating_sub(1));
    let sfnt = *offsets.get(index)?;
    let is_collection = &data[0..4] == b"ttcf";
    // level 0 才做「看起来能加载就别动」的短路；失败重试时（1/2）一律重建
    if level == 0 && browser_can_load(&data, sfnt, is_collection) {
        return None;
    }
    let ext = if &data[sfnt..sfnt + 4] == b"OTTO" { "otf" } else { "ttf" };
    let target = dir.join(format!("{CACHE_TAG}-L{level}-{key:016x}.{ext}"));

    let tables = tables_of(&data, sfnt)?;
    let map = unicode_pairs(&data, &tables)?;
    let pairs: Vec<(u32, u16)> = map.into_iter().collect();
    let cmap = build_cmap(&pairs);
    let rebuilt = rebuild(&data, sfnt, &tables, Some(&cmap), level >= 2, None)?;

    // 先写临时文件再改名，避免并发下读到半个文件
    let tmp = dir.join(format!(".{CACHE_TAG}-{key:016x}.{}.tmp", std::process::id()));
    fs::write(&tmp, &rebuilt).ok()?;
    if fs::rename(&tmp, &target).is_err() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    trim_cache(&dir);
    Some(target)
}

// ─────────────── 列表专用子集（保留 GID，不重编号） ───────────────
//
// 卡片和速览条目只渲染十几个字符，却要为它解码整个字体：库内 >8MB 的字体有 218 个，
// 一个中文大盘字解一次几百毫秒。这里把「非目标字形的 glyf 数据」丢掉 ——
// **保留原 GID 不重编号**，从而绕开重编号的全部难点（复合字形引用、GSUB/GPOS 索引、
// hmtx/post 对齐），实测产物只有原大的 0.65%~4.20%。
//
// 两条边界是有意保守的：
//   1. 只做 glyf 路线（TTF）。CFF/OTF 要裁 charstrings 得解析 CFF INDEX，风险与收益不成比例；
//      TTC 容器 OTS 本来就不收（它走修复通道）。这些一律 None → 调用方回退完整链路。
//   2. 可变字体（fvar）不做。gvar/HVAR 与 gid 强耦合，动 glyf 会让变体失效。

/// 复合字形里直接引用的 gid（不递归，调用方用队列展开）
fn composite_gids(data: &[u8], glyf_off: usize, start: usize, end: usize) -> Vec<u16> {
    let mut out = Vec::new();
    // 字形头 10 字节：numberOfContours(int16) + xMin/yMin/xMax/yMax
    if end < start + 10 {
        return out;
    }
    let Some(nc) = i16_at(data, glyf_off + start) else {
        return out;
    };
    if nc >= 0 {
        return out; // 简单字形，没有组件
    }
    let mut p = start + 10;
    while p + 4 <= end {
        let (Some(flags), Some(gid)) =
            (u16_at(data, glyf_off + p), u16_at(data, glyf_off + p + 2))
        else {
            break;
        };
        out.push(gid);
        p += 4;
        // ARG_1_AND_2_ARE_WORDS
        p += if flags & 0x0001 != 0 { 4 } else { 2 };
        if flags & 0x0008 != 0 {
            p += 2; // WE_HAVE_A_SCALE
        } else if flags & 0x0040 != 0 {
            p += 4; // WE_HAVE_AN_X_AND_Y_SCALE
        } else if flags & 0x0080 != 0 {
            p += 8; // WE_HAVE_A_TWO_BY_TWO
        }
        if flags & 0x0020 == 0 {
            break; // MORE_COMPONENTS
        }
    }
    out
}

/// 读 loca：返回每个 gid 的字节偏移（short 格式的偏移值要乘 2 才是字节）
fn read_loca(data: &[u8], tables: &[TableRec], num_glyphs: u16) -> Option<(Vec<u32>, bool)> {
    let head = tables.iter().find(|t| &t.tag == b"head")?;
    let loca = tables.iter().find(|t| &t.tag == b"loca")?;
    let long = i16_at(data, head.offset + 50)? != 0;
    let n = num_glyphs as usize;
    let need = n.checked_add(1)?.checked_mul(if long { 4 } else { 2 })?;
    if loca.len < need {
        return None; // 表不全就别猜，交给修复通道
    }
    let mut out = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let v = if long {
            u32_at(data, loca.offset + i * 4)?
        } else {
            u16_at(data, loca.offset + i * 2)? as u32 * 2
        };
        out.push(v);
    }
    Some((out, long))
}

/// 目标字符的 gid 闭包：种子 ∪ 复合字形递归引用 ∪ .notdef
fn glyph_closure(
    data: &[u8],
    glyf_off: usize,
    glyf_len: usize,
    loca: &[u32],
    seeds: &[u16],
    num_glyphs: u16,
) -> std::collections::HashSet<u16> {
    use std::collections::{HashSet, VecDeque};
    let n = num_glyphs as usize;
    let mut keep: HashSet<u16> = HashSet::new();
    let mut queue: VecDeque<u16> = VecDeque::with_capacity(seeds.len() + 1);
    queue.push_back(0); // .notdef 必须留：OTS 和渲染器都拿它当兜底
    queue.extend(seeds.iter().copied());
    while let Some(g) = queue.pop_front() {
        let gi = g as usize;
        if gi >= n || gi + 1 >= loca.len() {
            continue;
        }
        if !keep.insert(g) {
            continue;
        }
        let start = (loca[gi] as usize).min(glyf_len);
        let end = (loca[gi + 1] as usize).min(glyf_len);
        for c in composite_gids(data, glyf_off, start, end) {
            if (c as usize) < n && !keep.contains(&c) {
                queue.push_back(c);
            }
        }
    }
    keep
}

/// 拼新的 glyf + loca。保留的 gid 原样搬，其余长度为 0（空轮廓，不是删除 gid）
fn build_subset_glyf(
    data: &[u8],
    glyf_off: usize,
    glyf_len: usize,
    loca: &[u32],
    keep: &std::collections::HashSet<u16>,
    num_glyphs: u16,
) -> Option<(Vec<u8>, Vec<u8>, bool)> {
    let n = num_glyphs as usize;
    let mut glyf: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::with_capacity(n + 1);
    offsets.push(0);
    for g in 0..n {
        if keep.contains(&(g as u16)) {
            let start = (*loca.get(g)? as usize).min(glyf_len);
            let end = (*loca.get(g + 1)? as usize).min(glyf_len);
            if end > start {
                glyf.extend_from_slice(data.get(glyf_off + start..glyf_off + end)?);
                // 4 字节对齐：short loca 的偏移必须是偶数
                let pad = (4 - glyf.len() % 4) % 4;
                glyf.extend(std::iter::repeat(0u8).take(pad));
            }
        }
        offsets.push(glyf.len() as u32);
    }
    // short loca 用 u16 存「偏移 / 2」，上限 0x1FFFE；超了必须切 long
    let long = glyf.len() > 0x1FFFE;
    let mut out_loca: Vec<u8> = Vec::with_capacity((n + 1) * if long { 4 } else { 2 });
    for &o in &offsets {
        if long {
            push_u32(&mut out_loca, o);
        } else {
            push_u16(&mut out_loca, (o / 2) as u16);
        }
    }
    Some((glyf, out_loca, long))
}

/// 给「列表卡片 / 速览条目」生成只含 `chars` 的字体副本。
///
/// 返回 `(产物路径, 产物字节数)`。**字节数是给前端 LRU 记账用的** ——
/// 常驻渲染进程的是产物，不是原文件；按 `face.fileSize` 记账会把预算虚增几十倍，
/// 「160MB 能装更多字面」这条推理也就不成立了（交接文档 §12.3 坑①）。
///
/// 返回 `None` 表示这条路不适合这份字体（CFF / TTC / 可变字体 / 体积本来就小 /
/// 目标字符一个都不命中），调用方一律回退完整的 `useFontCss` 链路。
pub fn ensure_list_subset_font(path: &Path, face_index: u32, chars: &str) -> Option<(PathBuf, u64)> {
    // 规范化字符集：去重 + 排序。同一批字符换个顺序必须命中同一份缓存，
    // 否则「示例文字改回来」会白重新生成一遍。
    let mut cps: Vec<u32> = chars.chars().map(|c| c as u32).collect();
    cps.sort_unstable();
    cps.dedup();
    if cps.is_empty() {
        return None;
    }

    let md = fs::metadata(path).ok()?;
    if md.len() < SUBSET_MIN_BYTES {
        return None;
    }
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut chars_hash = fnv1a(0xCBF2_9CE4_8422_2325, SUBSET_TAG.as_bytes());
    for cp in &cps {
        chars_hash = fnv1a(chars_hash, &cp.to_be_bytes());
    }
    let key = fnv1a(0xCBF2_9CE4_8422_2325, path.to_string_lossy().as_bytes());
    let key = fnv1a(key, &mtime.to_be_bytes());
    let key = fnv1a(key, &md.len().to_be_bytes());
    let key = fnv1a(key, &(face_index as u64).to_be_bytes());
    let key = fnv1a(key, &chars_hash.to_be_bytes());
    let dir = cache_dir()?;
    // 前缀 `L` 与修复通道的 `v5-L0-…` 区分；SUBSET_TAG 进文件名，改算法老产物自动失效
    let target = dir.join(format!("{CACHE_TAG}-L-{SUBSET_TAG}-{key:016x}.ttf"));
    if target.exists() {
        touch(&target);
        let bytes = fs::metadata(&target).ok()?.len();
        return Some((target, bytes));
    }

    let data = fs::read(path).ok()?;
    if data.len() < 12 {
        return None;
    }
    // `.ttc / .otc` 不再直接放弃（A6）：`face_offsets` 能定位到具体那一个 sfnt，
    // 而结尾的 `rebuild()` 产出的本来就是**单面**独立字体，正好是 OTS 要的形态。
    // 集合里的表是共享/绝对寻址的，重建时按偏移取字节，不受影响。
    let offsets = face_offsets(&data)?;
    let index = (face_index as usize).min(offsets.len().saturating_sub(1));
    let sfnt = *offsets.get(index)?;
    let tables = tables_of(&data, sfnt)?;
    // CFF2（可变字体）没有 endchar、靠长度界定 charstring，本轮不做
    if tables.iter().any(|t| &t.tag == b"CFF2") {
        return None;
    }
    // 可变字体：gvar/HVAR 与 gid 强耦合，动字形会让所有变体失效
    if tables.iter().any(|t| &t.tag == b"fvar") {
        return None;
    }
    let cff_rec = tables.iter().find(|t| &t.tag == b"CFF ");
    let glyf_rec = tables.iter().find(|t| &t.tag == b"glyf");
    if cff_rec.is_none() && glyf_rec.is_none() {
        return None;
    }
    let num_glyphs = tables
        .iter()
        .find(|t| &t.tag == b"maxp")
        .and_then(|t| u16_at(&data, t.offset + 4))?;
    if num_glyphs == 0 {
        return None;
    }

    let full = unicode_pairs(&data, &tables)?;
    let mut subset: std::collections::BTreeMap<u32, u16> = std::collections::BTreeMap::new();
    let mut seeds: Vec<u16> = Vec::new();
    for cp in &cps {
        if let Some(&gid) = full.get(cp) {
            subset.insert(*cp, gid);
            seeds.push(gid);
        }
    }
    // 一个字符都没命中：不是「子集失败」，是这字体本来就缺这些字。
    // 交回完整链路去显示缺字提示 —— 子集产物会是一片空白，反而更难解释。
    if seeds.is_empty() {
        return None;
    }

    // ── CFF / OTF（1.0.0-1 之后新增）：保留 GID，非目标 charstring 换成 endchar ──
    if let Some(rec) = cff_rec {
        let cff = data.get(rec.offset..rec.offset + rec.len)?;
        let keep: std::collections::HashSet<u16> = seeds.iter().copied().collect();
        let new_cff = subset_cff_table(cff, num_glyphs, &keep)?;
        let pairs: Vec<(u32, u16)> = subset.into_iter().collect();
        let cmap = build_cmap(&pairs);
        let mut ov: std::collections::HashMap<[u8; 4], Vec<u8>> = std::collections::HashMap::new();
        ov.insert(*b"CFF ", new_cff);
        // hmtx 截断：CFF 产物里它占 11%（思源）~ 55%（康熙），是第二大块
        if let Some(max_gid) = keep.iter().copied().max() {
            if let Some((hmtx, hhea)) = truncate_hmtx(&data, &tables, num_glyphs, max_gid) {
                ov.insert(*b"hmtx", hmtx);
                ov.insert(*b"hhea", hhea);
            }
        }
        // kern 裁剪（A3）：左右 gid 都不在闭包里的 pair 没人会用到
        if let Some(kern) = truncate_kern(&data, &tables, &keep) {
            ov.insert(*b"kern", kern);
        }
        // strip_hinting = false：同上，子集已经很小，去提示程序会改变轮廓观感
        let out = rebuild(&data, sfnt, &tables, Some(&cmap), false, Some(&ov))?;
        if out.len() as u64 >= md.len() {
            return None;
        }
        return store_subset(&dir, &target, key, &out);
    }

    let glyf_rec = glyf_rec?;
    let (loca, _) = read_loca(&data, &tables, num_glyphs)?;
    let keep = glyph_closure(
        &data,
        glyf_rec.offset,
        glyf_rec.len,
        &loca,
        &seeds,
        num_glyphs,
    );
    let (glyf, loca_bytes, long_loca) = build_subset_glyf(
        &data,
        glyf_rec.offset,
        glyf_rec.len,
        &loca,
        &keep,
        num_glyphs,
    )?;

    // post 副本：**降级成 3.0，丢掉字形名数组**。
    //
    // post 2.0 是「numGlyphs 个字形名字符串」，按 gid 一一对应。我们不重编号 → numGlyphs
    // 不变 → rebuild 那边「名字数量 == numGlyphs」的校验会通过 → 整份 435 KB 的字形名被原样留下。
    // 实测它占产物 **60~65%**（宝马黑体 435 KB / 721 KB、刻石录 543 KB / 838 KB），
    // 而卡片预览一个字都用不到字形名（CSS 用的是我们自造的 family 名）。
    // 降级成 3.0 只留 32 字节固定头，同时保留 italicAngle / underline 这些真正有用的字段。
    let post_rec = tables.iter().find(|t| &t.tag == b"post");
    let post_bytes = post_rec.and_then(|t| {
        let raw = data.get(t.offset..t.offset + t.len)?;
        if raw.len() < 32 {
            return None;
        }
        let mut minimal = raw[..32].to_vec();
        // version 3.0：没有字形名数组（2.0 / 2.5 都要求按 gid 排名字）
        minimal[0..4].copy_from_slice(&0x0003_0000u32.to_be_bytes());
        Some(minimal)
    });

    // head 副本：loca 切 long 时必须同步改 indexToLocFormat，否则整份字体读不出字形
    let head_rec = tables.iter().find(|t| &t.tag == b"head")?;
    let mut head_bytes = data[head_rec.offset..head_rec.offset + head_rec.len].to_vec();
    if head_bytes.len() >= 52 {
        let flag: i16 = if long_loca { 1 } else { 0 };
        head_bytes[50..52].copy_from_slice(&flag.to_be_bytes());
    }

    let pairs: Vec<(u32, u16)> = subset.into_iter().collect();
    let cmap = build_cmap(&pairs);
    let mut ov: std::collections::HashMap<[u8; 4], Vec<u8>> = std::collections::HashMap::new();
    ov.insert(*b"glyf", glyf);
    ov.insert(*b"loca", loca_bytes);
    ov.insert(*b"head", head_bytes);
    if let Some(p) = post_bytes {
        ov.insert(*b"post", p);
    }
    // hmtx 截断：它占 glyf 产物 60.8%（宝马 174KB/286KB），是最大的一块索引表
    if let Some(max_gid) = keep.iter().copied().max() {
        if let Some((hmtx, hhea)) = truncate_hmtx(&data, &tables, num_glyphs, max_gid) {
            ov.insert(*b"hmtx", hmtx);
            ov.insert(*b"hhea", hhea);
        }
    }
    // kern 裁剪（A3）：只留「左右 gid 都在闭包里」的 pair
    if let Some(kern) = truncate_kern(&data, &tables, &keep) {
        ov.insert(*b"kern", kern);
    }
    // strip_hinting = false：子集本身已经很小，去掉 fpgm/prep 会改变字形轮廓观感
    let out = rebuild(&data, sfnt, &tables, Some(&cmap), false, Some(&ov))?;
    // 没变小就别用：个别字体的字形集中在一批复合字形里，子集可能反而更碎
    if out.len() as u64 >= md.len() {
        return None;
    }
    store_subset(&dir, &target, key, &out)
}

/// 按「最大的目标 gid」截断 hmtx。
///
/// 规范允许 `hhea.numberOfHMetrics < maxp.numGlyphs`：超出的字形全部沿用**最后一条**
/// advanceWidth。被截掉的那些字形正是我们清空的（不渲染），所以字宽不影响观感，
/// 而目标字符的字宽一条不少。
///
/// 实测（2026-11-01，按真实字符集含中文族名）：省 15%（宝马，max gid 30288）
/// ~ 50%（max gid 91）。hmtx 占 glyf 产物的 60%、康熙 CFF 产物的 55%，
/// 所以这一刀对两条路线都是最划算的。
///
/// 返回 (新 hmtx, 新 hhea)；任何一步对不上就返回 None，调用方照原样输出。
fn truncate_hmtx(
    data: &[u8],
    tables: &[TableRec],
    num_glyphs: u16,
    max_gid: u16,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let hhea = tables.iter().find(|t| &t.tag == b"hhea")?;
    let hmtx = tables.iter().find(|t| &t.tag == b"hmtx")?;
    if num_glyphs == 0 || hhea.len < 36 {
        return None;
    }
    let old_n = u16_at(data, hhea.offset + 34)? as usize;
    if old_n == 0 || old_n > num_glyphs as usize {
        return None;
    }
    let src = data.get(hmtx.offset..hmtx.offset + hmtx.len)?;
    let need = old_n * 4 + (num_glyphs as usize - old_n) * 2;
    if src.len() < need {
        return None;
    }
    let new_n = (max_gid as usize + 1).min(num_glyphs as usize);
    if new_n >= num_glyphs as usize {
        return None; // 没得省
    }
    let last_width = u16::from_be_bytes([src[(old_n - 1) * 4], src[(old_n - 1) * 4 + 1]]);
    let mut out = Vec::with_capacity(new_n * 4 + (num_glyphs as usize - new_n) * 2);
    for gid in 0..new_n {
        if gid < old_n {
            out.extend_from_slice(&src[gid * 4..gid * 4 + 4]);
        } else {
            // 原表没这么长的 hMetrics，沿用最后一条宽度，lsb 取原数组对应项
            out.extend_from_slice(&last_width.to_be_bytes());
            let at = old_n * 4 + (gid - old_n) * 2;
            out.extend_from_slice(&src[at..at + 2]);
        }
    }
    for gid in new_n..num_glyphs as usize {
        let at = if gid < old_n {
            gid * 4 + 2
        } else {
            old_n * 4 + (gid - old_n) * 2
        };
        out.extend_from_slice(&src[at..at + 2]);
    }
    if out.len() >= src.len() {
        return None;
    }
    let mut hhea_bytes = data[hhea.offset..hhea.offset + hhea.len].to_vec();
    hhea_bytes[34..36].copy_from_slice(&(new_n as u16).to_be_bytes());
    Some((out, hhea_bytes))
}

/// 把子集产物原子落到缓存目录（tmp + rename），并维护 384MB 的 LRU。
/// 裁掉 kern 里「左右 gid 都不在闭包内」的 pair（A3）。
///
/// 只动 **version 0 + format 0** 的子表：那是唯一带 `(left, right, value)` 三元组、
/// 也是占空间最大的形态。别的版本 / 格式看不懂就整段原样保留 —— 不懂的结构不动是最安全的默认。
///
/// 实测（宝马中国字体-黑体）：kern 占 glyf 产物 7.1%（20 KB），裁完字距不变（像素比对 0 差异）。
fn truncate_kern(
    data: &[u8],
    tables: &[TableRec],
    keep: &std::collections::HashSet<u16>,
) -> Option<Vec<u8>> {
    let rec = tables.iter().find(|t| &t.tag == b"kern")?;
    let src = data.get(rec.offset..rec.offset + rec.len)?;
    if src.len() < 4 || u16_at(src, 0)? != 0 {
        return None;
    }
    let n_tables = u16_at(src, 2)? as usize;
    let mut out: Vec<u8> = Vec::with_capacity(src.len());
    // kern 头 = version(2) + nTables(2)：nTables 先占位，末尾按实际保留数回填。
    // 只写 2 字节会把子表的 version 顶掉（子表直接从 offset 2 开始写），产物整份读不出来。
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    let mut kept: u16 = 0;
    let mut pos = 4usize;
    let mut changed = false;
    for _ in 0..n_tables {
        if pos + 6 > src.len() {
            return None;
        }
        let sub_len = u16_at(src, pos + 2)? as usize;
        let coverage = u16_at(src, pos + 4)?;
        // 0xFFFF 是 Apple 的「最后一个子表」哨兵，没有实体数据
        if sub_len == 0 || sub_len < 6 || pos + sub_len > src.len() {
            return None;
        }
        let body = &src[pos..pos + sub_len];
        let format = (coverage >> 8) as u8;
        pos += sub_len;
        if format != 0 {
            out.extend_from_slice(body);
            kept += 1;
            continue;
        }
        // format 0 表头：version(2) length(2) coverage(2) nPairs(2) searchRange(2)
        //               entrySelector(2) rangeShift(2)，之后是 nPairs × 6 字节
        if body.len() < 14 {
            return None;
        }
        let n_pairs = u16_at(body, 6)? as usize;
        if body.len() < 14 + n_pairs * 6 {
            return None;
        }
        let mut pairs: Vec<&[u8]> = Vec::with_capacity(n_pairs);
        for i in 0..n_pairs {
            let o = 14 + i * 6;
            let left = u16_at(body, o)?;
            let right = u16_at(body, o + 2)?;
            if keep.contains(&left) && keep.contains(&right) {
                pairs.push(&body[o..o + 6]);
            }
        }
        if pairs.len() == n_pairs {
            out.extend_from_slice(body); // 没得裁，原样搬
            kept += 1;
            continue;
        }
        changed = true;
        let mut hdr = body[..6].to_vec();
        let (search_range, entry_selector, range_shift) = search_params(pairs.len(), 6);
        let mut tail: Vec<u8> = Vec::with_capacity(8 + pairs.len() * 6);
        tail.extend_from_slice(&(pairs.len() as u16).to_be_bytes());
        tail.extend_from_slice(&search_range.to_be_bytes());
        tail.extend_from_slice(&entry_selector.to_be_bytes());
        tail.extend_from_slice(&range_shift.to_be_bytes());
        for p in &pairs {
            tail.extend_from_slice(p);
        }
        let new_len = (6 + tail.len()) as u16;
        hdr[2..4].copy_from_slice(&new_len.to_be_bytes());
        out.extend_from_slice(&hdr);
        out.extend_from_slice(&tail);
        kept += 1;
    }
    if !changed || kept == 0 {
        return None;
    }
    out[2..4].copy_from_slice(&kept.to_be_bytes());
    Some(out)
}

/// kern format 0 的三个搜索参数：searchRange = 最大 2 的幂 × entrySize
fn search_params(n: usize, entry_size: usize) -> (u16, u16, u16) {
    if n == 0 {
        return (0, 0, 0);
    }
    let mut pow = 1usize;
    let mut sel: u16 = 0;
    while pow * 2 <= n {
        pow *= 2;
        sel += 1;
    }
    (
        (pow * entry_size) as u16,
        sel,
        (n * entry_size - pow * entry_size) as u16,
    )
}

fn store_subset(dir: &Path, target: &Path, key: u64, out: &[u8]) -> Option<(PathBuf, u64)> {
    let tmp = dir.join(format!(".{CACHE_TAG}-{key:016x}.{}.tmp", std::process::id()));
    fs::write(&tmp, out).ok()?;
    if fs::rename(&tmp, target).is_err() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    trim_cache(dir);
    Some((target.to_path_buf(), out.len() as u64))
}

// ───────────────────── CFF / OTF 列表子集 ─────────────────────
//
// 和 glyf 同思路：**保留 GID 不重编号**，把非目标 charstring 换成单字节 endchar(0x0e)。
// 于是 charset（gid→SID）、FDSelect（gid→FD）、hmtx（按 gid 排）、cmap 里的 gid
// 全都不用重建，只需要把 CFF 内部的绝对偏移重算一遍。
//
// 实测布局（康熙 / 思源 / 苹方 / Adobe / Noto 一致）：
//   Header → Name INDEX → Top DICT INDEX → String INDEX → GSubr INDEX
//         → charset → FDSelect → CharStrings → FDArray → Private DICT + Local Subrs
// 所以缩小 CharStrings 只会平移 FDArray 及其后的一切。
//
// 三个「静默出错」点（原型里全踩过，产物都是 fontTools 能读、字体变坏）：
//   1. FDArray 里每个 Font DICT 带 [size, offset] 指向 Private DICT，那个 offset 是**绝对**的。
//      只改 Top DICT 不改它 → 产物 fontTools 能解析、FreeType 直接 unknown file format。
//   2. DICT 操作数可能是浮点（FontMatrix 0.001 …），重建时只能**原样复制字节**；
//      一律当整数重编码会把字宽/变换全搞乱。
//   3. 原样复制时的切片基准：Top DICT 是独立字节串，下标相对它自己，**不是相对整段 CFF**。
//      用错基准会吞掉 ROS 这类算子带的操作数（fontTools 报 IndexError，长度偏移却全对）。

const CFF_ENDCHAR_BYTE: [u8; 1] = [0x0E];
const CFF_OP_CHARSET: u16 = 15;
const CFF_OP_ENCODING: u16 = 16;
const CFF_OP_CHARSTRINGS: u16 = 17;
const CFF_OP_PRIVATE: u16 = 18;
const CFF_OP_FDARRAY: u16 = 1236;
const CFF_OP_FDSELECT: u16 = 1237;

struct CffIndex {
    items: Vec<(usize, usize)>,
    end: usize,
}

fn cff_index(data: &[u8], off: usize) -> Option<CffIndex> {
    let count = u16_at(data, off)? as usize;
    if count == 0 {
        return Some(CffIndex { items: Vec::new(), end: off + 2 });
    }
    let off_size = *data.get(off + 2)? as usize;
    if !(1..=4).contains(&off_size) {
        return None;
    }
    let p = off + 3;
    if p + (count + 1) * off_size > data.len() {
        return None;
    }
    let read = |i: usize| -> usize {
        let s = p + i * off_size;
        let mut v = 0usize;
        for k in 0..off_size {
            v = (v << 8) | data[s + k] as usize;
        }
        v
    };
    // INDEX 的 offset 是 1-based，所以数据区起点 = 偏移数组末字节
    let data_start = p + (count + 1) * off_size - 1;
    let mut items = Vec::with_capacity(count);
    for i in 0..count {
        let (a, b) = (read(i), read(i + 1));
        if b < a {
            return None;
        }
        items.push((data_start + a, data_start + b));
    }
    Some(CffIndex { items, end: data_start + read(count) })
}

fn cff_push_offset(out: &mut Vec<u8>, v: usize, size: usize) {
    // 必须转成 u32 再取字节：usize 在 64 位上是 **8 字节**，
    // 直接 to_be_bytes 后按 &b[4 - size..] 切片会每个偏移多写 4 个字节，
    // 整个 INDEX 错位、字典变空 —— 产物 fontTools 报「AttributeError charset」、
    // FreeType 报 broken table，而长度校验全部通过。
    let b = (v as u32).to_be_bytes();
    out.extend_from_slice(&b[4 - size..]);
}

fn write_cff_index(items: &[&[u8]]) -> Vec<u8> {
    let count = items.len();
    if count == 0 {
        return vec![0, 0];
    }
    let total: usize = items.iter().map(|x| x.len()).sum::<usize>() + 1;
    let off_size: usize = if total < 0x100 {
        1
    } else if total < 0x1_0000 {
        2
    } else if total < 0x100_0000 {
        3
    } else {
        4
    };
    let mut out = Vec::with_capacity(total + 4 + (count + 1) * off_size);
    out.extend_from_slice(&(count as u16).to_be_bytes());
    out.push(off_size as u8);
    let mut cur: usize = 1;
    cff_push_offset(&mut out, cur, off_size);
    for it in items {
        cur += it.len();
        cff_push_offset(&mut out, cur, off_size);
    }
    for it in items {
        out.extend_from_slice(it);
    }
    out
}

struct CffEntry {
    op: u16,
    operands: Vec<i32>,
    opnd_start: Option<usize>,
    op_start: usize,
}

/// 读一个 DICT 操作数；浮点只跳过、值记 0（重建时原样复制，不需要真值）。
fn cff_dict_operand(data: &[u8], i: &mut usize) -> Option<i32> {
    let b = *data.get(*i)?;
    match b {
        28 => {
            let v = i16::from_be_bytes([*data.get(*i + 1)?, *data.get(*i + 2)?]) as i32;
            *i += 3;
            Some(v)
        }
        29 => {
            let mut buf = [0u8; 4];
            for k in 0..4 {
                buf[k] = *data.get(*i + 1 + k)?;
            }
            *i += 5;
            Some(i32::from_be_bytes(buf))
        }
        30 => {
            let mut j = *i + 1;
            loop {
                let c = *data.get(j)?;
                let done = (c & 0x0F) == 0x0F || (c >> 4) == 0x0F;
                j += 1;
                if done {
                    break;
                }
            }
            *i = j;
            Some(0)
        }
        32..=246 => {
            *i += 1;
            Some(b as i32 - 139)
        }
        247..=250 => {
            let v = (b as i32 - 247) * 256 + *data.get(*i + 1)? as i32 + 108;
            *i += 2;
            Some(v)
        }
        251..=254 => {
            let v = -(b as i32 - 251) * 256 - *data.get(*i + 1)? as i32 - 108;
            *i += 2;
            Some(v)
        }
        _ => None,
    }
}

fn cff_dict(data: &[u8], start: usize, end: usize) -> Vec<CffEntry> {
    let mut out = Vec::new();
    let mut operands: Vec<i32> = Vec::new();
    let mut opnd_start: Option<usize> = None;
    let mut i = start;
    while i < end {
        let b = data[i];
        if b <= 21 {
            let op_start = i;
            let mut op = b as u16;
            i += 1;
            if b == 12 {
                if i < end {
                    op = 1200 + data[i] as u16;
                    i += 1;
                }
            }
            out.push(CffEntry {
                op,
                operands: std::mem::take(&mut operands),
                opnd_start,
                op_start,
            });
            opnd_start = None;
        } else {
            let before = i;
            match cff_dict_operand(data, &mut i) {
                Some(v) => {
                    if opnd_start.is_none() {
                        opnd_start = Some(before);
                    }
                    operands.push(v);
                }
                None => i = before + 1,
            }
        }
    }
    out
}

/// 固定 5 字节整数（0x1d + int32）：**长度与数值无关**，这是「两遍法」能收敛的前提。
fn cff_push_int(out: &mut Vec<u8>, v: i32) {
    out.push(0x1d);
    out.extend_from_slice(&v.to_be_bytes());
}

/// 重建 DICT：offset 型算子换成新值，其余操作数**原样复制字节**（保住浮点）。
fn rebuild_cff_dict(raw: &[u8], entries: &[CffEntry], map: &dyn Fn(i32) -> i32) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    for e in entries {
        let is_offset_op = matches!(
            e.op,
            CFF_OP_CHARSET | CFF_OP_ENCODING | CFF_OP_CHARSTRINGS | CFF_OP_FDARRAY | CFF_OP_FDSELECT
        );
        if is_offset_op && !e.operands.is_empty() {
            for v in &e.operands[..e.operands.len() - 1] {
                cff_push_int(&mut out, *v);
            }
            cff_push_int(&mut out, map(*e.operands.last().unwrap()));
        } else if e.op == CFF_OP_PRIVATE && e.operands.len() == 2 {
            cff_push_int(&mut out, e.operands[0]);
            cff_push_int(&mut out, map(e.operands[1]));
        } else if let Some(s) = e.opnd_start {
            out.extend_from_slice(&raw[s..e.op_start]);
        }
        if e.op >= 1200 {
            out.push(12);
            out.push((e.op - 1200) as u8);
        } else {
            out.push(e.op as u8);
        }
    }
    out
}

/// 目标 charstring 是否用了 seac（endchar 执行时栈上有 4 个操作数）。
/// 用了就得连带保留组件字形，而组件是按 SID 引用的 —— 本轮不处理，直接回退完整链路。
fn cff_charstring_has_seac(cs: &[u8]) -> bool {
    let mut stack: usize = 0;
    let mut stems: usize = 0;
    let mut i = 0usize;
    while i < cs.len() {
        let b = cs[i];
        match b {
            28 => {
                stack += 1;
                i += 3;
            }
            255 => {
                stack += 1;
                i += 5;
            }
            32..=246 => {
                stack += 1;
                i += 1;
            }
            247..=254 => {
                stack += 1;
                i += 2;
            }
            12 => {
                stack = 0;
                i += 2;
            }
            14 => return stack >= 4,
            1 | 3 | 18 | 23 => {
                stems += stack / 2;
                stack = 0;
                i += 1;
            }
            19 | 20 => {
                stems += stack / 2;
                stack = 0;
                i += 1 + (stems + 7) / 8;
            }
            _ => {
                stack = 0;
                i += 1;
            }
        }
    }
    false
}

/// 生成一份「保留 GID」的 CFF 表。失败一律返回 None（调用方回退完整字体）。
fn subset_cff_table(
    cff: &[u8],
    num_glyphs: u16,
    keep: &std::collections::HashSet<u16>,
) -> Option<Vec<u8>> {
    if cff.len() < 8 {
        return None;
    }
    let hdr = *cff.get(2)? as usize;
    if hdr < 4 || hdr > cff.len() {
        return None;
    }
    let name_idx = cff_index(cff, hdr)?;
    let top_start = name_idx.end;
    let top_idx = cff_index(cff, top_start)?;
    let str_idx = cff_index(cff, top_idx.end)?;
    let gsubr_idx = cff_index(cff, str_idx.end)?;
    let prefix_end = gsubr_idx.end;

    let (ts, te) = *top_idx.items.first()?;
    let top_raw = cff.get(ts..te)?;
    let top = cff_dict(top_raw, 0, top_raw.len());
    let dict_val = |op: u16| -> Option<i32> {
        top.iter().find(|e| e.op == op).and_then(|e| e.operands.last().copied())
    };

    let old_cs = dict_val(CFF_OP_CHARSTRINGS)? as usize;
    let old_fda = dict_val(CFF_OP_FDARRAY).map(|v| v as usize).filter(|v| *v > 0);
    let cs_idx = cff_index(cff, old_cs)?;
    if cs_idx.items.len() != num_glyphs as usize {
        return None;
    }
    let old_cs_end = cs_idx.end;

    for gid in keep {
        let (a, b) = *cs_idx.items.get(*gid as usize)?;
        if cff_charstring_has_seac(cff.get(a..b)?) {
            return None;
        }
    }

    let mut new_items: Vec<&[u8]> = Vec::with_capacity(num_glyphs as usize);
    for gid in 0..num_glyphs as usize {
        let (a, b) = cs_idx.items[gid];
        if gid == 0 || keep.contains(&(gid as u16)) {
            new_items.push(cff.get(a..b)?);
        } else {
            new_items.push(&CFF_ENDCHAR_BYTE);
        }
    }
    let new_cs = write_cff_index(&new_items);
    let d_cs = new_cs.len() as i64 - (old_cs_end - old_cs) as i64;

    // FDArray：重建每个 Font DICT（Private 偏移跟着平移）
    let mut fda_items: Vec<(usize, usize)> = Vec::new();
    let mut old_fda_end = old_fda.unwrap_or(0);
    let mut d_fda: i64 = 0;
    if let Some(fda_off) = old_fda {
        let fda = cff_index(cff, fda_off)?;
        // 只支持「FDArray 在 CharStrings 之后」这一种（实测覆盖全部样本）。
        // 别的排列（如 shaoluwenziw7）交回完整链路，绝不错位产出坏字体。
        if fda.items.first()?.0 < old_cs_end {
            return None;
        }
        old_fda_end = fda.end;
        fda_items = fda.items.clone();
        let mut dummy: Vec<Vec<u8>> = Vec::with_capacity(fda_items.len());
        for (a, b) in &fda_items {
            let raw = cff.get(*a..*b)?;
            let ents = cff_dict(raw, 0, raw.len());
            dummy.push(rebuild_cff_dict(raw, &ents, &|_v| 0));
        }
        let refs: Vec<&[u8]> = dummy.iter().map(|v| v.as_slice()).collect();
        d_fda = write_cff_index(&refs).len() as i64 - (old_fda_end - fda_off) as i64;
    }

    // Top DICT 长度与数值无关（固定 5 字节）→ 先算出位移量
    let dummy_top = rebuild_cff_dict(top_raw, &top, &|_v| 0);
    let l_top = write_cff_index(&[dummy_top.as_slice()]).len();
    let d_top = l_top as i64 - (top_idx.end - top_start) as i64;

    // 旧偏移 → 新偏移：CharStrings 之前只受 Top DICT 长度变化影响；
    // CharStrings 之后要先跨过 Δcs，再跨过 Δfda（Private / Local Subrs 在 FDArray 之后）。
    let old_fda_is_some = old_fda.is_some();
    let map = move |old: i32| -> i32 {
        let o = old as usize;
        let add = if o < old_cs_end {
            d_top
        } else if old_fda_is_some && o >= old_fda_end {
            d_top + d_cs + d_fda
        } else {
            d_top + d_cs
        };
        (old as i64 + add) as i32
    };

    let new_top = rebuild_cff_dict(top_raw, &top, &map);
    let new_top_index = write_cff_index(&[new_top.as_slice()]);
    if new_top_index.len() != l_top {
        return None; // 长度没收敛就说明假设错了，宁可不产出
    }

    let mut new_fda: Vec<u8> = Vec::new();
    if !fda_items.is_empty() {
        let mut items: Vec<Vec<u8>> = Vec::with_capacity(fda_items.len());
        for (a, b) in &fda_items {
            let raw = cff.get(*a..*b)?;
            let ents = cff_dict(raw, 0, raw.len());
            items.push(rebuild_cff_dict(raw, &ents, &map));
        }
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        new_fda = write_cff_index(&refs);
        let expect = (old_fda_end - old_fda.unwrap()) as i64 + d_fda;
        if new_fda.len() as i64 != expect {
            return None;
        }
    }

    let mut out = Vec::with_capacity(cff.len());
    out.extend_from_slice(cff.get(..hdr)?);
    out.extend_from_slice(cff.get(hdr..name_idx.end)?);
    out.extend_from_slice(&new_top_index);
    out.extend_from_slice(cff.get(top_idx.end..prefix_end)?);
    out.extend_from_slice(cff.get(prefix_end..old_cs)?);
    out.extend_from_slice(&new_cs);
    if let Some(fda_off) = old_fda {
        out.extend_from_slice(cff.get(old_cs_end..fda_off)?);
        out.extend_from_slice(&new_fda);
        out.extend_from_slice(cff.get(old_fda_end..)?);
    } else {
        out.extend_from_slice(cff.get(old_cs_end..)?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工冒烟：`ZFM_REPAIR_TEST="字体路径#字面序号" cargo test repair_smoke -- --ignored --nocapture`
    /// 列表子集冒烟：`ZFM_SUBSET_TEST="字体路径" cargo test subset_smoke -- --ignored --nocapture`
    /// 批量：`ZFM_SUBSET_LIST=清单文件 cargo test subset_smoke -- --ignored --nocapture`
    ///
    /// 验证三件事（都是「肉眼看不出来但一定会坏」的）：
    ///   1. 产物比原文件小（否则这条路线没意义）；
    ///   2. 产物自己能被重新解析出表目录与 cmap（loca 切 long / head 改标记是否写对）；
    ///   3. 每个目标字符在产物的 cmap 里都有 gid（否则卡片直接缺字）。
    #[test]
    #[ignore]
    fn subset_smoke() {
        let mut targets: Vec<String> = Vec::new();
        if let Ok(one) = std::env::var("ZFM_SUBSET_TEST") {
            targets.push(one);
        }
        if let Ok(list) = std::env::var("ZFM_SUBSET_LIST") {
            let text = fs::read_to_string(&list).expect("读不到清单");
            for line in text.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    targets.push(line.to_string());
                }
            }
        }
        if targets.is_empty() {
            return;
        }
        let chars = "Hello IIEOzoAa";
        // fail 永远是 0：任何断言失败直接 panic，走不到这里的 fail += 1 —— 它只进汇总行
        let (mut ok, mut skip, fail) = (0usize, 0usize, 0usize);
        for spec in &targets {
            // 支持 `路径#字面序号`，用来验 TTC 多面（默认第 0 面）。
            // Windows 文件名不会出现 `#数字` 结尾，按最后一段数字判断足够安全。
            let (path, face_index) = match spec.rsplit_once('#') {
                Some((p, idx)) if !p.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) && !idx.is_empty() => {
                    (p.to_string(), idx.parse::<u32>().unwrap_or(0))
                }
                _ => (spec.clone(), 0u32),
            };
            let path = &path;
            let p = Path::new(path);
            let orig = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let t0 = std::time::Instant::now();
            let got = ensure_list_subset_font(p, face_index, chars);
            let ms = t0.elapsed().as_millis();
            let Some((out, bytes)) = got else {
                skip += 1;
                // 区分两种 SKIP：格式不适用（可变字体 / 体积太小）与「一个字符都不命中」。
                // 后者对纯汉字字体是正常的 —— 它的 cmap 里没有任何拉丁字形。
                let hits = fs::read(p)
                    .ok()
                    .and_then(|d| {
                        let offs = face_offsets(&d)?;
                        let i = (face_index as usize).min(offs.len().saturating_sub(1));
                        let t = tables_of(&d, *offs.get(i)?)?;
                        Some((d, t))
                    })
                    .and_then(|(d, t)| unicode_pairs(&d, &t))
                    .map(|m| {
                        chars
                            .chars()
                            .filter(|c| m.contains_key(&(*c as u32)))
                            .count()
                    })
                    .unwrap_or(0);
                println!("SKIP {path}#{face_index} ({orig} bytes, {ms}ms) hit={hits}");
                continue;
            };
            assert!(bytes < orig, "产物没变小: {path}#{face_index}");
            let data = fs::read(&out).expect("读不到产物");
            let tables = tables_of(&data, 0).expect("产物表目录读不出来");
            let map = unicode_pairs(&data, &tables).expect("产物 cmap 读不出来");
            for c in chars.chars() {
                assert!(map.contains_key(&(c as u32)), "子集缺字 {c}: {path}");
            }
            // TTC 输入：产物必须是**单面** sfnt（OTS 只认单面），
            // 且字形数必须取自 face_index 那一面 —— 这条专抓「永远拿第 0 面」的实现错误：
            // 总取 offsets[0] 时体积、cmap 断言照样全过，只有字形数对不上。
            if let Ok(src) = fs::read(p) {
                if src.len() > 4 && &src[0..4] == b"ttcf" {
                    assert_ne!(&data[0..4], b"ttcf", "产物仍是集合字体: {path}#{face_index}");
                    let offs = face_offsets(&src).expect("原文件面偏移读不出来");
                    let i = (face_index as usize).min(offs.len().saturating_sub(1));
                    let src_tables = tables_of(&src, offs[i]).expect("原文件表目录读不出来");
                    let want = src_tables
                        .iter()
                        .find(|t| &t.tag == b"maxp")
                        .and_then(|t| u16_at(&src, t.offset + 4))
                        .unwrap_or(0);
                    let got = tables
                        .iter()
                        .find(|t| &t.tag == b"maxp")
                        .and_then(|t| u16_at(&data, t.offset + 4))
                        .unwrap_or(0);
                    assert_eq!(
                        got, want,
                        "产物字形数与原文件第 {face_index} 面不一致: {path}"
                    );
                }
            }
            // CFF 产物必须自己再解析一遍：**这一条不能省**。
            // 曾经因为 usize 的 to_be_bytes 是 8 字节，INDEX 偏移每个多写 4 字节，
            // Top DICT 变成空字典 —— 而 cmap 与体积断言全部通过，只有真正去解析
            // CFF 才能发现（FreeType 报 broken table）。
            if tables.iter().any(|t| &t.tag == b"CFF ") {
                let rec = tables.iter().find(|t| &t.tag == b"CFF ").unwrap();
                let cff = &data[rec.offset..rec.offset + rec.len];
                let hdr = cff[2] as usize;
                let name_idx = cff_index(cff, hdr).expect("产物 CFF name INDEX 读不出来");
                let top_idx = cff_index(cff, name_idx.end).expect("产物 CFF top INDEX 读不出来");
                let (a, b) = *top_idx.items.first().expect("产物 Top DICT 为空");
                let ents = cff_dict(cff, a, b);
                let cs_off = ents
                    .iter()
                    .rev()
                    .find(|e| e.op == CFF_OP_CHARSTRINGS)
                    .and_then(|e| e.operands.last().copied())
                    .expect("产物 Top DICT 里没有 CharStrings 算子");
                let cs = cff_index(cff, cs_off as usize).expect("产物 CharStrings INDEX 读不出来");
                let want = tables
                    .iter()
                    .find(|t| &t.tag == b"maxp")
                    .and_then(|t| u16_at(&data, t.offset + 4))
                    .unwrap_or(0) as usize;
                assert_eq!(
                    cs.items.len(),
                    want,
                    "产物 CharStrings 数量与 numGlyphs 不一致: {path}"
                );
                assert!(
                    cs.items.iter().filter(|(x, y)| y - x > 1).count() >= 1,
                    "产物 CharStrings 全被清空了: {path}"
                );
            }
            // hmtx 截断后必须自洽：hmtx 长度 == n*4 + (numGlyphs-n)*2
            if let (Some(hh), Some(hm), Some(mp)) = (
                tables.iter().find(|t| &t.tag == b"hhea"),
                tables.iter().find(|t| &t.tag == b"hmtx"),
                tables.iter().find(|t| &t.tag == b"maxp"),
            ) {
                let total = u16_at(&data, mp.offset + 4).unwrap_or(0) as usize;
                if hh.len >= 36 {
                    let n = u16_at(&data, hh.offset + 34).unwrap_or(0) as usize;
                    assert!(n >= 1 && n <= total, "hhea numberOfHMetrics 越界: {path}");
                    assert_eq!(
                        hm.len,
                        n * 4 + (total - n) * 2,
                        "hmtx 长度与 numberOfHMetrics 对不上: {path}"
                    );
                }
            }
            ok += 1;
            println!(
                "OK   {path}#{face_index} {orig} -> {bytes} ({:.2}%) {ms}ms cmap={}",
                bytes as f64 * 100.0 / orig as f64,
                map.len()
            );
        }
        println!("汇总 ok={ok} skip={skip} fail={fail}");
        assert_eq!(fail, 0);
    }

    /// A4 决策数据：`GSUB + GPOS` 在**子集产物**里占多大。
    ///
    /// `ZFM_SHARE_LIST=清单文件 cargo test layout_share -- --ignored --nocapture`
    /// 清单每行一个字体路径，支持 `路径#字面序号`（默认第 0 面）。
    ///
    /// 为什么不能只看原文件占比：子集化把 glyf 砍掉九成，布局表却原样搬过去，
    /// 所以原文件里占 5% 的表，在产物里可能占一半。判据是产物里的占比。
    /// 只有「> 10% 的字体数量」够多，A4（裁 layout 表）才值得做。
    #[test]
    #[ignore]
    fn layout_share() {
        let Ok(list) = std::env::var("ZFM_SHARE_LIST") else {
            return;
        };
        let text = fs::read_to_string(list).expect("读不到清单");
        let chars = "Hello IIEOzoAa";
        let (mut over10, mut measured, mut skipped) = (0usize, 0usize, 0usize);
        let mut gain_bytes = 0u64;
        println!("share%\t产物\tlayout\tGSUB\tGPOS\t原文件\t路径");
        for spec in text.lines() {
            let spec = spec.trim();
            if spec.is_empty() {
                continue;
            }
            let (path, face_index) = match spec.rsplit_once('#') {
                Some((p, idx))
                    if !p.is_empty() && !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) =>
                {
                    (p.to_string(), idx.parse::<u32>().unwrap_or(0))
                }
                _ => (spec.to_string(), 0u32),
            };
            let p = Path::new(&path);
            let orig = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let Some((out, bytes)) = ensure_list_subset_font(p, face_index, chars) else {
                skipped += 1;
                continue;
            };
            let Ok(data) = fs::read(&out) else { continue };
            let Some(tables) = tables_of(&data, 0) else {
                continue;
            };
            let gsub = tables
                .iter()
                .find(|t| &t.tag == b"GSUB")
                .map(|t| t.len)
                .unwrap_or(0) as u64;
            let gpos = tables
                .iter()
                .find(|t| &t.tag == b"GPOS")
                .map(|t| t.len)
                .unwrap_or(0) as u64;
            let layout = gsub + gpos;
            let share = layout as f64 * 100.0 / bytes.max(1) as f64;
            measured += 1;
            if share > 10.0 {
                over10 += 1;
                gain_bytes += layout;
            }
            println!("{share:.1}\t{bytes}\t{layout}\t{gsub}\t{gpos}\t{orig}\t{path}");
        }
        println!(
            "汇总：测了 {measured}，跳过 {skipped}，layout 占比 >10% 的有 {over10}（这些字体 layout 合计 {} KB）",
            gain_bytes / 1024
        );
    }

    /// 批量：`ZFM_REPAIR_LIST=清单文件 cargo test ...`，文件里每行 `路径#序号`。
    /// 只验证「修得出来、写进了缓存」，是否真能被 WebView2 加载要在应用里看。
    #[test]
    #[ignore]
    fn repair_smoke() {
        if let Ok(list) = std::env::var("ZFM_REPAIR_LIST") {
            let text = fs::read_to_string(&list).expect("读不到清单");
            // 全量体检时把每份产物另存一份：缓存有 384 MB 上限，边跑边淘汰会把它们删掉
            let sweep = std::env::var("ZFM_REPAIR_SWEEP").ok().map(PathBuf::from);
            if let Some(dir) = &sweep {
                let _ = fs::create_dir_all(dir);
            }
            let (mut ok, mut fail) = (0usize, 0usize);
            for (n, line) in text.lines().enumerate() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let (path, index) = match line.rsplit_once('#') {
                    Some((p, i)) => (p.to_string(), i.parse::<u32>().unwrap_or(0)),
                    None => (line.to_string(), 0),
                };
                match ensure_preview_font(Path::new(&path), index, 0) {
                    Some(p) => {
                        ok += 1;
                        if let Some(dir) = &sweep {
                            if let Some(ext) = p.extension() {
                                let name = format!("f{n:04}.{}", ext.to_string_lossy());
                                let _ = fs::copy(&p, dir.join(&name));
                                println!("OK\t{name}\t{line}");
                                continue;
                            }
                        }
                        println!("OK\t{}\t{}", p.to_string_lossy(), line);
                    }
                    None => {
                        fail += 1;
                        println!("NONE\t\t{line}");
                    }
                }
            }
            println!("合计 ok={ok} none={fail}");
            return;
        }

        let Ok(spec) = std::env::var("ZFM_REPAIR_TEST") else {
            return;
        };
        let (path, index) = match spec.rsplit_once('#') {
            Some((p, i)) => (p.to_string(), i.parse::<u32>().unwrap_or(0)),
            None => (spec, 0),
        };
        let out = ensure_preview_font(Path::new(&path), index, 0);
        println!("{path}#{index} -> {out:?}");
        assert!(out.is_some(), "没能修出预览字体");
    }

    /// A3：kern 裁剪必须产出「字面合法」的 format 0 子表（长度、搜索参数、pairs 都要对）
    #[test]
    fn kern_subset_keeps_valid_layout() {
        // 造一张 version 0 / format 0 / 2 个 pair 的 kern
        let mut src: Vec<u8> = Vec::new();
        src.extend_from_slice(&0u16.to_be_bytes()); // version
        src.extend_from_slice(&1u16.to_be_bytes()); // nTables
        src.extend_from_slice(&0u16.to_be_bytes()); // subtable version
        src.extend_from_slice(&26u16.to_be_bytes()); // length = 14 + 2*6
        src.extend_from_slice(&1u16.to_be_bytes()); // coverage: horizontal, format 0
        src.extend_from_slice(&2u16.to_be_bytes()); // nPairs
        src.extend_from_slice(&12u16.to_be_bytes()); // searchRange
        src.extend_from_slice(&1u16.to_be_bytes()); // entrySelector
        src.extend_from_slice(&0u16.to_be_bytes()); // rangeShift
        for (l, r, v) in [(5u16, 5u16, 10i16), (7, 7, 20)] {
            src.extend_from_slice(&l.to_be_bytes());
            src.extend_from_slice(&r.to_be_bytes());
            src.extend_from_slice(&v.to_be_bytes());
        }

        // 只保留 gid 5：应留 1 条 pair（5,5），长度 20
        let mut keep: std::collections::HashSet<u16> = std::collections::HashSet::new();
        keep.insert(5);
        let out = truncate_kern(&src, &[TableRec { tag: *b"kern", offset: 0, len: src.len() }], &keep)
            .expect("应该能裁");

        assert_eq!(u16_at(&out, 0), Some(0), "version 必须是 0");
        assert_eq!(u16_at(&out, 2), Some(1), "nTables 必须是 1");
        assert_eq!(u16_at(&out, 4), Some(0), "子表 version 必须是 0");
        assert_eq!(u16_at(&out, 6), Some(20), "子表长度 = 6 + 8 + 1*6");
        assert_eq!(u16_at(&out, 8), Some(1), "coverage 原样保留");
        assert_eq!(u16_at(&out, 10), Some(1), "nPairs = 1");
        assert_eq!(u16_at(&out, 12), Some(6), "searchRange = 6");
        assert_eq!(u16_at(&out, 14), Some(0), "entrySelector = 0");
        assert_eq!(u16_at(&out, 16), Some(0), "rangeShift = 0");
        assert_eq!(u16_at(&out, 18), Some(5), "留下的 pair left gid");
        assert_eq!(i16_at(&out, 22), Some(10), "留下的 pair 值不变");
        assert_eq!(out.len(), 24, "6(头) + nTables 头 4 + 子表 20");
    }
}
