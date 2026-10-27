#![cfg_attr(
    not(any(target_os = "windows", target_os = "macos")),
    allow(dead_code, unused_imports)
)]

use std::process::Command;

pub const NOT_RUNNING: &str = "not-running";

#[derive(Clone, Copy)]
pub enum Target {
    Photoshop,
    Illustrator,
    /// CorelDRAW Graphics Suite：没有 JavaScript 接口，只能直接操纵 COM 对象模型
    CorelDraw,
}

impl Target {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "photoshop" => Ok(Target::Photoshop),
            "illustrator" => Ok(Target::Illustrator),
            "coreldraw" => Ok(Target::CorelDraw),
            other => Err(format!("unknown application: {other}")),
        }
    }

    fn is_corel(self) -> bool {
        matches!(self, Target::CorelDraw)
    }
}

pub fn available() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn photoshop_script(postscript: &str, label: &str) -> String {
    format!(
        r#"(function () {{
  var font = {ps};
  var family = {label};
  if (app.documents.length === 0) {{ return "no-document"; }}
  var doc = app.activeDocument;

  function hasBackground() {{ try {{ doc.backgroundLayer; return true; }} catch (e) {{ return false; }} }}

  function selectedIndices() {{
    var out = [];
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    var key = stringIDToTypeID("targetLayers");
    if (desc.hasKey(key)) {{
      var list = desc.getList(key);
      var offset = hasBackground() ? 0 : 1;
      for (var i = 0; i < list.count; i++) {{ out.push(list.getReference(i).getIndex() + offset); }}
    }}
    return out;
  }}

  function selectByIndex(idx, add) {{
    var ref = new ActionReference();
    ref.putIndex(charIDToTypeID("Lyr "), idx);
    var desc = new ActionDescriptor();
    desc.putReference(charIDToTypeID("null"), ref);
    if (add) {{
      desc.putEnumerated(stringIDToTypeID("selectionModifier"), stringIDToTypeID("selectionModifierType"), stringIDToTypeID("addToSelection"));
    }}
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
  }}

  var unknown = false;
  var sawText = false;

  /**
   * 在一个图层上换字体。用户点的是「换掉选中文字的字体」，所以：
   * - 组（LayerSet）要递归进去，把里面所有文字图层都换掉——用户在图层面板里
   *   点中的往往是整个组，之前只看 activeLayer 的 kind，组一律不算文字，
   *   结果就是明明选中了文字却跑去新建图层；
   * - PostScript 名认不出时再试一次字族名（部分字体在 PS 里以族名登记）；
   * - 赋值抛异常或读回不一致都算「这个字体 PS 不认识」。
   */
  function applyTo(layer) {{
    if (layer.typename === "LayerSet") {{
      var n = 0, i;
      for (i = 0; i < layer.artLayers.length; i++) {{ var a = applyTo(layer.artLayers[i]); if (a > 0) n += a; }}
      for (i = 0; i < layer.layerSets.length; i++) {{ var b = applyTo(layer.layerSets[i]); if (b > 0) n += b; }}
      return n;
    }}
    if (layer.kind !== LayerKind.TEXT) {{ return 0; }}
    sawText = true;
    try {{ layer.textItem.font = font; }} catch (e) {{
      try {{ layer.textItem.font = family; }} catch (e2) {{ unknown = true; return 0; }}
    }}
    var cur = layer.textItem.font;
    if (cur === font || cur === family) {{ return 1; }}
    unknown = true;
    return 0;
  }}

  var applied = 0, r;
  var indices = [];
  try {{ indices = selectedIndices(); }} catch (e) {{ indices = []; }}
  var hadSelection = indices.length > 0;
  if (indices.length > 1) {{
    for (var i = 0; i < indices.length; i++) {{
      try {{ selectByIndex(indices[i], false); r = applyTo(doc.activeLayer); if (r > 0) applied += r; }} catch (e) {{}}
    }}
    try {{ selectByIndex(indices[0], false); for (var j = 1; j < indices.length; j++) selectByIndex(indices[j], true); }} catch (e) {{}}
  }} else {{
    try {{ r = applyTo(doc.activeLayer); if (r > 0) applied += r; }} catch (e) {{}}
  }}
  if (applied > 0) {{ return "applied:" + applied; }}
  if (unknown) {{ return "font-not-found"; }}
  // 有选中但里面（含组内）没有文字图层：不要悄悄新建，明确告诉用户先去选中文字
  if (hadSelection) {{ return "no-text-selected"; }}
  if (doc.mode === DocumentMode.BITMAP || doc.mode === DocumentMode.INDEXEDCOLOR) {{ return "apply-failed"; }}

  var prevUnits = app.preferences.rulerUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  var layer = null;
  try {{
    layer = doc.artLayers.add();
    layer.kind = LayerKind.TEXT;
    layer.name = label;
    layer.textItem.contents = label;
    layer.textItem.size = 48;
    layer.textItem.position = [doc.width.value / 8, doc.height.value / 2];
    try {{ layer.textItem.font = font; }} catch (e0) {{ layer.textItem.font = family; }}
    if (layer.textItem.font !== font && layer.textItem.font !== family) {{ layer.remove(); return "font-not-found"; }}
  }} catch (e) {{
    if (layer) {{ try {{ layer.remove(); }} catch (e2) {{}} }}
    return "font-not-found";
  }} finally {{
    app.preferences.rulerUnits = prevUnits;
  }}
  return "created";
}})();"#,
        ps = js_string(postscript),
        label = js_string(label),
    )
}

