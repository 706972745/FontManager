//! WOFF 网页字体的导入处理：判重 + 解包。
//!
//! 背景：Windows 的 GDI 字体机制不认识 WOFF/WOFF2（`AddFontResourceW` 对它们
//! 必定失败，报 "Windows couldn't load this font file"），就算链进库里也永远是
//! 「无法启用」的死面。所以导入时对 web 字体做两件事：
//!
//! 1. **判重**：同目录同名的 `.ttf`/`.otf` 与 woff 是同一款字体（对比 family /
//!    units_per_em / 字形数，name 表一致的才认）→ 跳过 woff，保留适配最高的
//!    原生格式。同名但内容不同（改名衍生版）视为两款字体，都保留。
//! 2. **解包**：落单的 WOFF1 解包还原成 sfnt（flavor 是 OTTO 就还原成 .otf，
//!    TrueType 就还原成 .ttf）再入库；WOFF2 需要 Brotli + 变换表重建
//!    （glyf/loca/hmtx 的转换编码），暂不支持，跳过并计数。
//!
//! 判重用「同目录同文件名」做候选是有意的：真实字体包里多格式同名是行业惯例
//! （Marthane.otf/.ttf/.woff 三份同体），跨目录、跨名字的巧合重名几乎不存在。

use std::path::Path;

/// 判断一个文件是不是 web 字体，返回 (扩展名小写, 是否 WOFF1, 是否 WOFF2)
pub fn webfont_ext(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "woff" => Some("woff"),
        "woff2" => Some("woff2"),
        _ => None,
    }
}

/// sfnt 表的校验和：数据按大端 u32 求和（不足 4 字节尾部补零）
fn calc_table_checksum(data: &[u8]) -> u32 {
    let mut sum: u32 = 0;
    let mut chunks = data.chunks_exact(4);
    for c in &mut chunks {
        sum = sum.wrapping_add(u32::from_be_bytes([c[0], c[1], c[2], c[3]]));
    }
    let rest = chunks.remainder();
    if !rest.is_empty() {
        let mut last = [0u8; 4];
        last[..rest.len()].copy_from_slice(rest);
        sum = sum.wrapping_add(u32::from_be_bytes(last));
    }
    sum
}

/// WOFF1 解包还原成 sfnt。
/// 返回的字节流可以直接写盘当 .ttf（flavor=0x00010000）/ .otf（flavor=OTTO）用。
pub fn woff1_to_sfnt(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 44 || &data[0..4] != b"wOFF" {
        return Err("not a WOFF1 file".into());
    }
    let flavor = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    let num_tables = u16::from_be_bytes([data[12], data[13]]) as usize;
    if num_tables == 0 || num_tables > 512 {
        return Err(format!("implausible table count: {num_tables}"));
    }

    // 解出全部表：tag -> (数据, 原始校验和)
    let mut tables: Vec<([u8; 4], Vec<u8>, u32)> = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let off = 44 + i * 20;
        if off + 20 > data.len() {
            return Err("truncated WOFF table directory".into());
        }
        let mut tag = [0u8; 4];
        tag.copy_from_slice(&data[off..off + 4]);
        let tbl_off = u32::from_be_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]])
            as usize;
        let comp_len =
            u32::from_be_bytes([data[off + 8], data[off + 9], data[off + 10], data[off + 11]])
                as usize;
        let orig_len =
            u32::from_be_bytes([data[off + 12], data[off + 13], data[off + 14], data[off + 15]])
                as usize;
        let orig_cks =
            u32::from_be_bytes([data[off + 16], data[off + 17], data[off + 18], data[off + 19]]);
        let end = tbl_off.checked_add(comp_len).ok_or("bad table offset")?;
        if end > data.len() {
            return Err(format!("table {tag:?} out of bounds"));
        }
        let raw = &data[tbl_off..end];
        let decompressed: Vec<u8> = if comp_len < orig_len {
            // zlib 流（WOFF1 规范：压缩表用 zlib 格式）
            let mut out = Vec::with_capacity(orig_len);
            let mut decoder = flate2::read::ZlibDecoder::new(raw);
            use std::io::Read;
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("zlib decompress {tag:?}: {e}"))?;
            out
        } else {
            raw.to_vec()
        };
        if decompressed.len() != orig_len {
            return Err(format!("table {tag:?} length mismatch"));
        }
        tables.push((tag, decompressed, orig_cks));
    }
    if tables.is_empty() {
        return Err("no tables".into());
    }

    build_sfnt(flavor, tables)
}

