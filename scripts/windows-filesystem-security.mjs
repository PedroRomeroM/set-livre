import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";

const windowsSecurityInspectionTimeoutMilliseconds = 30_000;

const windowsSecurityScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Read-Request {
  $source = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($source)) {
    throw 'invalid request'
  }
  return $source | ConvertFrom-Json
}

function Get-PathChain([string] $Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrEmpty($root) -or -not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'invalid path'
  }

  $chain = New-Object 'System.Collections.Generic.List[string]'
  $chain.Add($root)
  $current = $root
  $relativePath = $fullPath.Substring($root.Length)
  foreach ($component in $relativePath.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [System.IO.Path]::Combine($current, $component)
    $chain.Add($current)
  }
  return $chain.ToArray()
}

function Get-SafeAttributes([string] $Path) {
  try {
    return [System.IO.File]::GetAttributes($Path)
  } catch [System.IO.FileNotFoundException] {
    return $null
  } catch [System.IO.DirectoryNotFoundException] {
    return $null
  }
}

function Assert-PathWithoutReparse(
  [string] $Path,
  [bool] $AllowMissingLeaf,
  [string] $LeafKind,
  [bool] $Recursive
) {
  $chain = @(Get-PathChain $Path)
  for ($index = 0; $index -lt $chain.Count; $index += 1) {
    $candidate = $chain[$index]
    $isLeaf = $index -eq ($chain.Count - 1)
    $attributes = Get-SafeAttributes $candidate
    if ($null -eq $attributes) {
      if ($isLeaf -and $AllowMissingLeaf) {
        return
      }
      throw 'path missing'
    }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'reparse point'
    }
    if (-not $isLeaf -and ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
      throw 'ancestor is not a directory'
    }
  }

  $leafAttributes = Get-SafeAttributes $Path
  if ($null -eq $leafAttributes) {
    if ($AllowMissingLeaf) {
      return
    }
    throw 'path missing'
  }
  $leafIsDirectory = ($leafAttributes -band [System.IO.FileAttributes]::Directory) -ne 0
  if (($LeafKind -eq 'file' -and $leafIsDirectory) -or ($LeafKind -eq 'directory' -and -not $leafIsDirectory)) {
    throw 'unexpected leaf kind'
  }

  if (-not $Recursive) {
    return
  }
  if (-not $leafIsDirectory) {
    if ($LeafKind -eq 'any') {
      return
    }
    throw 'recursive path is not a directory'
  }

  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $directoryPath = $pending.Pop()
    $before = Get-SafeAttributes $directoryPath
    if ($null -eq $before -or ($before -band [System.IO.FileAttributes]::Directory) -eq 0 -or ($before -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'unsafe directory'
    }

    $directory = New-Object System.IO.DirectoryInfo($directoryPath)
    foreach ($child in $directory.EnumerateFileSystemInfos()) {
      $child.Refresh()
      if (-not $child.Exists) {
        throw 'unsafe child'
      }
      if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'unsafe child'
      }
      if (($child.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
        $pending.Push($child.FullName)
      }
    }

    $after = Get-SafeAttributes $directoryPath
    if ($null -eq $after -or ($after -band [System.IO.FileAttributes]::Directory) -eq 0 -or ($after -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'directory changed'
    }
  }
}

function Get-CurrentUserSid {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User) {
    throw 'current user has no SID'
  }
  return $identity.User
}