fn illustrator_script(postscript: &str, label: &str) -> String {
    format!(
        r#"(function () {{
  var name = {ps};
  var family = {label};
  if (app.documents.length === 0) {{ return "no-document"; }}
  var doc = app.activeDocument;
  var font = null;
  // PostScript 名认不出时再试字族名——部分字体在 textFonts 里按族名登记
  try {{ font = app.textFonts.getByName(name); }} catch (e) {{}}
  if (!font) {{ try {{ font = app.textFonts.getByName(family); }} catch (e) {{}} }}
  if (!font) {{ return "font-not-found"; }}

  var applied = 0;

  /**
   * 与 Photoshop 一致的语义：换掉「选中的文字」的字体。
   * 编组（GroupItem）要递归进去——用选择工具点中的常是编组，
   * 之前只认 TextFrame/TextRange，编组一律不算文字，结果跑去新建。
   */
  function applyItem(item) {{
    try {{
      if (item.typename === "TextFrame") {{ item.textRange.characterAttributes.textFont = font; applied++; }}
      else if (item.typename === "TextRange") {{ item.characterAttributes.textFont = font; applied++; }}
      else if (item.typename === "GroupItem") {{
        for (var k = 0; k < item.pageItems.length; k++) {{ applyItem(item.pageItems[k]); }}
      }}
    }} catch (e) {{}}
  }}

  var sel = doc.selection;
  if (sel && sel.length) {{
    for (var i = 0; i < sel.length; i++) {{ applyItem(sel[i]); }}
  }}
  if (applied > 0) {{ return "applied:" + applied; }}
  // 有选中但没有文字（或只有路径 / 图片）：不要悄悄新建，明确告诉用户
  if (sel && sel.length) {{ return "no-text-selected"; }}

  var frame = null;
  try {{
    frame = doc.textFrames.add();
    frame.contents = label;
    frame.textRange.characterAttributes.textFont = font;
    frame.textRange.characterAttributes.size = 48;
    frame.position = [doc.width / 8, doc.height / 2];
  }} catch (e) {{
    if (frame) {{ try {{ frame.remove(); }} catch (e2) {{}} }}
    return "apply-failed";
  }}
  return "created";
}})();"#,
        ps = js_string(postscript),
        label = js_string(label),
    )
}

fn script_for(target: Target, postscript: &str, label: &str) -> String {
    match target {
        Target::Photoshop => photoshop_script(postscript, label),
        Target::Illustrator => illustrator_script(postscript, label),
        // CorelDRAW 不走 JavaScript，脚本由 Windows 分支直接生成
        Target::CorelDraw => String::new(),
    }
}

