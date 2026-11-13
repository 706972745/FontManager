; ═══════════════════════════════════════════════════════════════════════════
; FontManager 安装器模板（自定义 fork，2.1.5 起）
;
; 来源：Tauri CLI 2.12.2 内嵌的 NSIS 模板（@tauri-apps/cli-win32-x64-msvc 里
;      以 handlebars 原文嵌入，共 984 行）。**不要凭空手写这份文件** ——
;      升级 Tauri 时的正确做法是重新提取上游模板与这份做 diff，再决定怎么合并。
;      执行器已经入库：`tools/nsis-fork-audit.js`（QA 写的溯源 + UI-only 审计），
;        git show 0b4f117:src-tauri/windows/installer.nsi > ../../_tmp/pristine.nsi
;        node tools/nsis-fork-audit.js ../../_tmp/pristine.nsi src-tauri/windows/installer.nsi
;      三段输出：[溯源] 未命中=0（pristine 逐字命中 CLI 内嵌模板，才配当基线）
;               → [审计] 被删/新增行 → [红线] 命中 Section Install / .onInit /
;               un.ConfirmShow / handlebars 循环（#each）即 exit 1。
;      ⚠️ 这类 diff **按「出现次数」（多重集）比，不能按集合比**：像
;         `MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive` 这种行在基线里本来就有多个合法
;         实例（许可页/完成页各一处），集合比会把「删掉一处但别处还留着」误判成「没删」。
;
; 本 fork 只改了「看得见的部分」：
;   · 配色（白底 + 近黑字）、欢迎页/完成页的文案与留白、目录页的写探针、
;     升级时跳过目录页、侧栏图换掉 NSIS 自带的蓝色 win.bmp；
;   · 双语文案集中到 zfm-strings.nsh（在 MUI_LANGUAGE 之后 include）。
;
; **一个字都没动**的东西（动了就是升级断链 / 数据被清）：
;   · .onInit 的 $INSTDIR 默认值与 RestorePreviousInstallLocation
;   · Section Install 里 WriteRegStr ... "" $INSTDIR、WriteUninstaller、
;     UNINSTKEY 的全部值与 EstimatedSize 计算
;   · 三个 NSIS_HOOK_* 插入点（位置也不能变：POSTINSTALL 必须在
;     StartMenuShortcut 之后、SetAutoClose 之前）
;   · un.ConfirmShow 的 GetDpiForWindow /96 换算
;   · 所有 handlebars 循环（#each …，当前大多为空，但将来加资源/文件关联全靠它们注入；
;     删掉以后加资源会静默丢失，构建不报错）
;
; 若某个界面文案突然变回英文长句 → 先来查 zfm-strings.nsh 里对 MUI_TEXT_* 的覆盖表，
; MUI 大版本升级可能把这些私有 LangString 改名（不会崩，只是覆盖失效）。
; ═══════════════════════════════════════════════════════════════════════════
Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

; ★ 2.1.5 新增：data 根标记文件名（安装器与程序共用同一个名字）
;   安装器在 $INSTDIR\data\.zfm-data-root 写 v=1；
;   程序迁移成功后往同一个文件追加 migrated=1。
;   程序只拿它当「这个安装根启用 data 布局」的信号，**不当迁移完成的证据** ——
;   迁移是否完成只认 data\state.json 是否存在（见 src-tauri/src/store.rs）。
!define ZFM_DATA_MARKER ".zfm-data-root"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; ────── 视觉：只有三档颜色，别再加第四种 ──────
; 底 #ffffff / 主文字 #1c1c24（纯黑 #000 在白色上发灰、显脏）/ 次级文字靠系统灰。
;
; ⚠️ MUI_BGCOLOR / MUI_TEXTCOLOR 的值会被 MUI **原样**传给 SetCtlColors
; （Interface.nsh:247-251），所以这里要写 BGR，不是 RGB：
;   #1c1c24  →  "241C1C"   （写反成 "1C1C24" 会得到 #241c1c，看着像黑但偏红）
;   #ffffff  →  "FFFFFF"   （对称，写反看不出来 —— 所以只写对这一个会漏掉另一个）
; 换算口诀：hex #RRGGBB → 0xBBGGRR。
; 为什么不做暗色：NSIS 的按钮、输入框、目录树都是**系统主题**画出来的浅色控件，
; 暗底上会贴出一排惨白的系统按钮，比现在更难看。真要暗色只能自绘所有控件，
; 那是 800 行 nsDialogs，与「只改 UI、可维护性优先」直接冲突。
!define MUI_BGCOLOR   "FFFFFF"
!define MUI_TEXTCOLOR "241C1C"

