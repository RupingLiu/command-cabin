; =============================================================================
; CommandCabin per-machine 安装器（NSIS 3.x，Unicode）
;
; 构建（native/scripts/build-installer.ps1 会传入全部绝对路径 define）：
;   makensis /DVERSION=x.y.z /DSETUP_OUTFILE=<abs> /DEXE_SOURCE=<abs>
;            /DLICENSE_SOURCE=<abs> /DICON_SOURCE=<abs> installer.nsi
;   （缺省值假设在 native/ 目录下手动运行 makensis。）
;
; 安装/卸载语义（对齐 TS 版 electron-builder：nsis perMachine: true +
; oneClick: false + allowToChangeInstallationDirectory: true）：
; - per-machine 安装：$PROGRAMFILES64\command-cabin\CommandCabin
;   （64 位 Program Files 下 command-cabin 中转层，与原版 Electron 安装器
;   同一目录布局），RequestExecutionLevel admin（写入 Program Files 需提权；
;   启动安装包即弹 UAC）。自更新 /S 静默安装同样经 UAC 一次提权完成。
; - 桌面快捷方式复选框默认勾选：对齐 TS createDesktopShortcut: always；
;   静默安装 /S 不显示页面、取默认值 → 桌面快捷方式照建。
; - 升级路径：/S 静默覆盖安装（SetOverwrite on，同目录重入，先读注册表
;   InstallLocation 复用旧目录，/D= 优先于注册表值）。安装开始时轮询等待
;   CommandCabin.exe 退出（应用侧更新编排：spawn 安装包 /S 后立即退出事件）。
;   等待预算 30s（30 x 1s 轮询 tasklist）；超时后继续安装——文件被占用时
;   交互模式弹重试框，静默模式 NSIS 置错误位继续（旧 exe 保留）。
; - 卸载：删除 exe / LICENSE / 卸载器 / 开始菜单与桌面快捷方式 / HKLM 卸载键；
;   **绝不触碰 %APPDATA%\CommandCabin（userData 永久保留；本脚本对 APPDATA
;   无任何 Delete / RMDir 指令——数据连续性红线）**。$INSTDIR 仅在清空后移除。
; - 注册表卸载键：HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\
;   CommandCabin（per-machine → HKLM）。
; =============================================================================

Unicode true
ManifestDPIAware true

!define APP_NAME      "CommandCabin"
!define APP_EXE       "CommandCabin.exe"
!define UNINSTALLER   "Uninstall CommandCabin.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CommandCabin"
; per-machine 默认目录（对齐原版 Electron：Program Files\command-cabin\CommandCabin）。
!define DEFAULT_DIR   "$PROGRAMFILES64\command-cabin\CommandCabin"

; 等待运行中进程退出的预算（秒）：30 x 1s 轮询。
!define WAIT_FOR_EXIT_SECONDS 30

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SETUP_OUTFILE
  !define SETUP_OUTFILE "artifacts\CommandCabin-Setup-${VERSION}.exe"
!endif
!ifndef EXE_SOURCE
  !define EXE_SOURCE "artifacts\cabin-app-release.exe"
!endif
!ifndef LICENSE_SOURCE
  !define LICENSE_SOURCE "..\LICENSE"
!endif
!ifndef FONT_LICENSE_SOURCE
  !define FONT_LICENSE_SOURCE "assets\fonts\LICENSE-LiberationSans.txt"
!endif
!ifndef ICON_SOURCE
  !define ICON_SOURCE "assets\icon.ico"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"

; StrStr 声明（安装侧 + 卸载侧；必须位于全局作用域，Section/Function 之前）
${Using:StrFunc} StrStr
${Using:StrFunc} UnStrStr

Name "${APP_NAME} ${VERSION}"
OutFile "${SETUP_OUTFILE}"
InstallDir "${DEFAULT_DIR}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "${APP_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}.0"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright 2026 ${APP_NAME}"

Icon "${ICON_SOURCE}"
UninstallIcon "${ICON_SOURCE}"

!define MUI_ICON "${ICON_SOURCE}"
!define MUI_UNICON "${ICON_SOURCE}"

