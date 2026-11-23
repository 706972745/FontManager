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
;   · 配色（白底 + 近黑字）、目录页的写探针、升级时跳过目录页；
;   · 仅存的行为性文案已内联在 MUI_LANGUAGE 之后；不再使用侧栏图。
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
; 回退面已只剩原生 MUI 页面（欢迎 / 目录 / 安装 / 完成、卸载确认 / 卸载中）；
; 自绘页与旧文案文件已移除，升级 Tauri 时不要再把那段带回来。
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

; ═══════════════════════════════════════════════════════════════════════════
; ★ 2.1.7 · 路线 C：安装器/卸载器的界面由**主程序**画（规格书 §9.5 / PRD §9.7）
;
; 为什么：用户要求「尽量 0 体积占用的 1:1 还原」。NSIS 自绘上限 75%（照片级右图、
; 墨黑按钮、1px 描边都画不出）；独立 Tauri 安装器要 +5MB。主程序里已经有 WebView2、
; 已有 Inter、已有图标 —— 借它画，增量只有几百行 Rust。
;
; 开关就是下面这一行宏定义，**默认处于注释状态**：不打开时所有 ZFM_ROUTE_C 分支
; 都不参与编译，打出来的包与 2.1.6 那条路完全同源（一个字节都没动）。
;
; 出路线 C 的包：
;     node tools/route-c.mjs on     # 打开（改这一行，不新建文件）
;     npx tauri build --config _tauri.nobuild.json --bundles nsis
;     node tools/route-c.mjs off    # 关回去，别把开启状态留在仓库里
;
; 为什么不用「标记文件 + !if /FileExists」：tauri 打包前会把本模板**渲染到
; `rust-target/release/nsis/x64/installer.nsi`** 再交给 makensis，那时
; `${__FILEDIR__}` 指向的是那个临时目录而不是本目录 —— 标记文件永远找不到，
; 开关恒为假（2026-11-14 实测：开与关打出来的包字节完全相同）。
; 宏定义是纯文本，渲染后原样保留，所以在哪编译都有效。
;
; /S、/P、/UPDATE 三条一律走原来的路径 —— 更新是主程序内部触发的（update.rs 靠
; `Start-Process -Wait` 等退出码），绝不能弹界面，也绝不能多一层等待。
; ═══════════════════════════════════════════════════════════════════════════
!define ZFM_ROUTE_C

; ★ 2.1.5 新增：data 根标记文件名（安装器与程序共用同一个名字）
;   安装器在 $INSTDIR\data\.zfm-data-root 写 v=1；
;   程序迁移成功后往同一个文件追加 migrated=1。
;   程序只拿它当「这个安装根启用 data 布局」的信号，**不当迁移完成的证据** ——
;   迁移是否完成只认 data\state.json 是否存在（见 src-tauri/src/store.rs）。
!define ZFM_DATA_MARKER ".zfm-data-root"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
; 路线 C：界面明确要求"建桌面快捷方式"（`/DS`）。与 `NoShortcutMode` 是"要/不要"
; 一对，谁最后被设置谁算数（`.onInit` 里 /NS 先、/DS 后）。
Var ForceDesktop
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
; 1. 欢迎页（原生 MUI；路线 C 下 .onInit 已 Quit，不显示）
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

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

; 5. Choose install directory page
;
; 这一页是「装到 D 盘」的唯一入口，必须有（去掉它 = G2 直接失去意义）。
; 但**升级时必须跳过**并锁回旧目录 —— 见 ZfmDirPre 里那段反例说明。
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
; 复选框文案（$(deleteAppData)）已内联为「同时删除全部数据与字体库」——
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

; ────── 仅存的行为性文案（内联）──────
;
; 位置不能动：LangString 只能往「已经 MUI_LANGUAGE 加载过的语言」里写，
; 所以这一段**必须**在 languages 那组循环（MUI_LANGUAGE）之后。
LangString deleteAppData     ${LANG_SIMPCHINESE} "同时删除全部数据与字体库"
LangString ZM_UN_TEXT        ${LANG_SIMPCHINESE} "将从这台电脑移除 FontManager。"
LangString ZM_DIR_NOWRITE    ${LANG_SIMPCHINESE} "这个位置当前用户没有写入权限。$\r$\n请换一个位置（例如“文档”下的文件夹），或者以管理员身份重新运行安装程序。"
LangString ZM_FINISH_RUN     ${LANG_SIMPCHINESE} "立即运行 FontManager"
LangString ZM_FINISH_DESKTOP ${LANG_SIMPCHINESE} "在桌面创建快捷方式"

