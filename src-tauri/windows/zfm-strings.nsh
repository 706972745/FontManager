; FontManager 安装器文案（2.1.5）
;
; ⚠️ 本文件是 UTF-8 **with BOM**。BOM 不能丢：NSIS 靠它判断源码是 UTF-8，
;    没有 BOM 的中文在中文 Windows 上会按 GBK 解，装出来就是乱码。（同 hooks.nsh。）
;
; 为什么单独一个文件：模板里塞满两种语言的中文字面量，改一句话要在上千行里翻三次；
; 而且 LangString 只能往「已经 MUI_LANGUAGE 加载过的语言」里写，
; 所以这个文件**必须** include 在 MUI_LANGUAGE 之后（放前面 = 编译期 "language not found"）。
;
; 两份语言必须与 tauri.conf.json 的 languages 数组严格一一对应：
;   少一份 → 那种语言的页面文案空白（不报错，装机时才发现）；
;   多一份未加载的语言 → 编译期报错（好事，构建期就炸）。
;
; 文案是设计文档 §6.2 的定稿表逐字照抄的（§6.3 给了成品），改字之前先回去改文档。
; 与 §6.3 成品的唯一差异（实现时删了四个空槽位，理由是「两份文案会打架」）：
;   ZM_DIR_TITLE / ZM_UN_TITLE / ZM_REINST_TITLE / ZM_REINST_TEXT 没有定义，因为这几个
;   「页标题 / 正文」在 NSIS 里由 MUI 的私有串承担，而官方中文翻译恰好与定稿表**逐字一致**：
;     MUI_TEXT_DIRECTORY_TITLE   = "选择安装位置"        （= 定稿表 ② 页标题）
;     MUI_UNTEXT_CONFIRM_TITLE   = "卸载 $(^NameDA)"     （= 定稿表 ⑥ 页标题）
;     alreadyInstalled / olderOrUnknownVersionInstalled  （= 定稿表 ⑤ 头标题与正文，见下）
;   再抄一份 ZM_* 进去，只会得到「两份文案、改一处忘了另一处」。
;   英文侧唯一差别：目录页标题仍是 MUI 原生的 "Choose Install Location"（定稿表写的是
;   "Choose a location"）—— 为一句措辞再去覆盖一个全局私有串不划算，列已知差异。
; 按钮文字（下一步/上一步/取消/安装/完成）**故意不覆盖**：^Next / ^Install 这类是
; 全局 LangString，改了会影响所有页面，收益只是措辞。
;
; ${VERSION} 在 LangString 里是编译期展开（NSIS 先做 define 替换再存字符串表），
; 已实测可用；若哪天没展开，退化成在模板里用普通 define 拼接（会失去本地化）。
!include "LogicLib.nsh"

; ── 简体中文（逐字对应 §6.2 定稿表）──────────────────────
LangString ZM_WELCOME_TITLE  ${LANG_SIMPCHINESE} "FontManager"
LangString ZM_WELCOME_SUB    ${LANG_SIMPCHINESE} "版本 ${VERSION} · 免费开源的字体管理器"
LangString ZM_WELCOME_L1     ${LANG_SIMPCHINESE} "程序、字体库和全部数据都保存在安装目录下。"
LangString ZM_WELCOME_L2     ${LANG_SIMPCHINESE} "想整体搬走，直接搬这个文件夹就行。"
LangString ZM_FOOT           ${LANG_SIMPCHINESE} "IIEOzo · GPL-3.0"

LangString ZM_DIR_TOP        ${LANG_SIMPCHINESE} "程序、字体库和全部数据都保存在这个目录下。"
LangString ZM_DIR_DEST       ${LANG_SIMPCHINESE} "安装到："
LangString ZM_DIR_NOWRITE    ${LANG_SIMPCHINESE} "这个位置当前用户没有写入权限。$\r$\n请换一个位置（例如“文档”下的文件夹），或者以管理员身份重新运行安装程序。"

LangString ZM_FINISH_TITLE   ${LANG_SIMPCHINESE} "安装完成"
LangString ZM_FINISH_TEXT    ${LANG_SIMPCHINESE} "FontManager ${VERSION} 已安装。$\r$\n数据保存在安装目录的 data 文件夹。$\r$\n卸载时可以选择是否保留。"
LangString ZM_FINISH_RUN     ${LANG_SIMPCHINESE} "立即运行 FontManager"
LangString ZM_FINISH_DESKTOP ${LANG_SIMPCHINESE} "在桌面创建快捷方式"

LangString ZM_UN_TEXT        ${LANG_SIMPCHINESE} "将从这台电脑移除 FontManager。"
LangString ZM_UN_DELDATA     ${LANG_SIMPCHINESE} "同时删除全部数据与字体库"

