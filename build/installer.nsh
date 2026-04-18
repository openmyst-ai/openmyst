; NSIS hook used by electron-builder (nsis.include) to register the
; `openmyst://` URL scheme on Windows for the managed-mode sign-in
; deep-link flow (changes.md §2.1). The `protocols:` block in
; electron-builder.yml is read cross-platform but NSIS needs the
; explicit HKCU writes below to actually wire the scheme up.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\openmyst" "" "URL:openmyst Protocol"
  WriteRegStr HKCU "Software\Classes\openmyst" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\openmyst\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\openmyst\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\openmyst"
!macroend