/// 把 (tag, 数据) 集合组装成合法 sfnt：表按 tag 排序、4 字节对齐、
/// 每张表算校验和，最后修正 head.checkSumAdjustment。
fn build_sfnt(flavor: u32, mut tables: Vec<([u8; 4], Vec<u8>, u32)>) -> Result<Vec<u8>, String> {
    tables.sort_by(|a, b| a.0.cmp(&b.0));
    // tag 必须唯一
    for w in tables.windows(2) {
        if w[0].0 == w[1].0 {
            return Err(format!("duplicate table tag {:?}", w[0].0));
        }
    }
    let n = tables.len();
    // searchRange / entrySelector / rangeShift 按 OpenType 规范
    let entry_selector = (31 - (n as u32).leading_zeros()) as u16; // floor(log2(n))
    let search_range = 16u32 * (1u32 << entry_selector);
    let range_shift = (n as u32) * 16 - search_range;

    let dir_len = 12 + 16 * n;
    let mut out: Vec<u8> = Vec::with_capacity(dir_len + tables.iter().map(|t| t.1.len() + 3).sum::<usize>());
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&(n as u16).to_be_bytes());
    out.extend_from_slice(&(search_range as u16).to_be_bytes());
    out.extend_from_slice(&(entry_selector).to_be_bytes());
    out.extend_from_slice(&(range_shift as u16).to_be_bytes());

    // 先算偏移
    let mut offset = dir_len;
    let mut layout: Vec<([u8; 4], u32, u32, u32)> = Vec::with_capacity(n); // tag, offset, length, checksum
    for (tag, data, _) in &tables {
        let cks = calc_table_checksum(data);
        layout.push((*tag, offset as u32, data.len() as u32, cks));
        offset += (data.len() + 3) & !3;
    }
    for (tag, off, len, cks) in &layout {
        out.extend_from_slice(tag);
        out.extend_from_slice(&cks.to_be_bytes());
        out.extend_from_slice(&off.to_be_bytes());
        out.extend_from_slice(&len.to_be_bytes());
    }
    // 表数据（补零对齐）
    for (_, data, _) in &tables {
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }

    // head.checkSumAdjustment（head 表内偏移 8）：全文件校验和凑成 0xB1B0AFBA
    if let Some(&(tag, off, len, _)) = layout.iter().find(|t| t.0 == *b"head") {
        if tag == *b"head" && len >= 12 {
            let adj_pos = off as usize + 8;
            out[adj_pos..adj_pos + 4].copy_from_slice(&[0; 4]);
            let whole = calc_table_checksum(&out);
            let adjustment = 0xB1B0AFBAu32.wrapping_sub(whole);
            out[adj_pos..adj_pos + 4].copy_from_slice(&adjustment.to_be_bytes());
        }
    }
    Ok(out)
}

/// 提取 (family, full name)：typographic 优先，回退普通 family。
fn font_identity(data: &[u8]) -> Option<(String, String, u16, u16)> {
    let face = ttf_parser::Face::parse(data, 0).ok()?;
    let pick = |id: u16| {
        face.names()
            .into_iter()
            .filter(|n| n.name_id == id)
            .find_map(|n| n.to_string())
    };
    let family = pick(ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| pick(ttf_parser::name_id::FAMILY))?;
    let full = pick(ttf_parser::name_id::FULL_NAME)
        .or_else(|| pick(ttf_parser::name_id::POST_SCRIPT_NAME))
        .unwrap_or_default();
    Some((family, full, face.units_per_em(), face.number_of_glyphs()))
}

/// 两份字体数据是否为同一款字体（family + 字形规格一致才认）。
pub fn same_font(a: &[u8], b: &[u8]) -> bool {
    match (font_identity(a), font_identity(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// woff/woff2 解出来的 sfnt 该用什么扩展名
pub fn sfnt_extension(data: &[u8]) -> &'static str {
    if data.len() >= 4 && &data[0..4] == b"OTTO" {
        "otf"
    } else {
        "ttf"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用真字体手工拼一个最小 WOFF1：单表（无法通过 Face::parse，但结构可校验）
    fn wrap_woff(flavor: u32, tables: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        let n = tables.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"wOFF");
        out.extend_from_slice(&flavor.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // length 占位
        out.extend_from_slice(&(n as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // totalSfntSize 占位
        out.extend_from_slice(&1u16.to_be_bytes()); // major
        out.extend_from_slice(&0u16.to_be_bytes()); // minor
        out.extend_from_slice(&0u32.to_be_bytes()); // metaOffset
        out.extend_from_slice(&0u32.to_be_bytes()); // metaLength
        out.extend_from_slice(&0u32.to_be_bytes()); // metaOrigLength
        out.extend_from_slice(&0u32.to_be_bytes()); // privOffset
        out.extend_from_slice(&0u32.to_be_bytes()); // privLength
        let dir_len = 44 + n * 20;
        let mut offset = dir_len;
        let mut body: Vec<u8> = Vec::new();
        for (tag, data) in &tables {
            out.extend_from_slice(tag.as_bytes());
            out.extend_from_slice(&(offset as u32).to_be_bytes());
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(&calc_table_checksum(data).to_be_bytes());
            body.extend_from_slice(data);
            while body.len() % 4 != 0 {
                body.push(0);
            }
            offset = dir_len + body.len();
        }
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn woff1_roundtrip_minimal() {
        // 造一个假 head 表（>=12 字节）验证解包/组装/校验和修正不炸
        let mut head = vec![0u8; 54];
        head[8..12].copy_from_slice(&[0u8; 4]);
        let woff = wrap_woff(0x00010000, vec![("head", head)]);
        let sfnt = woff1_to_sfnt(&woff).expect("convert");
        assert_eq!(&sfnt[0..4], &0x00010000u32.to_be_bytes());
        assert_eq!(u16::from_be_bytes([sfnt[4], sfnt[5]]), 1);
        // head 表应出现在 sfnt 里且 checkSumAdjustment 已修正
        let tag_pos = sfnt
            .windows(4)
            .position(|w| w == b"head")
            .expect("head entry");
        let off = u32::from_be_bytes([
            sfnt[tag_pos + 8],
            sfnt[tag_pos + 9],
            sfnt[tag_pos + 10],
            sfnt[tag_pos + 11],
        ]) as usize;
        // adjustment = 0xB1B0AFBA - checksum(whole with zeroed adj) —— 只验证非零且已写回
        assert_ne!(&sfnt[off + 8..off + 12], &[0, 0, 0, 0]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(woff1_to_sfnt(b"nope").is_err());
        let mut w = wrap_woff(0x00010000, vec![("head", vec![0u8; 54])]);
        w[12] = 0x7F; // numTables 高位乱写
        assert!(woff1_to_sfnt(&w).is_err());
    }
}