function Get-TrustedDirectoryChain([string] $TrustedRoot, [string] $Path) {
  if ([string]::IsNullOrWhiteSpace($TrustedRoot)) {
    return @()
  }

  $rootPath = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd([char[]]@('\', '/'))
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $parentPath = [System.IO.Path]::GetDirectoryName($fullPath)
  if ([string]::IsNullOrWhiteSpace($rootPath) -or [string]::IsNullOrWhiteSpace($parentPath)) {
    throw 'invalid trusted root'
  }

  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (
    -not $parentPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $parentPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'path escapes trusted root'
  }

  $chain = New-Object 'System.Collections.Generic.List[string]'
  $chain.Add($rootPath)
  if ($parentPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $chain.ToArray()
  }

  $current = $rootPath
  $relativePath = $parentPath.Substring($prefix.Length)
  foreach ($component in $relativePath.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [System.IO.Path]::Combine($current, $component)
    $chain.Add($current)
  }
  return $chain.ToArray()
}

function Assert-TrustedDirectoryAcl([string] $Path, [bool] $RequireProtectedDacl) {
  $currentUser = Get-CurrentUserSid
  $trustedOwners = @{}
  foreach ($sid in @(
    $currentUser.Value,
    'S-1-5-18',
    'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  )) {
    $trustedOwners[$sid] = $true
  }
  $trustedWriters = @{}
  foreach ($sid in $trustedOwners.Keys) {
    $trustedWriters[$sid] = $true
  }
  $trustedWriters['S-1-3-0'] = $true
  $trustedWriters['S-1-3-4'] = $true

  $attributesBefore = Get-SafeAttributes $Path
  if (
    $null -eq $attributesBefore -or
    ($attributesBefore -band [System.IO.FileAttributes]::Directory) -eq 0 -or
    ($attributesBefore -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw 'unsafe trusted directory'
  }

  $directory = New-Object System.IO.DirectoryInfo($Path)
  $security = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or -not $trustedOwners.ContainsKey($owner.Value)) {
    throw 'untrusted directory owner'
  }
  if ($RequireProtectedDacl -and -not $security.AreAccessRulesProtected) {
    throw 'trusted root DACL is not protected'
  }

  $dangerousRights = [int64](
    [System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $rules = $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if (
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      ([int64]$rule.FileSystemRights -band $dangerousRights) -ne 0 -and
      -not $trustedWriters.ContainsKey($rule.IdentityReference.Value)
    ) {
      throw 'untrusted directory writer'
    }
  }

  $attributesAfter = Get-SafeAttributes $Path
  if (
    $null -eq $attributesAfter -or
    ($attributesAfter -band [System.IO.FileAttributes]::Directory) -eq 0 -or
    ($attributesAfter -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw 'trusted directory changed'
  }
}

function Assert-TrustedDirectoryChain([string] $TrustedRoot, [string] $Path) {
  $chain = @(Get-TrustedDirectoryChain $TrustedRoot $Path)
  for ($index = 0; $index -lt $chain.Count; $index += 1) {
    Assert-TrustedDirectoryAcl ([string]$chain[$index]) ($index -eq 0)
  }
}

function Assert-PrivateFileAcl([string] $Path, [bool] $AllowMissing, [string] $TrustedRoot) {
  Assert-PathWithoutReparse $Path $AllowMissing 'file' $false
  Assert-TrustedDirectoryChain $TrustedRoot $Path
  if ($null -eq (Get-SafeAttributes $Path) -and $AllowMissing) {
    Assert-TrustedDirectoryChain $TrustedRoot $Path
    return
  }
  $currentUser = Get-CurrentUserSid
  $allowedSids = @(
    $currentUser.Value,
    'S-1-5-18',
    'S-1-5-32-544'
  )
  $allowedSidSet = @{}
  foreach ($sid in $allowedSids) {
    $allowedSidSet[$sid] = $true
  }

  $file = New-Object System.IO.FileInfo($Path)
  $security = $file.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or $owner.Value -ne $currentUser.Value -or -not $security.AreAccessRulesProtected) {
    throw 'unsafe owner or inherited DACL'
  }

  $seen = @{}
  $fullControl = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
  $rules = $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    $rights = [int64]$rule.FileSystemRights
    if (
      -not $allowedSidSet.ContainsKey($sid) -or
      $rule.IsInherited -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
      ($rights -band $fullControl) -ne $fullControl
    ) {
      throw 'unsafe DACL rule'
    }
    $seen[$sid] = $true
  }
  foreach ($sid in $allowedSids) {
    if (-not $seen.ContainsKey($sid)) {
      throw 'missing private DACL rule'
    }
  }
  Assert-PathWithoutReparse $Path $false 'file' $false
  Assert-TrustedDirectoryChain $TrustedRoot $Path
}

function Protect-PrivateFile([string] $Path, [string] $TrustedRoot) {
  Assert-PathWithoutReparse $Path $false 'file' $false
  Assert-TrustedDirectoryChain $TrustedRoot $Path
  $currentUser = Get-CurrentUserSid
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetOwner($currentUser)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sidValue in @($currentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  $file = New-Object System.IO.FileInfo($Path)
  $file.SetAccessControl($security)
  Assert-PrivateFileAcl $Path $false $TrustedRoot
}

$request = Read-Request
$path = [string]$request.path
switch ([string]$request.action) {
  'assert-path' {
    Assert-PathWithoutReparse $path ([bool]$request.allowMissingLeaf) ([string]$request.leafKind) ([bool]$request.recursive)
  }
  'assert-private-file' {
    Assert-PrivateFileAcl $path ([bool]$request.allowMissingLeaf) ([string]$request.trustedRoot)
  }
  'protect-private-file' {
    Protect-PrivateFile $path ([string]$request.trustedRoot)
  }
  default {
    throw 'invalid action'
  }
}
[Console]::Out.Write('ok')
`;

function assertWindowsLocalAbsolutePath(path, description) {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !/^[A-Za-z]:[\\/]/u.test(path)
  ) {
    throw new Error(`${description} precisa usar um caminho local absoluto canônico no Windows.`);
  }
}

function resolveWindowsPowerShell(systemRoot) {
  if (
    typeof systemRoot !== "string" ||
    systemRoot === "" ||
    systemRoot.includes("\0") ||
    !win32.isAbsolute(systemRoot) ||
    win32.resolve(systemRoot) !== systemRoot
  ) {
    throw new Error("SystemRoot não identifica uma instalação Windows local confiável.");
  }

  const executable = win32.resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const information = lstatSync(executable, { throwIfNoEntry: false });
  if (information === undefined || !information.isFile() || information.isSymbolicLink()) {
    throw new Error("O Windows PowerShell do sistema não é um executável físico regular.");
  }
  return executable;
}

export function runWindowsFilesystemSecurityCommand(
  request,
  {
    execute = spawnSync,
    resolvePowerShell = resolveWindowsPowerShell,
    systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
  } = {},
) {
  const executable = resolvePowerShell(systemRoot);
  const encodedCommand = Buffer.from(windowsSecurityScript, "utf16le").toString("base64");
  const result = execute(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
      input: JSON.stringify(request),
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: windowsSecurityInspectionTimeoutMilliseconds,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.stdout !== "ok") {
    throw new Error("A inspeção nativa de segurança do Windows falhou.", {
      cause: result.error,
    });
  }
}

export function assertWindowsPathWithoutReparse(
  path,
  {
    allowMissingLeaf = false,
    description = "O caminho",
    leafKind = "any",
    recursive = false,
    runCommand = runWindowsFilesystemSecurityCommand,
  } = {},
) {
  assertWindowsLocalAbsolutePath(path, description);
  if (!new Set(["any", "directory", "file"]).has(leafKind)) {
    throw new Error(`${description} possui um tipo de alvo inválido.`);
  }
  try {
    runCommand({
      action: "assert-path",
      allowMissingLeaf,
      leafKind,
      path,
      recursive,
    });
  } catch (error) {
    throw new Error(`${description} não pode conter nem atravessar reparse points no Windows.`, {
      cause: error,
    });
  }
}

export function assertWindowsPrivateFile(
  path,
  {
    allowMissing = false,
    description = "O arquivo privado",
    runCommand = runWindowsFilesystemSecurityCommand,
    trustedRoot,
  } = {},
) {
  assertWindowsLocalAbsolutePath(path, description);
  if (trustedRoot !== undefined) {
    assertWindowsLocalAbsolutePath(trustedRoot, "A raiz confiável");
  }
  try {
    runCommand({
      action: "assert-private-file",
      allowMissingLeaf: allowMissing,
      path,
      trustedRoot: trustedRoot ?? "",
    });
  } catch (error) {
    throw new Error(
      `${description} precisa usar ancestrais Windows confiáveis e uma DACL protegida somente para usuário, SYSTEM e Administrators.`,
      { cause: error },
    );
  }
}

export function protectWindowsPrivateFile(
  path,
  {
    description = "O arquivo privado",
    runCommand = runWindowsFilesystemSecurityCommand,
    trustedRoot,
  } = {},
) {
  assertWindowsLocalAbsolutePath(path, description);
  if (trustedRoot !== undefined) {
    assertWindowsLocalAbsolutePath(trustedRoot, "A raiz confiável");
  }
  try {
    runCommand({
      action: "protect-private-file",
      path,
      trustedRoot: trustedRoot ?? "",
    });
  } catch (error) {
    throw new Error(`${description} não pôde receber a DACL privada obrigatória do Windows.`, {
      cause: error,
    });
  }
}
