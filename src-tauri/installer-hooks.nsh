; JCode 自定义 NSIS 安装器 Hook
;
; 在每次安装完成后清除"Installer Language"注册表值。
; 这样下一次安装升级时，语言选择对话框能再次弹出，避免用户被
; 上一次的语言选择"锁住"（NSIS 的 MUI_LANGDLL_DISPLAY 在检测到
; 已有注册表值时，会直接使用那个值而跳过弹窗）。

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
!macroend
