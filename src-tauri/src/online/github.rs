use super::{
    fontsource, license_file_name, license_info, licenses_dir, metadata_pb, slug_from_id, spdx_for_dir,
    staging_dir, DownloadProgress, DownloadResult, FamilyDetail,
};
use crate::net;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

pub const RAW_BASE: &str = "https://raw.githubusercontent.com/google/fonts/main";

/// 来源缩写：取 RAW_BASE 域名后的前两段，如 "google/fonts" → "google-fonts"
pub fn source_abbrev() -> String {
    let after_domain = RAW_BASE
        .split("://")
        .nth(1)
        .and_then(|s| s.splitn(2, '/').nth(1))
        .unwrap_or("unknown-source");
    let segs: Vec<&str> = after_domain.split('/').filter(|s| !s.is_empty()).collect();
    let abbrev = segs.iter().take(2).cloned().collect::<Vec<_>>().join("-");
    if abbrev.is_empty() {
        "unknown-source".to_string()
    } else {
        abbrev
    }
}

const DIRS: [&str; 3] = ["ofl", "apache", "ufl"];

fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn family_url(dir: &str, slug: &str, file: &str) -> String {
    format!("{RAW_BASE}/{dir}/{slug}/{}", encode_segment(file))
}

fn dir_order(preferred: &str) -> Vec<&'static str> {
    let mut v: Vec<&'static str> = Vec::with_capacity(3);
    if let Some(p) = DIRS.iter().find(|d| **d == preferred) {
        v.push(p);
    }
    for d in DIRS {
        if !v.contains(&d) {
            v.push(d);
        }
    }
    v
}

async fn locate(client: &reqwest::Client, slug: &str, preferred_dir: &str) -> Result<(String, metadata_pb::PbFamily), String> {
    let mut last_err = String::new();
    for dir in dir_order(preferred_dir) {
        match net::get_text(client, &family_url(dir, slug, "METADATA.pb")).await {
            Ok(text) => {
                let parsed = metadata_pb::parse(&text)?;
                return Ok((dir.to_string(), parsed));
            }
            Err(e) => last_err = e,
        }
    }
    // 目录用的是「族名全小写去空格」，和目录索引里的 id 不一定对得上：
    // 上游改名/下架后（如 Source Sans Pro → Source Sans 3）旧 id 会一直 404。
    Err(format!(
        "family '{slug}' not found in google/fonts — 该字体可能已在上游改名或下架（{last_err}）"
    ))
}

pub async fn detail(client: &reqwest::Client, id: &str) -> Result<FamilyDetail, String> {
    let cached = fontsource::cached_family(id).ok_or_else(|| format!("'{id}' is not in the catalogue cache"))?;
    let (preferred_dir, _, _) = license_info(&cached.license);
    let slug = slug_from_id(id);
    let (dir, pb) = locate(client, &slug, preferred_dir).await?;
    let spdx = spdx_for_dir(&dir);
    let (_, license_name, license_url) = license_info(spdx);
    let license_text = net::get_text(client, &family_url(&dir, &slug, license_file_name(&dir))).await?;
    let copyright = pb.fonts.first().map(|f| f.copyright.clone()).unwrap_or_default();
    let reserved = metadata_pb::reserved_font_name(&copyright);
    Ok(FamilyDetail {
        id: id.to_string(),
        family: pb.name,
        designer: pb.designer,
        category: cached.category,
        license: spdx.to_string(),
        license_name: license_name.to_string(),
        license_url: license_url.to_string(),
        reserved_font_name: reserved,
        copyright,
        files: pb.fonts,
        license_text,
        source_dir: dir,
    })
}

fn safe_name(filename: &str) -> Result<String, String> {
    PathBuf::from(filename)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("bad filename in METADATA.pb: {filename}"))
}

