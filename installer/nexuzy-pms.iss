; Nexuzy PMS Windows installer template.
; installer/build-installer.js fills the {{PLACEHOLDERS}} and compiles this file.
; The payload already contains node.exe and production node_modules, so the
; target PC does not need Node.js, npm or an internet connection.

#define MyAppName "Nexuzy PMS"
#define MyAppVersion "{{APP_VERSION}}"
#define MyAppPublisher "Nexuzy Lab"
#define MyAppURL "https://nexuzy.in"
#define MyAppExeName "Nexuzy PMS.vbs"

[Setup]
AppId={{8F3C1A52-7E4B-4C9D-9A31-6B2E5D7C4A18}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\Nexuzy PMS
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile={{LICENSE}}
OutputDir={{OUTPUT_DIR}}
OutputBaseFilename=Nexuzy-PMS-Setup-{#MyAppVersion}
SetupIconFile={{ICON}}
UninstallDisplayIcon={app}\nexuzy.ico
; lzma2/max decompresses in far less memory than ultra64, so setup also
; completes on 4 GB Windows 11 laptops instead of failing while unpacking.
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; x64compatible also runs on Windows 11 on ARM (the bundled x64 runtime is
; emulated); plain x64 refused to install on those machines.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; PrepareToInstall stops our own node.exe, so the Restart Manager is not needed
; and cannot block the upgrade on a busy Windows 11 desktop.
CloseApplications=no
RestartApplications=no
UsedUserAreasWarning=no
SetupLogging=yes
VersionInfoVersion={{VERSION4}}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Nexuzy PMS installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; data\, uploads, backups and .env are never part of the payload, so upgrades
; leave the hotel's database and uploaded logos untouched.
Source: "{{PAYLOAD}}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\nexuzy.ico"; Comment: "Hotel, restaurant and property management"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\nexuzy.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\data\runtime.json"
Type: files; Name: "{app}\data\launch-hidden.vbs"

[Code]
function GetRunningPid(): Integer;
var
  RuntimeFile: string;
  Content: AnsiString;
  P, I: Integer;
  Digits: string;
begin
  Result := 0;
  RuntimeFile := ExpandConstant('{app}\data\runtime.json');
  if not FileExists(RuntimeFile) then exit;
  if not LoadStringFromFile(RuntimeFile, Content) then exit;

  P := Pos('"pid"', Content);
  if P = 0 then exit;
  P := P + 5;
  while (P <= Length(Content)) and (Content[P] <> ':') do Inc(P);
  Inc(P);
  while (P <= Length(Content)) and
        ((Content[P] = ' ') or (Content[P] = #9) or (Content[P] = #13) or (Content[P] = #10)) do Inc(P);

  Digits := '';
  while (P <= Length(Content)) and (Content[P] >= '0') and (Content[P] <= '9') do
  begin
    Digits := Digits + Content[P];
    Inc(P);
  end;
  if Digits <> '' then Result := StrToIntDef(Digits, 0);
end;

function IsNodeProcess(Pid: Integer): Boolean;
var
  ResultCode: Integer;
  OutputFile: string;
  Output: AnsiString;
begin
  Result := False;
  OutputFile := ExpandConstant('{tmp}\nexuzy-tasklist.txt');
  if Exec(ExpandConstant('{cmd}'),
          '/C tasklist /FI "PID eq ' + IntToStr(Pid) + '" /FO CSV /NH > "' + OutputFile + '"',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if LoadStringFromFile(OutputFile, Output) then
      Result := Pos('node.exe', Lowercase(Output)) > 0;
    DeleteFile(OutputFile);
  end;
end;

procedure StopRunningServer();
var
  Pid, ResultCode: Integer;
begin
  Pid := GetRunningPid();
  if (Pid > 0) and IsNodeProcess(Pid) then
  begin
    Exec(ExpandConstant('{cmd}'), '/C taskkill /PID ' + IntToStr(Pid) + ' /T /F',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1200);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  // Only a verified node.exe process from this installation is stopped, so an
  // unrelated program that reused a stale PID is never touched.
  StopRunningServer();
  Result := '';
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  // Per-user installs need a writable profile folder. Windows 11 with a
  // redirected or locked profile otherwise fails later with a vague error.
  if not DirExists(ExpandConstant('{localappdata}')) then
  begin
    MsgBox('Nexuzy PMS could not find your Windows user profile folder.' + #13#10 +
           'Sign in to Windows with a normal user account and run the setup again.',
           mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Answer: Integer;
begin
  // Close the running PMS before removing files, otherwise node.exe and the
  // SQLite WAL handles keep the installation locked.
  if CurUninstallStep = usUninstall then
  begin
    StopRunningServer();
    // Program files are always removed. Hotel data is deliberately kept by
    // default so a reinstall/upgrade never destroys bookings or invoices.
    Answer := MsgBox('Also delete the hotel database, uploaded logos and backups?' + #13#10 +
                     'Choose No to keep the data for a future reinstall.',
                     mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
    if Answer = IDYES then
      DelTree(ExpandConstant('{app}\data'), True, True, True);
  end;
end;
