; Liminn — NSIS install/uninstall hooks.
;
; Windows Defender Firewall blocks unsolicited inbound TCP connections
; by default. Liminn's transfer server needs to accept inbound POSTs on
; its ephemeral port from peers on the LAN; without an explicit allow
; rule the first-run prompt sometimes doesn't appear (or is dismissed)
; and sends to this machine silently fail with timeouts. Add a rule at
; install time so the app works out of the box.
;
; `profile=any` covers Private + Public + Domain. `edgetraversal=yes`
; is harmless on a LAN and keeps the rule working if the user is on a
; network where the NIC reports as edge-traversable.

!macro customInstall
  ; Remove any pre-existing rule with the same name so upgrades don't
  ; accumulate duplicates pointing at stale install paths.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Liminn"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Liminn" dir=in action=allow program="$INSTDIR\${PRODUCT_FILENAME}.exe" enable=yes profile=any edgetraversal=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Liminn"'
!macroend
