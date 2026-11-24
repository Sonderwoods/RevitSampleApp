; NSIS hooks for the Cloudburst setup program (tauri.conf.json → bundle.windows.nsis.installerHooks).
; The setup program is per-user (no administrator rights). After the desktop app is installed it offers to install
; the bundled plug-ins ($INSTDIR\plugins, staged by Desktop/stage-plugins.ps1) for the CAD programs it finds:
;   Revit 2026  → %AppData%\Autodesk\Revit\Addins\2026            (Cloudburst.addin + Cloudburst\)
;   Rhino 8     → Rhino's own package manager: Yak.exe install <cloudburst-*.yak>   (plug-in + Grasshopper)
; Uninstalling removes them again. Silent installs (/S) answer Yes.

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1

  ; ---- Revit 2026
  IfFileExists "$INSTDIR\plugins\Revit\Cloudburst.addin" 0 cb_revit_done
  IfFileExists "$PROGRAMFILES64\Autodesk\Revit 2026\Revit.exe" cb_revit_ask 0
  IfFileExists "$APPDATA\Autodesk\Revit\Addins\2026\*.*" cb_revit_ask cb_revit_done
  cb_revit_ask:
  MessageBox MB_YESNO|MB_ICONQUESTION "Revit 2026 was found.$\n$\nAlso install the Cloudburst add-in for Revit?" /SD IDYES IDNO cb_revit_done
  CreateDirectory "$APPDATA\Autodesk\Revit\Addins\2026"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\plugins\Revit\*.*" "$APPDATA\Autodesk\Revit\Addins\2026"
  IfErrors 0 cb_revit_done
  MessageBox MB_OK|MB_ICONEXCLAMATION "The Revit add-in could not be copied (is Revit running?).$\n$\nClose Revit and run this setup again, or copy the contents of$\n$INSTDIR\plugins\Revit$\ninto %AppData%\Autodesk\Revit\Addins\2026." /SD IDOK
  cb_revit_done:

  ; ---- Rhino 8 (+ Grasshopper)
  IfFileExists "$PROGRAMFILES64\Rhino 8\System\Yak.exe" 0 cb_rhino_done
  FindFirst $0 $1 "$INSTDIR\plugins\Rhino\*.yak"
  StrCmp $1 "" cb_rhino_close
  MessageBox MB_YESNO|MB_ICONQUESTION "Rhino 8 was found.$\n$\nAlso install the Cloudburst plug-in for Rhino and Grasshopper?" /SD IDYES IDNO cb_rhino_close
  DetailPrint "Installing the Rhino package $1"
  nsExec::ExecToLog '"$PROGRAMFILES64\Rhino 8\System\Yak.exe" install "$INSTDIR\plugins\Rhino\$1"'
  Pop $1
  StrCmp $1 "0" cb_rhino_close
  MessageBox MB_OK|MB_ICONEXCLAMATION "The Rhino package could not be installed automatically.$\n$\nDrag the .yak file in$\n$INSTDIR\plugins\Rhino$\nonto a Rhino 8 window instead." /SD IDOK
  cb_rhino_close:
  FindClose $0
  cb_rhino_done:

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Revit add-in (only our own files)
  Delete "$APPDATA\Autodesk\Revit\Addins\2026\Cloudburst.addin"
  RMDir /r "$APPDATA\Autodesk\Revit\Addins\2026\Cloudburst"
  ; Rhino package
  IfFileExists "$PROGRAMFILES64\Rhino 8\System\Yak.exe" 0 cb_un_rhino_done
  nsExec::ExecToLog '"$PROGRAMFILES64\Rhino 8\System\Yak.exe" uninstall cloudburst'
  Pop $0
  cb_un_rhino_done:
!macroend
