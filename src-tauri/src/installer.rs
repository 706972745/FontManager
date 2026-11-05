use crate::copyright;
use crate::font_types::{FontFace, FontSource, TrashEntry};
use crate::parser;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// 在线下载字体在库目录下的父文件夹名
pub const ONLINE_DIR_NAME: &str = "在线栏目";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub file: String,
    pub done: usize,
    pub total: usize,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub installed: Vec<FontFace>,
    pub errors: Vec<String>,
    pub duplicates: Vec<String>,
    /// 本次导入跳过的 WOFF/WOFF2 个数（同字体已有 ttf/otf，或 woff2 不受支持）
    #[serde(default)]
    pub webfonts_skipped: usize,
    /// 因「系统已经装了这个字体」而没入库的文件数（避免在库里造出重复副本）
    #[serde(default)]
    pub system_duplicates: usize,
    /// 「移动」导入时跨盘降级成「复制 + 源文件进回收站」的源路径（C7）。
    /// 非空时前端必须告诉用户源文件去哪了，不能只说「导入成功」。
    #[serde(default)]
    pub recycled_sources: Vec<String>,
    /// 本次真正复制进字族目录的版权/说明文档数
    #[serde(default)]
    pub docs_copied: usize,
    /// 目标目录里已有**内容完全相同**的文档，跳过不重复写
    #[serde(default)]
    pub docs_skipped: usize,
    /// 找不到明确归属、因此没有归档的文档数（多字族批次里的散装文档）。
    /// 源文件仍在原处，只是不往字族目录里塞 —— 见 license_targets 的注释。
    #[serde(default)]
    pub docs_unassigned: usize,
    /// 同名但内容不同的文档：记下目标路径，不覆盖、也不生成 N- 副本
    #[serde(default)]
    pub doc_conflicts: Vec<String>,
    /// 因「一个压缩包里混了多个字族」被整包拒绝的包。
    /// 非空时前端要明确说清是哪个包、里面有哪些字族，而不是只说「没导进来」。
    #[serde(default)]
    pub rejected_zips: Vec<RejectedZip>,
}

/// 被拒绝导入的压缩包：一个包里混了多个字族。
///
/// 为什么要拒（用户 2026-11-02 的要求）：压缩包的包名会作为「文件夹备注」参与版权判定，
/// 包内平铺的授权文档又没法归属到具体字族（见 resolve_class 的注释）。一个包装多个字族时，
/// 这份备注 / 文档会被套到包内**所有**字体上 —— 与其猜，不如整包拒绝、让用户按字族拆开再导。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RejectedZip {
    /// 压缩包文件名（不带目录，便于直接展示）
    pub name: String,
    /// 包里识别到的字族名（最多 `ZIP_FAMILY_LIST_MAX` 个）
    pub families: Vec<String>,
    /// 被拒绝的字体文件数
    pub font_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    Link,
    /// 搬进字体库（源文件被移走 / 进回收站）
    Move,
    /// 复制进字体库（源文件夹原样保留）—— 「导入文件夹」按钮用这个
    Copy,
}

impl InstallMode {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "link" => Ok(Self::Link),
            "move" => Ok(Self::Move),
            "copy" => Ok(Self::Copy),
            _ => Err(format!("unknown install mode: {s}")),
        }
    }
}
pub fn dup_key(face: &FontFace) -> String {
    face.postscript_name
        .clone()
        .unwrap_or_else(|| format!("{} {}", face.family, face.style))
}

fn move_file(from: &Path, to: &Path) -> Result<bool, String> {
    if fs::rename(from, to).is_ok() {
        return Ok(false);
    }
    fs::copy(from, to).map_err(|e| e.to_string())?;
    recycle(from)?;
    // 跨盘：`rename` 必然失败，退化成「复制 + 把源文件送进 Windows 回收站」。
    // 返回 true 让调用方把源文件去向告诉用户 —— 以前这里完全静默，界面只说「导入成功」，
    // 用户以为文件被搬走了，实际躺在回收站里（C7）。
    Ok(true)
}

/// 把字体放到目标位置：`copy_only = true` 时只复制一份（源文件保留）。
///
/// 「导入文件夹」按钮用复制模式——用户 2026-10-30 要求：不移动、不走链接，
/// 把字体复制进软件的字库目录，原来的文件夹原样不动。
///
/// 返回值 `true` 表示「跨盘移动」：源文件已经进了回收站，调用方应当告知用户。
fn place_file(from: &Path, to: &Path, copy_only: bool) -> Result<bool, String> {
    if copy_only {
        fs::copy(from, to).map(|_| false).map_err(|e| e.to_string())
    } else {
        move_file(from, to)
    }
}

/// 导入失败时，把刚为这个文件建出来、而且仍然是空的字族目录收掉。
///
/// 只处理「库内的、确实是空的」目录：库根本身和分类目录（`_01_中文字体` 这类）
/// 一律不动 —— 它们不是为某个文件建的，删了会把用户的组织结构弄塌。
fn prune_empty_dir(dir: &Path, library: &Path) {
    if dir == library || !dir.starts_with(library) {
        return;
    }
    let empty = fs::read_dir(dir)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if empty {
        let _ = fs::remove_dir(dir);
    }
}

fn recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

fn unique_dest(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut dest = dir.join(file_name);
    let mut n = 1;
    // 账本文件也要避让：只避让字体会出现「文件没重名、账本被上一轮的同名条目压掉」，
    // 那条旧条目就从此消失在回收站视图里（文件还在，但查不到记录）。
    while dest.exists() || sidecar_path(&dest).exists() {
        dest = dir.join(format!("{n}-{}", file_name.to_string_lossy()));
        n += 1;
    }
    dest
}

/// 回收站条目的「账本」：与字体文件同 stem，扩展名换成 `<ext>.zfmtrash`。
/// `list_trash` 只认账本，界面里看得见、能还原的条目全凭它。
fn sidecar_path(dest: &Path) -> PathBuf {
    dest.with_extension(format!(
        "{}.zfmtrash",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ))
}

/// 暂存/待处理文件：字体 或 版权信息类文件（许可证、版权说明等）
#[derive(Debug, Clone)]
pub struct StagedFile {
    pub path: PathBuf,
    /// 是否为字体文件（false = 版权信息类文件）
    pub is_font: bool,
    /// 是否来自 zip 压缩包（zip 导入无论选择何种模式都移动进字体库）
    pub is_zip: bool,
    /// 是否为本批转换出的文件（WOFF 解包的 sfnt 落在 staging 临时目录，
    /// 没有「源路径」可链，与 zip 一样强制移动进字体库）
    pub converted: bool,
    /// 在压缩包/拖入文件夹内的相对目录（空 = 根目录），用于把许可证与对应字体归到同一字族
    pub rel: PathBuf,
    /// 这一条来自哪个「批次」：压缩包路径 / 拖入的文件夹路径 / None（散装单个文件）。
    /// 一次拖入多个 zip（或多个文件夹）时，解压后都平铺在同一个 staging 目录里，
    /// 只靠 rel 区分会把 A 包的授权文件套到 B 包的字体上，所以匹配许可证要连它一起看。
    pub origin: Option<PathBuf>,
    /// 文件夹备注的版权信息：文件所在文件夹的名字（zip 用压缩包名）。
    /// 文件夹名里写明版权时（"Lora（免费字体）"）按它分类，权重低于版权信息文件、
    /// 高于字体自带的版权信息。
    pub folder_note: Option<String>,
}

impl StagedFile {
    fn new(path: PathBuf, is_font: bool, is_zip: bool, rel: PathBuf, note: Option<String>) -> Self {
        StagedFile {
            path,
            is_font,
            is_zip,
            converted: false,
            rel,
            origin: None,
            folder_note: note,
        }
    }
}

/// 取「文件夹备注的版权信息」：文件所在文件夹的名字；zip 来源用压缩包名（解压后是平铺的临时目录，没有意义）
fn folder_note_for(path: &Path, is_zip: bool, zip_stem: Option<&str>) -> Option<String> {
    if is_zip {
        return zip_stem.map(|s| s.to_string());
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
}

/**
 * 导入时判定一个字族的版权分类，三级权重：
 *   1. 版权信息文件（同目录 / 唯一的一份 LICENSE、OFL、版权说明…的正文）
 *   2. 文件夹备注的版权信息（文件夹名里写明的版权）
 *   3. 字体自带的版权信息（name 表 license → copyright）
 * 权重高的那一级识别出结果就用它，识别不出才往下一级走。
 */
/// 版权信息文件的归属键：同一个压缩包/文件夹里的同一相对目录
type InfoKey = (Option<PathBuf>, PathBuf);

/// 归属键的唯一构造点：批次（origin）+ 相对目录（rel）。
/// 分组和查找都必须走它，否则「按包隔离」这个约束会在某一边悄悄失效。
fn info_key_for(staged: &StagedFile) -> InfoKey {
    (staged.origin.clone(), staged.rel.clone())
}

/// 把版权信息类文件按归属键分组（install 与单元测试共用同一套分组）
fn group_infos(
    infos: &[StagedFile],
) -> std::collections::HashMap<InfoKey, Vec<PathBuf>> {
    let mut map: std::collections::HashMap<InfoKey, Vec<PathBuf>> =
        std::collections::HashMap::new();
    for i in infos {
        map.entry(info_key_for(i)).or_default().push(i.path.clone());
    }
    map
}

fn resolve_class(
    staged: &StagedFile,
    faces: &[FontFace],
    infos_by_rel: &std::collections::HashMap<InfoKey, Vec<PathBuf>>,
    all_infos: &[(Option<PathBuf>, PathBuf)],
    scope: copyright::DocScope,
) -> copyright::CopyrightClass {
    // 1. 版权信息文件：优先与字体「同批次 + 同目录」的那些。
    //    批次（origin）必须一致：一次拖入多个 zip 时它们都平铺在同一个 staging 里，
    //    只看相对目录会把 A 包的 OFL 套到 B 包的字体上。
    //
    //    **但文档还得能归属到这个字族**：目录里混着多个字族时，一份 OFL 不能代表
    //    别人家的字体。旧版这里无条件采信第一个判出结果的文档，于是
    //    「其他Fonts」这种平铺目录（4923 个字体 + 1 份 OFL）被整体染成「商用免费」。
    let key = info_key_for(staged);
    let mut candidates: Vec<PathBuf> = infos_by_rel.get(&key).cloned().unwrap_or_default();
    if scope == copyright::DocScope::Mixed {
        // 多字族目录：只认「文件名里写了这个字族」的文档，其余一律不猜
        let family = faces
            .iter()
            .find(|f| !f.name_fallback)
            .map(|f| f.family.as_str())
            .unwrap_or("");
        let token = copyright::norm_token(family);
        if token.len() < 4 {
            candidates.clear();
        } else {
            candidates.retain(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| copyright::norm_token(n).contains(&token))
                    .unwrap_or(false)
            });
        }
    }
    // 跨目录兜底：整批只有一份、且和自己同一批次时才敢采信。
    // 目录里混着多个字族时不做这个兜底 —— 那一份多半是「整包授权」，归属不明。
    if candidates.is_empty() && scope == copyright::DocScope::Family {
        if let [(origin, path)] = all_infos {
            if *origin == staged.origin {
                candidates = vec![path.clone()];
            }
        }
    }
    for p in candidates {
        if let Some(text) = read_text_snippet(&p, 64 * 1024) {
            let class = copyright::classify(Some(&text));
            if class != copyright::CopyrightClass::Unknown {
                return class;
            }
        }
    }
    // 2. 原来的「文件夹备注」这一级已删除（v7）：目录名是软件自己写的，
    //    读回来当依据等于自证。用户要手工指定版权，走详情面板的下拉。
    // 3. 字体自带的版权信息
    for f in faces {
        let class = copyright::classify(f.license.as_deref());
        if class != copyright::CopyrightClass::Unknown {
            return class;
        }
        let class = copyright::classify(f.copyright.as_deref());
        if class != copyright::CopyrightClass::Unknown {
            return class;
        }
    }
    copyright::CopyrightClass::Unknown
}

