; FontManager 安装器文案（2.1.5）
;
; ⚠️ 本文件是 UTF-8 **with BOM**。BOM 不能丢：NSIS 靠它判断源码是 UTF-8，
;    没有 BOM 的中文在中文 Windows 上会按 GBK 解，装出来就是乱码。
;    （和 hooks.nsh 同一个理由，见那边的文件头。）
;
; 为什么单独一个文件：模板里塞满两种语言的中文字面量，改一句话要在 984 行里翻三次；
; 而且 LangString 只能往「已经 MUI_LANGUAGE 加载过的语言」里写，
; 所以这个文件**必须** include 在 MUI_LANGUAGE 之后（放前面 = 编译期 "language not found"）。
;
; 两份语言必须与 tauri.conf.json 的 languages 数组严格一一对应：
;   少一份 → 那种语言的页面文案空白（不报错，装机时才发现）；
;   多一份未加载的语言 → 编译期报错（好事，构建期就炸）。
;
; 文案是设计文档 §6.2 的定稿表逐字照抄的，改字之前先回去改文档。
!include "LogicLib.nsh"

; ── 简体中文 ──────────────────────────────────────────────
LangString ZM_WELCOME_TITLE  ${LANG_SIMPCHINESE} "安装 FontManager"
LangString ZM_WELCOME_TEXT   ${LANG_SIMPCHINESE} "版本 ${VERSION} · 免费开源的字体管理器$\r$\n$\r$\n程序、字体库和全部数据都会保存在安装目录下，$\r$\n卸载时随安装目录一起移除。"
LangString ZM_DIR_TOP        ${LANG_SIMPCHINESE} "程序、字体库和全部数据都会保存在这个目录下。以后想整体搬走，直接搬这个文件夹即可。"
LangString ZM_DIR_DEST       ${LANG_SIMPCHINESE} "安装到："
LangString ZM_DIR_NOWRITE    ${LANG_SIMPCHINESE} "这个位置当前用户没有写入权限。$\r$\n请换一个位置（例如用户目录下的文件夹），或者以管理员身份重新运行安装程序。"
LangString ZM_FINISH_TITLE   ${LANG_SIMPCHINESE} "安装完成"
LangString ZM_FINISH_TEXT    ${LANG_SIMPCHINESE} "FontManager ${VERSION} 已安装。$\r$\n数据保存在安装目录的 data 文件夹，卸载时可选择是否保留。"
LangString ZM_FINISH_RUN     ${LANG_SIMPCHINESE} "立即运行 FontManager"
LangString ZM_FINISH_DESKTOP ${LANG_SIMPCHINESE} "在桌面创建快捷方式"

; 覆盖 MUI 自带的啰嗦文案（后定义生效）。原文案是英文直译，一屏 5 行废话。
LangString MUI_TEXT_WELCOME_INFO_TEXT       ${LANG_SIMPCHINESE} ""
LangString MUI_TEXT_DIRECTORY_INFO          ${LANG_SIMPCHINESE} "选择安装位置"
LangString MUI_TEXT_INSTALLING_TITLE        ${LANG_SIMPCHINESE} "正在安装"
LangString MUI_TEXT_INSTALLING_SUBTITLE     ${LANG_SIMPCHINESE} "只需几秒钟。"
LangString MUI_TEXT_FINISH_INFO_TITLE       ${LANG_SIMPCHINESE} "安装完成"
LangString MUI_TEXT_FINISH_INFO_TEXT        ${LANG_SIMPCHINESE} ""

; ── English ──────────────────────────────────────────────
LangString ZM_WELCOME_TITLE  ${LANG_ENGLISH} "Install FontManager"
LangString ZM_WELCOME_TEXT   ${LANG_ENGLISH} "Version ${VERSION} · free and open-source font manager$\r$\n$\r$\nThe app, your font library and all data stay inside the install folder$\r$\nand go away with it when you uninstall."
LangString ZM_DIR_TOP        ${LANG_ENGLISH} "The app, your font library and all data live in this folder. To move FontManager later, just move the folder."
LangString ZM_DIR_DEST       ${LANG_ENGLISH} "Install to:"
LangString ZM_DIR_NOWRITE    ${LANG_ENGLISH} "You don't have write access to this folder.$\r$\nPick another location (for example one under your user folder), or run the installer as administrator."
LangString ZM_FINISH_TITLE   ${LANG_ENGLISH} "Installation complete"
LangString ZM_FINISH_TEXT    ${LANG_ENGLISH} "FontManager ${VERSION} is installed.$\r$\nData lives in the data folder next to the app; you choose on uninstall whether to keep it."
LangString ZM_FINISH_RUN     ${LANG_ENGLISH} "Launch FontManager now"
LangString ZM_FINISH_DESKTOP ${LANG_ENGLISH} "Create a desktop shortcut"

LangString MUI_TEXT_WELCOME_INFO_TEXT   ${LANG_ENGLISH} ""
LangString MUI_TEXT_DIRECTORY_INFO      ${LANG_ENGLISH} "Choose a location"
LangString MUI_TEXT_INSTALLING_TITLE    ${LANG_ENGLISH} "Installing"
LangString MUI_TEXT_INSTALLING_SUBTITLE ${LANG_ENGLISH} "This takes a few seconds."
LangString MUI_TEXT_FINISH_INFO_TITLE   ${LANG_ENGLISH} "Installation complete"
LangString MUI_TEXT_FINISH_INFO_TEXT    ${LANG_ENGLISH} ""
