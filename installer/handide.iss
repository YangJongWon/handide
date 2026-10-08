; Windows installer for handide. Built by installer/build.mjs, which stages the app with its
; own Node.js and passes AppVersion and StageDir.
;
; One click, per user (no admin): handide itself, VS Code when missing, Start menu and
; desktop shortcuts, "Open on phone" in Explorer's folder menu, the "handide" command.
; The last page offers the one-time Tailscale setup ("handide remote"), whose sign-in
; is the only step left to the user.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "out\stage"
#endif

[Setup]
AppId={{7FFF7941-E1B1-4867-83EC-18EF35F1D9B0}
AppName=handide
AppVersion={#AppVersion}
AppVerName=handide {#AppVersion}
AppPublisher=YangJongWon
AppPublisherURL=https://github.com/YangJongWon/handide
AppSupportURL=https://github.com/YangJongWon/handide/issues
DefaultDirName={localappdata}\Programs\handide
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
OutputBaseFilename=handide-setup-{#AppVersion}
SetupIconFile={#StageDir}\handide.ico
UninstallDisplayIcon={app}\handide.ico
UninstallDisplayName=handide
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#if FileExists(CompilerPath + "Languages\Korean.isl")
  #define HaveKorean
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#endif

[CustomMessages]
english.DesktopIcon=Create a desktop shortcut
english.ContextMenu=Add "Open on phone (handide)" to Explorer's folder menu
english.AddToPath=Add the "handide" command to terminals (PATH)
english.InstallVSCode=Install Visual Studio Code (required, not found on this PC)
english.OpenOnPhone=Open on phone (handide)
english.RemoteShortcut=handide remote setup
english.SetupRemote=Set up access from anywhere now (installs Tailscale; sign in with Google, Microsoft, GitHub or Apple)
english.LaunchNow=Start handide now (choose a folder)
english.DownloadingVSCode=Downloading Visual Studio Code
english.InstallingVSCode=Installing Visual Studio Code...
english.VSCodeDownloadFailed=Could not download VS Code (%1).%n%nhandide is installed anyway; install VS Code from https://code.visualstudio.com before starting it.
english.VSCodeInstallFailed=VS Code setup did not finish (%1).%n%nInstall it from https://code.visualstudio.com before starting handide.
#ifdef HaveKorean
korean.DesktopIcon=바탕화면에 바로가기 만들기
korean.ContextMenu=탐색기 폴더 우클릭 메뉴에 "휴대폰에서 열기 (handide)" 추가
korean.AddToPath=터미널에서 "handide" 명령 사용 (PATH에 추가)
korean.InstallVSCode=Visual Studio Code 설치 (필수, 이 PC에 없음)
korean.OpenOnPhone=휴대폰에서 열기 (handide)
korean.RemoteShortcut=handide 원격 설정
korean.SetupRemote=지금 집 밖에서도 접속되게 설정 (Tailscale 설치 후 Google·Microsoft·GitHub·Apple 계정으로 로그인)
korean.LaunchNow=지금 handide 시작 (폴더 선택)
korean.DownloadingVSCode=Visual Studio Code 다운로드 중
korean.InstallingVSCode=Visual Studio Code 설치 중...
korean.VSCodeDownloadFailed=VS Code를 내려받지 못했습니다 (%1).%n%nhandide는 설치됩니다. 시작하기 전에 https://code.visualstudio.com 에서 VS Code를 설치하세요.
korean.VSCodeInstallFailed=VS Code 설치가 끝나지 않았습니다 (%1).%n%nhandide를 시작하기 전에 https://code.visualstudio.com 에서 설치하세요.
#endif

[Tasks]
Name: "vscode"; Description: "{cm:InstallVSCode}"; Check: not HasVSCode
Name: "desktopicon"; Description: "{cm:DesktopIcon}"
Name: "contextmenu"; Description: "{cm:ContextMenu}"
Name: "addtopath"; Description: "{cm:AddToPath}"

[InstallDelete]
; The previous version's app files, so removed files don't linger after an update.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\handide"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\handide.ico"
Name: "{autoprograms}\{cm:RemoteShortcut}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"" -Remote"; WorkingDir: "{userdocs}"; IconFilename: "{app}\handide.ico"
Name: "{autodesktop}\handide"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\handide.ico"; Tasks: desktopicon

[Registry]
; Right-click a folder, or the empty space inside one. "%V\." keeps a drive root's
; trailing backslash from escaping the closing quote.
Root: HKCU; Subkey: "Software\Classes\Directory\shell\handide"; ValueType: string; ValueName: ""; ValueData: "{cm:OpenOnPhone}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\handide"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\handide.ico"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\handide\command"; ValueType: string; ValueName: ""; ValueData: """{sys}\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"" -Folder ""%V\."""; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\handide"; ValueType: string; ValueName: ""; ValueData: "{cm:OpenOnPhone}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\handide"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\handide.ico"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\handide\command"; ValueType: string; ValueName: ""; ValueData: """{sys}\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"" -Folder ""%V\."""; Tasks: contextmenu

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"" -Remote"; WorkingDir: "{userdocs}"; Description: "{cm:SetupRemote}"; Flags: postinstall nowait skipifsilent
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch.ps1"""; WorkingDir: "{userdocs}"; Description: "{cm:LaunchNow}"; Flags: postinstall nowait skipifsilent unchecked

[UninstallDelete]
; The user's handide home (~\.handide: token, certificate, layout) is kept.
Type: filesandordirs; Name: "{app}"

[Code]
const
  EnvKey = 'Environment';
  VSCodeUrl = 'https://update.code.visualstudio.com/latest/win32-x64-user/stable';

var
  DownloadPage: TDownloadWizardPage;
  VSCodeDownloaded: Boolean;

{ Where handide's editor detection (proxy/editor.mjs) looks for VS Code. }
function HasVSCode: Boolean;
begin
  Result :=
    FileExists(ExpandConstant('{localappdata}\Programs\Microsoft VS Code\bin\code-tunnel.exe')) or
    FileExists(ExpandConstant('{commonpf64}\Microsoft VS Code\bin\code-tunnel.exe')) or
    FileExists(ExpandConstant('{commonpf32}\Microsoft VS Code\bin\code-tunnel.exe'));
end;

procedure AddToPath(Dir: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0 then exit;
  if (Paths <> '') and (Paths[Length(Paths)] <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromPath(Dir: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then exit;
  Paths := ';' + Paths + ';';
  if StringChangeEx(Paths, ';' + Dir + ';', ';', True) = 0 then exit;
  while (Length(Paths) > 0) and (Paths[1] = ';') do Delete(Paths, 1, 1);
  while (Length(Paths) > 0) and (Paths[Length(Paths)] = ';') do Delete(Paths, Length(Paths), 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(CustomMessage('DownloadingVSCode'), '', nil);
end;

{ VS Code is downloaded before installing, so a failure can be reported up front.
  handide is installed either way. }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID <> wpReady) or not WizardIsTaskSelected('vscode') then exit;
  DownloadPage.Clear;
  DownloadPage.Add(VSCodeUrl, 'VSCodeUserSetup.exe', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
      VSCodeDownloaded := True;
    except
      if not DownloadPage.AbortedByUser then
        SuppressibleMsgBox(FmtMessage(CustomMessage('VSCodeDownloadFailed'), [GetExceptionMessage]), mbError, MB_OK, IDOK);
    end;
  finally
    DownloadPage.Hide;
  end;
end;

procedure InstallVSCode;
var
  Code: Integer;
begin
  WizardForm.StatusLabel.Caption := CustomMessage('InstallingVSCode');
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    if not Exec(ExpandConstant('{tmp}\VSCodeUserSetup.exe'), '/VERYSILENT /NORESTART /MERGETASKS=!runcode', '', SW_SHOW, ewWaitUntilTerminated, Code) then
      SuppressibleMsgBox(FmtMessage(CustomMessage('VSCodeInstallFailed'), [SysErrorMessage(Code)]), mbError, MB_OK, IDOK)
    else if Code <> 0 then
      SuppressibleMsgBox(FmtMessage(CustomMessage('VSCodeInstallFailed'), ['exit code ' + IntToStr(Code)]), mbError, MB_OK, IDOK);
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then exit;
  if WizardIsTaskSelected('addtopath') then AddToPath(ExpandConstant('{app}'));
  if VSCodeDownloaded then InstallVSCode;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveFromPath(ExpandConstant('{app}'));
end;