; 覆盖 MUI 自带的啰嗦文案（NSIS 后定义生效）。原文案是英文直译，一屏 5 行废话。
LangString MUI_TEXT_WELCOME_INFO_TEXT       ${LANG_SIMPCHINESE} ""
LangString MUI_TEXT_DIRECTORY_INFO          ${LANG_SIMPCHINESE} "选择安装位置"
LangString MUI_TEXT_INSTALLING_TITLE        ${LANG_SIMPCHINESE} "正在安装"
LangString MUI_TEXT_INSTALLING_SUBTITLE     ${LANG_SIMPCHINESE} "只需几秒钟。"
LangString MUI_TEXT_FINISH_INFO_TITLE       ${LANG_SIMPCHINESE} "安装完成"
LangString MUI_TEXT_FINISH_INFO_TEXT        ${LANG_SIMPCHINESE} ""
; 升级维护页的四个串：位置语义见 §6.2 ⑤ 的警告，只改措辞不改映射
LangString alreadyInstalled                    ${LANG_SIMPCHINESE} "已安装较旧版本"
LangString olderOrUnknownVersionInstalled      ${LANG_SIMPCHINESE} "FontManager 将安装到现有位置，字体库和数据都会保留。"
LangString dontUninstall                       ${LANG_SIMPCHINESE} "直接覆盖安装（推荐）"
LangString uninstallBeforeInstalling           ${LANG_SIMPCHINESE} "先卸载再安装"
; 卸载确认页的复选框：必须提「字体库」，见 §6.2 ⑥ 与 R-04
; （hooks.nsh 在勾选时确实会删 $INSTDIR\字体库，里面有用户花钱买的字体）
LangString deleteAppData                       ${LANG_SIMPCHINESE} "同时删除全部数据与字体库"

; ── English ──────────────────────────────────────────────
LangString ZM_WELCOME_TITLE  ${LANG_ENGLISH} "FontManager"
LangString ZM_WELCOME_SUB    ${LANG_ENGLISH} "Version ${VERSION} · Free, open-source font manager"
LangString ZM_WELCOME_L1     ${LANG_ENGLISH} "The app, your font library and all data live in the install folder."
LangString ZM_WELCOME_L2     ${LANG_ENGLISH} "To move FontManager, just move the folder."
LangString ZM_FOOT           ${LANG_ENGLISH} "IIEOzo · GPL-3.0"

LangString ZM_DIR_TOP        ${LANG_ENGLISH} "The app, your font library and all data live in this folder."
LangString ZM_DIR_DEST       ${LANG_ENGLISH} "Install to:"
LangString ZM_DIR_NOWRITE    ${LANG_ENGLISH} "You don't have write access to this folder.$\r$\nPick another location (for example one under Documents), or run the installer as administrator."

LangString ZM_FINISH_TITLE   ${LANG_ENGLISH} "Installation complete"
LangString ZM_FINISH_TEXT    ${LANG_ENGLISH} "FontManager ${VERSION} is installed.$\r$\nYour data lives in the data folder next to the app.$\r$\nYou choose on uninstall whether to keep it."
LangString ZM_FINISH_RUN     ${LANG_ENGLISH} "Launch FontManager now"
LangString ZM_FINISH_DESKTOP ${LANG_ENGLISH} "Create a desktop shortcut"

LangString ZM_UN_TEXT        ${LANG_ENGLISH} "This will remove FontManager from this computer."
LangString ZM_UN_DELDATA     ${LANG_ENGLISH} "Also delete all data and the font library"

LangString MUI_TEXT_WELCOME_INFO_TEXT   ${LANG_ENGLISH} ""
LangString MUI_TEXT_DIRECTORY_INFO      ${LANG_ENGLISH} "Choose a location"
LangString MUI_TEXT_INSTALLING_TITLE    ${LANG_ENGLISH} "Installing"
LangString MUI_TEXT_INSTALLING_SUBTITLE ${LANG_ENGLISH} "This takes seconds."
LangString MUI_TEXT_FINISH_INFO_TITLE   ${LANG_ENGLISH} "Installation complete"
LangString MUI_TEXT_FINISH_INFO_TEXT    ${LANG_ENGLISH} ""
LangString alreadyInstalled                    ${LANG_ENGLISH} "Older version installed"
LangString olderOrUnknownVersionInstalled      ${LANG_ENGLISH} "FontManager will install over the existing copy; your library and data are kept."
LangString dontUninstall                       ${LANG_ENGLISH} "Install over the existing copy (recommended)"
LangString uninstallBeforeInstalling           ${LANG_ENGLISH} "Uninstall first"
LangString deleteAppData                       ${LANG_ENGLISH} "Also delete all data and the font library"
