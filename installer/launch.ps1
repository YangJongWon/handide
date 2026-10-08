# Start-menu, desktop and Explorer entry point of the Windows installer.
#   launch.ps1                 pick a folder (the last one is preselected), then serve it
#   launch.ps1 -Folder <path>  serve that folder (Explorer "Open on phone")
#   launch.ps1 -Remote         one-time Tailscale setup (installer's last page)
# This console window is handide's log; closing it stops handide.
param([string]$Folder, [switch]$Remote)

$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$node = Join-Path $app 'node\node.exe'
$server = Join-Path $app 'app\proxy\server.mjs'
$home_ = if ($env:HANDIDE_HOME) { $env:HANDIDE_HOME } else { Join-Path $env:USERPROFILE '.handide' }
$lastFile = Join-Path $home_ 'last-folder'
$Host.UI.RawUI.WindowTitle = 'handide'

function Wait-Close($msg) {
	Write-Host ''
	Read-Host $msg | Out-Null
}

if ($Remote) {
	& $node $server remote
	if ($LASTEXITCODE -eq 0) { Wait-Close '설정이 끝났습니다. Enter를 누르면 닫힙니다 (Done, press Enter)' }
	else { Wait-Close '설정을 마치지 못했습니다. 시작 메뉴의 "handide 원격 설정"으로 다시 할 수 있습니다. Enter를 누르면 닫힙니다' }
	exit $LASTEXITCODE
}

if (-not $Folder) {
	Add-Type -AssemblyName System.Windows.Forms
	$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
	$dialog.Description = '휴대폰에서 열 프로젝트 폴더를 고르세요 (Choose the folder to open on the phone)'
	$dialog.ShowNewFolderButton = $true
	if (Test-Path $lastFile) {
		$last = (Get-Content $lastFile -Raw).Trim()
		if ($last -and (Test-Path $last)) { $dialog.SelectedPath = $last }
	}
	$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
	if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
	$Folder = $dialog.SelectedPath
}

# Explorer passes "<dir>\." so a drive root's trailing backslash cannot escape the quote.
$Folder = [System.IO.Path]::GetFullPath($Folder)
New-Item -ItemType Directory -Force $home_ | Out-Null
Set-Content -Path $lastFile -Value $Folder -Encoding UTF8

& $node $server $Folder --open
if ($LASTEXITCODE -ne 0) { Wait-Close 'handide가 멈췄습니다. 위 메시지를 확인하세요. Enter를 누르면 닫힙니다 (handide stopped, press Enter)' }