/// 读一小段文本用于版权分类（许可证文件可能很大）
fn read_text_snippet(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.by_ref().take(limit as u64).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// 判断是否为值得保留的版权信息类文件（许可证、版权声明、说明文档等）
pub(crate) fn is_info_file(name: &Path) -> bool {
    let Some(fname) = name.file_name().and_then(|f| f.to_str()) else {
        return false;
    };
    let lower = fname.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if matches!(ext, "ttf" | "otf" | "ttc" | "woff" | "woff2") {
        return false;
    }
    let keyword = ["license", "licence", "copyright", "ofl", "readme", "notice", "patents", "授权", "版权", "许可"]
        .iter()
        .any(|k| lower.contains(k));
    matches!(ext, "txt" | "md" | "pdf") || keyword
}

fn expand_dropped(path: &Path, staging: &Path) -> Result<Vec<StagedFile>, String> {
    if path.is_dir() {
        let mut out = Vec::new();
        for e in walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let p = e.path();
            let rel = p
                .strip_prefix(path)
                .ok()
                .and_then(|r| r.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_default();
            let note = folder_note_for(p, false, None);
            if parser::is_font_file(p) {
                let mut st = StagedFile::new(p.to_path_buf(), true, false, rel, note);
                st.origin = Some(path.to_path_buf());
                out.push(st);
            } else if is_info_file(p) {
                let mut st = StagedFile::new(p.to_path_buf(), false, false, rel, note);
                st.origin = Some(path.to_path_buf());
                out.push(st);
            }
        }
        return Ok(out);
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        fs::create_dir_all(staging).map_err(|e| e.to_string())?;
        // 解压后是平铺的临时目录，文件夹备注只能看压缩包自己的名字
        let zip_note = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string());
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(name) = entry.enclosed_name() else { continue };
            let is_font = parser::is_font_file(&name);
            let is_info = !is_font && is_info_file(&name);
            if !is_font && !is_info {
                continue; // 其余文件（安装器、图片等）不保留
            }
            let file_name = name.file_name().ok_or("bad zip entry")?.to_owned();
            let dest = unique_dest(staging, &file_name);
            let mut out_file = fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            let mut st = StagedFile::new(
                dest,
                is_font,
                true,
                name.parent().map(|pp| pp.to_path_buf()).unwrap_or_default(),
                zip_note.clone(),
            );
            st.origin = Some(path.to_path_buf());
            out.push(st);
        }
        return Ok(out);
    }
    if parser::is_font_file(path) {
        return Ok(vec![StagedFile::new(
            path.to_path_buf(),
            true,
            false,
            PathBuf::new(),
            folder_note_for(path, false, None),
        )]);
    }
    Err(format!("not a font file: {}", path.display()))
}

/// WOFF/WOFF2 的导入判重与解包（规则见 webfonts 模块注释）：
/// - 与同目录同名的 ttf/otf 是同一款字体 → 跳过 woff（计数 webfontsSkipped）；
/// - 落单的 WOFF1 → 解包成 sfnt 落到 staging，作为转换文件强制移动进字体库；
/// - WOFF2 → 跳过（GDI 不支持，转换需要 Brotli + 变换表重建，暂不实现）。
fn process_webfonts(
    files: Vec<StagedFile>,
    staging: &Path,
    result: &mut InstallResult,
) -> Vec<StagedFile> {
    // staging 以前只在 zip 分支建目录；落单 WOFF 解包也要往这里写，
    // 拖放/导入文件夹时它并不存在 → fs::write 报 os error 3（系统找不到指定的路径）。
    // 解包要写文件就先把目录准备好（失败不早退，后面 write 会给出具体错误）。
    if files.iter().any(|f| crate::webfonts::webfont_ext(&f.path).is_some()) {
        let _ = fs::create_dir_all(staging);
    }
    let (rest, webs): (Vec<_>, Vec<_>) = files.into_iter().partition(|f| {
        !(f.is_font && crate::webfonts::webfont_ext(&f.path).is_some())
    });
    if webs.is_empty() {
        return rest;
    }

    // 同批兄弟索引：(相对目录, 小写主干) -> ttf/otf 暂存路径
    let mut siblings: std::collections::HashMap<(Option<PathBuf>, String, String), Vec<PathBuf>> =
        std::collections::HashMap::new();
    for f in &rest {
        if !f.is_font {
            continue;
        }
        let ext = f
            .path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("ttf") | Some("otf")) {
            continue;
        }
        if let Some(stem) = f.path.file_stem().and_then(|s| s.to_str()) {
            let key = (
                f.origin.clone(),
                f.rel.to_string_lossy().to_lowercase(),
                stem.to_lowercase(),
            );
            siblings.entry(key).or_default().push(f.path.clone());
        }
    }

    let mut out = rest;
    for f in webs {
        let ext = crate::webfonts::webfont_ext(&f.path).unwrap_or("woff");
        let name = f
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 同批兄弟（zip 解压平铺时靠 rel 区分目录）
        let batch_sibs = f
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| {
                siblings
                    .get(&(
                        f.origin.clone(),
                        f.rel.to_string_lossy().to_lowercase(),
                        stem.to_lowercase(),
                    ))
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        // 磁盘同目录同名（单个文件拖入时批次里没有兄弟；zip 来源没有真实目录概念）
        let mut disk_sibs: Vec<PathBuf> = Vec::new();
        if !f.is_zip {
            if let (Some(parent), Some(stem)) = (f.path.parent(), f.path.file_stem()) {
                if let Ok(rd) = fs::read_dir(parent) {
                    for e in rd.flatten() {
                        let p = e.path();
                        let Some(x) = p.extension().and_then(|e| e.to_str()) else { continue };
                        if !matches!(x.to_ascii_lowercase().as_str(), "ttf" | "otf") {
                            continue;
                        }
                        if p.file_stem().is_some_and(|s| s.eq_ignore_ascii_case(stem)) {
                            disk_sibs.push(p);
                        }
                    }
                }
            }
        }

        // 身份比对：woff 解包后的 sfnt 与任一兄弟同字体 → 跳过
        let mut is_same = false;
        'check: for sib in batch_sibs.iter().chain(disk_sibs.iter()) {
            let (Ok(wdata), Ok(sdata)) = (fs::read(&f.path), fs::read(sib)) else {
                continue;
            };
            let Ok(sfnt) = crate::webfonts::woff1_to_sfnt(&wdata) else {
                break 'check; // woff 坏了，走后面的解包报错路径
            };
            if crate::webfonts::same_font(&sfnt, &sdata) {
                is_same = true;
                break;
            }
        }
        if is_same {
            result.webfonts_skipped += 1;
            continue;
        }
        if ext == "woff2" {
            // GDI 加载不了 woff2，转换又需要 Brotli + 变换表重建：跳过并计数
            result.webfonts_skipped += 1;
            continue;
        }

        // 落单的 WOFF1：解包成 sfnt，强制移动进字体库
        let converted = match fs::read(&f.path) {
            Ok(data) => match crate::webfonts::woff1_to_sfnt(&data) {
                Ok(sfnt) => {
                    let ext2 = crate::webfonts::sfnt_extension(&sfnt);
                    let stem = f
                        .path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "font".into());
                    let dest = unique_dest(staging, Path::new(&format!("{stem}.{ext2}")).as_os_str());
                    match fs::write(&dest, &sfnt) {
                        Ok(()) => Some(StagedFile {
                            path: dest,
                            is_font: true,
                            is_zip: false,
                            converted: true,
                            rel: f.rel.clone(),
                            origin: f.origin.clone(),
                            folder_note: f.folder_note.clone(),
                        }),
                        Err(e) => {
                            result.errors.push(format!("woff → {ext2}: {e}"));
                            None
                        }
                    }
                }
                Err(e) => {
                    result.errors.push(format!("{name}: {e}"));
                    None
                }
            },
            Err(e) => {
                result.errors.push(format!("{name}: {e}"));
                None
            }
        };
        if let Some(c) = converted {
            out.push(c);
        } else {
            result.webfonts_skipped += 1;
        }
    }
    out
}

/// 把**整族**损坏的字体挪进 `<字库>/非完整字体/<字族（版权）/`。
///
/// 用户 2026-10-30 定：**字族里只要有一个字重坏了，整个字族都要进「非完整字体」目录**
/// —— 半个字族留在外面、半个在里面的状态最难理解，也不方便一次性清理。
///
/// 所以这里按**字族**判断，不按文件：族里任何字面 `incomplete` 为真，就把这一族
/// 在字库目录里的所有文件都搬进去（系统目录里的不动，那不是我们的文件）。
/// 挪不动（被占用 / 只读）就原地留着，下次扫描再试。
/// 返回 `(旧路径, 新路径)`，调用方据此更新 state 与内存里的字面。
pub fn relocate_incomplete(library: &Path, faces: &[FontFace]) -> Vec<(String, String)> {
    let root = library.join(copyright::INCOMPLETE_DIR);
    // 按字族聚合：任一字面坏 → 整族算坏
    let mut family_broken: std::collections::HashMap<&str, bool> =
        std::collections::HashMap::new();
    let mut family_class: std::collections::HashMap<&str, crate::copyright::CopyrightClass> =
        std::collections::HashMap::new();
    for f in faces {
        let flag = family_broken.entry(f.family.as_str()).or_insert(false);
        // 只有「文件本身坏了」（读不出 / 解析失败）才自动搬。
        // 「缺 cmap / 0 字形」只标记不搬 —— 老字体格式特殊的情况不少，不能擅自动用户文件。
        if f.incomplete.as_deref().is_some_and(crate::parser::is_hard_damage) {
            *flag = true;
        }
        if let Some(cls) = copyright::class_from_status(f.copyright_class.as_deref().unwrap_or("")) {
            family_class.entry(f.family.as_str()).or_insert(cls);
        }
    }
    let mut moved: Vec<(String, String)> = Vec::new();
    let mut done: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for f in faces {
        // 这一族一个坏字面都没有 → 留在原地
        if !family_broken.get(f.family.as_str()).copied().unwrap_or(false) {
            continue;
        }
        let src = Path::new(&f.path);
        if !src.is_file() || !src.starts_with(library) || src.starts_with(&root) {
            continue;
        }
        // 一个文件可能产多个字面，只搬一次
        if !done.insert(f.path.as_str()) {
            continue;
        }
        let class = family_class
            .get(f.family.as_str())
            .copied()
            .unwrap_or(crate::copyright::CopyrightClass::Unknown);
        let dir = root.join(copyright::family_dir_name(&f.family, class));
        if fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let Some(name) = src.file_name() else { continue };
        let dest = unique_dest(&dir, name);
        if fs::rename(src, &dest).is_err() {
            continue;
        }
        crate::diag::log(&format!(
            "[incomplete] 整族归集 {:?} → {:?}",
            src, dest
        ));
        moved.push((
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        ));
    }
    moved
}