async fn fetch_into_staging(
    client: &reqwest::Client,
    det: &FamilyDetail,
    slug: &str,
    file: &metadata_pb::PbFont,
) -> Result<PathBuf, String> {
    let stage = staging_dir().join(slug);
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let dest = stage.join(safe_name(&file.filename)?);
    if let Ok(meta) = fs::metadata(&dest) {
        if meta.len() > 1024 {
            return Ok(dest);
        }
    }
    let bytes = net::get_bytes(client, &family_url(&det.source_dir, slug, &file.filename)).await?;
    if bytes.len() < 1024 {
        return Err(format!("{} came back suspiciously small ({} bytes)", file.filename, bytes.len()));
    }
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn preview_face(det: &FamilyDetail) -> Option<&metadata_pb::PbFont> {
    det.files
        .iter()
        .find(|f| f.style == "normal" && f.weight == 400)
        .or_else(|| det.files.iter().find(|f| f.style == "normal"))
        .or_else(|| det.files.first())
}

pub async fn preview(client: &reqwest::Client, id: &str) -> Result<String, String> {
    let det = detail(client, id).await?;
    let face = preview_face(&det).ok_or("family lists no files")?;
    let slug = slug_from_id(id);
    let path = fetch_into_staging(client, &det, &slug, face).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// 下载字族文件到 staging。
/// - `only_files`：只下这些文件名（None = 全部）。字库里已存在的字重不该重复下载。
/// - `want_license`：是否同时落许可证文本（只补版权文件时传 true 且 only_files 为空）。
pub async fn download(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    id: &str,
    only_files: Option<&[String]>,
    want_license: bool,
) -> Result<DownloadResult, String> {
    let det = detail(client, id).await?;
    let slug = slug_from_id(id);

    let mut seen = std::collections::HashSet::new();
    let files: Vec<&metadata_pb::PbFont> = det
        .files
        .iter()
        .filter(|f| seen.insert(f.filename.clone()))
        .filter(|f| match only_files {
            Some(list) => list.iter().any(|n| n == &f.filename),
            None => true,
        })
        .collect();
    let total = files.len();
    let mut paths: Vec<String> = Vec::with_capacity(total);
    crate::diag::log(&format!(
        "online[{}]: {} 个字体文件待下载（{}），license={}",
        id,
        total,
        match only_files {
            Some(_) => "只补字库里缺的",
            None => "全部",
        },
        want_license
    ));
    for (i, f) in files.iter().enumerate() {
        crate::diag::log(&format!("online[{}]: 下载 {}", id, f.filename));
        let _ = app.emit(
            "online:progress",
            DownloadProgress {
                id: id.to_string(),
                file: f.filename.clone(),
                done: i,
                total,
            },
        );
        let dest = fetch_into_staging(client, &det, &slug, f).await?;
        paths.push(dest.to_string_lossy().into_owned());
    }
    let _ = app.emit(
        "online:progress",
        DownloadProgress {
            id: id.to_string(),
            file: String::new(),
            done: total,
            total,
        },
    );

    let license_path = if want_license {
        fs::create_dir_all(licenses_dir()).map_err(|e| e.to_string())?;
        let path = licenses_dir().join(format!("{slug}.txt"));
        let header = format!(
            "{}\nDesigner: {}\nLicence: {} ({})\nSource: {RAW_BASE}/{}/{slug}/\n{}\n\n",
            det.family, det.designer, det.license_name, det.license, det.source_dir, det.copyright
        );
        fs::write(&path, format!("{header}{}", det.license_text)).map_err(|e| e.to_string())?;
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(DownloadResult {
        family: det.family,
        paths,
        license_path,
        source: source_abbrev(),
    })
}

pub fn clear_staging(id: &str) {
    let _ = fs::remove_dir_all(staging_dir().join(slug_from_id(id)));
}

// ── 按字体身份反查上游许可证 ──────────────────────────────────────────

/// 一条「确定是这款字体」的许可证命中记录
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseMatch {
    pub family: String,
    pub license: String,
    pub license_name: String,
    pub license_url: String,
    /// 建议写入的文件名（OFL.txt / LICENSE.txt / UFL.txt）
    pub file_name: String,
    /// 已带来源说明的许可证正文
    pub text: String,
    /// 匹配依据：命中的 PostScript 名
    pub postscript: String,
    pub slug: String,
    pub source_dir: String,
}

fn norm_name(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Google Fonts 的目录名规则：族名小写、去掉空格与非常规字符
fn dir_slugs(family: &str) -> Vec<String> {
    let lower = family.trim().to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for cand in [lower.replace(' ', ""), lower.replace(' ', "-")] {
        let cleaned: String = cand.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if !cleaned.is_empty() && !out.contains(&cleaned) {
            out.push(cleaned);
        }
    }
    out
}

/// 严格反查：族名必须完全一致，且 PostScript 名必须与上游列表里的某一条完全一致。
/// 两条都满足才算命中；任何一条对不上就当作没搜到（宁可漏，不可错）。
pub async fn search_license(
    client: &reqwest::Client,
    family: &str,
    postscripts: &[String],
) -> Result<Option<LicenseMatch>, String> {
    let want = norm_name(family);
    let wanted_ps: Vec<String> = postscripts
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if want.is_empty() || wanted_ps.is_empty() {
        return Ok(None);
    }

    for slug in dir_slugs(family) {
        for dir in DIRS {
            let Ok(meta) = net::get_text(client, &family_url(dir, &slug, "METADATA.pb")).await else {
                continue;
            };
            let Ok(pb) = metadata_pb::parse(&meta) else {
                continue;
            };
            // ① 族名必须完全一致
            if norm_name(&pb.name) != want {
                continue;
            }
            // ② 必须有一个 PostScript 名完全一致（同一款字体的身份证明）
            let Some(hit_ps) = wanted_ps.iter().find(|ps| {
                pb.fonts
                    .iter()
                    .any(|f| !f.post_script_name.trim().is_empty() && f.post_script_name.eq_ignore_ascii_case(ps))
            }) else {
                continue;
            };
            let Ok(text) = net::get_text(client, &family_url(dir, &slug, license_file_name(dir))).await else {
                continue;
            };
            // ③ 正文得像是许可证，别把 404 页面写进字体目录
            if text.len() < 512 || !text.to_lowercase().contains("license") {
                continue;
            }
            let (_, license_name, license_url) = license_info(spdx_for_dir(dir));
            let copyright = pb.fonts.first().map(|f| f.copyright.clone()).unwrap_or_default();
            let header = format!(
                "{}\nDesigner: {}\nLicence: {license_name} ({})\nMatched by PostScript name: {hit_ps}\nSource: {RAW_BASE}/{dir}/{slug}/\n{}\n\n",
                pb.name,
                pb.designer,
                spdx_for_dir(dir),
                copyright.trim()
            );
            return Ok(Some(LicenseMatch {
                family: pb.name,
                license: spdx_for_dir(dir).to_string(),
                license_name: license_name.to_string(),
                license_url: license_url.to_string(),
                file_name: license_file_name(dir).to_string(),
                text: format!("{header}{text}"),
                postscript: hit_ps.clone(),
                slug: slug.clone(),
                source_dir: dir.to_string(),
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_brackets_and_spaces() {
        assert_eq!(encode_segment("Lora[wght].ttf"), "Lora%5Bwght%5D.ttf");
        assert_eq!(encode_segment("Open Sans.ttf"), "Open%20Sans.ttf");
        assert_eq!(encode_segment("Lora-Italic.ttf"), "Lora-Italic.ttf");
    }

    #[test]
    fn builds_urls() {
        assert_eq!(
            family_url("ofl", "lora", "Lora[wght].ttf"),
            "https://raw.githubusercontent.com/google/fonts/main/ofl/lora/Lora%5Bwght%5D.ttf"
        );
    }

    #[test]
    fn preferred_dir_first() {
        assert_eq!(dir_order("apache"), vec!["apache", "ofl", "ufl"]);
        assert_eq!(dir_order("ofl"), vec!["ofl", "apache", "ufl"]);
        assert_eq!(dir_order("bogus"), vec!["ofl", "apache", "ufl"]);
    }

    #[test]
    fn dir_slugs_follow_google_rules() {
        assert_eq!(dir_slugs("Lora"), vec!["lora"]);
        assert_eq!(dir_slugs("Source Sans 3"), vec!["sourcesans3", "source-sans-3"]);
        assert_eq!(dir_slugs("Roboto Slab"), vec!["robotoslab", "roboto-slab"]);
        // 非拉丁族名推不出目录，宁可返回空也不瞎猜
        assert!(dir_slugs("思源黑体").is_empty());
        assert!(dir_slugs("   ").is_empty());
    }

    #[test]
    fn norm_name_ignores_case_and_padding() {
        assert_eq!(norm_name("  Lora "), norm_name("LORA"));
    }

    #[test]
    #[ignore]
    fn live_license_search_is_strict() {
        fn client() -> reqwest::Client {
            let mut st = crate::store::AppState::default();
            st.online_fonts_enabled = true;
            crate::net::client(&st).expect("client")
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let client = client();

            // 族名 + PostScript 都对得上 → 命中
            let hit = search_license(&client, "Lora", &["Lora-Regular".to_string()])
                .await
                .expect("search")
                .expect("lora should match");
            assert_eq!(hit.family, "Lora");
            assert_eq!(hit.file_name, "OFL.txt");
            assert!(hit.text.to_lowercase().contains("open font license"));

            // PostScript 对不上（同族名但不是这款字体）→ 不命中
            let miss = search_license(&client, "Lora", &["Arial-BoldMT".to_string()])
                .await
                .expect("search");
            assert!(miss.is_none(), "must not match on family name alone");

            // 没有 PostScript 名 → 不命中
            assert!(search_license(&client, "Lora", &[]).await.expect("search").is_none());

            // 上游已改名的旧条目 → 不命中
            let gone = search_license(&client, "Source Sans Pro", &["SourceSansPro-Regular".to_string()])
                .await
                .expect("search");
            assert!(gone.is_none());
        });
    }
}
