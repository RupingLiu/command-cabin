!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
!macroend

!macro customInstall
  ReadEnvStr $0 "LOCALAPPDATA"
  StrCmp "$0" "" legacyCleanupDone 0
  StrCmp "$INSTDIR" "$0\Programs\command-cabin" legacyCleanupDone 0
  RMDir /r "$0\Programs\command-cabin"
  legacyCleanupDone:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