; Installer sidebar image
;
; ⚠️ 这里不是「有就放、没有就算了」：MUI_WELCOMEFINISHPAGE_BITMAP 的默认值是
; NSIS 自带的蓝色 win.bmp，而置空会编译期 !error（Pages/Welcome.nsh:26-28）——
; 「不放图」的真实结果是「还是那张蓝的」，正是用户抱怨的东西。
; 所以 sidebarImage 必须配（tauri.conf.json → bundle.windows.nsis.sidebarImage），
; 图由 windows/gen-nsis-images.py 生成（纯标准库手写 BMP，可重新生成）。
;
; 内容 = **纯白 #ffffff + 右缘 1px #efefef 竖线，不画图标**：
;   · 欢迎页改成自绘后，这张图只剩**完成页**在用；完成页右侧已经有「立即运行 /
;     桌面快捷方式」两个交互，左边再放 logo 只是抢注意力；
;   · FitControl 默认会把图**拉伸**到控件尺寸（164:314 不等于 MUI 内页 109u 的实际宽高比），
;     纯白 + 1px 竖线拉伸后仍是纯白 + 略粗的竖线（可接受），图标会被拉变形；
;   · 参考稿的美学就是「纯白 + 大量留白 + 1px 细线」，白底侧栏 = 「没有侧栏」。
; 图标版留在 gen-nsis-images.py 的 build_sidebar_icon() 里（P2，默认不调用）。
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
;
; ══════════════════════════════════════════════════════════════════════════
; 1. 欢迎页：**自绘**（Page custom），纯白满版 + 大标题 + 细线 + 页脚
; ══════════════════════════════════════════════════════════════════════════
; 为什么自绘而不是用 MUI 自带的欢迎页（Welcome 页宏）：
;   MUI 的欢迎页把标题固定成 12pt bold、正文固定 130u 高、左侧**永远**留 109u 给位图，
;   做不出参考稿那种「大标题 + 宽留白」的层次；而它的内部控件只能靠控件 ID 去改字体，
;   MUI 一升级就断。自绘一个**内页**反而更稳：nsDialogs::Create 1018 建的是内页，
;   外层窗口 / 按钮 / 品牌字仍然是 MUI 的，DPI 与键盘可达性都还在。
;
; DPI 三条纪律（125%/150% 全靠它们不错位）：
;   · 坐标**一律用 u**，禁止像素 —— u 由系统 DPI 换算，像素不会；
;   · 字号用 CreateFont 的「磅」，NSIS 内部按 GetDeviceCaps(LOGPIXELSY)/72 换算；
;   · 字族用 $(^Font)（系统 UI 字体），写死「微软雅黑」会让英文系统 fallback 成难看的字。
;
; 已知风险（在验收里盯）：用户在辅助功能里把「文本大小」调到 125% 以上时 u 会整体变大，
; 固定 u 高度的 Label 可能装不下两行正文 —— 靠「文案不超过 2 行 + 留够 12u 行高」来兜。
; 跨显示器拖动不重排是 NSIS 不处理 WM_DPICHANGED，属已知限制，不修（修 = 自己写窗口过程）。
Page custom ZfmWelcome
Function ZfmWelcome
  ; ── R-17：被动模式（/P）必须跳过本页 ──
  ; Page custom **没有 PRE 回调**，只能在 create 里 Abort —— 这是 NSIS 的既定用法。
  ; 不跳的后果：`setup.exe /P`（进度条模式的静默安装）会**卡在自绘页**上等人点下一步，
  ; 而 /P 的设计前提恰好是「不需要人」。静默模式（/S）NSIS 本来就不建页面，不受影响。
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  ; 外层 header 文案留空：大标题由下面自己的 Label 承担，否则同一句话会出现两遍
  !insertmacro MUI_HEADER_TEXT "" ""

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ; 整页白底：给内页本身刷背景色，否则会露出系统灰
  SetCtlColors $0 "0x241C1C" "0xFFFFFF"

  ; ── 版面（2026-11-13 截图实测后重排的，别再凭感觉改）──
  ;   · **负值坐标 = 距底**，按**内页实际高度**解析，不是固定像素。
  ;     实测（100% DPI、客户端 662×416）：内页白区 y≈84..348px，1u ≈ 1.88px
  ;     → 内页高约 **141u**（早先按「153u」估过一轮，负值落点算高了 12u，
  ;      页脚因此压到正文上 —— 所以这两个数必须以实测为准）。
  ;     -10u → 距顶 141-10 = 131u。换 DPI / 换 MUI 版本后要重新量一次。
  ;   · 第一版按 200u 排版的教训：页脚 -22u 解析成距顶 131u，正好压在 124u 起的
  ;     第二行正文上，屏幕上两行字叠在一起（截图实测两行渲染带都是 317..330）。
  ;   · 布局表（自上而下，y 为距顶，h 为高）：
  ;       大标题 26u/30u → 副标题 58u/14u → 细线 82u/1u → 正文 L1 92u/12u
  ;       → 正文 L2 108u/12u（底边 120u）→ 页脚 -10u/10u（距顶约 131u，与 L2 盒子隔 11u）
  ;   · 量出来的文字带（深像素行区间）：标题 140..169、副标题 193..208、
  ;     L1 257..270、L2 287..300、页脚 332..341 —— L2 与页脚之间隔 32px，无重叠。
  ;   · L2 底边与页脚之间至少 12u 间距是硬要求（截图量出来的最小不重叠距离）。

  ; 大标题 22pt/700（#1c1c24）
  ${NSD_CreateLabel} 16u 26u -32u 30u "$(ZM_WELCOME_TITLE)"
  Pop $1
  CreateFont $2 "$(^Font)" "22" "700"
  SendMessage $1 ${WM_SETFONT} $2 0
  SetCtlColors $1 "0x241C1C" "0xFFFFFF"

  ; 副标题 10pt/400（#727279）
  ${NSD_CreateLabel} 16u 58u -32u 14u "$(ZM_WELCOME_SUB)"
  Pop $3
  CreateFont $4 "$(^Font)" "10" "400"
  SendMessage $3 ${WM_SETFONT} $4 0
  SetCtlColors $3 "0x797272" "0xFFFFFF"

  ; 1u 高的「细线」：NSIS 没有 Line 控件，用一个实心背景的静态控件模拟（标准做法）。
  ; 用 u 不用 px —— 150% 下 1px 会消失，1u 会变成约 2px（可接受）。
  ${NSD_CreateLabel} 16u 82u -32u 1u ""
  Pop $5
  SetCtlColors $5 "0xEFEFEF" "0xEFEFEF"

  ; 正文两行：拆成两个 Label，不用 $\r$\n —— 不同 DPI 下 $\r$\n 的折行位置不可控
  ${NSD_CreateLabel} 16u 92u -32u 12u "$(ZM_WELCOME_L1)"
  Pop $6
  SetCtlColors $6 "0x797272" "0xFFFFFF"
  ${NSD_CreateLabel} 16u 108u -32u 12u "$(ZM_WELCOME_L2)"
  Pop $7
  SetCtlColors $7 "0x797272" "0xFFFFFF"

  ; 页脚小字（#9b9ba0）：y 用负值 = 距底（见上面版面表里的实测说明）
  ${NSD_CreateLabel} 16u -10u -32u 10u "$(ZM_FOOT)"
  Pop $8
  SetCtlColors $8 "0xA09B9B" "0xFFFFFF"

  nsDialogs::Show
