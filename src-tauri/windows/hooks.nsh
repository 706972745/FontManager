; FontManager — NSIS 卸载钩子（UTF-8 with BOM，中文路径必须靠 BOM 才能被 NSIS 正确读取）
;
; Tauri 内置卸载确认页已经有「删除应用数据」复选框：
;   $DeleteAppDataCheckboxState = 1  -> 用户勾选「同时删除全部数据」
; 内置脚本只清 $APPDATA\<bundleId> / $LOCALAPPDATA\<bundleId>（WebView2 缓存），
; 但本软件的数据自 2.1.5 起在 <安装目录>\data（老版本与回退情况在 %APPDATA%\FontManager）、
; 0.8.x 一路用下来的旧目录 ZFontManager、
; 以及安装目录下的字体库 / plugins / *-runtime，还有 HKCU 字体表与文件关联，这里补齐。
;
; 原则（重要）：白名单精确删除。
;   - 只删本软件自己创建 / 下载的目录、文件与注册表值；
;   - 不删系统字体目录、不动系统字体注册项、不删用户自定义字体库里的字体；
;   - 不整目录 RMDir "$INSTDIR"，避免误删用户放进安装目录的东西；
;   - 数据目录先确认有本软件的特征文件才整体删除，避免同名目录被误删。
; 覆盖安装（/UPDATE）一律跳过清理，避免升级过程把用户数据清掉。

!include "LogicLib.nsh"

; ── 静默升级的 WebView2 等待（1.8.8）─────────────────────────────────────
; 覆盖安装时宿主刚退、msedgewebview2 子进程还握着 fontmanager.exe 的映像句柄；
; 不等它们退出，NSIS 的 File 覆盖失败会在 /S 下静默中止 —— 看起来升级成功，
; 实际文件没换。这里等「命令行带本程序名的 msedgewebview2」全部退出（最多 30s）。
; 用 -EncodedCommand 是因为 NSIS 单引号字符串里塞脚本引号太难写对；
; 这段 base64 解出来就是上面那行等待循环（UTF-16LE）。
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在等待 FontManager 的 WebView2 进程退出…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -EncodedCommand ZgBvAHIAKAAkAGkAPQAwADsAJABpACAALQBsAHQAIAAxADIAMAA7ACQAaQArACsAKQB7ACQAbAA9AEcAZQB0AC0AQwBpAG0ASQBuAHMAdABhAG4AYwBlACAAVwBpAG4AMwAyAF8AUAByAG8AYwBlAHMAcwAgAC0ARgBpAGwAdABlAHIAIAAiAE4AYQBtAGUAPQAnAG0AcwBlAGQAZwBlAHcAZQBiAHYAaQBlAHcAMgAuAGUAeABlACcAIgAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAB7ACQAXwAuAEMAbwBtAG0AYQBuAGQATABpAG4AZQAgAC0AYQBuAGQAIAAkAF8ALgBDAG8AbQBtAGEAbgBkAEwAaQBuAGUALgBDAG8AbgB0AGEAaQBuAHMAKAAnAGYAbwBuAHQAbQBhAG4AYQBnAGUAcgAuAGUAeABlACcAKQB9ADsAIABpAGYAKAAtAG4AbwB0ACAAJABsACkAewBiAHIAZQBhAGsAfQA7ACAAUwB0AGEAcgB0AC0AUwBsAGUAZQBwACAALQBNAGkAbABsAGkAcwBlAGMAbwBuAGQAcwAgADIANQAwAH0A'
  Pop $R9
!macroend