/// 提示里最多列几个字族名（再多就用「等」概括，提示框一屏放得下）
const ZIP_FAMILY_LIST_MAX: usize = 5;

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

/// 扫一批字体，按出现顺序收集其中不同的字族名。
///
/// 凑够 `want` 个就停 —— 判定「是不是多字族包」只需要看到第二个，几百个字体的大包
/// 不必为此全解析一遍。解析不出来的（占位字面 `name_fallback`）不算数，
/// 否则包里混一个坏文件就可能把正常包误拒。
fn zip_families(fonts: &[&StagedFile], want: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for f in fonts {
        for face in parser::parse_font_file(&f.path, FontSource::Managed) {
            if face.name_fallback {
                continue;
            }
            let shown = face.family.trim();
            if shown.is_empty() {
                continue;
            }
            // 比较用规范化键（压空白 + 小写），展示用原样：不同字重的 name 表偶尔有
            // 大小写 / 尾空格差异，不规范化会把同一族算成两族。
            let key = shown.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            out.push(shown.to_string());
            if out.len() >= want {
                return out;
            }
        }
    }
    out
}

/// 把「混了多个字族」的压缩包整包摘掉：字体、连同它解压出来的授权文档一起丢弃。
///
/// 只认 zip 来源 —— 拖入的文件夹有真实目录结构，授权文档能按目录归属到字族，不需要拒。
/// 一次拖入多个包时逐个判定：只拒有问题的那个，正常的包照常导入。
fn reject_multi_family_zips(files: Vec<StagedFile>) -> (Vec<StagedFile>, Vec<RejectedZip>) {
    let mut by_origin: std::collections::HashMap<PathBuf, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, f) in files.iter().enumerate() {
        if !f.is_font {
            continue;
        }
        let Some(origin) = &f.origin else { continue };
        // 只按来源判断是不是 zip（WOFF 解包出的转换文件 is_zip=false，但 origin 仍是那个包）
        if !is_zip_path(origin) {
            continue;
        }
        by_origin.entry(origin.clone()).or_default().push(i);
    }
    if by_origin.is_empty() {
        return (files, Vec::new());
    }

    let mut rejected: Vec<RejectedZip> = Vec::new();
    let mut drop_origins: HashSet<PathBuf> = HashSet::new();
    for (origin, idx) in by_origin {
        let refs: Vec<&StagedFile> = idx.iter().map(|&i| &files[i]).collect();
        let families = zip_families(&refs, ZIP_FAMILY_LIST_MAX + 1);
        // 0 个 = 里面的字体一个都解析不出来（坏包），交给后面的正常流程报错；
        // 1 个 = 单字族，放行
        if families.len() < 2 {
            continue;
        }
        crate::diag::log(&format!(
            "[install] 拒绝多字族压缩包 {:?}：{:?}（{} 个字体文件）",
            origin,
            families,
            refs.len()
        ));
        rejected.push(RejectedZip {
            name: origin
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            families: families.into_iter().take(ZIP_FAMILY_LIST_MAX).collect(),
            font_count: refs.len(),
        });
        drop_origins.insert(origin);
    }
    if rejected.is_empty() {
        return (files, rejected);
    }
    rejected.sort_by(|a, b| a.name.cmp(&b.name));
    let kept: Vec<StagedFile> = files
        .into_iter()
        .filter(|f| !f.origin.as_ref().is_some_and(|o| drop_origins.contains(o)))
        .collect();
    (kept, rejected)
}

pub fn install(
    app: &tauri::AppHandle,
    dropped: Vec<String>,
    existing: &HashSet<String>,
    mode: InstallMode,
    library: &Path,
) -> InstallResult {
    let staging = crate::store::app_data_dir().join("staging");
    let mut result = InstallResult::default();
    let mut known: HashSet<String> = existing.clone();

    let mut files: Vec<StagedFile> = Vec::new();
    for p in &dropped {
        match expand_dropped(Path::new(p), &staging) {
            Ok(mut f) => files.append(&mut f),
            Err(e) => result.errors.push(e),
        }
    }
    // WOFF 判重 / 解包（见 process_webfonts 与 webfonts 模块注释）
    let files = process_webfonts(files, &staging, &mut result);

    // 混装多个字族的压缩包 → 整包拒绝（见 reject_multi_family_zips 的注释）
    let (files, rejected_zips) = reject_multi_family_zips(files);
    result.rejected_zips = rejected_zips;

    // zip 导入无论选择何种模式都移动进字体库（zip 解压出的临时文件没有"链接"意义）；
    // WOFF 解包出的转换文件落在 staging 临时目录，同理强制移动
    let any_zip = files.iter().any(|f| f.is_zip || f.converted);

    let infos: Vec<StagedFile> = files
        .iter()
        .filter(|f| !f.is_font)
        .cloned()
        .collect();
    let fonts: Vec<StagedFile> = files.into_iter().filter(|f| f.is_font).collect();
    let total = fonts.len();
    // 系统已装字体的 PostScript 名（缓存一次）：命中就别再往库里复制一份
    let sys_ps = crate::scanner::system_postscript_names();

    // 版权信息文件按「批次 + 相对目录」归好类，供「版权信息文件 > 文件夹备注 > 字体自带」的权重判断。
    // 批次必带：一次拖入多个 zip/文件夹时，它们解压后共用一个 staging 平铺目录。
    let infos_by_rel = group_infos(&infos);
    let all_infos: Vec<(Option<PathBuf>, PathBuf)> = infos
        .iter()
        .map(|i| (i.origin.clone(), i.path.clone()))
        .collect();

    // 每个「批次 + 相对目录」里到底有几个字族 —— 决定那里的授权文档能不能归属到具体字族。
    // 只在有授权文档时才需要算；而且见到第二个字族就停，平铺目录几乎不花时间。
    let mut key_scope: std::collections::HashMap<InfoKey, copyright::DocScope> =
        std::collections::HashMap::new();
    if !infos_by_rel.is_empty() {
        let mut first_family: std::collections::HashMap<InfoKey, String> =
            std::collections::HashMap::new();
        for f in &fonts {
            let key = info_key_for(f);
            if !infos_by_rel.contains_key(&key) {
                continue;
            }
            if key_scope.get(&key) == Some(&copyright::DocScope::Mixed) {
                continue;
            }
            for face in parser::parse_font_file(&f.path, FontSource::Managed) {
                if face.name_fallback {
                    continue;
                }
                match first_family.get(&key) {
                    None => {
                        first_family.insert(key.clone(), face.family.clone());
                    }
                    Some(first) if *first != face.family => {
                        key_scope.insert(key.clone(), copyright::DocScope::Mixed);
                        break;
                    }
                    _ => {}
                }
            }
        }
        // 没被标成 Mixed 的（真·单字族目录）才是 Family
        for key in infos_by_rel.keys() {
            key_scope
                .entry(key.clone())
                .or_insert(copyright::DocScope::Family);
        }
    }

    if matches!(mode, InstallMode::Move | InstallMode::Copy) || any_zip {
        if let Err(e) = fs::create_dir_all(library) {
            result.errors.push(e.to_string());
            return result;
        }
    }

    // 归档追踪：批次+相对目录 → 该目录中的字体被归入的字族目录；
    // 以及本次安装创建的全部字族目录（按批次再分一份，许可证回填时不能跨包乱发）
    let mut rel_family_dirs: std::collections::HashMap<InfoKey, Vec<PathBuf>> =
        std::collections::HashMap::new();
    let mut all_family_dirs: Vec<PathBuf> = Vec::new();
    let mut origin_family_dirs: std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>> =
        std::collections::HashMap::new();

    for (i, staged) in fonts.into_iter().enumerate() {
        let src = staged.path.clone();
        let src_faces = parser::parse_font_file(&src, FontSource::Managed);
        // 系统里已经装了这个字体 → 不再复制/链接一份进库。
        // 以前判重只看**路径**（known），同一个字体从别处拷过来就算"新"，
        // 于是库里越攒越多和系统重复的副本（用户 2026-10-31 问「以后还会不会自动再复制一份」）。
        if !sys_ps.is_empty()
            && src_faces.iter().any(|f| {
                f.postscript_name
                    .as_ref()
                    .map(|ps| sys_ps.contains(&ps.to_lowercase()))
                    .unwrap_or(false)
            })
        {
            result.system_duplicates += 1;
            continue;
        }
        let src_keys: Vec<String> = src_faces.iter().map(dup_key).collect();
        if !src_keys.is_empty() && src_keys.iter().all(|k| known.contains(k)) {
            for k in &src_keys {
                if !result.duplicates.contains(k) {
                    result.duplicates.push(k.clone());
                }
            }
            let _ = app.emit(
                "install:progress",
                InstallProgress {
                    file: src
                        .file_name()
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    done: i + 1,
                    total,
                    ok: true,
                    error: None,
                },
            );
            continue;
        }
        // zip 来源的字体强制走移动模式，保证字体与版权信息文件一起进入字体库；
        // WOFF 解包的转换文件落在 staging 临时目录，同理强制移动
        let eff_mode = if staged.is_zip || staged.converted {
            InstallMode::Move
        } else {
            mode
        };
        match eff_mode {
            InstallMode::Link => {
                if src_faces.is_empty() {
                    let name = src
                        .file_name()
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let _ = app.emit(
                        "install:progress",
                        InstallProgress {
                            file: name.clone(),
                            done: i + 1,
                            total,
                            ok: false,
                            error: Some("couldn't read font file".to_string()),
                        },
                    );
                    result
                        .errors
                        .push(format!("couldn't read font file: {}", src.display()));
                    continue;
                }
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        file: src
                            .file_name()
                            .map(|f| f.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        done: i + 1,
                        total,
                        ok: true,
                        error: None,
                    },
                );
                let mut faces = src_faces.clone();
                for face in &mut faces {
                    face.active = false;
                    known.insert(dup_key(face));
                }
                result.installed.extend(faces);
            }
            InstallMode::Move | InstallMode::Copy => {
                let file_name = src.file_name().map(|f| f.to_owned()).unwrap_or_default();
                // 按字族归档：<库目录>/<家族名（版权后缀）>/；解析失败时退回库根目录
                // 目录后缀按「版权信息文件 > 文件夹备注 > 字体自带信息」三级权重判定
                let class = if src_faces.is_empty() {
                    None
                } else {
                    Some(resolve_class(
                        &staged,
                        &src_faces,
                        &infos_by_rel,
                        &all_infos,
                        key_scope
                            .get(&info_key_for(&staged))
                            .copied()
                            .unwrap_or(copyright::DocScope::Family),
                    ))
                };
                // 损坏 / 不完整的字体单独归档到 <库>/非完整字体/<家族（版权后缀）>/：
                // 用户 2026-10-30 要求坏字体别跟正常字族混在一起，筛选里也能单独看到。
                // 整份文件里的字面**全**坏才搬走：.ttc 这类一个文件装多个字面，
                // 只要还有一个好字面，文件本身就不能拆，搬走等于把好字面也关起来。
                let incomplete = !src_faces.is_empty()
                    && src_faces
                        .iter()
                        .all(|f| f.incomplete.as_deref().is_some_and(crate::parser::is_hard_damage));
                let base = if incomplete {
                    library.join(copyright::INCOMPLETE_DIR)
                } else {
                    library.to_path_buf()
                };
                // 真族名（不是拿文件名顶上的那种）。假族名一律收进「未识别字体」这一个桶：
                // 否则「导入一批」就产生一批 `<文件名>（未知版权）` 目录，内容一搬走就成空壳。
                let real_family = src_faces
                    .first()
                    .filter(|f0| !f0.name_fallback)
                    .map(|f0| f0.family.as_str());
                let target_dir = match (real_family, class) {
                    (Some(fam), Some(class)) => base.join(copyright::family_dir_name(fam, class)),
                    (None, Some(class)) => base.join(copyright::family_dir_name(
                        copyright::UNIDENTIFIED_FAMILY,
                        class,
                    )),
                    // 版权判不出来（只剩残缺字体这条路）：至少按族名分目录，别摊在根上
                    (Some(fam), None) if incomplete => base.join(copyright::sanitize(fam)),
                    (None, None) if incomplete => {
                        base.join(copyright::sanitize(copyright::UNIDENTIFIED_FAMILY))
                    }
                    _ => base,
                };
                let created = fs::create_dir_all(&target_dir).map_err(|e| e.to_string());
                if let Err(e) = created {
                    let _ = app.emit(
                        "install:progress",
                        InstallProgress {
                            file: file_name.to_string_lossy().into_owned(),
                            done: i + 1,
                            total,
                            ok: false,
                            error: Some(e.clone()),
                        },
                    );
                    result.errors.push(e);
                    continue;
                }
                let dest = unique_dest(&target_dir, &file_name);
                // 复制模式：源文件夹原样保留（用户 2026-10-30 要求「导入文件夹」不移动）；
                // WOFF 解包产物在 staging 临时目录，本来也只能复制走
                let moved = place_file(
                    &src,
                    &dest,
                    matches!(mode, InstallMode::Copy) || staged.converted,
                );
                let (ok, error) = match &moved {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e.clone())),
                };
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        file: file_name.to_string_lossy().into_owned(),
                        done: i + 1,
                        total,
                        ok,
                        error: error.clone(),
                    },
                );
                match moved {
                    Ok(recycled) => {
                        // 跨盘移动：源文件进了回收站。staging 里的临时文件（zip 解包 / WOFF 转换）
                        // 不算「用户的源文件」，不进清单，否则每次 zip 导入都报一堆假提示。
                        if recycled && !src.starts_with(&staging) {
                            result.recycled_sources.push(src.to_string_lossy().into_owned());
                        }
                        // 复用刚才对**源文件**的解析结果，不再把刚落盘的副本整份读一遍。
                        // `place_file` 做的是逐字节复制（跨盘时是 copy + 回收站），
                        // 副本的解析结果与源完全一致，唯一要改的只有 path/id。
                        // 2026-11-01 实测：这一步原本让每次导入多读一整份字体
                        // （54 MB 样本 → 多读 57 MB，占「每文件 3 份读」里的 1 份）。
                        let mut faces = if src_faces.is_empty() {
                            parser::parse_font_file(&dest, FontSource::Managed)
                        } else {
                            let dest_str = dest.to_string_lossy().into_owned();
                            let mut f = src_faces.clone();
                            for face in &mut f {
                                face.path = dest_str.clone();
                                face.id = format!("{}#{}", dest_str, face.face_index);
                            }
                            f
                        };
                        for face in &mut faces {
                            face.active = false;
                            // 判定结果带到前端：文件夹备注 / 版权信息文件定的版权也能在界面上看到
                            if let Some(class) = class {
                                face.copyright_class = Some(class.as_str().to_string());
                            }
                            known.insert(dup_key(face));
                        }
                        // 记录字族目录，供版权信息文件归档
                        if let Some(parent) = Path::new(&dest).parent() {
                            if parent != library {
                                if !all_family_dirs.iter().any(|d| d == parent) {
                                    all_family_dirs.push(parent.to_path_buf());
                                }
                                rel_family_dirs
                                    .entry(info_key_for(&staged))
                                    .or_default()
                                    .push(parent.to_path_buf());
                                origin_family_dirs
                                    .entry(staged.origin.clone())
                                    .or_default()
                                    .push(parent.to_path_buf());
                            }
                        }
                        result.installed.extend(faces);
                    }
                    Err(e) => {
                        // 文件没放进去 → 刚为它建的字族目录还空着，收掉。
                        // 以前这里直接留空目录，一次失败的导入就在库根留一个空壳（2.4）。
                        prune_empty_dir(&target_dir, library);
                        result.errors.push(e)
                    }
                }
            }
        }
    }

    // 版权信息文件（许可证/版权声明/说明）随字体归档到字族目录：
    // 与字体同处一个子目录且该目录只归入一个字族 → 只进那个字族；
    // 否则若本次安装只产生一个字族 → 进它；**多字族时不再广播**（2026-11-02 修）。
    if matches!(mode, InstallMode::Move | InstallMode::Copy) || any_zip {
        for info in &infos {
            let Some(name) = info.path.file_name().map(|f| f.to_owned()) else {
                continue;
            };
            let targets = license_targets(info, &rel_family_dirs, &origin_family_dirs, &all_family_dirs);
            if targets.is_empty() {
                result.docs_unassigned += 1;
                continue;
            }
            for t in targets {
                let dest = t.join(&name);
                if dest.is_file() {
                    // 同内容 → 重复，跳过（导入幂等就靠这条：第二次导入零新增）
                    if same_content(&info.path, &dest) {
                        result.docs_skipped += 1;
                    } else {
                        // 同名不同内容：记冲突，**不覆盖、也不生成 N- 副本**
                        result.doc_conflicts.push(dest.to_string_lossy().into_owned());
                    }
                    continue;
                }
                if fs::copy(&info.path, &dest).is_ok() {
                    result.docs_copied += 1;
                }
            }
        }
    }

    let _ = fs::remove_dir_all(&staging);
    refresh_system_font_cache();
    result
}