FunctionEnd
;
; 注意：这里**没有** MUI_WELCOMEPAGE_TITLE / _TEXT 的 define 了 —— 欢迎页自绘后它们
; 不再被使用；留着只会让人误以为改那两行就能改文案（实际显示的是上面的 Label）。
; MUI_WELCOMEFINISHPAGE_BITMAP 仍然必须配：完成页还在用它（见上面 SIDEBARIMAGE 段）。

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  ;
  ; ★ R-18：下面三组 $R1/$R2/$R3 的赋值顺序就是「第几个 radio = 什么行为」的**唯一**定义，
  ;   PageLeaveReinstall 完全依赖它。逐条对照基线，不要「顺手整理」成看起来对称的写法：
  ;     同版本：R2(addOrReinstall) 进第 1 个 radio，R3(uninstallApp) 进第 2 个
  ;     升级　：R2(uninstallBeforeInstalling) 进第 1 个 —— 注意这里第 1 个**是卸载**
  ;     降级　：同上，且 downgrades 关闭时第 2 个 radio 被禁用
  ;   「推荐」这一行在升级场景里是 R3(dontUninstall)，进的是第 2 个 radio。
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    ; ★ 2.1.5 一行默认值修正（不是语义变更）：默认勾选**第 2 个** radio。
    ;   $R3 = dontUninstall = 「直接覆盖安装（推荐）」。不改的话默认停在第 1 个
    ;   （uninstallBeforeInstalling = 先卸载再安装）上，用户直接点下一步就走了卸载分支，
    ;   卸载成功但安装失败 = 这台机器上没软件了。
    ;   ⚠️ 这里只写 $ReinstallPageCheck 的**初值**；上面 $R1/$R2/$R3 的映射与
    ;   PageLeaveReinstall 的分支逻辑一个字节都不许动（R-18 红线）。
    ;
    ;   ★★ 这个守卫必须写 `= 0`（数值比较），**不能**写 `== 0`（字符串比较）。
    ;   LogicLib 的语义（Include\LogicLib.nsh）：
    ;     `==` → StrCmp（字符串比较）；`=` → IntCmp（数值比较，空串按 0）
    ;   而 `Var ReinstallPageCheck` 的初值是**空串**：
    ;     StrCmp("", "0") 恒假 → 守卫从不触发 → 默认永远停在第 1 个 radio；
    ;     IntCmp("", 0) 成立 → 空串算 0 → 守卫按预期触发。
    ;   用户点过 radio 之后值是 "1"/"2"，IntCmp("1",0) 为假，返回上一页时的选择原样保留
    ;   （PageReinstallUpdateSelection 只在点过 radio 之后才写 1/2）。
    ;   教训一句话：**判「变量还没被赋值」必须用 `=`，用 `== 0` 永远不成立。**
    ${If} $ReinstallPageCheck = 0
      StrCpy $ReinstallPageCheck 2
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
      ; 同上：默认停在第 2 个（= 直接覆盖安装）。只改初值，不动 R-18 映射。
      ; 守卫同样是 `= 0`（数值），理由见上面那段 LogicLib 说明。
      ${If} $ReinstallPageCheck = 0
        StrCpy $ReinstallPageCheck 2
      ${EndIf}
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
      ; 这里**不**改默认：禁止降级时第 2 个 radio 是禁用的（下面 EnableWindow 0），
      ; 默认勾一个灰掉的选项等于给用户一个点不动的「推荐」。
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ; ══════════════════════════════════════════════════════════════════════════
  ; ⚠️ R-18 安全红线：这个函数里的**语义映射**一个字都不能动。
  ;
  ; $R0 = 版本比较结果（0 同版本 / 1 升级 / -1 降级）；
  ; $R1 = 用户选中的是第几个 radio（1 = 第一个 / 0 = 第二个）。
  ; 而「第一个 radio 是卸载还是直接覆盖」由 PageReinstall 里那三组 StrCpy 决定，
  ; 且**每组的分工不一样**（同版本页 1=直接装、升级页 1=先卸载）。
  ;
  ; 把 $R1 的语义或那三组 StrCpy 的赋值顺序对调 = 用户在「推荐」选项上点下一步，
  ; 实际走了**卸载**分支：卸载完再装失败，用户就没软件了（数据还在，但软件没了，
  ; 而且他不知道发生了什么）。这是本文件里唯一「改错就毁机器」的地方。
  ;
  ; 允许改的只有：这些分支里引用的 $(...) 文案（见 zfm-strings.nsh 的
  ; alreadyInstalled / dontUninstall / uninstallBeforeInstalling 覆盖）。
  ; ══════════════════════════════════════════════════════════════════════════
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
;
; 这一页是「装到 D 盘」的唯一入口，必须有（去掉它 = G2 直接失去意义）。
; 但**升级时必须跳过**并锁回旧目录 —— 见 ZfmDirPre 里那段反例说明。
!define MUI_DIRECTORYPAGE_TEXT_TOP         "$(ZM_DIR_TOP)"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "$(ZM_DIR_DEST)"
!define MUI_PAGE_CUSTOMFUNCTION_PRE        ZfmDirPre
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE      ZfmDirLeave
!insertmacro MUI_PAGE_DIRECTORY

