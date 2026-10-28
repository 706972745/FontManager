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

/// 缓存在 `%APPDATA%/ZFontManager/preview-cache`
const CACHE_DIR: &str = "preview-cache";
/// 缓存上限。老中文字体单个字面几 MB，给到 384 MB 够用又不会把硬盘吃掉
const CACHE_LIMIT: u64 = 384 * 1024 * 1024;
/// 修复算法的版本号。改了重建逻辑就加一，老的缓存文件自动失效
const CACHE_TAG: &str = "v5";

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

/// 用给定的 cmap 重新拼一个单字面的 sfnt
fn rebuild(data: &[u8], sfnt: usize, tables: &[TableRec], new_cmap: Option<&[u8]>) -> Option<Vec<u8>> {
    // 收表：丢掉 DSIG（老字体的签名表经常是坏的，OTS 会因此整份拒收）、
    // 零长度表、竖向度量表（OTS 会检查 vmtx 是否覆盖全部字形，老字体常常对不上；
    // 横向预览完全用不到），cmap 换成新的
    let mut items: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    let mut saw_cmap = false;
    for t in tables {
        if &t.tag == b"DSIG" || &t.tag == b"vmtx" || &t.tag == b"vhea" || &t.tag == b"VORG" {
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
            if !matches!(version, 0x0001_0000 | 0x0002_0000 | 0x0002_5000 | 0x0003_0000) {
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
    let dir = dirs::data_dir()?.join("ZFontManager").join(CACHE_DIR);
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
fn browser_can_load(data: &[u8], sfnt: usize, is_collection: bool) -> bool {
    if is_collection {
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
pub fn ensure_preview_font(path: &Path, face_index: u32) -> Option<PathBuf> {
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
        let hit = dir.join(format!("{CACHE_TAG}-{key:016x}.{ext}"));
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
    if browser_can_load(&data, sfnt, is_collection) {
        return None;
    }
    let ext = if &data[sfnt..sfnt + 4] == b"OTTO" { "otf" } else { "ttf" };
    let target = dir.join(format!("{CACHE_TAG}-{key:016x}.{ext}"));

    let tables = tables_of(&data, sfnt)?;
    let cmap_rec = tables.iter().find(|t| &t.tag == b"cmap")?;
    let subs = cmap_subtables(&data, cmap_rec.offset);

    // 挑一个子表来重建：有 Unicode 子表就直接用（码值就是码点），
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
    let raw = parse_subtable(&data, sub);
    if raw.is_empty() {
        return None;
    }
    let num_glyphs = tables
        .iter()
        .find(|t| &t.tag == b"maxp")
        .and_then(|t| u16_at(&data, t.offset + 4))
        .unwrap_or(u16::MAX);
    // 多个旧编码可能落到同一个 Unicode，必须去重，否则重建的 cmap 段会重叠
    let mut map: std::collections::BTreeMap<u32, u16> = std::collections::BTreeMap::new();
    for (code, gid) in raw {
        // 旧字体里常有指到 numGlyphs 甚至更远的脏映射，OTS 会判
        // 「cmap: Range glyph reference too high」，必须滤掉
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
        return None;
    }
    let pairs: Vec<(u32, u16)> = map.into_iter().collect();
    let cmap = build_cmap(&pairs);
    let rebuilt = rebuild(&data, sfnt, &tables, Some(&cmap))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工冒烟：`ZFM_REPAIR_TEST="字体路径#字面序号" cargo test repair_smoke -- --ignored --nocapture`
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
                match ensure_preview_font(Path::new(&path), index) {
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
        let out = ensure_preview_font(Path::new(&path), index);
        println!("{path}#{index} -> {out:?}");
        assert!(out.is_some(), "没能修出预览字体");
    }
}