LangString deleteAppData     ${LANG_ENGLISH} "Also delete all data and the font library"
LangString ZM_UN_TEXT        ${LANG_ENGLISH} "This will remove FontManager from this computer."
LangString ZM_DIR_NOWRITE    ${LANG_ENGLISH} "You don't have write access to this folder.$\r$\nPick another location (for example one under Documents), or run the installer as administrator."
LangString ZM_FINISH_RUN     ${LANG_ENGLISH} "Launch FontManager now"
LangString ZM_FINISH_DESKTOP ${LANG_ENGLISH} "Create a desktop shortcut"

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ; `/DS`：路线 C 的界面在**用户勾了**「在桌面创建快捷方式」时给的正向指令。
  ; 只有 `/NS` 的反向逻辑不够：函数里 `$UpdateMode = 1` 会先 Return 跳过创建，
  ; 光"不禁止"并不等于"要建"（RC-9）。两条都给，语义才闭合。
  ; 只在路线 C 的构建里认这个参数 —— 老包一个字节都不受影响。
  !ifdef ZFM_ROUTE_C
  ${GetOptions} $CMDLINE "/DS" $R0
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 0
    StrCpy $ForceDesktop 1
  ${EndIf}
  !endif

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

  ; ── 路线 C：GUI 安装 ────────────────────────────────────────────────
  ; NSIS 只做三件事：① 把主程序解到 $PLUGINSDIR（包里唯一的大件）；
  ; ② 等它把四屏界面跑完；③ 按它的退出码决定这次算"装好"还是"用户取消"。
  ; 真正的解包/注册表/快捷方式仍然由它内部拉起的 `setup.exe /S` 完成 —— 引擎只有一份。
  !ifdef ZFM_ROUTE_C
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
    ; **不要 SetSilent**：它会把页面不可逆地抑制掉，一旦界面挂掉就变成
    ; 「没人点却自动装完」（2026-11-14 实测踩到）。.onInit 里 Quit 本身就
    ; 足够阻止页面渲染 —— 因为页面比 .onInit 晚。
    SetOutPath "$PLUGINSDIR"
    File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"
    ExecWait '"$PLUGINSDIR\${MAINBINARYNAME}.exe" --installer-ui --setup-exe="$EXEPATH" --install-dir="$INSTDIR"' $R9
    StrCmp $R9 "0" zfm_rc_ok
    StrCmp $R9 "10" zfm_rc_cancel
    ; 其它返回值（界面起不来 / 被杀软拦 / WebView2 缺失）：什么都不做，
    ; 让 .onInit 正常返回 → NSIS 照常画原生 MUI 页继续装（E7/G6 的降级面）。
    Goto zfm_rc_done
  zfm_rc_cancel:
    SetErrorLevel 10            ; 用户自己取消：不算失败，但也不是"装好了"
    Quit
  zfm_rc_ok:
    SetErrorLevel 0             ; 界面内部已经拉起 `setup.exe /S` 装完了
    Quit
  zfm_rc_done:
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
          ; ★ 这是**本仓库真正会编译、真正会执行**的 WebView2 失败分支之一
          ;   （INSTALLWEBVIEW2MODE = downloadBootstrapper）。
          ;   显式置 1，不依赖 NSIS 未文档化默认值（实测裸 Abort 在 /S 下退 2，
          ;   但那是实现细节，不能当契约）。update.rs 的唯一判据是 `ExitCode -eq 0`，
          ;   这里必须保证"下载失败 = 非 0"，否则会被当成装好后删包重启。
          SetErrorLevel 1
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
          ; ★ 另一处真正会执行的 WebView2 失败分支（bootstrapper 下回来了，但装不上）。
          ;   同上：显式非 0，不靠默认值。装了 WebView2 失败的机器上主程序必白屏，
          ;   绝不能让它看起来"装成功"。
          SetErrorLevel 1
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    ; ⚠️ 下面这一整块（`!if` 到 `!endif`）在本仓库**当前不参与编译**：
    ;   tauri 渲染出的 `MINIMUMWEBVIEW2VERSION` 是 `""`（tauri.conf.json 未配置
    ;   `minimumWebview2Version`），`!if "${MINIMUMWEBVIEW2VERSION}" != ""` 恒假。
    ;   保留它是给"配了最低 WebView2 版本"的构建用的（那时走 EdgeUpdate 的
    ;   /install appguid 通道，失败点是下面的 ExecWait）。
    ;
    ;   ★ 因此**真正保护静默更新的不在这里**，而是 Section WebView2 上半段那两处
    ;   `SetErrorLevel 1` + `Abort`（原行号 :901 下载失败 / :933 安装失败），
    ;   因为本仓库激活的是 INSTALLWEBVIEW2MODE = downloadBootstrapper。
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
              ; WebView2 装不上 = 主程序起来必白屏，属于最坏的一类失败，必须让上游知道。
              ;
              ; ★ 更正一处曾写错的事实（2.1.7 QA 实测）：旧代码 `MessageBox` + `Quit`
              ;   在 `/S` 下的退出码**不是 0** —— 裸 `Abort`/`Quit` 在 `/S` 下实测退 **2**，
              ;   所以 update.rs 的 `ExitCode -eq 0` 从来没被它骗过。
              ;   真正的病是：`MessageBox` 在 `/S` 下**照常弹窗并阻塞**，而 update.rs 用
              ;   `Start-Process -Wait -PassThru` 等进程退出 → **永久挂死**。
              ;   `SetErrorLevel 1` 的意义是把"失败 = 非 0"写成显式契约，
              ;   不依赖 NSIS 未文档化的默认值（默认值哪天变了就是"报成功但白屏"）。
              ${If} ${Silent}
                System::Call 'kernel32::AttachConsole(i -1)i.r0'
                ${If} $0 <> 0
                  System::Call 'kernel32::GetStdHandle(i -11)i.r0'
                  System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
                  FileWrite $0 "$(webview2InstallError)"
                ${EndIf}
                SetErrorLevel 1
                Quit
              ${Else}
                MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
                ; 走到这里 = 用户选了 Abort（Retry 会跳回 update_webview，Ignore 跳 ignore）
                SetErrorLevel 1
                Quit
              ${EndIf}
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
  ; 成功路径**显式**置 0，不要依赖默认值：模板里多处 `Quit`/`Abort` 的退出码取决于
  ; 之前有没有被 SetErrorLevel 改过，而 update.rs 的唯一判据就是 `ExitCode -eq 0`
  ; （0 → 删包 + 重启）。在这里钉死"装完且装好 = 0"，语义才闭合。
  ; 放在最前面：后面的 RunAsUser 属于"装完之后顺带拉起程序"，它失败不代表没装好。
  SetErrorLevel 0

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

  ; `/PURGE=1`：静默卸载时"同时删除数据"的唯一入口。
  ; 模板里 `$DeleteAppDataCheckboxState` 只有确认页（un.ConfirmShow）会置 1，
  ; 而 /S 下页面根本不跑 —— 没有这条口子，路线 C 界面上的勾选框就是个摆设。
  ; 只有在路线 C 的构建里才认这个参数：老包一个字节都不受影响。
  !ifdef ZFM_ROUTE_C
  ${GetOptions} $CMDLINE "/PURGE" $R0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
  !endif

  ; ── 路线 C：GUI 卸载 ────────────────────────────────────────────────
  ; 先把主程序拷到 %TEMP% 再跑界面：界面一会儿要拉起 `uninstall.exe /S`，
  ; 那个进程会删 `$INSTDIR\fontmanager.exe` —— 界面自己就是那个文件的话删不掉，
  ; 用户看到的是"卸完了但程序还在"（这类 bug 最难解释，所以从一开始就避开）。
  !ifdef ZFM_ROUTE_C
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
    ; 同上：**不要 SetSilent**。界面失败就退回原生卸载页，不许静默把东西删了。
    CreateDirectory "$TEMP\FontManager-setup-ui"
    CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$TEMP\FontManager-setup-ui\${MAINBINARYNAME}.exe"
    ${If} ${FileExists} "$TEMP\FontManager-setup-ui\${MAINBINARYNAME}.exe"
      ExecWait '"$TEMP\FontManager-setup-ui\${MAINBINARYNAME}.exe" --uninstall-ui --install-dir="$INSTDIR"' $R9
      Delete "$TEMP\FontManager-setup-ui\${MAINBINARYNAME}.exe"
      RMDir "$TEMP\FontManager-setup-ui"
      ; 界面的 WebView2 数据目录（用完即弃，别在用户 %TEMP% 里留几十 MB）
      RMDir /r "$TEMP\FontManager-setup-webview"
      StrCmp $R9 "0" zfm_un_rc_ok
      StrCmp $R9 "10" zfm_un_rc_cancel
    ${EndIf}
    ; 界面起不来 / 用户取消：都退回原生卸载页（原页面一行都没删）
    Goto zfm_un_rc_done
  zfm_un_rc_cancel:
    SetErrorLevel 10
    Quit
  zfm_un_rc_ok:
    SetErrorLevel 0
    Quit
  zfm_un_rc_done:
  ${EndIf}
  !endif
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
  ; 例外：路线 C 的 `/DS`（用户勾了"在桌面创建快捷方式"）压过上面两条 ——
  ; 勾选是用户的明确指令，覆盖升级也得按它来（RC-9）。
  ${If} $ForceDesktop <> 1
    ${If} $WixMode = 0
      ${If} $UpdateMode = 1
      ${OrIf} $NoShortcutMode = 1
        Return
      ${EndIf}
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
