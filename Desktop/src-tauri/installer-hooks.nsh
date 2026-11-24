; NSIS hooks for the Cloudburst setup program (tauri.conf.json → bundle.windows.nsis.installerHooks).
; The setup program is per-user (no administrator rights). Besides the desktop app it installs the bundled plug-ins
; ($INSTDIR\plugins, staged by Desktop/stage-plugins.ps1) for the CAD programs found on the computer:
;   Revit 2026  → %AppData%\Autodesk\Revit\Addins\2026            (Cloudburst.addin + Cloudburst\)
;   Rhino 8     → Rhino's own package manager: Yak.exe install <cloudburst-*.yak>   (plug-in + Grasshopper)
; The first page of the setup program lists them with a tick box each (all found programs ticked by default).
; Silent (/S), passive (/P) and update (/UPDATE) installs show no page and install for every program found.
; Uninstalling removes the plug-ins again.
;
; This file is included near the top of Tauri's installer.nsi, before its own pages and variables, so the page
; declared here comes first and only uses its own variables.

!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include FileFunc.nsh

Var CbRevit     ; 1 = install the Revit add-in ("" until decided)
Var CbRhino     ; 1 = install the Rhino package ("" until decided)
Var CbHasRevit  ; 1 = Revit 2026 found
Var CbHasRhino  ; 1 = Rhino 8 found
Var CbChkRevit
Var CbChkRhino
Var CbTmp

Page custom CbHostsPage CbHostsLeave

; Finds the CAD programs and, the first time, ticks every one that was found.
Function CbDetectHosts
  StrCpy $CbHasRevit 0
  ${If} ${FileExists} "$PROGRAMFILES64\Autodesk\Revit 2026\Revit.exe"
  ${OrIf} ${FileExists} "$APPDATA\Autodesk\Revit\Addins\2026\*.*"
    StrCpy $CbHasRevit 1
  ${EndIf}
  StrCpy $CbHasRhino 0
  ${If} ${FileExists} "$PROGRAMFILES64\Rhino 8\System\Yak.exe"
    StrCpy $CbHasRhino 1
  ${EndIf}
  ${If} $CbRevit == ""
    StrCpy $CbRevit $CbHasRevit
  ${EndIf}
  ${If} $CbRhino == ""
    StrCpy $CbRhino $CbHasRhino
  ${EndIf}
FunctionEnd

Function CbHostsPage
  Call CbDetectHosts
  ; no page for passive and update installs
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $CbTmp
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $CbTmp
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors

  GetDlgItem $CbTmp $HWNDPARENT 1037
  SendMessage $CbTmp ${WM_SETTEXT} 0 "STR:Choose what to install"
  GetDlgItem $CbTmp $HWNDPARENT 1038
  SendMessage $CbTmp ${WM_SETTEXT} 0 "STR:Cloudburst works as a desktop app and inside Revit and Rhino."

  nsDialogs::Create 1018
  Pop $CbTmp
  ${If} $CbTmp == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Tick the programs you want Cloudburst in. Programs that were not found on this computer are greyed out. No administrator rights are needed."
  Pop $CbTmp

  ${NSD_CreateCheckbox} 0 30u 100% 12u "Cloudburst desktop app"
  Pop $CbTmp
  ${NSD_Check} $CbTmp
  EnableWindow $CbTmp 0

  ${If} $CbHasRevit = 1
    ${NSD_CreateCheckbox} 0 48u 100% 12u "Revit 2026 add-in"
    Pop $CbChkRevit
    ${If} $CbRevit = 1
      ${NSD_Check} $CbChkRevit
    ${EndIf}
  ${Else}
    ${NSD_CreateCheckbox} 0 48u 100% 12u "Revit 2026 add-in (Revit 2026 not found)"
    Pop $CbChkRevit
    EnableWindow $CbChkRevit 0
  ${EndIf}

  ${If} $CbHasRhino = 1
    ${NSD_CreateCheckbox} 0 66u 100% 12u "Rhino 8 plug-in and Grasshopper components"
    Pop $CbChkRhino
    ${If} $CbRhino = 1
      ${NSD_Check} $CbChkRhino
    ${EndIf}
  ${Else}
    ${NSD_CreateCheckbox} 0 66u 100% 12u "Rhino 8 plug-in and Grasshopper components (Rhino 8 not found)"
    Pop $CbChkRhino
    EnableWindow $CbChkRhino 0
  ${EndIf}

  ${NSD_CreateLabel} 0 90u 100% 20u "Close Revit before you continue, otherwise its add-in files cannot be replaced. Rhino picks the plug-in up the next time it starts."
  Pop $CbTmp

  nsDialogs::Show
FunctionEnd

Function CbHostsLeave
  ${NSD_GetState} $CbChkRevit $CbRevit
  ${NSD_GetState} $CbChkRhino $CbRhino
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Call CbDetectHosts ; silent / passive installs never saw the page: install for every program found

  ; ---- Revit 2026
  ${If} $CbRevit = 1
  ${AndIf} ${FileExists} "$INSTDIR\plugins\Revit\Cloudburst.addin"
    DetailPrint "Installing the Revit 2026 add-in"
    CreateDirectory "$APPDATA\Autodesk\Revit\Addins\2026"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\plugins\Revit\*.*" "$APPDATA\Autodesk\Revit\Addins\2026"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Revit add-in could not be copied (is Revit running?).$\n$\nClose Revit and run this setup again, or copy the contents of$\n$INSTDIR\plugins\Revit$\ninto %AppData%\Autodesk\Revit\Addins\2026." /SD IDOK
    ${EndIf}
  ${EndIf}

  ; ---- Rhino 8 (+ Grasshopper)
  ${If} $CbRhino = 1
  ${AndIf} ${FileExists} "$PROGRAMFILES64\Rhino 8\System\Yak.exe"
    FindFirst $0 $1 "$INSTDIR\plugins\Rhino\*.yak"
    ${If} $1 != ""
      DetailPrint "Installing the Rhino package $1"
      nsExec::ExecToLog '"$PROGRAMFILES64\Rhino 8\System\Yak.exe" install "$INSTDIR\plugins\Rhino\$1"'
      Pop $1
      ${If} $1 != "0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "The Rhino package could not be installed automatically.$\n$\nDrag the .yak file in$\n$INSTDIR\plugins\Rhino$\nonto a Rhino 8 window instead." /SD IDOK
      ${EndIf}
    ${EndIf}
    FindClose $0
  ${EndIf}

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Revit add-in (only our own files)
    Delete "$APPDATA\Autodesk\Revit\Addins\2026\Cloudburst.addin"
    RMDir /r "$APPDATA\Autodesk\Revit\Addins\2026\Cloudburst"
    ; Rhino package
    ${If} ${FileExists} "$PROGRAMFILES64\Rhino 8\System\Yak.exe"
      nsExec::ExecToLog '"$PROGRAMFILES64\Rhino 8\System\Yak.exe" uninstall cloudburst'
      Pop $0
    ${EndIf}
  ${EndIf}
!macroend