Function ZfmDirPre
  ; ① 被动模式（/P）跳过本页 —— 与上游原来的 SkipIfPassive 完全等价。
  ;    MUI 每页只允许一个 PRE 回调，所以这里必须把它合进来而不是再 define 一个。
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}

  ; ② 显式 /D=... 是「我就是要装到这儿」（企业静默部署），按用户意愿执行，
  ;    不做「升级锁目录」的覆盖。不给这个出口会把合法用法一起挡掉。
  ${GetOptions} $CMDLINE "/D=" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}

  ; ③ 升级（注册表里已有安装目录）→ 跳过本页并把 $INSTDIR 钉回去。
  ;
  ; 反例（不跳）：老用户在升级时手滑把路径从 %LOCALAPPDATA%\FontManager 改成
  ; D:\FontManager，装完就是**两套**：桌面快捷方式指向新的，字体库和账本留在旧的，
  ; 用户看到的是「升个级标签分组全没了」。这比迁移逻辑写错更常见，也更容易被
  ; 误判成「数据丢了」—— 所以这一条是硬规则，不要为了「灵活」而放开。
  ReadRegStr $R0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
    Abort
  ${EndIf}
FunctionEnd

Function ZfmDirLeave
  ; 写探针：RequestExecutionLevel user 下，普通用户往 C:\Program Files 写会被拒。
  ;
  ; 不拦的后果（实测过）：NSIS 会在 File "fontmanager.exe" 那一步报
  ; "Error opening file for writing"，然后留下一个「目录建了、文件没写、注册表没写全」
  ; 的半装状态 —— 用户装了个空壳，还占着 HKCU 的 Uninstall 键。
  ; 探针把失败提前到页面内，用户当场就能改路径。
  CreateDirectory "$INSTDIR"
  ClearErrors
  FileOpen $R9 "$INSTDIR\.zfm-probe" w
  ${If} ${Errors}
    ; 别把刚建出来的空目录留在 Program Files 里：RMDir 是非递归的，
    ; 只会在目录确实是空的时候成功，动不到任何已有内容。
    RMDir "$INSTDIR"
    MessageBox MB_ICONEXCLAMATION "$(ZM_DIR_NOWRITE)"
    Abort          ; 停在当前页，让用户改路径（不会进入安装阶段）
  ${EndIf}
  FileClose $R9
  Delete "$INSTDIR\.zfm-probe"