/// 决定某个版权信息文件应该复制进哪些字族目录。
///
/// 规则（多 zip 一起导入时必须按包隔离，不能互相串）：
/// 1. 同批次 + 同相对目录下的字族目录只有一个 → 只进它（最常见的「族目录自带授权」）；
/// 2. 否则看**同一批次**（origin）产生的字族：只有一个 → 进它；
/// 3. 否则看**本次安装**总共只产生了一个字族 → 进它；
/// 4. 以上都不成立（多字族批次里一份散装文档）→ **返回空，不归档**。
///
/// 第 4 条是 2026-11-02 改的：以前是 `_ => mine`，把整批散装文档广播给每个族目录，
/// 一次导入整个字体库就产生「族数 × 文档数」个 N- 副本（实测 54 万个 / 1.15 GB）。
/// 现在宁可这份文档不进库（源文件仍在原处），也不制造副本。
fn license_targets(
    info: &StagedFile,
    rel_family_dirs: &std::collections::HashMap<InfoKey, Vec<PathBuf>>,
    origin_family_dirs: &std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>>,
    all_family_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    fn uniq(dirs: &[PathBuf]) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for d in dirs {
            if !out.contains(d) {
                out.push(d.clone());
            }
        }
        out
    }
    if let Some(dirs) = rel_family_dirs.get(&info_key_for(info)) {
        let one = uniq(dirs);
        if one.len() == 1 {
            return vec![one[0].clone()];
        }
    }
    let mine = origin_family_dirs
        .get(&info.origin)
        .map(|d| uniq(d))
        .unwrap_or_default();
    match mine.len() {
        1 => vec![mine[0].clone()],
        0 => {
            if all_family_dirs.len() == 1 {
                vec![all_family_dirs[0].clone()]
            } else {
                Vec::new()
            }
        }
        // 多字族批次：**一律不广播**。
        //
        // 旧行为是 `_ => mine`，无条件把整批散装文档复制进**每一个**字族目录，再用
        // `unique_dest` 加 N- 前缀避让 —— 一次导入整个字体库就会产生
        // 「族数 × 文档数」个副本（实测 3,904 族 × 131 份 = 54 万个文件、1.15 GB，
        // 2026-11-02 缺陷报告）。用户的预期是「导入多少字体就是多少，除重复外不多一份」。
        //
        // 这里刻意**不做任何"猜归属"的兜底**（不按文档数量、不按文件名关键词判断
        // 哪份是"整包授权"）—— 只要这份文档不在某个族目录里，就不归档。规则只有
        // 一条，没有分支可错：目标库里每个族目录只会多出它自己目录里的文档。
        //
        // 代价（用户 2026-11-02 明确接受）：放在族目录外面的授权文档不会进目标库，
        // 源文件仍在原处。单族批次不受影响（走上面的 `1 =>` 分支）。
        //
        // 唯一例外（v7）：**文件名点了某个字族的名**（`NotoSans-OFL.txt`）时归它。
        // 判定那边（`resolve_class`）在多字族目录里也只认这种文档，
        // 归档必须跟着判定走：判定用了哪份文档，就得把它放进那个字族目录，
        // 否则下次扫描时证据已经不在了，同一个字体会从「商用免费」掉回「未知」。
        _ => {
            let stem = info
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .map(copyright::norm_token)
                .unwrap_or_default();
            let hits: Vec<PathBuf> = mine
                .iter()
                .filter(|d| {
                    let key = d
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(copyright::family_of_dir_name)
                        .map(copyright::norm_token)
                        .unwrap_or_default();
                    key.len() >= 4 && stem.contains(&key)
                })
                .cloned()
                .collect();
            if hits.len() == 1 {
                hits
            } else {
                Vec::new()
            }
        }
    }
}

/// 两个文件内容是否完全一致（先比长度，长度相同再逐字节比）。
/// 版权/说明文档都是小文件，直接读进内存比引一个哈希库划算。
fn same_content(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => match (fs::read(a), fs::read(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        },
        _ => false,
    }
}