/// PowerShell 单引号字符串字面量
#[cfg(target_os = "windows")]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/**
 * CorelDRAW：没有 DoJavaScript 之类的脚本入口，只能直接驱动 COM 对象模型。
 * 语义与 Photoshop / Illustrator 一致——
 * 没在运行就报 not-running（不替用户拉软件）；选中的文本换字体；
 * 没选中文本时新建一个美术字。
 *
 * 几个在 CorelDRAW Graphics Suite 2022（v24）上逐步实测出来的坑，别改回去：
 *
 * 1) CorelDRAW **不注册 Running Object Table**：进程明明在跑，
 *    `Marshal.GetActiveObject('CorelDRAW.Application')` 也一律返回
 *    MK_E_UNAVAILABLE (0x800401E3)。所以「是否在运行」只能看进程
 *    （`Get-Process CorelDRW`），连接走 `[Type]::GetTypeFromProgID` +
 *    `[Activator]::CreateInstance`（挂到现有实例上，复用同一批文档）。
 *    **绝对不要在没运行时替用户激活**：机器上常装着多个版本的 CorelDRAW，
 *    无版本号的主 ProgID 指向哪个版本不可控，会把旧版拉起来。
 * 2) 多版本共存的机器上，先读每个 ProgID 的 CLSID\LocalServer32，
 *    挑「exe 路径 = 正在运行的 CorelDRW.exe」的那个版本再连接。
 * 3) 没有 `Documents.Add()`，建文档用 **`$app.CreateDocument()`**。
 * 4) 换字体用 **`Shape.Text.Story.Font`**（直接赋值 + 读回来比对）。
 *    `IVGStructFontProperties` 结构体的 `.Name` 在 2022 上**写不进去**
 *    （连结构体自身的 `.Name` 都不变），所以不能走 FontProperties 路线。
 * 5) CorelDRAW 认不出的字体名会被**静默忽略**（不抛异常），唯一可靠的成功判据
 *    是赋值后读回来比对（`-eq` 在 PowerShell 里对字符串大小写不敏感）。
 * 6) `Layer.CreateArtisticText` 只有 **三参版本**可用；
 *    带字体名 / 字号的 4、5 参重载会 DISP_E_TYPEMISMATCH。字号随后用
 *    `Text.Story.Size` 设置，单位是「点」，与文档单位无关。
 */
#[cfg(target_os = "windows")]
const CORELDRAW_TEMPLATE: &str = r#"$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# 与 PS / AI 同一条规则：没在运行就直接报未运行，不替用户拉软件。
$procsAll = @(Get-Process -Name 'CorelDRW' -ErrorAction SilentlyContinue)
if ($procsAll.Count -eq 0) { Write-Output 'not-running'; exit 0 }
$procs = @($procsAll | Where-Object { $_.Path })

# 主 ProgID + 各版本后缀，从高到低试（22 ~ 26 对应 CorelDRAW X8 之后的版本号）
$ids = @('CorelDRAW.Application','CorelDRAW.Application.26','CorelDRAW.Application.25','CorelDRAW.Application.24','CorelDRAW.Application.23','CorelDRAW.Application.22','CorelDRAW.Application.21','CorelDRAW.Application.20','CorelDRAW.Application.19','CorelDRAW.Application.18','CorelDRAW.Application.17')

# 读某个 ProgID 的 COM 服务器 exe 路径（LocalServer32 形如 "C:\...\CorelDRW.exe" /Automation）
function Get-ProgIDExe($id) {
  try {
    $t = [Type]::GetTypeFromProgID($id)
    if (-not $t) { return $null }
    $key = 'Registry::HKEY_CLASSES_ROOT\CLSID\' + $t.GUID.ToString('B') + '\LocalServer32'
    $v = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
    if (-not $v) { return $null }
    if ($v -match '^"([^"]+)"') { return $Matches[1] }
    return ($v -split '\s+')[0]
  } catch { return $null }
}