FunctionEnd

; 6. Start menu shortcut page
;
; ★ 这一页**不是废代码，不许删**。它现在恒被跳过，只是因为 tauri.conf.json 里没配
;   `startMenuFolder` → 走 !else 分支 → PRE 回调 `Skip`（Abort）= 界面上看不到。
;   所以「欢迎 → 安装位置 → 安装中 → 完成」这个 4 页流程**本来就成立**，不需要删页。
;   删掉这段的后果：哪天有人填上 startMenuFolder，就变成「用户不能选开始菜单文件夹名」
;   的功能回退 —— 而且是静默回退（构建不报错，装机时才发现少了选项）。
;   同理，`Call CreateOrUpdateStartMenuShortcut` 与 /S 下补建桌面快捷方式的分支也留着。
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; 大标题 + 两行说明：完成页是用户唯一会认真看一眼的页面，
; 数据位置那句话就放在这里（设置页「数据位置」那一行是 P2，本版不做）。
!define MUI_FINISHPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE "$(ZM_FINISH_TITLE)"
!define MUI_FINISHPAGE_TEXT  "$(ZM_FINISH_TEXT)"
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(ZM_FINISH_DESKTOP)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(ZM_FINISH_RUN)"
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
;
; 正文用定稿表 ⑥ 的那一句（页标题沿用 MUI 原生的 "卸载 $(^NameDA)" = "卸载 FontManager"，
; 中文翻译与定稿表逐字一致，再覆盖一遍只会多一处要同步的文案）。
; 复选框文案（$(deleteAppData)）在 zfm-strings.nsh 里改成「同时删除全部数据与字体库」——
; hooks.nsh 勾选时确实会删 $INSTDIR\字体库（用户的付费字体也在里面），
; 不写清就是在踩 R-04 的口径风险；这属于信息披露，不是行为变更。
; ⚠️ 下面的 GetDpiForWindow + /96 换算是基线代码，整段保留，不要"顺手优化"。
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(ZM_UN_TEXT)"
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; ────── FontManager 自己的双语文案（2.1.5）──────
;
; 位置不能动：LangString 只能往「已经 MUI_LANGUAGE 加载过的语言」里写，
; 所以这一段**必须**在 languages 那组循环（MUI_LANGUAGE）之后。
;
; 为什么路径绕这么一圈：NSIS 的 !include 相对路径以**主脚本所在目录**为基准
; （已实测：子文件里 include 同目录的兄弟文件会 "could not find"），而渲染后的主脚本
; 落在构建产物目录 rust-target\release\nsis\x64\ —— 我们的源码目录根本不在那。
; handlebars 又只给绝对路径的**文件** token，没有「目录」token，所以从 sidebar_image
; 的绝对路径里把文件名削掉换出源码目录。注意 NSIS 会把 define 里的反斜杠归一成正斜杠
; （已实测），所以这里搜的是 "/sidebar.bmp" 而不是 "\sidebar.bmp"。
;
; 若 sidebarImage 被清空 → 这里编译期就炸，不会静默丢文案（宁可构建失败）。
;
; 反斜杠而不是正斜杠：**实测**过两种写法 —— 渲染后的脚本带 UTF-8 BOM，此时
; `!define` 里的 `\` 原样保留（搜 "/sidebar.bmp" 匹配不到）；而不带 BOM 的脚本会被
; NSIS 归一成正斜杠（搜 "\sidebar.bmp" 匹配不到）。因为 tauri 渲染时一定加 BOM，
; 这里以反斜杠为准，同时保留正斜杠那次尝试兜住上游将来改行为。
!searchreplace ZFM_NSIS_DIR "${SIDEBARIMAGE}" "\sidebar.bmp" ""
!if "${ZFM_NSIS_DIR}" == "${SIDEBARIMAGE}"
  !searchreplace ZFM_NSIS_DIR "${SIDEBARIMAGE}" "/sidebar.bmp" ""
!endif
!if "${ZFM_NSIS_DIR}" == "${SIDEBARIMAGE}"
  !error "无法从 sidebarImage 推出源码目录，找 zfm-strings.nsh 失败：${SIDEBARIMAGE}"
!endif
!addincludedir "${ZFM_NSIS_DIR}"
!include "zfm-strings.nsh"

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; Abort downgrades if they are disabled, in the modes that skip the reinstall page choice:
  ; silent, passive and update
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R0
    ; If downgrading
    ${If} $R0 = -1
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 <> 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
      ${Else}
        MessageBox MB_ICONSTOP "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
FunctionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