; --- 页面 ------------------------------------------------------------------
!insertmacro MUI_PAGE_DIRECTORY
Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; --- 语言（未显示选择框：按系统 UI 语言自动匹配，缺省简体中文） ------------
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString LngDesktopTitle     ${LANG_SIMPCHINESE} "快捷方式"
LangString LngDesktopSubtitle  ${LANG_SIMPCHINESE} "选择是否创建桌面快捷方式。"
LangString LngDesktopCheckbox  ${LANG_SIMPCHINESE} "创建桌面快捷方式(&D)"
LangString LngWaitRunning      ${LANG_SIMPCHINESE} "检测到 ${APP_EXE} 正在运行，等待其退出（最多 ${WAIT_FOR_EXIT_SECONDS} 秒）…"
LangString LngWaitTimeout      ${LANG_SIMPCHINESE} "等待超时，继续安装。若文件被占用导致失败，请关闭 ${APP_NAME} 后重试。"
LangString LngAppRunning       ${LANG_SIMPCHINESE} "检测到 ${APP_NAME} 正在运行。$\n$\n点击 [确定] 自动关闭它并继续安装，或点击 [取消] 退出安装程序。"
LangString LngUnAppRunning     ${LANG_SIMPCHINESE} "检测到 ${APP_NAME} 正在运行。$\n$\n点击 [确定] 自动关闭它并继续卸载，或点击 [取消] 退出卸载程序。"

LangString LngDesktopTitle     ${LANG_ENGLISH} "Shortcuts"
LangString LngDesktopSubtitle  ${LANG_ENGLISH} "Choose whether to create a desktop shortcut."
LangString LngDesktopCheckbox  ${LANG_ENGLISH} "Create &desktop shortcut"
LangString LngWaitRunning      ${LANG_ENGLISH} "${APP_EXE} is running; waiting up to ${WAIT_FOR_EXIT_SECONDS} s for it to exit..."
LangString LngWaitTimeout      ${LANG_ENGLISH} "Wait timed out; continuing. If installation fails because files are locked, close ${APP_NAME} and retry."
LangString LngAppRunning       ${LANG_ENGLISH} "${APP_NAME} is currently running.$\n$\nClick OK to close it automatically and continue, or Cancel to quit setup."
LangString LngUnAppRunning     ${LANG_ENGLISH} "${APP_NAME} is currently running.$\n$\nClick OK to close it automatically and continue, or Cancel to quit uninstall."

; --- 变量 ------------------------------------------------------------------
Var DesktopShortcutState   ; 1=勾选（默认，对齐 TS createDesktopShortcut: always）/ 0=取消
Var hDesktopCheckbox       ; 复选框句柄（Create/Leave 两个回调间共享，勿用 $0-$R9 寄存器）

; --- 等待运行中进程退出（轮询 tasklist，零插件依赖） ------------------------
; $SYSDIR\tasklist.exe 按镜像名过滤，直接扫其 stdout 是否含进程名（StrStr 子串
; 检索）。不经 cmd/find：规避 PATH 上 GNU find 遮蔽与 WOW64 下 System32\find.exe
; 缺失两类环境性失效；tasklist 本身在 $SYSDIR（32 位安装器下重定向 SysWOW64，
; 该副本存在，已验证）。exec 失败（$R1="error"）按“已退出”处理 → 继续安装。
!macro WaitAppExitLoop un
  StrCpy $R9 0
wait_running_loop:
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXE}" /NH'
  Pop $R0                 ; 退出码（tasklist 命中与否均可能为 0，忽略，仅看输出）
  Pop $R1                 ; stdout（OEM；进程名 ASCII）
  ${${un}StrStr} $R2 $R1 "${APP_EXE}"
  ${If} $R2 != ""         ; 输出含进程名 → 仍在运行
    ${If} $R9 == 0
      DetailPrint "$(LngWaitRunning)"
    ${EndIf}
    ${If} $R9 >= ${WAIT_FOR_EXIT_SECONDS}
      DetailPrint "$(LngWaitTimeout)"
      Goto wait_running_done
    ${EndIf}
    Sleep 1000
    IntOp $R9 $R9 + 1
    Goto wait_running_loop
  ${EndIf}
wait_running_done:
!macroend

; --- 关闭运行中的应用（UI 修复 9：安装/卸载前主动提示关闭，不再让用户手动退）--
; 检测到 ${APP_EXE} 在运行时：
; - 交互模式：弹窗 [确定]=taskkill 自动关闭后继续 / [取消]=Abort 退出；
; - 静默模式（/S，自更新路径）：直接 taskkill，不弹窗。
; taskkill 失败（权限等）重试至多 3 次；仍失败则交由后续 WaitAppExitLoop /
; NSIS 文件占用重试兜底。应用数据安全：taskkill 不触碰 %APPDATA%（应用侧
; SQLite 全部原子写，强杀不损库——WAL 模式恢复语义）。
!macro CloseRunningApp un MsgLang
  StrCpy $R9 0