$app = $null
# 优先：LocalServer32 的 exe 和正在运行的进程是同一个文件 → 挂到这个版本上
foreach ($id in $ids) {
  if ($app) { break }
  $exe = Get-ProgIDExe $id
  if (-not $exe -or $procs.Count -eq 0) { continue }
  foreach ($p in $procs) {
    if ($exe -ieq $p.Path) {
      try { $app = [Activator]::CreateInstance([Type]::GetTypeFromProgID($id)) } catch { $app = $null }
      break
    }
  }
}
# 兜底：进程路径拿不到（权限）或对不上注册表（便携版）就按 ProgID 顺序挂
if (-not $app) {
  foreach ($id in $ids) {
    if ($app) { break }
    try { $app = [Activator]::CreateInstance([Type]::GetTypeFromProgID($id)) } catch { $app = $null }
  }
}
if (-not $app) { Write-Output 'not-running'; exit 0 }

# 进程起来了不代表 automation 已挂上，轮询 Version 等它就绪（最多 30 秒）
$ready = $false
$until = [DateTime]::Now.AddSeconds(30)
while (-not $ready -and [DateTime]::Now -lt $until) {
  try { if ($app.Version) { $ready = $true } } catch { Start-Sleep -Milliseconds 200 }
}
if (-not $ready) { Write-Output 'launch-timeout'; exit 0 }
try { $app.Visible = $true } catch {}

$doc = $null
try { $doc = $app.ActiveDocument } catch { $doc = $null }
if (-not $doc) { try { $doc = $app.CreateDocument() } catch { $doc = $null } }
if (-not $doc) { Write-Output 'no-document'; exit 0 }

$names = @({FONTS})

# 返回 'no-text'（没有文字）/ 'ok' / 'fail'（有文字但候选名全都没被接受）
function Set-CorelFont($shape, $cands) {
  $story = $null
  try { $story = $shape.Text.Story } catch { $story = $null }
  if (-not $story) { return 'no-text' }
  foreach ($n in $cands) {
    try {
      $story.Font = $n
      Start-Sleep -Milliseconds 10
      if ($story.Font -eq $n) { return 'ok' }
    } catch {}
  }
  return 'fail'
}

$shapes = @()
try {
  $sr = $app.ActiveSelectionRange
  if ($sr -and $sr.Shapes -and $sr.Shapes.Count -gt 0) { foreach ($s in $sr.Shapes) { $shapes += $s } }
} catch {}
if ($shapes.Count -eq 0) {
  try { $one = $app.ActiveShape; if ($one) { $shapes += $one } } catch {}
}

# 失败码细分：字体在 CorelDRAW 字体列表里、但赋值被静默吞掉 → 'font-rejected'
# （最常见的原因：给中文文字套用不含中文字形的西文字体，CorelDRAW 只认能覆盖该文字的字体）
function Get-FailCode() {
  try {
    # 用哈希表比对：装了上万字体的机器上，把 FontList 逐个塞进数组再遍历是 O(n²)，
    # 光是这段就能耗掉几秒。
    $want = @{}
    foreach ($n in $names) { $want[[string]$n] = $true }
    foreach ($f in $app.FontList) {
      if ($want.ContainsKey([string]$f)) { return 'font-rejected' }
    }
  } catch {}
  return 'font-not-found'
}

$applied = 0
$unknown = $false
foreach ($s in $shapes) {
  $r = Set-CorelFont $s $names
  if ($r -eq 'ok') { $applied = $applied + 1 }
  elseif ($r -eq 'fail') { $unknown = $true }
}
if ($applied -gt 0) { Write-Output ('applied:' + $applied); exit 0 }
if ($unknown) { Write-Output (Get-FailCode); exit 0 }

# 没选中任何文字：新建一段美术字把字体铺上去。
# 坐标是文档单位（默认英寸），原点在页面左下角，取「靠左 + 页面上方 40%」处。
$layer = $null
try { $layer = $doc.ActiveLayer } catch { $layer = $null }
if (-not $layer) { Write-Output 'apply-failed'; exit 0 }

