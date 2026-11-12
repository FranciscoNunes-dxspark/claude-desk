; Windows installer hooks (tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Claude Desk was renamed Switchyard. The NSIS installer keys an install by its product
; name (uninstall entry, shortcuts, folder), so updating from Claude Desk installs
; Switchyard beside it, and the old shortcuts would keep opening the old copy. Once
; Switchyard is installed, remove what the Claude Desk installer left behind.
;
; Settings, open sessions and history are kept: they live under the app's identifier
; (com.dxspark.claudedesk), which didn't change, so nothing here touches app data.

!include LogicLib.nsh

!define SWITCHYARD_OLD_NAME "Claude Desk"
!define SWITCHYARD_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Claude Desk"

; Removes the old install recorded under ROOT (HKCU for per-user installs, the default;
; HKLM for per-machine ones).
!macro SWITCHYARD_REMOVE_OLD ROOT
  Push $R0
  Push $R1
  ReadRegStr $R0 ${ROOT} "${SWITCHYARD_OLD_UNINSTKEY}" "InstallLocation"
  ${If} $R0 != ""
    ; The value may be quoted.
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 -1 1
    ${EndIf}
    ; Only a folder that is plainly the old install ("…\Claude Desk"), and never the one
    ; Switchyard was just installed into.
    StrCpy $R1 $R0 "" -12
    ${If} $R1 == "\${SWITCHYARD_OLD_NAME}"
    ${AndIf} $R0 != $INSTDIR
      RMDir /r "$R0"
    ${EndIf}
    DeleteRegKey ${ROOT} "${SWITCHYARD_OLD_UNINSTKEY}"
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SWITCHYARD_REMOVE_OLD HKCU
  !insertmacro SWITCHYARD_REMOVE_OLD HKLM
  ; The old shortcuts (Start menu, its folder if one was chosen, desktop).
  Delete "$SMPROGRAMS\${SWITCHYARD_OLD_NAME}.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${SWITCHYARD_OLD_NAME}.lnk"
  Delete "$DESKTOP\${SWITCHYARD_OLD_NAME}.lnk"
!macroend
