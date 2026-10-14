!macro customInit
  ${if} ${Silent}
    Return
  ${endIf}

  ${if} $hasPerUserInstallation == "1"
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $R1 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    StrCpy $R2 "$perUserInstallationFolder"
  ${elseif} $hasPerMachineInstallation == "1"
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    StrCpy $R2 "$perMachineInstallationFolder"
  ${else}
    Return
  ${endIf}

  ${if} $R0 == ""
    MessageBox MB_OK|MB_ICONSTOP "O Routiner já está instalado, mas o desinstalador não foi encontrado. Nenhuma alteração foi feita."
    Quit
  ${endIf}

  MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "O Routiner ${VERSION} está pronto para instalação. Já existe a versão $R1 em:$\r$\n$R2$\r$\n$\r$\nSim: atualizar ou reparar usando esta versão.$\r$\nNão: desinstalar o Routiner e manter os dados locais.$\r$\nCancelar: sair sem alterar a instalação." IDYES installOrRepair IDNO uninstallExisting
  Quit

  installOrRepair:
    Return

  uninstallExisting:
    ExecWait '$R0 /KEEP_APP_DATA' $R3
    ${if} $R3 != 0
      MessageBox MB_OK|MB_ICONSTOP "A desinstalação não foi concluída (código $R3). A instalação foi cancelada."
    ${endIf}
    Quit

!macroend