$x = 1; $y = 5
try { $x = [double]$doc.ActivePage.SizeWidth * 0.1 } catch { $x = 1 }
try { $y = [double]$doc.ActivePage.SizeHeight * 0.6 } catch { $y = 5 }
if ($y -le 0) { $y = 5 }

foreach ($n in $names) {
  $made = $null
  try { $made = $layer.CreateArtisticText([double]$x, [double]$y, {LABEL}) } catch { $made = $null }
  if (-not $made) { continue }
  if ((Set-CorelFont $made $names) -eq 'ok') {
    try { $made.Text.Story.Size = 48 } catch {}
    try { $made.CreateSelection() } catch {}
    Write-Output 'created'; exit 0
  }
  # 字体没认出来就别留痕迹
  try { $made.Delete() } catch {}
}
Write-Output (Get-FailCode)
"#;

#[cfg(target_os = "windows")]
fn coreldraw_script(label: &str, postscript: &str) -> String {
    let fonts = corel_font_names(label, postscript)
        .iter()
        .map(|n| ps_quote(n))
        .collect::<Vec<_>>()
        .join(",");
    CORELDRAW_TEMPLATE
        .replace("{FONTS}", &fonts)
        .replace("{LABEL}", &ps_quote(label))
}

/// 候选字体名：先显示名，再 PostScript 名（CorelDRAW 认哪个用哪个）
#[cfg(target_os = "windows")]
fn corel_font_names(label: &str, postscript: &str) -> Vec<String> {
    let mut fonts = vec![label.to_string()];
    if !postscript.is_empty() && postscript != label {
        fonts.push(postscript.to_string());
    }
    fonts
}

fn finish(out: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }

    Ok(stdout.lines().last().unwrap_or("").trim().to_string())
}