/// 在线下载字体的安装：
/// 目标结构 <库目录>/在线栏目/<来源缩写>/<家族名（版权后缀）>/，
/// 字体文件移入该目录，许可证文件复制一份进去，最后清掉本次下载的 staging 目录。
/// `license_dirs`：字库里已有的同名字族目录，许可证也会补一份到这些目录（补齐缺失的版权文件）。
pub fn install_online(
    app: &tauri::AppHandle,
    paths: Vec<String>,
    existing: &HashSet<String>,
    family: &str,
    license_path: Option<&str>,
    source: &str,
    library: &Path,
    license_dirs: &[String],
) -> InstallResult {
    let mut result = InstallResult::default();
    let mut known: HashSet<String> = existing.clone();
    let total = paths.len();

    // 许可证文本 → 版权分类 → 目录名后缀
    let license_text = license_path.and_then(|p| fs::read_to_string(p).ok());
    let class = copyright::classify(license_text.as_deref());
    let fresh_dir = library
        .join(ONLINE_DIR_NAME)
        .join(sanitize_component(source))
        .join(copyright::family_dir_name(family, class));

    // 字库里已有的同名字族目录
    let existing_dirs: Vec<PathBuf> = license_dirs.iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
    // 补字重时不带许可证 → 版权分类会变成「未知版权」，照这个新建目录就会把同一个字族劈成两个。
    // 已有目录里名字对得上族名的，直接沿用。
    let dir = existing_dirs
        .iter()
        .find(|p| dir_name_is_family(p, family))
        .cloned()
        .unwrap_or(fresh_dir);
    let mut license_dirs: Vec<PathBuf> = existing_dirs.into_iter().filter(|p| p.as_path() != dir.as_path()).collect();
    license_dirs.retain(|p| p.is_dir());

    let need_new_dir = !paths.is_empty() || (license_path.is_some() && license_dirs.is_empty());
    if need_new_dir {
        if let Err(e) = fs::create_dir_all(&dir) {
            result.errors.push(e.to_string());
            return result;
        }
    }

    let emit = |file: &str, done: usize, ok: bool, error: Option<String>| {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                file: file.to_string(),
                done,
                total,
                ok,
                error,
            },
        );
    };

    // 无论有没有真装文件都要清 staging（只补版权文件时 paths 为空）
    let staging_parent: Option<PathBuf> = paths.first().and_then(|p| Path::new(p).parent().map(|x| x.to_path_buf()));
    for (i, p) in paths.iter().enumerate() {
        let src = Path::new(p);
        let file_name = src.file_name().map(|f| f.to_owned()).unwrap_or_default();
        let src_faces = parser::parse_font_file(src, FontSource::Managed);
        let src_keys: Vec<String> = src_faces.iter().map(dup_key).collect();
        if !src_keys.is_empty() && src_keys.iter().all(|k| known.contains(k)) {
            for k in &src_keys {
                if !result.duplicates.contains(k) {
                    result.duplicates.push(k.clone());
                }
            }
            emit(&file_name.to_string_lossy(), i + 1, true, None);
            continue;
        }
        let dest = unique_dest(&dir, &file_name);
        match move_file(src, &dest) {
            // 在线字体是从下载 staging 搬过来的临时文件，跨盘回收属正常，不报给用户
            Ok(_) => {
                let mut faces = parser::parse_font_file(&dest, FontSource::Managed);
                for face in &mut faces {
                    face.active = false;
                    known.insert(dup_key(face));
                }
                result.installed.extend(faces);
                emit(&file_name.to_string_lossy(), i + 1, true, None);
            }
            Err(e) => {
                result.errors.push(e.clone());
                emit(&file_name.to_string_lossy(), i + 1, false, Some(e));
            }
        }
    }

    // 许可证文件复制进字族目录（保留原文件名）
    if let Some(lp) = license_path {
        if let Some(name) = Path::new(lp).file_name() {
            if dir.is_dir() {
                let _ = fs::copy(lp, dir.join(name));
            }
            // 字库中已有的同名字族目录也补一份，避免"字重齐全但没有版权文件"
            for p in &license_dirs {
                let _ = fs::copy(lp, p.join(name));
            }
        }
    }
    // 清掉本次下载的 staging 目录
    if let Some(parent) = staging_parent {
        let _ = fs::remove_dir_all(parent);
    }
    crate::diag::log(&format!(
        "online install[{family}]: 装入 {} 个字体面 / 收到 {} 个文件，license={}，目标目录 {}，附带目录 {} 个",
        result.installed.len(),
        total,
        license_path.is_some(),
        dir.display(),
        license_dirs.len()
    ));
    if !result.installed.is_empty() {
        refresh_system_font_cache();
    }
    result
}

/// 目录名是不是这个字族的目录（「Lora（商用免费）」→ Lora）
fn dir_name_is_family(dir: &Path, family: &str) -> bool {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let base = match name.find('（') {
        Some(i) => &name[..i],
        None => name,
    };
    base.trim().to_lowercase() == family.trim().to_lowercase()
}

/// 清理路径组件中的非法字符
fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => c,
        })
        .collect();
    cleaned.trim().to_string()
}

/// `uninstall_quiet` 的本体：**不广播 WM_FONTCHANGE**（批量入口最后统一广播一次，见 `unlink_quiet`）。
///
/// DEF-6（2026-11-01 测试报告，高危）：旧顺序是「先动文件、后写账本」，而跨盘时
/// `move_file` 走「复制 + 源送 Windows 回收站」——`trash` crate 的 IFileOperation
/// **即使真把文件搬走了也可能报 `Some operations were aborted`**（实测 7/7：
/// 文件进了 E: 盘 Windows 回收站，$R/$I 时间戳与失败秒级吻合）。错误一抛，
/// 账本没写、副本留在回收站目录里 → 「文件已离开字体库、回收站视图却空着、
/// 用户既看不见也还原不了」的悬挂状态。
///
/// 新顺序与分流规则：
///   1. **先写账本，再动文件**——文件只要离开原位置，账就必须已经存在；
///      账本写不进去就什么都没动，直接报错。
///   2. 移动报告失败后**不信错误、信文件系统**：原文件还在 → 撤摊子（删副本 +
///      删账本，当没发生过）；原文件已经没了 → 认账（副本是唯一留存，账本已写好，
///      至少能从应用回收站还原）。
pub fn uninstall_quiet(path: &str, family: &str) -> Result<TrashEntry, String> {
    #[cfg(target_os = "windows")]
    unregister_user_font(path);

    let trash = crate::store::trash_dir();
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let src = Path::new(path);
    let file_name = src.file_name().ok_or("invalid path")?;
    let dest = unique_dest(&trash, file_name);

    let entry = TrashEntry {
        id: dest.to_string_lossy().into_owned(),
        original_path: path.to_string(),
        trashed_path: dest.to_string_lossy().into_owned(),
        family: family.to_string(),
        trashed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let meta = sidecar_path(&dest);
    // 先落账：此刻文件还原地没动，账本写失败就是干净的「什么都没发生」
    fs::write(&meta, serde_json::to_vec(&entry).unwrap_or_default())
        .map_err(|e| format!("写入回收站记录失败：{e}"))?;

    match move_file(src, &dest) {
        Ok(_) => Ok(entry),
        Err(e) => match recover_move_failure(src, &dest) {
            MoveRecovery::Rollback => {
                // 原文件还在（或副本也没落成）：撤摊子。副本和账本都收掉，当没发生过
                let _ = fs::remove_file(&dest);
                let _ = fs::remove_file(&meta);
                Err(e)
            }
            MoveRecovery::Commit => Ok(entry),
        },
    }
}

/// DEF-6：移动报告失败后的真实状态分流。**不信错误、信文件系统。**
///
/// 跨盘时 `move_file` 是「复制 + 源送 Windows 回收站」，而 `trash` crate 的
/// IFileOperation 即使真把文件搬走了也可能报 `Some operations were aborted`
/// （2026-11-01 实测 7/7，$R/$I 时间戳与失败秒级吻合）。所以失败之后必须看：
///   - 原文件已经不在、且副本落在了回收站里 → **认账**：副本是唯一留存，
///     账本也已经写好（先写账后动文件），至少能从应用回收站还原；
///   - 其余一切情况（原文件还在 / 副本也没落成）→ **回滚**：收掉副本和账本，
///     原样返回错误，库里的字体分毫未动。
///
/// 单独抽出来是为了锁住这张真值表：真实复现需要「IFileOperation 报错但文件已搬走」，
/// 测试环境造不出来，但决策规则不能靠运气。
#[derive(Debug, PartialEq, Eq)]
enum MoveRecovery {
    Rollback,
    Commit,
}

fn recover_move_failure(src: &Path, dest: &Path) -> MoveRecovery {
    if !src.exists() && dest.exists() {
        MoveRecovery::Commit
    } else {
        MoveRecovery::Rollback
    }
}

pub fn list_trash() -> Vec<TrashEntry> {
    let trash = crate::store::trash_dir();
    let Ok(entries) = fs::read_dir(&trash) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().to_string_lossy().ends_with(".zfmtrash"))
        .filter_map(|e| {
            let bytes = fs::read(e.path()).ok()?;
            serde_json::from_slice::<TrashEntry>(&bytes).ok()
        })
        .filter(|t| Path::new(&t.trashed_path).exists())
        .collect()
}

