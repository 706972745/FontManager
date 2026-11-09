; FontManager — NSIS 卸载钩子（UTF-8 with BOM，中文路径必须靠 BOM 才能被 NSIS 正确读取）
;
; Tauri 内置卸载确认页已经有「删除应用数据」复选框：
;   $DeleteAppDataCheckboxState = 1  -> 用户勾选「同时删除全部数据」
; 内置脚本只清 $APPDATA\<bundleId> / $LOCALAPPDATA\<bundleId>（WebView2 缓存），
; 但本软件的数据在 %APPDATA%\FontManager、旧目录 ZFontManager、以及安装目录下的
; 字体库 / plugins / *-runtime，还有 HKCU 字体表与文件关联，这里补齐。
;
; 原则（重要）：白名单精确删除。
;   - 只删本软件自己创建 / 下载的目录、文件与注册表值；
;   - 不删系统字体目录、不动系统字体注册项、不删用户自定义字体库里的字体；
;   - 不整目录 RMDir "$INSTDIR"，避免误删用户放进安装目录的东西；
;   - 数据目录先确认有本软件的特征文件才整体删除，避免同名目录被误删。
; 覆盖安装（/UPDATE）一律跳过清理，避免升级过程把用户数据清掉。

!include "LogicLib.nsh"

; 判断 $R2（HKCU Fonts 值的数据 = 字体文件绝对路径）是否落在指定前缀内。
; 命中时把 $R6 置 1。只比较前缀，绝不按值名删除（值名与系统字体同格式）。
!macro ZFM_MATCH_FONT_PREFIX PREFIX
  StrLen $R4 "${PREFIX}"
  ${If} $R4 > 0
    StrCpy $R5 $R2 $R4
    ${If} $R5 == "${PREFIX}"
      StrCpy $R6 1
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; ── 1. 软件本体留下的注册表关联：无论是否勾选都清掉（都是死链接了）──
  ; 这三个扩展名是 FontManager 专有，不会与其它软件冲突。
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\.S-FontManager"
    DeleteRegKey HKCU "Software\Classes\.P-FontManager"
    DeleteRegKey HKCU "Software\Classes\.L-FontManager"

    ; 1.5.5 起 publisher 从 "TheHolyOneZ / IIEOzo" 改为 "IIEOzo"，
    ; 安装记录键随之从 Software\TheHolyOneZ / IIEOzo\FontManager
    ; 变成 Software\IIEOzo\FontManager。模板只会删新键，旧键会残留，
    ; 这里按精确键名补删（/ifempty 保证不误删别人的子键）。
    DeleteRegValue HKCU "Software\TheHolyOneZ / IIEOzo\FontManager" "Installer Language"
    DeleteRegKey /ifempty HKCU "Software\TheHolyOneZ / IIEOzo\FontManager"
    DeleteRegKey /ifempty HKCU "Software\TheHolyOneZ / IIEOzo"
  ${EndIf}

  ; ── 2. 只有勾选「删除全部数据」且不是覆盖更新时才清数据 ──
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    DetailPrint "正在删除 FontManager 的全部数据…"

    ; 2.1 安装目录内本软件创建 / 下载的目录（不整目录删）
    RMDir /r "$INSTDIR\字体库"
    RMDir /r "$INSTDIR\plugins"
    RMDir /r "$INSTDIR\python-runtime"
    RMDir /r "$INSTDIR\node-runtime"
    RMDir /r "$INSTDIR\resources\python-runtime"
    RMDir /r "$INSTDIR\resources\node-runtime"
    Delete "$INSTDIR\snapshot-icon.ico"
    Delete "$INSTDIR\pack-icon.ico"
    Delete "$INSTDIR\data-icon.ico"

    ; 2.2 应用数据目录：确认含有本软件特征文件才整体删除
    ${If} ${FileExists} "$APPDATA\FontManager\state.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\font-cache.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\api.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\activation.log"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\system-ps.json"
      RMDir /r "$APPDATA\FontManager"
    ${EndIf}

    ; 1.2.4 改名前的旧品牌目录，同样只删确认属于本软件的
    ${If} ${FileExists} "$APPDATA\ZFontManager\state.json"
    ${OrIf} ${FileExists} "$APPDATA\ZFontManager\font-cache.json"
    ${OrIf} ${FileExists} "$APPDATA\ZFontManager\api.json"
    ${OrIf} ${FileExists} "$APPDATA\ZFontManager\activation.log"
      RMDir /r "$APPDATA\ZFontManager"
    ${EndIf}

    ; 2.3 MSI 版回退字体库：只删软件创建的子目录，不动目录里的其它内容。
    ;     绝不触碰 %LOCALAPPDATA%\Microsoft\Windows\Fonts（系统/用户字体目录）。
    RMDir /r "$LOCALAPPDATA\FontManager\字体库"
    RMDir /r "$LOCALAPPDATA\FontManager\plugins"
    RMDir /r "$LOCALAPPDATA\FontManager\python-runtime"
    RMDir /r "$LOCALAPPDATA\FontManager\node-runtime"
    RMDir "$LOCALAPPDATA\FontManager"

    ; 2.4 临时文件：精确文件名，不用通配符
    Delete "$TEMP\fontmanager-comhost.log"
    Delete "$TEMP\fontmanager-python-runtime.zip"
    Delete "$TEMP\fontmanager-node-runtime.zip"

    ; 2.5 HKCU 字体注册项：只删「值数据指向本软件字体库」的那些。
    ;     值名是 "字体族名 (TrueType)" 格式，和系统字体一样，不能按名字删；
    ;     系统字体（数据在 %WINDIR%\Fonts）与用户自定义库里的字体一律保留。
    StrCpy $R0 0
    StrCpy $R7 0
  zfm_font_enum_loop:
    IntOp $R7 $R7 + 1
    ${If} $R7 > 20000
      Goto zfm_font_enum_done
    ${EndIf}
    EnumRegValue $R1 HKCU "Software\Microsoft\Windows NT\CurrentVersion\Fonts" $R0
    StrCmp $R1 "" zfm_font_enum_done
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows NT\CurrentVersion\Fonts" "$R1"
    StrCpy $R6 0
    !insertmacro ZFM_MATCH_FONT_PREFIX "$INSTDIR\字体库\"
    !insertmacro ZFM_MATCH_FONT_PREFIX "$LOCALAPPDATA\FontManager\字体库\"
    !insertmacro ZFM_MATCH_FONT_PREFIX "$APPDATA\FontManager\"
    !insertmacro ZFM_MATCH_FONT_PREFIX "$APPDATA\ZFontManager\"
    ${If} $R6 = 1
      ClearErrors
      DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\Fonts" "$R1"
      IfErrors zfm_font_enum_next
      ; 删掉后后面的值会前移，索引不变重新枚举
      Goto zfm_font_enum_loop
    ${EndIf}
  zfm_font_enum_next:
    IntOp $R0 $R0 + 1
    Goto zfm_font_enum_loop
  zfm_font_enum_done:

    DetailPrint "FontManager 的数据已清理完毕。"
  ${EndIf}
!macroend