#[cfg(target_os = "windows")]
pub fn apply(target: Target, postscript: &str, label: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // CorelDRAW 走常驻宿主：它把 COM 连接攥在手里，避免每次点字体都重付
    // 「首次访问对象图」那 4 秒的初始化税（详见 comhost.rs 顶部注释）。
    // 宿主出任何问题（起不来 / 超时 / 崩了）都回落到下面的一次性脚本，
    // 保证功能不会因为这一层而整体不可用。
    if target.is_corel() {
        let names = corel_font_names(label, postscript);
        match crate::comhost::apply(label, &names) {
            Ok(outcome) => return Ok(outcome),
            // 超时不要直接报给用户：宿主可能只是攥着一个已经卡住的连接（CorelDRAW
            // 忙过一次就会留下这种连接）。丢掉宿主重新起一个，新连接通常 0.6 秒就通。
            // 实测：冷宿主 646ms / 热宿主 250ms，一次重试的成本远小于让用户白等 25 秒。
            Err(e) if e.contains("timeout") => {
                crate::comhost::shutdown();
                match crate::comhost::apply(label, &names) {
                    Ok(outcome) => return Ok(outcome),
                    // 重试也超时 = CorelDRAW 真的没响应（模态框 / 正在渲大图）
                    Err(e2) if e2.contains("timeout") => {
                        return Ok("app-no-response".to_string());
                    }
                    // 重试时是宿主自身的问题，仍按老路回落一次性脚本
                    Err(_) => {}
                }
            }
            // 其余都是宿主自身的问题（起不来 / 崩了 / 管道断了），回落到一次性脚本
            Err(_) => {}
        }
    }

    // CorelDRAW 没有脚本入口，整段 PowerShell 自己驱动 COM；Photoshop / Illustrator
    // 则把 JSX 落盘后交给 DoJavaScript 执行。
    let (ps, script_path) = if target.is_corel() {
        (coreldraw_script(label, postscript), None)
    } else {
        let prog_id = match target {
            Target::Photoshop => "Photoshop.Application",
            Target::Illustrator => "Illustrator.Application",
            Target::CorelDraw => unreachable!(),
        };
        let path = std::env::temp_dir()
            .join(format!("zfontmanager-apply-{}.jsx", std::process::id()));
        std::fs::write(&path, script_for(target, postscript, label)).map_err(|e| e.to_string())?;
        let path_literal = path.to_string_lossy().replace('\'', "''");
        (format!(
            "$ErrorActionPreference = 'Stop'\n\
             try {{ [Console]::OutputEncoding = [Text.Encoding]::UTF8 }} catch {{}}\n\
             try {{ $a = [Runtime.InteropServices.Marshal]::GetActiveObject('{prog_id}') }} catch {{ Write-Output '{NOT_RUNNING}'; exit 0 }}\n\
             $code = [IO.File]::ReadAllText('{path_literal}', [Text.Encoding]::UTF8)\n\
             try {{ $r = $a.DoJavaScript($code); Write-Output ([string]$r) }} catch {{ Write-Output ('ps-error:' + $_.Exception.Message) }}\n"
        ), Some(path))
    };

    let utf16: Vec<u8> = ps.encode_utf16().flat_map(|w| w.to_le_bytes()).collect();
    let encoded = base64_encode(&utf16);

    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let exe = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let exe = if std::path::Path::new(&exe).exists() { exe } else { "powershell".to_string() };

    // CorelDRAW 脚本里有轮询与读回比对（最多再等 30 秒就绪），给 60 秒足够；
    // 未运行的情况脚本自己立刻返回。PS / AI 只是执行一段 JSX，几秒就够。
    let budget = if target.is_corel() {
        std::time::Duration::from_secs(60)
    } else {
        std::time::Duration::from_secs(30)
    };
    let mut child = match Command::new(exe)
        // -Sta：CorelDRAW 这类单线程套间的 COM 服务器在非交互 powershell 下
        // 默认可能是 MTA，显式指定避免属性写入被静默丢弃。
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };

    // 脚本只在最后打印一行结果，所以边跑边读 stdout：拿到结果就杀掉子进程。
    // 原因：PowerShell 跑完脚本后，退出时要释放 CorelDRAW 的 COM 对象（CLR/RCW 收尾），
    // 实测那段要 4~7 秒，而脚本本体只花 1~2 秒——等它「优雅退出」是纯浪费。
    let stdout_pipe = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    if let Some(mut so) = stdout_pipe {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let mut reader = std::io::BufReader::new(&mut so);
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = buf.trim().to_string();
                        if !line.is_empty() && tx.send(Some(line)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(None);
        });
    } else {
        let _ = tx.send(None);
    }

    let deadline = std::time::Instant::now() + budget;
    let mut lines: Vec<String> = Vec::new();
    let mut killed_early = false;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(path) = script_path.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            return Ok(if target.is_corel() {
                "launch-timeout".to_string()
            } else {
                "ps-error:timeout".to_string()
            });
        }
        match rx.recv_timeout(left) {
            Ok(Some(line)) => {
                // 进程还活着说明脚本已打完结果、正在收尾 → 直接杀掉
                let alive = matches!(child.try_wait(), Ok(None));
                lines.push(line);
                if alive {
                    let _ = child.kill();
                    let _ = child.wait();
                    killed_early = true;
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(path) = script_path.as_ref() {
                    let _ = std::fs::remove_file(path);
                }
                return Ok(if target.is_corel() {
                    "launch-timeout".to_string()
                } else {
                    "ps-error:timeout".to_string()
                });
            }
        }
    }

    if let Some(path) = script_path {
        let _ = std::fs::remove_file(&path);
    }

    // 提前杀掉的分支：脚本已经给出结果，退出码不可信（是我们 kill 的），直接采信最后一行
    if killed_early {
        return Ok(lines.last().cloned().unwrap_or_default());
    }

    // 进程自己结束：沿用「退出码 + stderr」判定（脚本报错走这条）
    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    let mut stderr = Vec::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let _ = e.read_to_end(&mut stderr);
    }
    let out = std::process::Output {
        status,
        stdout: lines.join("\n").into_bytes(),
        stderr,
    };
    finish(out)
}