close_app_check:
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXE}" /NH'
  Pop $R0
  Pop $R1
  ${${un}StrStr} $R2 $R1 "${APP_EXE}"
  ${If} $R2 == ""
    Return                ; 未在运行
  ${EndIf}
  ${If} ${Silent}
    Goto close_app_kill
  ${EndIf}
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "$(${MsgLang})" IDOK close_app_kill IDCANCEL close_app_abort
  Goto close_app_kill
close_app_abort:
  Abort
close_app_kill:
  DetailPrint "closing ${APP_EXE}..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM ${APP_EXE}'
  Sleep 1500
  IntOp $R9 $R9 + 1
  ${If} $R9 < 3
    Goto close_app_check
  ${EndIf}
!macroend

Function .onInit
  StrCpy $DesktopShortcutState 1
  ; UI 修复 9：应用在运行 → 提示自动关闭（静默 /S 直接关闭），不再让用户手动退。
  !insertmacro CloseRunningApp "" LngAppRunning
  ; 升级复用旧安装目录：仅当未通过 /D= 指定目录时（$INSTDIR 仍等于缺省值）。
  ReadRegStr $R0 HKLM "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $R0 != ""
    ${If} $INSTDIR == "${DEFAULT_DIR}"
      StrCpy $INSTDIR $R0
    ${EndIf}
  ${EndIf}
FunctionEnd

; 卸载前同样先关闭运行中的应用（提示/静默同安装侧）。
Function un.onInit
  !insertmacro CloseRunningApp "Un" LngUnAppRunning
FunctionEnd

; --- 桌面快捷方式复选框页（自定义 nsDialogs 页，静默安装自动跳过） -----------
Function DesktopShortcutPageCreate
  !insertmacro MUI_HEADER_TEXT "$(LngDesktopTitle)" "$(LngDesktopSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 20u 100% 12u "$(LngDesktopCheckbox)"
  Pop $hDesktopCheckbox
  ${NSD_SetState} $hDesktopCheckbox $DesktopShortcutState
  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $hDesktopCheckbox $DesktopShortcutState
FunctionEnd

; --- 安装 ------------------------------------------------------------------
Section "-Install"
  !insertmacro WaitAppExitLoop ""

  SetOutPath "$INSTDIR"
  SetOverwrite on
  ; 构建产物改名安装：cabin-app-release.exe -> CommandCabin.exe
  File "/oname=${APP_EXE}" "${EXE_SOURCE}"
  ; LICENSE 有则装；OFL 字体许可随内嵌字体进 exe，第三方声明文件列 M6
  File "/nonfatal" "${LICENSE_SOURCE}"
  File "/nonfatal" "/oname=LICENSE-LiberationSans.txt" "${FONT_LICENSE_SOURCE}"

  ; 卸载器（WriteUninstaller 同时负责旧版卸载器的覆盖重入）
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; 快捷方式（per-machine → 公共 shell 目录；SetShellVarContext 显式 all）
  SetShellVarContext all
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  ${If} $DesktopShortcutState == 1
    CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  ${EndIf}

  ; 注册表卸载键（per-machine → HKLM）
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayName"          "${APP_NAME}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayVersion"      "${VERSION}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "Publisher"           "${APP_NAME}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayIcon"         "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "InstallLocation"     "$INSTDIR"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "UninstallString"     '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify"            1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair"            1
  ; EstimatedSize（KB，DWORD；供“应用和功能”显示）——/S=0K 显式指定 KB 单位
  ${GetSize} "$INSTDIR" "/S=0K" $R1 $R2 $R3
  IntFmt $R1 "0x%08X" $R1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" $R1

  ; 装完自动启动（含静默自更新路径）：直接 Exec 新装 exe。交互与静默一致——
  ; 自更新链路（应用 spawn Setup /S 后立即退出）装完即拉起新实例，免手动开启。
  Exec '"$INSTDIR\${APP_EXE}"'
SectionEnd

; --- 卸载 ------------------------------------------------------------------
Section "Uninstall"
  !insertmacro WaitAppExitLoop "Un"

  SetShellVarContext all
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSE-LiberationSans.txt"
  Delete "$INSTDIR\${UNINSTALLER}"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegKey HKLM "${UNINSTALL_KEY}"

  ; 数据连续性红线：%APPDATA%\CommandCabin（Electron userData / native 设置）
  ; 卸载时**永久保留**——本节对 APPDATA 无任何 Delete / RMDir。
  ; $INSTDIR 仅在已空时移除（RMDir 不删非空目录，用户私人物品安全）。
  RMDir "$INSTDIR"
SectionEnd