pub fn restore(entry_id: &str) -> Result<RestoreOutcome, String> {
    let entry = list_trash()
        .into_iter()
        .find(|t| t.id == entry_id)
        .ok_or("trash entry not found")?;
    if entry.original_path == entry.trashed_path {
        if let Some(sidecar) = find_sidecar(&crate::store::trash_dir(), entry_id) {
            let _ = fs::remove_file(sidecar);
        }
        refresh_system_font_cache();
        return Ok(RestoreOutcome::Relinked(entry.original_path));
    }
    if let Some(parent) = Path::new(&entry.original_path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // DEF-6 同款分流：跨盘还原也是「复制 + 回收站里的副本送 Windows 回收站」，
    // IFileOperation 报错但副本其实已经搬走时，原路径已经有了文件 —— 那就是还原成功，
    // 顺手收掉回收站里残留的副本和账本，别让它既在库里又挂在回收站视图里。
    let orig_existed = Path::new(&entry.original_path).exists();
    match move_file(
        Path::new(&entry.trashed_path),
        Path::new(&entry.original_path),
    ) {
        Ok(_) => {
            remove_sidecar(&entry.trashed_path);
            refresh_system_font_cache();
            Ok(RestoreOutcome::Moved)
        }
        Err(e) => {
            if !orig_existed && Path::new(&entry.original_path).exists() {
                let _ = fs::remove_file(Path::new(&entry.trashed_path));
                remove_sidecar(&entry.trashed_path);
                refresh_system_font_cache();
                Ok(RestoreOutcome::Moved)
            } else {
                Err(e)
            }
        }
    }
}

pub fn empty_trash() -> Result<(), String> {
    let trash = crate::store::trash_dir();
    if !trash.exists() {
        return Ok(());
    }
    let mut errors = Vec::new();
    for entry in list_trash() {
        if entry.original_path == entry.trashed_path {
            continue;
        }
        let trashed = Path::new(&entry.trashed_path);
        // IFileOperation 即使搬成功也可能报 aborted（DEF-6）：以「文件还在不在」为准
        if let Err(e) = recycle(trashed) {
            if trashed.exists() {
                errors.push(e);
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    fs::remove_dir_all(&trash).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_trash_entry(entry_id: &str) -> Result<(), String> {
    let entry = list_trash()
        .into_iter()
        .find(|t| t.id == entry_id)
        .ok_or("trash entry not found")?;
    if entry.original_path == entry.trashed_path {
        if let Some(sidecar) = find_sidecar(&crate::store::trash_dir(), entry_id) {
            fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let trashed = Path::new(&entry.trashed_path);
    // 同 empty_trash：报错但文件已经搬走 = 成功
    if let Err(e) = recycle(trashed) {
        if trashed.exists() {
            return Err(e);
        }
    }
    remove_sidecar(&entry.trashed_path);
    Ok(())
}

pub enum RestoreOutcome {
    Moved,
    Relinked(String),
}

/// `unlink_quiet` 的本体：**不广播 WM_FONTCHANGE**。
///
/// 批量删除要走这个版本 —— 4020 个链接字体若每个都广播一次 `WM_FONTCHANGE`，
/// 等于向所有顶层窗口发 4020 轮通知（C8：与「每项重写整份 state」同一个毛病，
/// 都是把「单条操作」的开销乘上了批量规模）。批量入口最后统一广播一次。
pub fn unlink_quiet(path: &str, family: &str) -> Result<TrashEntry, String> {
    #[cfg(target_os = "windows")]
    unregister_user_font(path);

    let trash = crate::store::trash_dir();
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let trashed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = TrashEntry {
        id: format!("link:{path}"),
        original_path: path.to_string(),
        trashed_path: path.to_string(),
        family: family.to_string(),
        trashed_at,
    };
    let mut sidecar = trash.join(format!("link-{trashed_at}.zfmtrash"));
    let mut n = 1;
    while sidecar.exists() {
        n += 1;
        sidecar = trash.join(format!("link-{trashed_at}-{n}.zfmtrash"));
    }
    fs::write(&sidecar, serde_json::to_vec(&entry).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(entry)
}

fn find_sidecar(trash: &Path, entry_id: &str) -> Option<PathBuf> {
    fs::read_dir(trash)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("zfmtrash"))
        .find(|p| {
            fs::read(p)
                .ok()
                .and_then(|b| serde_json::from_slice::<TrashEntry>(&b).ok())
                .is_some_and(|t| t.id == entry_id)
        })
}

fn remove_sidecar(trashed_path: &str) {
    let p = Path::new(trashed_path);
    let meta = p.with_extension(format!(
        "{}.zfmtrash",
        p.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    let _ = fs::remove_file(meta);
}

pub(crate) fn refresh_system_font_cache() {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut child) = std::process::Command::new("fc-cache").spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendNotifyMessageW, HWND_BROADCAST, WM_FONTCHANGE,
        };
        SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「导入文件夹」＝递归展开目录：子目录里的字体、同目录的授权文档都要被收进来，
    /// 后面的去重和「按字族归档」跟拖拽导入是同一条管线，不会因为入口不同而跑偏。
    #[test]
    fn folder_import_expands_recursively_like_a_drop() {
        let tmp = std::env::temp_dir().join(format!("zfm-folder-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("字体库");
        let sub = root.join("_01_中文字体").join("Some Family（商用免费）");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("Some-Regular.ttf"), b"a").unwrap();
        fs::write(sub.join("Some-Bold.ttf"), b"b").unwrap();
        fs::write(sub.join("版权说明.txt"), "本字体免费商用".as_bytes()).unwrap();
        fs::write(root.join("说明.txt"), "根目录的说明".as_bytes()).unwrap();
        fs::write(root.join("cover.png"), b"png").unwrap();

        let staged = expand_dropped(&root, &tmp.join("staging")).unwrap();
        let fonts: Vec<_> = staged.iter().filter(|s| s.is_font).collect();
        let infos: Vec<_> = staged.iter().filter(|s| !s.is_font).collect();
        assert_eq!(fonts.len(), 2, "子目录里的两个字体都要被展开");
        assert_eq!(infos.len(), 2, "两份 .txt 都算授权/说明文件");
        assert!(
            staged.iter().all(|s| s.origin.as_deref() == Some(root.as_path())),
            "同一批文件要带同一个来源目录，版权文件才不会串到别的文件夹"
        );
        // png 不是字体也不是授权文件，不该被收进来
        assert!(!staged
            .iter()
            .any(|s| s.path.extension().and_then(|e| e.to_str()) == Some("png")));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 复制模式必须留着源文件；搬移模式必须把源文件挪走
    #[test]
    fn copy_mode_keeps_the_source_file() {
        let tmp = std::env::temp_dir().join(format!("zfm-copy-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src_dir = tmp.join("src");
        let lib = tmp.join("lib");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&lib).unwrap();
        let src = src_dir.join("Source-Sans.ttf");
        fs::write(&src, b"font-bytes").unwrap();

        let dest = lib.join("Source-Sans.ttf");
        place_file(&src, &dest, true).unwrap();
        assert!(src.exists(), "复制模式不能删源文件");
        assert!(dest.exists(), "复制模式要把文件放进字库");
        assert_eq!(fs::read(&dest).unwrap(), b"font-bytes");

        // 模式字符串能被解析（前端「导入文件夹」传的就是 copy）
        assert_eq!(InstallMode::parse("copy").unwrap(), InstallMode::Copy);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 复现（2026-11-02 缺陷报告）：一次导入多个字族、批次根目录下还放着说明文件时，
    /// 这些「不属于任何单个字族」的文档会被 `license_targets` 的兜底分支广播到**每一个**
    /// 字族目录 —— 报告实测 3,904 族 × 131 份 = 54 万个编号副本、1.15 GB。
    ///
    /// 期望：多字族批次里的根级文档找不到归属，就谁也别塞（宁可不归档，也不能污染全库）。
    #[test]
    fn repro_root_doc_must_not_be_broadcast_to_every_family() {
        use std::collections::HashMap;

        let origin: Option<PathBuf> = Some(PathBuf::from("E:/源库"));
        let fam_a = PathBuf::from("E:/lib/族A");
        let fam_b = PathBuf::from("E:/lib/族B");
        let fam_c = PathBuf::from("E:/lib/族C");
        let all_dirs = vec![fam_a.clone(), fam_b.clone(), fam_c.clone()];

        // 每个字族的字体各自在自己的子目录里 → 各有一条 rel 键
        let mut rel_family_dirs: HashMap<InfoKey, Vec<PathBuf>> = HashMap::new();
        rel_family_dirs.insert((origin.clone(), PathBuf::from("族A")), vec![fam_a.clone()]);
        rel_family_dirs.insert((origin.clone(), PathBuf::from("族B")), vec![fam_b.clone()]);
        rel_family_dirs.insert((origin.clone(), PathBuf::from("族C")), vec![fam_c.clone()]);

        let mut origin_family_dirs: HashMap<Option<PathBuf>, Vec<PathBuf>> = HashMap::new();
        origin_family_dirs.insert(origin.clone(), all_dirs.clone());

        // 放在源库根目录的说明文件：rel 为空，不属于任何字族
        let root_doc = StagedFile {
            path: PathBuf::from("E:/源库/说明.txt"),
            is_font: false,
            is_zip: false,
            converted: false,
            rel: PathBuf::new(),
            origin: origin.clone(),
            folder_note: None,
        };

        // 一批里有 3 个族各自的文档时，根目录那份没有归属 → sole_info = false
        let targets =
            license_targets(&root_doc, &rel_family_dirs, &origin_family_dirs, &all_dirs);
        assert!(
            targets.is_empty(),
            "根目录说明文件不该进任何字族目录，实际被广播进了 {} 个：{:?}",
            targets.len(),
            targets
        );
    }

    #[test]
    fn detects_info_files() {        assert!(is_info_file(Path::new("OFL.txt")));
        assert!(is_info_file(Path::new("LICENSE")));
        assert!(is_info_file(Path::new("Font-License.pdf")));
        assert!(is_info_file(Path::new("版权说明.txt")));
        assert!(!is_info_file(Path::new("Font.ttf")));
        assert!(!is_info_file(Path::new("preview.png")));
        assert!(!is_info_file(Path::new("installer.exe")));
    }

    /// zip 导入时应同时暂存字体与版权信息文件，并标记为 zip 来源（强制移动入库）
    #[test]
    fn zip_stages_fonts_and_info_files() {
        let tmp = std::env::temp_dir().join(format!("zfm-zip-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let zip_path = tmp.join("pack.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zw = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                ("Fonts/Font-Regular.ttf", &b"font-bytes"[..]),
                ("Fonts/OFL.txt", &b"SIL Open Font License"[..]),
                ("Fonts/preview.png", &b"png"[..]),
            ] {
                zw.start_file(name, opts).unwrap();
                std::io::Write::write_all(&mut zw, body).unwrap();
            }
            zw.finish().unwrap();
        }

        let staging = tmp.join("staging");
        let files = expand_dropped(&zip_path, &staging).unwrap();

        assert_eq!(files.len(), 2, "font + license only, images skipped");
        assert!(files.iter().all(|f| f.is_zip), "all zip entries force move");
        let font = files.iter().find(|f| f.is_font).expect("font staged");
        assert_eq!(font.rel, PathBuf::from("Fonts"));
        let info = files.iter().find(|f| !f.is_font).expect("license staged");
        assert_eq!(
            info.path.file_name().and_then(|n| n.to_str()),
            Some("OFL.txt")
        );
        assert_eq!(info.rel, PathBuf::from("Fonts"));

        let _ = fs::remove_dir_all(&tmp);
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            zw.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zw, *body).unwrap();
        }
        zw.finish().unwrap();
    }

    /// 一个 zip 里混了两个字族 → 整包拒绝；同字族的不同字重 → 正常放行。
    ///
    /// 用系统自带字体做真实解析，CI 镜像里字体不一定齐，所以标记 ignore：
    /// 本地验证 `cargo test --lib -- --ignored multi_family_zip`。
    #[test]
    #[ignore = "依赖系统字体，本地手工跑（CI 镜像字体不保证齐）"]
    fn multi_family_zip_rejected_end_to_end() {
        let fonts_dir = PathBuf::from(r"C:\Windows\Fonts");
        let regular = fonts_dir.join("arial.ttf");
        let bold = fonts_dir.join("arialbd.ttf");
        let serif = fonts_dir.join("times.ttf");
        if !(regular.is_file() && bold.is_file() && serif.is_file()) {
            eprintln!("跳过：本机系统字体不全");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("zfm-multifam-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let staging = tmp.join("staging");
        let (arial, arial_bold, times) = (
            fs::read(&regular).unwrap(),
            fs::read(&bold).unwrap(),
            fs::read(&serif).unwrap(),
        );

        // ① 同字族的两个字重 → 允许
        let one = tmp.join("Arial.zip");
        write_zip(
            &one,
            &[("arial.ttf", &arial[..]), ("arialbd.ttf", &arial_bold[..])],
        );
        let (kept, rejected) =
            reject_multi_family_zips(expand_dropped(&one, &staging).unwrap());
        assert!(rejected.is_empty(), "同字族多字重不该被拒：{rejected:?}");
        assert_eq!(kept.iter().filter(|f| f.is_font).count(), 2);

        // ② 两个字族 → 整包拒绝，字体和解压出的授权文档一起丢
        let two = tmp.join("Mixed.zip");
        write_zip(
            &two,
            &[
                ("arial.ttf", &arial[..]),
                ("times.ttf", &times[..]),
                ("OFL.txt", &b"SIL Open Font License"[..]),
            ],
        );
        let (kept, rejected) =
            reject_multi_family_zips(expand_dropped(&two, &staging).unwrap());
        assert_eq!(rejected.len(), 1, "应该只拒这一个包：{rejected:?}");
        assert_eq!(rejected[0].name, "Mixed.zip");
        assert_eq!(rejected[0].font_count, 2);
        assert!(rejected[0].families.len() >= 2, "要能报出包里的字族名");
        assert_eq!(kept.len(), 0, "整包都该被摘掉（含授权文档）");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 拖入文件夹不走这条规则：目录结构能让授权文档归属到字族，不需要整包拒绝。
    #[test]
    fn folder_import_is_never_rejected() {
        let tmp = std::env::temp_dir().join(format!("zfm-folderfam-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let pack = tmp.join("Some Pack");
        fs::create_dir_all(pack.join("sub")).unwrap();
        fs::write(pack.join("a.ttf"), b"aaa").unwrap();
        fs::write(pack.join("sub/b.ttf"), b"bbb").unwrap();

        let files = expand_dropped(&pack, &tmp.join("staging")).unwrap();
        let (kept, rejected) = reject_multi_family_zips(files);
        assert!(rejected.is_empty(), "文件夹导入不该被拒");
        assert_eq!(kept.len(), 2);

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 一次导入多个 zip：A 包的授权文件不能套到 B 包的字体上。
    /// （解压后都平铺在同一个 staging 目录，两个包都把字体放在根目录时 rel 都是空）
    #[test]
    fn multi_zip_license_does_not_leak_across_zips() {
        let tmp = std::env::temp_dir().join(format!("zfm-multizip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let zip_a = tmp.join("free-pack.zip");
        write_zip(
            &zip_a,
            &[
                ("A-Font.ttf", &b"aaa"[..]),
                ("OFL.txt", &b"SIL Open Font License Version 1.1"[..]),
            ],
        );
        let zip_b = tmp.join("paid-pack.zip");
        write_zip(&zip_b, &[("B-Font.ttf", &b"bbb"[..])]);

        let staging = tmp.join("staging");
        let mut files = Vec::new();
        for z in [&zip_a, &zip_b] {
            files.extend(expand_dropped(z, &staging).unwrap());
        }

        let infos: Vec<StagedFile> = files.iter().filter(|f| !f.is_font).cloned().collect();
        // 必须和 install() 用同一个分组函数，否则回归时测试也会「跟着一起错」
        let infos_by_rel = group_infos(&infos);
        let all_infos: Vec<(Option<PathBuf>, PathBuf)> = infos
            .iter()
            .map(|i| (i.origin.clone(), i.path.clone()))
            .collect();

        let font_a = files
            .iter()
            .find(|f| f.is_font && f.origin.as_deref() == Some(zip_a.as_path()))
            .expect("A 包的字体");
        let font_b = files
            .iter()
            .find(|f| f.is_font && f.origin.as_deref() == Some(zip_b.as_path()))
            .expect("B 包的字体");

        assert_eq!(
            resolve_class(font_a, &[], &infos_by_rel, &all_infos, copyright::DocScope::Family),
            copyright::CopyrightClass::FreeCommercial,
            "A 包自己的 OFL 应该生效"
        );
        assert_ne!(
            resolve_class(font_b, &[], &infos_by_rel, &all_infos, copyright::DocScope::Family),
            copyright::CopyrightClass::FreeCommercial,
            "B 包没有授权文件，不能被 A 包的 OFL 串成商用免费"
        );
        assert_eq!(
            resolve_class(
                font_b,
                &[],
                &infos_by_rel,
                &all_infos,
                copyright::DocScope::Family
            ),
            copyright::CopyrightClass::Unknown,
            "判不出来就应该老实报未知"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 多 zip 一起导入：A 包的授权文件只能落在 A 包的字族目录里
    #[test]
    fn license_targets_stay_inside_own_zip() {
        let zip_a = PathBuf::from(r"C:/fonts/a-free.zip");
        let zip_b = PathBuf::from(r"C:/fonts/b-paid.zip");
        let dir_a = PathBuf::from(r"C:/lib/FamilyA（商用免费）");
        let dir_b = PathBuf::from(r"C:/lib/FamilyB（收费字体）");

        let mut info_a = StagedFile::new(PathBuf::from("OFL.txt"), false, true, PathBuf::new(), None);
        info_a.origin = Some(zip_a.clone());

        let mut rel_dirs: std::collections::HashMap<InfoKey, Vec<PathBuf>> =
            std::collections::HashMap::new();
        rel_dirs.insert((Some(zip_a.clone()), PathBuf::new()), vec![dir_a.clone()]);
        rel_dirs.insert((Some(zip_b.clone()), PathBuf::new()), vec![dir_b.clone()]);

        let mut origin_dirs: std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>> =
            std::collections::HashMap::new();
        origin_dirs.insert(Some(zip_a.clone()), vec![dir_a.clone()]);
        origin_dirs.insert(Some(zip_b.clone()), vec![dir_b.clone()]);

        let all = vec![dir_a.clone(), dir_b.clone()];
        assert_eq!(
            license_targets(&info_a, &rel_dirs, &origin_dirs, &all),
            vec![dir_a.clone()],
            "A 包的 OFL 不能进 B 包的字族目录"
        );

        // 许可证在包根、字体在子目录：按同批次兜底，仍然只进 A 自己的字族
        let mut root_info =
            StagedFile::new(PathBuf::from("LICENSE.txt"), false, true, PathBuf::new(), None);
        root_info.origin = Some(zip_a.clone());
        let mut rel_dirs2 = rel_dirs.clone();
        rel_dirs2.insert(
            (Some(zip_a.clone()), PathBuf::from("Fonts")),
            vec![dir_a.clone()],
        );
        assert_eq!(
            license_targets(&root_info, &rel_dirs2, &origin_dirs, &all),
            vec![dir_a.clone()]
        );
    }

    /// 一个 zip 里只有**一个字族**（同族多字重），授权文件叫「版权说明.txt」放在包根：
    /// 它必须落进这个唯一的字族目录 —— 既不能丢，也不能复制多份。
    #[test]
    fn zip_single_family_root_doc_lands_in_that_family() {
        // 「版权说明.txt」靠 .txt 扩展名就够；即使去掉扩展名，「版权」也是关键词
        assert!(is_info_file(Path::new("版权说明.txt")));
        assert!(is_info_file(Path::new("版权说明")));
        assert!(!is_info_file(Path::new("Regular.ttf")), "字体不能被当作文档");

        let zip = PathBuf::from(r"C:/fonts/方正兰亭黑.zip");
        let dir = PathBuf::from(r"C:/lib/方正兰亭黑（个人免费）");

        let mut doc =
            StagedFile::new(PathBuf::from("版权说明.txt"), false, true, PathBuf::new(), None);
        doc.origin = Some(zip.clone());

        let mut origin_dirs: std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>> =
            std::collections::HashMap::new();
        origin_dirs.insert(Some(zip.clone()), vec![dir.clone()]);

        // 情形 1：说明与字体同在包根（zip 内相对目录都是空）→ 走「同目录只有一个族」
        let mut rel_dirs: std::collections::HashMap<InfoKey, Vec<PathBuf>> =
            std::collections::HashMap::new();
        rel_dirs.insert((Some(zip.clone()), PathBuf::new()), vec![dir.clone()]);
        assert_eq!(
            license_targets(&doc, &rel_dirs, &origin_dirs, &[dir.clone()]),
            vec![dir.clone()],
            "同层只有一个字族：说明文件进这个族目录"
        );

        // 情形 2：字体在子目录、说明在包根 → 同批次只产生了一个族，仍然进它
        let mut sub_dirs: std::collections::HashMap<InfoKey, Vec<PathBuf>> =
            std::collections::HashMap::new();
        sub_dirs.insert((Some(zip.clone()), PathBuf::from("Regular")), vec![dir.clone()]);
        assert_eq!(
            license_targets(&doc, &sub_dirs, &origin_dirs, &[dir.clone()]),
            vec![dir.clone()],
            "说明在包根、字体在子目录：同批次仅一个族，仍然进它"
        );
    }

    /// 松散文件夹（一次拖入一个文件夹）：根目录的授权文件**不再**发给文件夹里的每个字族。
    ///
    /// 2026-11-02 改：以前这里断言「广播给每个族」，那正是字体库导入产生 54 万个副本的根源。
    /// 现在的规则只有一条 —— 文档不在某个族目录里就不归档，所以这里必须为空。
    #[test]
    fn license_targets_never_broadcasts_to_other_families() {
        let folder = PathBuf::from(r"C:/fonts/pack");
        let d1 = PathBuf::from(r"C:/lib/FamilyOne");
        let d2 = PathBuf::from(r"C:/lib/FamilyTwo");

        let mut info = StagedFile::new(PathBuf::from("LICENSE.txt"), false, false, PathBuf::new(), None);
        info.origin = Some(folder.clone());

        let mut origin_dirs: std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>> =
            std::collections::HashMap::new();
        origin_dirs.insert(Some(folder), vec![d1.clone(), d2.clone()]);

        // 这份 LICENSE 在文件夹根目录、两个族各有自己的子目录 → 它不属于任何单个族
        let targets = license_targets(
            &info,
            &std::collections::HashMap::new(),
            &origin_dirs,
            &[d1.clone(), d2.clone()],
        );
        assert!(
            targets.is_empty(),
            "根目录的授权文件不该广播给每个族（那正是 54 万副本的来源），实际：{:?}",
            targets
        );

        // 单族批次仍然正常归档：这是唯一允许「文档进族目录」的兜底
        let mut origin_one: std::collections::HashMap<Option<PathBuf>, Vec<PathBuf>> =
            std::collections::HashMap::new();
        origin_one.insert(info.origin.clone(), vec![d1.clone()]);
        let single = license_targets(
            &info,
            &std::collections::HashMap::new(),
            &origin_one,
            &[d1.clone()],
        );
        assert_eq!(single, vec![d1], "单族批次里，批次文档要进这个唯一的族目录");
    }

    /// 2.4：导入失败留下的空字族目录要收掉，但库根与非空目录绝不能动
    #[test]
    fn prune_removes_only_empty_family_dirs() {
        let tmp = std::env::temp_dir().join(format!("zfm-prune-{}", std::process::id()));
        let lib = tmp.join("lib");
        let empty_family = lib.join("SomeFamily（未知版权）");
        let keep = lib.join("_01_中文字体");
        fs::create_dir_all(&empty_family).unwrap();
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("a.ttf"), b"x").unwrap();

        prune_empty_dir(&empty_family, &lib);
        assert!(!empty_family.exists(), "空的字族目录应被收掉");

        prune_empty_dir(&lib, &lib);
        assert!(lib.exists(), "库根本身不能删");

        prune_empty_dir(&keep, &lib);
        assert!(keep.exists(), "非空目录不能删");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 两个 zip 里有同名文件：解压到同一个 staging 时不能互相覆盖
    #[test]
    fn multi_zip_same_file_name_keeps_both() {
        let tmp = std::env::temp_dir().join(format!("zfm-multizip-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let zip_a = tmp.join("one.zip");
        write_zip(&zip_a, &[("Same.ttf", &b"first"[..])]);
        let zip_b = tmp.join("two.zip");
        write_zip(&zip_b, &[("Same.ttf", &b"second"[..])]);

        let staging = tmp.join("staging");
        let mut fonts = Vec::new();
        for z in [&zip_a, &zip_b] {
            fonts.extend(
                expand_dropped(z, &staging)
                    .unwrap()
                    .into_iter()
                    .filter(|f| f.is_font),
            );
        }
        assert_eq!(fonts.len(), 2, "两个同名文件都要留下来");
        assert_ne!(fonts[0].path, fonts[1].path, "落盘路径不能相同");

        let bodies: Vec<Vec<u8>> = fonts.iter().map(|f| fs::read(&f.path).unwrap()).collect();
        assert!(bodies.contains(&b"first".to_vec()) && bodies.contains(&b"second".to_vec()));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 0.9.4-1 回归：落单的 WOFF（不走 zip 分支）也必须把 staging 目录建出来，
    /// 否则解包落盘报 os error 3（系统找不到指定的路径）。
    #[test]
    fn lone_woff_creates_staging_dir() {
        let tmp = std::env::temp_dir().join(format!("zfm-woff-staging-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let woff = tmp.join("Lone.woff");
        fs::write(&woff, b"wOFF-garbage").unwrap(); // 分流只看扩展名，内容好坏不影响本断言
        let staged = StagedFile::new(woff, true, false, PathBuf::new(), None);

        let staging = tmp.join("deep").join("staging"); // 故意用不存在的多级目录
        let mut result = InstallResult {
            installed: vec![],
            errors: vec![],
            duplicates: vec![],
            webfonts_skipped: 0,
            // 0.9.9-13 新增的字段：测试这里只关心 staging 目录，不关心系统重复计数
            system_duplicates: 0,
            // 1.0.0-4 新增：跨盘移动被回收的源文件清单，本测试不涉及
            recycled_sources: vec![],
            // 1.1.3 新增：版权文档归档统计，本测试只关心 staging 目录
            docs_copied: 0,
            docs_skipped: 0,
            docs_unassigned: 0,
            doc_conflicts: vec![],
            // 1.1.7 之后新增：多字族压缩包拒绝清单，本测试不涉及
            rejected_zips: vec![],
        };
        let _ = process_webfonts(vec![staged], &staging, &mut result);

        assert!(staging.is_dir(), "落单 WOFF 也应创建 staging 目录");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 导入时版权来源的权重（v7 之后）：授权文档 > 字体自带信息。
    /// 目录名**不参与** —— 它本来就是软件自己写出去的，读回来等于自证。
    #[test]
    fn copyright_source_priority() {
        let tmp = std::env::temp_dir().join(format!("zfm-lic-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let license = tmp.join("LICENSE.txt");
        fs::write(&license, b"This font is licensed under the SIL Open Font License").unwrap();

        let staged = StagedFile::new(
            tmp.join("Font-Regular.ttf"),
            true,
            false,
            PathBuf::new(),
            Some("某某字体（收费字体）".to_string()),
        );

        // 1. 同目录有版权信息文件：按文件正文判定（商用免费），文件夹名的「收费」不作数
        let mut by_rel: std::collections::HashMap<(Option<PathBuf>, PathBuf), Vec<PathBuf>> =
            std::collections::HashMap::new();
        by_rel.insert((None, PathBuf::new()), vec![license.clone()]);
        assert_eq!(
            resolve_class(
                &staged,
                &[],
                &by_rel,
                &[(None, license.clone())],
                copyright::DocScope::Family
            ),
            copyright::CopyrightClass::FreeCommercial
        );

        // 2. 目录名写着「收费字体」但没有授权证据 → 未知。
        //    旧版这里会读目录名直接判 Paid，那正是「自己给自己作证」的入口。
        assert_eq!(
            resolve_class(
                &staged,
                &[],
                &std::collections::HashMap::new(),
                &[],
                copyright::DocScope::Family
            ),
            copyright::CopyrightClass::Unknown,
            "目录名不能当版权证据"
        );

        // 3. 目录里混着多个字族时，同一份 OFL 不能外溢给这个字族
        assert_eq!(
            resolve_class(
                &staged,
                &[],
                &by_rel,
                &[(None, license.clone())],
                copyright::DocScope::Mixed
            ),
            copyright::CopyrightClass::Unknown,
            "平铺目录里的授权文档不能整目录生效"
        );

        // 4. 什么都没有 → 未知
        let plain = StagedFile::new(
            tmp.join("Font-Regular.ttf"),
            true,
            false,
            PathBuf::new(),
            Some("字体合集".to_string()),
        );
        assert_eq!(
            resolve_class(
                &plain,
                &[],
                &std::collections::HashMap::new(),
                &[],
                copyright::DocScope::Family
            ),
            copyright::CopyrightClass::Unknown
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn uninstall_restore_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("zfm-inst-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        unsafe { std::env::set_var("XDG_DATA_HOME", &tmp) };

        let font = tmp.join("Fake Font.ttf");
        fs::write(&font, b"not really a font").unwrap();

        let entry = uninstall_quiet(font.to_str().unwrap(), "Fake Font").unwrap();
        assert!(!font.exists(), "file should be moved out");
        assert!(Path::new(&entry.trashed_path).exists());

        let listed = list_trash();
        let found = listed
            .iter()
            .find(|t| t.id == entry.id)
            .expect("our entry should be listed");
        assert_eq!(found.family, "Fake Font");

        restore(&entry.id).unwrap();
        assert!(font.exists(), "file should be back after restore");
        assert!(list_trash().iter().all(|t| t.id != entry.id));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// DEF-6 回归：账本必须与文件同在。旧顺序「先动文件、后写账本」在跨盘 +
    /// IFileOperation 报 aborted 时会留下「回收站里有文件、视图里查不到」的悬挂条目
    /// （2026-11-01 实测：7 个字体物理离开字体库，回收站计数却是 0，无法还原）。
    #[test]
    fn uninstall_writes_sidecar_with_the_file() {
        // 独立目录：cargo test 默认多线程并行，共用 temp 子目录会互相删对象
        let tmp = std::env::temp_dir().join(format!("zfm-sidecar-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        unsafe { std::env::set_var("XDG_DATA_HOME", &tmp) };

        let font = tmp.join("Ledger Font.ttf");
        fs::write(&font, b"not really a font").unwrap();

        let entry = uninstall_quiet(font.to_str().unwrap(), "Ledger Font").unwrap();
        // 账本、副本、列表三处必须同时看得到这条记录
        let sidecar = sidecar_path(Path::new(&entry.trashed_path));
        assert!(sidecar.exists(), "账本应与副本同时存在");
        assert!(Path::new(&entry.trashed_path).exists());
        assert!(list_trash().iter().any(|t| t.id == entry.id));

        restore(&entry.id).unwrap();
        assert!(font.exists());
        assert!(!sidecar.exists(), "还原后账本应被收掉");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// DEF-6：移动失败后的分流真值表。真实场景是「IFileOperation 报 aborted、
    /// 但文件已经搬进 Windows 回收站」——测试环境造不出来，真值表必须锁死。
    #[test]
    fn recover_move_failure_truth_table() {
        let tmp = std::env::temp_dir().join(format!("zfm-recover-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("src.ttf");
        let dest = tmp.join("dest.ttf");

        // 原文件还在 → 回滚（哪怕副本已经落成：库里的字体不能动）
        fs::write(&src, b"a").unwrap();
        fs::write(&dest, b"b").unwrap();
        assert_eq!(recover_move_failure(&src, &dest), MoveRecovery::Rollback);

        // 原文件没了、副本在 → 认账（DEF-6 实测场景：副本是唯一留存）
        fs::remove_file(&src).unwrap();
        assert_eq!(recover_move_failure(&src, &dest), MoveRecovery::Commit);

        // 原文件没了、副本也没落成 → 回滚（干净的「什么都没发生」）
        fs::remove_file(&dest).unwrap();
        assert_eq!(recover_move_failure(&src, &dest), MoveRecovery::Rollback);

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 回收站目标名要同时避让「已存在的文件」和「已存在的账本」：
    /// 只避让文件时，同名旧账本会被新条目压掉，旧条目从此凭空消失。
    #[test]
    fn unique_dest_avoids_existing_sidecars() {
        let tmp = std::env::temp_dir().join(format!("zfm-dest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let name = std::ffi::OsStr::new("Dup.ttf");
        let first = unique_dest(&tmp, name);
        assert_eq!(first.file_name().unwrap(), name);
        assert_eq!(
            sidecar_path(&first).file_name().unwrap().to_string_lossy(),
            "Dup.ttf.zfmtrash"
        );

        // 只建账本、不建文件：dest 本身没被占，但账本路径被占 → 也必须让位
        fs::write(sidecar_path(&first), b"{}").unwrap();
        let second = unique_dest(&tmp, name);
        assert_ne!(second, first, "账本被占的名字也要避让");
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "1-Dup.ttf");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// C7 真机验证：跨盘「移动」导入必须把源文件送进回收站，并如实回报 `recycled = true`。
    ///
    /// 同盘 `rename` 直接成功，跨盘才落到「复制 + 源进回收站」那条分支，
    /// 所以这里强制要求源和目标在不同盘。样本路径用环境变量给，不把用户路径写进仓库：
    ///   ZFM_CROSS_SRC=D:\some\dir  ZFM_CROSS_DST=E:\tmp\lib  cargo test cross_drive -- --ignored --nocapture
    #[test]
    #[ignore]
    fn cross_drive_move_recycles_source() {
        let src_dir = match std::env::var("ZFM_CROSS_SRC") {
            Ok(v) => std::path::PathBuf::from(v),
            Err(_) => {
                println!("跳过：未设置 ZFM_CROSS_SRC");
                return;
            }
        };
        let dst_dir = match std::env::var("ZFM_CROSS_DST") {
            Ok(v) => std::path::PathBuf::from(v),
            Err(_) => {
                println!("跳过：未设置 ZFM_CROSS_DST");
                return;
            }
        };
        let src_drive = src_dir.components().next();
        let dst_drive = dst_dir.components().next();
        assert_ne!(src_drive, dst_drive, "必须在不同盘之间测，否则测不到跨盘分支");

        fs::create_dir_all(&dst_dir).unwrap();
        let mut moved = 0usize;
        let mut recycled = 0usize;
        let mut names: Vec<String> = vec![];
        for entry in fs::read_dir(&src_dir).unwrap() {
            let src = entry.unwrap().path();
            if !src.is_file() {
                continue;
            }
            let name = src.file_name().unwrap().to_string_lossy().into_owned();
            let dest = dst_dir.join(&name);
            let was_recycled = place_file(&src, &dest, false).expect("移动失败");
            assert!(!src.exists(), "源文件应当已经不在了: {src:?}");
            assert!(dest.exists(), "目标文件应当存在: {dest:?}");
            println!(
                "{name}: recycled={was_recycled} size={}",
                fs::metadata(&dest).unwrap().len()
            );
            moved += 1;
            if was_recycled {
                recycled += 1;
            }
            names.push(name);
        }
        println!("moved={moved} recycled={recycled} dst={dst_dir:?} files={names:?}");
        assert!(moved > 0, "样本目录里没有文件");
        assert_eq!(
            recycled, moved,
            "跨盘移动必须走「复制 + 源进回收站」，否则源文件是被硬删的"
        );
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn unregister_user_font(path: &str) {
    use crate::registry;
    registry::remove_font_resource(path);
    for name in registry::user_entries_for(path) {
        let _ = registry::delete_user_entry(&name);
    }
    refresh_system_font_cache();
}