#[cfg(target_os = "windows")]
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 只读探针：确认能不能接上 Photoshop / Illustrator，顺便量一下要多久。
///
/// 底部那条预热指示器需要「现在到底是不是热的」。这两个软件没有常驻连接，
/// 所以这里测的是「接一次要多少毫秒」——这个数字就是用户点击后要等的时间。
#[cfg(target_os = "windows")]
pub fn probe(target: Target) -> Result<(bool, u32), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let prog_id = match target {
        Target::Photoshop => "Photoshop.Application",
        Target::Illustrator => "Illustrator.Application",
        Target::CorelDraw => return Err("probe: CorelDRAW 走 comhost".to_string()),
    };
    let ps = format!(
        "$ErrorActionPreference = 'Stop'\n\
         try {{ [Console]::OutputEncoding = [Text.Encoding]::UTF8 }} catch {{}}\n\
         try {{ $a = [Runtime.InteropServices.Marshal]::GetActiveObject('{prog_id}') }} catch {{ Write-Output '{NOT_RUNNING}'; exit 0 }}\n\
         if ($a) {{ Write-Output ('ok:' + [string]$a.Name) }} else {{ Write-Output '{NOT_RUNNING}' }}\n"
    );
    let utf16: Vec<u8> = ps.encode_utf16().flat_map(|w| w.to_le_bytes()).collect();
    let encoded = base64_encode(&utf16);

    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let exe = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let exe = if std::path::Path::new(&exe).exists() { exe } else { "powershell".to_string() };

    let started = std::time::Instant::now();
    let mut child = Command::new(exe)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let deadline = started + std::time::Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("probe: timeout".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let ms = started.elapsed().as_millis() as u32;
    let mut buf = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let mut raw = Vec::new();
        let _ = out.read_to_end(&mut raw);
        buf = String::from_utf8_lossy(&raw).to_string();
    }
    let first = buf.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if first.starts_with("ok:") {
        Ok((true, ms))
    } else {
        Ok((false, ms))
    }
}

