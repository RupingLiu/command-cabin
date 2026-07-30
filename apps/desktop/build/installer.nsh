!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\Program Files\command-cabin"
!macroend

!macro customInstall
  ; Never recursively delete the historical per-user directory from the installer.
  ; Older builds may have shared that path with unrelated files or a reparse point.
  ; A verified legacy uninstaller can be invoked by a future migration, but an
  ; unowned directory must be preserved.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