; 1.8.8 起：安装器创建/写 $INSTDIR\data 与 .zfm-data-root 标记（2.1.5）
;
; 只做三件事：建目录、探针、写标记。**绝不**在这里建 字体库 / plugins：
;   · 字体库的位置由程序自己决定（它有三级回退 + `pin_legacy_library` 钉住老库）；
;   · plugins 有它自己的「老用户不搬家」规则，安装器插一手会和程序打架。
; 探针写不进去（Program Files + 普通用户）就什么都不做 —— 程序启动时自己会探针并
; 回退到 %LOCALAPPDATA%\FontManager\data，装不进去不是错误，只是要换个地方写。
;
; 为什么标记文件用追加（"a"）而不是覆盖（"w"）：程序迁移成功后会往同一个文件
; 追加 migrated=1，升级安装时如果把文件重写一遍，那行历史就没了（不致命，
; 但排查「这台机器到底迁过没有」时少一条证据）。
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\data"
  ClearErrors
  FileOpen $R8 "$INSTDIR\.zfm-data-probe" w
  ${If} ${Errors}
    DetailPrint "安装目录当前用户不可写，运行时数据将回退到 %LOCALAPPDATA%\FontManager\data"
  ${Else}
    FileClose $R8
    Delete "$INSTDIR\.zfm-data-probe"

    ClearErrors
    FileOpen $R8 "$INSTDIR\data\${ZFM_DATA_MARKER}" a
    ${IfNot} ${Errors}
      FileWrite $R8 "v=1$\r$\n"
      FileWrite $R8 "version=${VERSION}$\r$\n"
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

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

    ; 2.1b 2.1.5 的数据根（<安装目录>\data，账本 / 偏好 / 缓存 / 日志 / 在线目录都在里面）
    ;
    ; ⚠️ 这一段**必须**留在上面那个 ${If} $DeleteAppDataCheckboxState = 1 ${AndIf}
    ;    $UpdateMode <> 1 括号里面。挪出去 = 升级（/UPDATE）时把用户 1.7MB 的账本
    ;    （标签/分组/收藏/台账/快照）连带删掉，且卸载器不会问一句 —— 这是 2.1.5
    ;    最容易被「顺手优化」搞出来的事故（设计文档 R-04）。
    ;
    ; 先认特征文件再整删：用户完全可能把自建文件丢进 data\（目录名太普通了），
    ; 一个特征文件都没有就说明这目录不是我们建的，别动。
    ${If} ${FileExists} "$INSTDIR\data\state.json"
    ${OrIf} ${FileExists} "$INSTDIR\data\font-cache.json"
    ${OrIf} ${FileExists} "$INSTDIR\data\api.json"
    ${OrIf} ${FileExists} "$INSTDIR\data\${ZFM_DATA_MARKER}"
      RMDir /r "$INSTDIR\data"
    ${EndIf}

    ; 2.1c 程序在「安装目录不可写」时的回退位置（MSI 装到 Program Files、或用户强行
    ;      /D 装到 Program Files 时数据会跑到这里）。同样先认特征文件。
    ${If} ${FileExists} "$LOCALAPPDATA\FontManager\data\state.json"
      RMDir /r "$LOCALAPPDATA\FontManager\data"
    ${EndIf}

    ; 2.2 应用数据目录：确认含有本软件特征文件才整体删除
    ${If} ${FileExists} "$APPDATA\FontManager\state.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\font-cache.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\api.json"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\activation.log"
    ${OrIf} ${FileExists} "$APPDATA\FontManager\system-ps.json"
      RMDir /r "$APPDATA\FontManager"
    ${EndIf}

    ; 1.2.4 改名前的旧数据目录（0.8.x 一路沿用下来的），同样只删确认属于本软件的
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

    ; 2.3b 1.9.8 之前应用标识是 com.theholyonez.fontmanager，WebView2 的用户数据目录
    ;      就在这个旧名字下。新版启动时会把整目录改名搬走，但「从没跑过 1.9.8 就卸载」
    ;      的机器上它还在原地 —— 勾了「删除应用数据」就该一并清掉。
    ;      只认这个确切路径，不扫别的目录。
    RMDir /r "$LOCALAPPDATA\com.theholyonez.fontmanager"
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
    ; 2.1.5 预防性一条：当前字体库**不在** data 下（见 ADR-D2，字体是用户资产，
    ; 不跟数据混在一层），所以这条今天匹配不到任何东西。
    ; 留着是因为将来若真把库搬进 data\，忘了加这条的后果是「卸载后 HKCU 里残留
    ; 一堆指向已删文件的字体项」—— 那比多一行没用的前缀难查得多。
    !insertmacro ZFM_MATCH_FONT_PREFIX "$INSTDIR\data\"
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