#[cfg(target_os = "macos")]
pub fn apply(target: Target, postscript: &str, label: &str) -> Result<String, String> {
    let bundle = match target {
        Target::Photoshop => "com.adobe.Photoshop",
        Target::Illustrator => "com.adobe.illustrator",
        // CorelDRAW 没有 macOS 版
        Target::CorelDraw => return Err("CorelDRAW is Windows-only".into()),
    };

    let probe = Command::new("osascript")
        .args([
            "-e",
            &format!(
                r#"tell application "System Events" to (exists (first application process whose bundle identifier is "{bundle}"))"#
            ),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Ok(NOT_RUNNING.to_string());
    }

    let out = Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            &format!(r#"tell application id "{bundle}" to do javascript (item 1 of argv)"#),
            "-e",
            "end run",
            &script_for(target, postscript, label),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    finish(out)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn apply(_target: Target, _postscript: &str, _label: &str) -> Result<String, String> {
    Err("Photoshop and Illustrator integration is only available on Windows and macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_embed_names_safely() {
        let ps = photoshop_script("My\"Font-Bold", "Fam \\ ily");
        assert!(ps.contains(r#"var font = "My\"Font-Bold";"#));
        assert!(ps.contains(r#"var family = "Fam \\ ily";"#));
        let ai = illustrator_script("Inter-Regular", "Inter");
        assert!(ai.contains(r#"app.textFonts.getByName(name)"#));
        assert!(ai.contains(r#"var name = "Inter-Regular";"#));
        assert!(ai.contains(r#"var family = "Inter";"#));
        // 选中了非文字图层要报 no-text-selected，不能再悄悄新建
        assert!(ps.contains("no-text-selected"));
        assert!(ai.contains("no-text-selected"));
        // PS 组要递归；AI 编组要递归
        assert!(ps.contains("LayerSet"));
        assert!(ai.contains("GroupItem"));
    }

    #[test]
    fn ps_script_handles_failures_gracefully() {
        let ps = photoshop_script("SomeFont-Regular", "Fam");
        assert!(ps.contains("catch (e)"));
        assert!(ps.contains("apply-failed"));
        assert!(ps.contains("DocumentMode.BITMAP"));
        assert!(ps.contains("font-not-found"));
        let ai = illustrator_script("SomeFont-Regular", "Fam");
        assert!(ai.contains("apply-failed"));
        assert!(ai.contains("frame.remove()"));
    }

    #[test]
    fn coreldraw_is_a_known_target() {
        assert!(Target::parse("coreldraw").is_ok());
        assert!(Target::parse("nope").is_err());
    }

    /// 真机调试用：把 PS / AI 的 JSX 落到 rust-target/scripts/，
    /// 供 Fonts工程文件/adobe_app_e2e.py 直接喂给 Photoshop / Illustrator 执行。
    /// 跑法：cargo test dump_scripts -- --exact --nocapture
    #[test]
    fn dump_scripts_for_e2e() {
        let dir = std::path::Path::new("../../../rust-target/scripts");
        let _ = std::fs::create_dir_all(dir);
        for (name, target) in [
            ("photoshop.jsx", Target::Photoshop),
            ("illustrator.jsx", Target::Illustrator),
        ] {
            let body = script_for(target, "ArialMT", "Arial");
            std::fs::write(dir.join(name), body).expect("write jsx");
        }
        std::fs::write(dir.join("photoshop.font-not-found.jsx"), photoshop_script("NoSuchFont-XYZ", "NoSuchFont"))
            .expect("write jsx");
        std::fs::write(dir.join("illustrator.font-not-found.jsx"), illustrator_script("NoSuchFont-XYZ", "NoSuchFont"))
            .expect("write jsx");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn coreldraw_script_embeds_names_safely() {
        let s = coreldraw_script("Bob's Font", "BobsFont-Regular");
        assert!(s.contains("'Bob''s Font'"), "单引号必须转义");
        assert!(s.contains("'BobsFont-Regular'"));
        assert!(!s.contains("{FONTS}"), "占位符要替换掉");
        assert!(!s.contains("{LABEL}"));
        assert!(s.contains("ActiveSelectionRange"));
        assert!(s.contains("CreateArtisticText"));
        // 必须靠 GetTypeFromProgID + Activator 激活：CorelDRAW 不注册 ROT，
        // Marshal.GetActiveObject 即使进程在跑也返回 MK_E_UNAVAILABLE
        assert!(s.contains("[Type]::GetTypeFromProgID"), "要走 COM 激活而不是 GetActiveObject");
        assert!(s.contains("[Activator]::CreateInstance"));
        assert!(!s.contains("GetActiveObject"));
        // 2022 上没有 Documents.Add，也没有四/五参 CreateArtisticText
        assert!(s.contains("CreateDocument"));
        assert!(!s.contains("Documents.Add"));
        assert!(s.contains("CreateArtisticText([double]$x, [double]$y,"), "只有三参版本可用");
        // 换字体要走 Story.Font（FontProperties 的 Name 写不进去）
        assert!(s.contains("$story.Font"), "换字体要走 Story.Font（FontProperties 的 Name 写不进去）");
        assert!(s.contains("Text.Story"));
        assert!(!s.contains("FontProperties"));
        assert!(s.contains("not-running"), "没运行就报未运行，不替用户拉软件");
        assert!(s.contains("Get-Process -Name 'CorelDRW'"), "用进程判断是否在运行（CorelDRAW 不注册 ROT）");
        assert!(s.contains("LocalServer32"), "多版本机器要按运行中的 exe 匹配 ProgID 版本");
        assert!(s.contains("launch-timeout"));
        assert!(s.contains("no-document"));
        assert!(s.contains("applied:"));
        assert!(s.contains("font-not-found"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn coreldraw_script_deduplicates_identical_names() {
        let s = coreldraw_script("Inter", "Inter");
        assert_eq!(s.matches("'Inter'").count(), 2, "名字数组 + 新建文本各用一次");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn base64_matches_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
