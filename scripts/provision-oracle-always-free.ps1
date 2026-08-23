#requires -Version 7.0

[CmdletBinding(DefaultParameterSetName = "Plan")]
param(
  [Parameter(Mandatory = $true, ParameterSetName = "Plan")]
  [switch]$Plan,

  [Parameter(Mandatory = $true, ParameterSetName = "Apply")]
  [switch]$Apply,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$AdministrativeCidr,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$EvidenceDirectory,

  [Parameter(Mandatory = $true, ParameterSetName = "Apply")]
  [ValidateNotNullOrEmpty()]
  [string]$ConfirmationToken,

  [Parameter(Mandatory = $true, ParameterSetName = "Apply")]
  [ValidatePattern("^[0-9a-f]{64}$")]
  [string]$ApprovedPlanSha256,

  [Parameter(Mandatory = $true, ParameterSetName = "Apply")]
  [ValidateNotNullOrEmpty()]
  [string]$ZeroCostConfirmation,

  [Parameter(DontShow = $true)]
  [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$InformationPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

if (-not $IsWindows) {
  throw "Este provisionador deve ser executado no Windows com PowerShell 7."
}

$script:Contract = [ordered]@{
  schemaVersion = 4
  planSchemaVersion = 3
  stateSchemaVersion = 4
  profile = "SET_LIVRE"
  region = "sa-saopaulo-1"
  compartmentName = "SetLivre"
  ociCliVersion = "3.90.1"
  ociCliSha256 = "69775c7147b42af55e25e357670f3414795b7fc78afb5bc201ba5239664673e8"
  confirmationToken = "SET_LIVRE_ALWAYS_FREE"
  zeroCostConfirmation = "OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED"
  vcnCidr = "10.20.0.0/16"
  subnetCidr = "10.20.1.0/24"
  shape = "VM.Standard.E2.1.Micro"
  architecture = "x86_64"
  # Valor de metadata retornado pela API do shape; não representa CPU dedicada.
  # O contrato Always Free publicado descreve a capacidade como 1/8 OCPU burstable.
  ocpus = 1.0
  memoryInGBs = 1.0
  bootVolumeInGBs = 50
  bootVolumeVpusPerGB = 10
  bootVolumePerformanceClass = "BALANCED"
  alwaysFreeInstanceCeiling = 2.0
  alwaysFreeVolumeCeilingInGBs = 200
  alwaysFreeVcnCeiling = 2.0
  preflightMaximumAgeSeconds = 900
  retryTokenMaximumAgeSeconds = 86400
  mutationJournalMaximumEntries = 128
  planRemoteProbes = [ordered]@{
    "compute-capacity-report" = [ordered]@{
      command = @("compute", "compute-capacity-report", "create")
      persistentMutation = $false
    }
  }
  imagePattern = "^Canonical-Ubuntu-24[.]04-[0-9]{4}[.][0-9]{2}[.][0-9]{2}-[0-9]+$"
  managedBy = "provision-oracle-always-free-v2"
  tagNormalization = [ordered]@{
    transitionContract = "v1-freeform-tags-to-v2"
    sourceManagedBy = "provision-oracle-always-free-v1"
    resourceKinds = @("compartment", "vcn")
  }
  shapeContract = "always-free-e2-micro"
  names = [ordered]@{
    vcn = "set-livre-vcn"
    internetGateway = "set-livre-internet-gateway"
    routeTable = "set-livre-public-route-table"
    securityList = "set-livre-no-ingress-security-list"
    subnet = "set-livre-public-subnet"
    nsg = "set-livre-production-nsg"
    instance = "set-livre-production"
  }
}

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:EvidencePath = $null
$script:EvidenceFile = $null
$script:PlanFile = $null
$script:StateFile = $null
$script:ScratchPath = $null
$script:GlobalMutex = $null
$script:GlobalMutexOwned = $false
$script:GlobalLockStream = $null
$script:OciPath = $null
$script:OciConfigPath = $null
$script:OciMutationPreflight = $null
$script:PrivateState = $null
$script:ApprovedPlan = $null
$script:ApprovedPlanRaw = $null
$script:CurrentPlanSha256 = $null
$script:PlanningPhase = $true
$script:Evidence = [ordered]@{
  schemaVersion = $script:Contract.schemaVersion
  generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  mode = if ($Apply) { "Apply" } else { "Plan" }
  status = "initializing"
  contract = [ordered]@{
    profile = $script:Contract.profile
    region = $script:Contract.region
    compartment = $script:Contract.compartmentName
    shape = $script:Contract.shape
    architecture = $script:Contract.architecture
    ocpus = $script:Contract.ocpus
    memoryInGBs = $script:Contract.memoryInGBs
    bootVolumeInGBs = $script:Contract.bootVolumeInGBs
    bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
    bootVolumePerformanceClass = $script:Contract.bootVolumePerformanceClass
    vcnCidr = $script:Contract.vcnCidr
    subnetCidr = $script:Contract.subnetCidr
    administrativeCidr = $AdministrativeCidr
  }
  facts = [ordered]@{}
  plannedActions = [Collections.Generic.List[string]]::new()
  limitations = [Collections.Generic.List[string]]::new()
  failure = $null
}

function Get-Field {
  param(
    [AllowNull()][object]$InputObject,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $InputObject) {
    return $null
  }

  if ($InputObject -is [Collections.IDictionary]) {
    if ($InputObject.Contains($Name)) {
      return $InputObject[$Name]
    }
    return $null
  }

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Get-OciItems {
  param([AllowNull()][object]$Response)

  $data = Get-Field -InputObject $Response -Name "data"
  if ($null -eq $data) {
    return @()
  }

  return @($data)
}

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$SafeMessage
  )

  if (-not $Condition) {
    throw $SafeMessage
  }
}

function Test-MutationExecutionEnabled {
  return [bool]($Apply -and -not $script:PlanningPhase)
}

function Add-PlannedAction {
  param([Parameter(Mandatory = $true)][string]$Action)

  Assert-True -Condition ($Action -match "^[a-z0-9]+(?:-[a-z0-9]+)*$") -SafeMessage "A ação planejada possui identificador inválido."
  if (-not ($script:Evidence.plannedActions -ccontains $Action)) {
    $script:Evidence.plannedActions.Add($Action)
  }
}

function ConvertTo-CanonicalJson {
  param([Parameter(Mandatory = $true)][object]$Value)

  $normalized = ConvertTo-CanonicalValue -Value $Value
  return ($normalized | ConvertTo-Json -Depth 64 -Compress)
}

function ConvertTo-CanonicalValue {
  param([AllowNull()][object]$Value)

  if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) {
    return $Value
  }
  if ($Value -is [Collections.IDictionary]) {
    $result = [ordered]@{}
    [string[]]$keys = @($Value.Keys | ForEach-Object { [string]$_ })
    [Array]::Sort($keys, [StringComparer]::Ordinal)
    foreach ($key in $keys) {
      $result[$key] = ConvertTo-CanonicalValue -Value $Value[$key]
    }
    return $result
  }
  if ($Value -is [Collections.IEnumerable]) {
    $items = [Collections.Generic.List[object]]::new()
    foreach ($item in $Value) {
      $items.Add((ConvertTo-CanonicalValue -Value $item))
    }
    return , @($items)
  }

  $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") })
  if ($properties.Count -gt 0) {
    $result = [ordered]@{}
    [string[]]$names = @($properties.Name)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    foreach ($name in $names) {
      $result[$name] = ConvertTo-CanonicalValue -Value $Value.PSObject.Properties[$name].Value
    }
    return $result
  }
  throw "O valor não pode ser serializado no formato canônico do Plan."
}

function Get-Sha256HexForText {
  param([Parameter(Mandatory = $true)][string]$Text)

  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  try {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Assert-NoForbiddenTargetName {
  param(
    [AllowNull()][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceLabel
  )

  $displayName = [string](Get-Field -InputObject $Resource -Name "display-name")
  if ($displayName -match "(?i)(SpensesApp|Spenses|piadas)") {
    throw "O recurso candidato de $ResourceLabel pertence a um alvo proibido."
  }
}

function Test-ExactPublicIpv4Cidr32 {
  param([Parameter(Mandatory = $true)][string]$Cidr)

  if ($Cidr -notmatch "^(?<address>[0-9]{1,3}(?:[.][0-9]{1,3}){3})/32$") {
    return $false
  }

  $address = $null
  if (-not [Net.IPAddress]::TryParse($Matches.address, [ref]$address)) {
    return $false
  }
  if ($address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }
  if ($address.ToString() -cne $Matches.address) {
    return $false
  }

  $octets = $address.GetAddressBytes()
  $first = [int]$octets[0]
  $second = [int]$octets[1]
  $isPrivate = $first -eq 10 -or ($first -eq 172 -and $second -ge 16 -and $second -le 31) -or ($first -eq 192 -and $second -eq 168)
  $isSpecial = $first -eq 0 -or $first -eq 127 -or $first -ge 224 -or ($first -eq 169 -and $second -eq 254) -or ($first -eq 100 -and $second -ge 64 -and $second -le 127)
  return -not ($isPrivate -or $isSpecial)
}

function Assert-NoReparsePointInExistingPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "O caminho privado de evidência não pode atravessar reparse points."
      }
    }

    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) {
      break
    }
    $cursor = $parent.FullName
  }
}

function Set-PrivateDirectoryAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $currentIdentity.User
  Assert-True -Condition ($null -ne $currentSid) -SafeMessage "Não foi possível resolver o SID do usuário atual."

  $allowedSids = @(
    $currentSid,
    [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
    [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  )
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in $allowedSids) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.IdentityReference]$sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]$inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security

  $effective = Get-Acl -LiteralPath $Path
  Assert-True -Condition $effective.AreAccessRulesProtected -SafeMessage "A DACL do diretório privado ainda permite herança."
  $rules = @($effective.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  Assert-True -Condition ($rules.Count -eq 3) -SafeMessage "A DACL do diretório privado contém identidades inesperadas."
  $expected = @($allowedSids | ForEach-Object { $_.Value } | Sort-Object)
  $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
  Assert-True -Condition (($actual -join "|") -ceq ($expected -join "|")) -SafeMessage "A DACL do diretório privado diverge do contrato."
  foreach ($rule in $rules) {
    Assert-True -Condition ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) -SafeMessage "A DACL do diretório privado contém regra não permitida."
    Assert-True -Condition (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) -SafeMessage "A DACL do diretório privado não concede o contrato esperado."
  }
}

function Set-PrivateFileAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $currentIdentity.User
  $allowedSids = @(
    $currentSid,
    [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
    [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  )
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowedSids) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.IdentityReference]$sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security

  $effective = Get-Acl -LiteralPath $Path
  Assert-True -Condition $effective.AreAccessRulesProtected -SafeMessage "A DACL do arquivo privado ainda permite herança."
  $rules = @($effective.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  Assert-True -Condition ($rules.Count -eq 3) -SafeMessage "A DACL do arquivo privado contém identidades inesperadas."
  $expected = @($allowedSids | ForEach-Object { $_.Value } | Sort-Object)
  $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
  Assert-True -Condition (($actual -join "|") -ceq ($expected -join "|")) -SafeMessage "A DACL do arquivo privado diverge do contrato."
}

function Assert-PrivateFileAclContract {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  Assert-True -Condition (Test-Path -LiteralPath $Path -PathType Leaf) -SafeMessage "$SafeLabel não existe como arquivo físico."
  Assert-NoReparsePointInExistingPath -Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  Assert-True -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "$SafeLabel não pode ser link ou reparse point."

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  Assert-True -Condition ($null -ne $currentSid) -SafeMessage "Não foi possível resolver o SID do usuário atual."
  $expected = @(
    $currentSid.Value,
    "S-1-5-18",
    "S-1-5-32-544"
  ) | Sort-Object
  $effective = Get-Acl -LiteralPath $Path
  Assert-True -Condition ($effective.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $currentSid.Value) -SafeMessage "$SafeLabel possui owner inesperado."
  Assert-True -Condition $effective.AreAccessRulesProtected -SafeMessage "$SafeLabel ainda permite herança de ACL."
  $rules = @($effective.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  Assert-True -Condition ($rules.Count -eq 3) -SafeMessage "$SafeLabel contém identidades de ACL inesperadas."
  $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
  Assert-True -Condition (($actual -join "|") -ceq ($expected -join "|")) -SafeMessage "$SafeLabel contém identidades de ACL inesperadas."
  foreach ($rule in $rules) {
    Assert-True -Condition ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) -SafeMessage "$SafeLabel contém uma ACL de negação inesperada."
    Assert-True -Condition (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) -SafeMessage "$SafeLabel não está restrito ao contrato de controle total esperado."
  }
}

function Assert-PrivateDirectoryAclContract {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  Assert-True -Condition (Test-Path -LiteralPath $Path -PathType Container) -SafeMessage "$SafeLabel não existe como diretório físico."
  Assert-NoReparsePointInExistingPath -Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  Assert-True -Condition ($item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "$SafeLabel não pode ser link ou reparse point."
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  Assert-True -Condition ($null -ne $currentSid) -SafeMessage "Não foi possível resolver o SID do usuário atual."
  $expected = @($currentSid.Value, "S-1-5-18", "S-1-5-32-544") | Sort-Object
  $effective = Get-Acl -LiteralPath $Path
  Assert-True -Condition $effective.AreAccessRulesProtected -SafeMessage "$SafeLabel ainda permite herança de ACL."
  Assert-True -Condition ($effective.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $currentSid.Value) -SafeMessage "$SafeLabel possui owner inesperado."
  $rules = @($effective.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
  Assert-True -Condition ($rules.Count -eq 3 -and ($actual -join "|") -ceq ($expected -join "|")) -SafeMessage "$SafeLabel contém identidades de ACL inesperadas."
  foreach ($rule in $rules) {
    Assert-True -Condition ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) -SafeMessage "$SafeLabel contém uma ACL de negação inesperada."
    Assert-True -Condition (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) -SafeMessage "$SafeLabel não está restrito ao contrato de controle total esperado."
  }
}

function Assert-PrivatePathAncestorAclContract {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedRoot = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $parent = [IO.Directory]::GetParent($resolvedPath)
  Assert-True -Condition ($null -ne $parent) -SafeMessage "$SafeLabel não possui diretório pai inequívoco."
  $resolvedParent = $parent.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  Assert-True -Condition (
    $resolvedParent.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedParent.StartsWith(($resolvedRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
  ) -SafeMessage "$SafeLabel saiu do diretório privado autorizado."

  $cursor = $resolvedParent
  while ($true) {
    Assert-PrivateDirectoryAclContract -Path $cursor -SafeLabel "$SafeLabel ancestral"
    if ($cursor.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $next = [IO.Directory]::GetParent($cursor)
    Assert-True -Condition ($null -ne $next) -SafeMessage "$SafeLabel não alcançou o diretório privado autorizado."
    $cursor = $next.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    Assert-True -Condition (
      $cursor.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $cursor.StartsWith(($resolvedRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
    ) -SafeMessage "$SafeLabel atravessou um ancestral fora do diretório privado autorizado."
  }
}

function Assert-NoUntrustedFileWriters {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SafeLabel,
    [switch]$AllowCurrentUser
  )

  Assert-True -Condition (Test-Path -LiteralPath $Path -PathType Leaf) -SafeMessage "$SafeLabel não existe como arquivo físico."
  Assert-NoReparsePointInExistingPath -Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  Assert-True -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "$SafeLabel não pode ser link ou reparse point."

  $trustedInstallerSid = [Security.Principal.NTAccount]::new("NT SERVICE", "TrustedInstaller").Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
  $allowedWriters = [Collections.Generic.List[string]]::new()
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544", $trustedInstallerSid)) {
    $allowedWriters.Add($sid)
  }
  if ($AllowCurrentUser) {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    Assert-True -Condition ($null -ne $currentSid) -SafeMessage "Não foi possível resolver o SID do usuário atual."
    $allowedWriters.Add($currentSid.Value)
  }

  $writeMask = [uint32]::Parse("500D0156", [Globalization.NumberStyles]::HexNumber)
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  Assert-True -Condition ($allowedWriters -ccontains $owner) -SafeMessage "$SafeLabel possui owner não confiável."
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    if (
      $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
    ) {
      $accessMask = [uint32]([int64]$rule.FileSystemRights -band 0xFFFFFFFFL)
      if (($accessMask -band $writeMask) -ne 0) {
        Assert-True -Condition ($allowedWriters -ccontains $rule.IdentityReference.Value) -SafeMessage "$SafeLabel permite escrita por identidade não confiável."
      }
    }
  }
}

function Initialize-IsolatedProcessEnvironment {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.ProcessStartInfo]$StartInfo,
    [Parameter(Mandatory = $true)][string[]]$ExecutableDirectories
  )

  $systemDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($systemDirectory)) -SafeMessage "O diretório System32 não pôde ser resolvido."
  $windowsDirectory = [IO.Directory]::GetParent($systemDirectory).FullName
  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  $programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  $temporaryDirectory = [IO.Path]::GetFullPath((Join-Path $localAppData "Temp"))
  $homeDrive = [IO.Path]::GetPathRoot($userProfile).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $homePath = $userProfile.Substring([IO.Path]::GetPathRoot($userProfile).Length - 1)
  Assert-True -Condition (Test-Path -LiteralPath $temporaryDirectory -PathType Container) -SafeMessage "O diretório temporário privado do usuário não existe."

  $StartInfo.Environment.Clear()
  $StartInfo.Environment["Path"] = @(
    $ExecutableDirectories,
    $systemDirectory,
    $windowsDirectory,
    (Join-Path $systemDirectory "WindowsPowerShell\v1.0")
  ) | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique | Join-String -Separator ([IO.Path]::PathSeparator)
  $StartInfo.Environment["SystemRoot"] = $windowsDirectory
  $StartInfo.Environment["WINDIR"] = $windowsDirectory
  $StartInfo.Environment["COMSPEC"] = Join-Path $systemDirectory "cmd.exe"
  $StartInfo.Environment["USERPROFILE"] = $userProfile
  $StartInfo.Environment["HOMEDRIVE"] = $homeDrive
  $StartInfo.Environment["HOMEPATH"] = $homePath
  $StartInfo.Environment["LOCALAPPDATA"] = $localAppData
  $StartInfo.Environment["APPDATA"] = $roamingAppData
  $StartInfo.Environment["PROGRAMDATA"] = $programData
  $StartInfo.Environment["TEMP"] = $temporaryDirectory
  $StartInfo.Environment["TMP"] = $temporaryDirectory
}

function Initialize-OciProcessEnvironment {
  param([Parameter(Mandatory = $true)][Diagnostics.ProcessStartInfo]$StartInfo)

  Initialize-IsolatedProcessEnvironment -StartInfo $StartInfo -ExecutableDirectories @((Split-Path -Parent $script:OciPath))
  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  Assert-True -Condition (
    -not [string]::IsNullOrWhiteSpace($userProfile) -and
    -not [string]::IsNullOrWhiteSpace($programFiles) -and
    -not [string]::IsNullOrWhiteSpace($windowsDirectory)
  ) -SafeMessage "As raízes nativas do Windows PowerShell não puderam ser resolvidas."
  $nativeModuleRoots = @(
    (Join-Path $userProfile "Documents\WindowsPowerShell\Modules"),
    (Join-Path $programFiles "WindowsPowerShell\Modules"),
    (Join-Path $windowsDirectory "System32\WindowsPowerShell\v1.0\Modules")
  ) | ForEach-Object { [IO.Path]::GetFullPath($_) }
  $securityModule = Join-Path $nativeModuleRoots[2] "Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
  Assert-True -Condition (Test-Path -LiteralPath $securityModule -PathType Leaf) -SafeMessage "O módulo nativo Microsoft.PowerShell.Security não existe no Windows PowerShell físico."
  $StartInfo.Environment["PSModulePath"] = ($nativeModuleRoots | Join-String -Separator ([IO.Path]::PathSeparator))
  $StartInfo.Environment["OCI_CLI_RETRY_ENABLED"] = "false"
  $unexpectedOciVariables = @($StartInfo.Environment.Keys | Where-Object {
      $_ -match "^(?i:OCI(?:_CLI)?_)" -and $_ -cne "OCI_CLI_RETRY_ENABLED"
    })
  Assert-True -Condition ($unexpectedOciVariables.Count -eq 0) -SafeMessage "O ambiente isolado da OCI CLI contém variável OCI inesperada."
}

function Resolve-TrustedSshKeygen {
  $windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($windowsDirectory)) -SafeMessage "O diretório Windows não pôde ser resolvido."
  $expected = [IO.Path]::GetFullPath((Join-Path $windowsDirectory "System32\OpenSSH\ssh-keygen.exe"))
  Assert-NoUntrustedFileWriters -Path $expected -SafeLabel "O ssh-keygen do Windows"
  $signature = Get-AuthenticodeSignature -LiteralPath $expected
  Assert-True -Condition (
    $signature.Status -eq [Management.Automation.SignatureStatus]::Valid -and
    $null -ne $signature.SignerCertificate -and
    $signature.SignerCertificate.Subject -ceq "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
  ) -SafeMessage "O ssh-keygen do Windows não possui assinatura Microsoft válida."
  return $expected
}

function Get-PublicKeyFromPrivateKey {
  param(
    [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)][string]$SshKeygenPath
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $SshKeygenPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  Initialize-IsolatedProcessEnvironment -StartInfo $startInfo -ExecutableDirectories @((Split-Path -Parent $SshKeygenPath))
  foreach ($argument in @("-y", "-f", $PrivateKeyPath)) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    Assert-True -Condition $process.Start() -SafeMessage "O ssh-keygen não pôde validar o par SSH."
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill($true)
      $process.WaitForExit()
      [void]$stdoutTask.GetAwaiter().GetResult()
      [void]$stderrTask.GetAwaiter().GetResult()
      throw "O ssh-keygen excedeu o timeout ao validar o par SSH."
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
    [void]$stderrTask.GetAwaiter().GetResult()
    Assert-True -Condition ($process.ExitCode -eq 0) -SafeMessage "A chave privada SSH não pôde derivar uma chave pública."
    Assert-True -Condition ($stdout -notmatch "[\r\n]") -SafeMessage "A chave privada derivou mais de uma linha pública."
    $fields = $stdout -split "\s+"
    Assert-True -Condition ($fields.Count -ge 2 -and $fields[0] -ceq "ssh-ed25519" -and $fields[1] -match "^[A-Za-z0-9+/]+={0,2}$") -SafeMessage "A chave privada não é uma chave Ed25519 válida."
    return ($fields[0] + " " + $fields[1])
  } finally {
    $process.Dispose()
  }
}

function Resolve-TrustedOciCli {
  $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($programFilesX86)) -SafeMessage "Program Files x86 não pôde ser resolvido pelo Windows."
  $trustedRoot = [IO.Path]::GetFullPath($programFilesX86).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $expected = [IO.Path]::GetFullPath((Join-Path $trustedRoot "Oracle\oci_cli\oci.exe"))
  Assert-True -Condition (Test-Path -LiteralPath $expected -PathType Leaf) -SafeMessage "A OCI CLI oficial não existe no caminho protegido esperado."
  Assert-NoReparsePointInExistingPath -Path $expected

  $allowedWriterSids = @(
    [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
    [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"),
    [Security.Principal.NTAccount]::new("NT SERVICE", "TrustedInstaller").Translate(
      [Security.Principal.SecurityIdentifier]
    )
  )
  $allowedWriterValues = @($allowedWriterSids | ForEach-Object { $_.Value })
  $writeMask = [uint32]::Parse("500D0156", [Globalization.NumberStyles]::HexNumber)
  $cursor = $expected
  while ($true) {
    $acl = Get-Acl -LiteralPath $cursor
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Assert-True -Condition ($allowedWriterValues -ccontains $owner) -SafeMessage "A OCI CLI ou um ancestral possui owner não confiável."
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
      if (
        $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
      ) {
        $accessMask = [uint32]([int64]$rule.FileSystemRights -band 0xFFFFFFFFL)
        if (($accessMask -band $writeMask) -ne 0) {
          Assert-True -Condition ($allowedWriterValues -ccontains $rule.IdentityReference.Value) -SafeMessage "A OCI CLI ou um ancestral permite escrita por identidade não confiável."
        }
      }
    }

    if ([string]::Equals($cursor, $trustedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $parent = [IO.Directory]::GetParent($cursor)
    Assert-True -Condition ($null -ne $parent) -SafeMessage "A OCI CLI saiu do ancestral protegido esperado."
    $cursor = $parent.FullName
    Assert-True -Condition (
      [string]::Equals($cursor, $trustedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $cursor.StartsWith(($trustedRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
    ) -SafeMessage "A OCI CLI saiu do ancestral protegido esperado."
  }

  $item = Get-Item -LiteralPath $expected -Force
  Assert-True -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "A OCI CLI não pode ser link ou reparse point."
  Assert-True -Condition ($item.VersionInfo.FileVersion -ceq ($script:Contract.ociCliVersion + ".0")) -SafeMessage "A versão física da OCI CLI diverge do contrato."
  $hash = (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True -Condition ($hash -ceq $script:Contract.ociCliSha256) -SafeMessage "A OCI CLI diverge do hash fixado."
  return $expected
}

function Resolve-PrivateOciProfileFile {
  param(
    [Parameter(Mandatory = $true)][string]$ConfiguredPath,
    [Parameter(Mandatory = $true)][string]$UserProfile,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  $resolvedInput = $ConfiguredPath.Trim()
  Assert-True -Condition ($resolvedInput -notmatch "%[^%]+%") -SafeMessage "$SafeLabel não pode depender de expansão de variável de ambiente."
  if ($resolvedInput.StartsWith("~", [StringComparison]::Ordinal)) {
    $resolvedInput = Join-Path $UserProfile $resolvedInput.Substring(1).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  }
  Assert-True -Condition ([IO.Path]::IsPathFullyQualified($resolvedInput)) -SafeMessage "$SafeLabel deve usar caminho absoluto ou relativo ao home com til."
  $resolved = [IO.Path]::GetFullPath($resolvedInput)
  $ociRoot = [IO.Path]::GetFullPath((Join-Path $UserProfile ".oci")).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  Assert-True -Condition ($resolved.StartsWith(($ociRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) -SafeMessage "$SafeLabel deve permanecer dentro do diretório privado .oci."
  Assert-PrivatePathAncestorAclContract -Path $resolved -TrustedRoot $ociRoot -SafeLabel $SafeLabel
  Assert-PrivateFileAclContract -Path $resolved -SafeLabel $SafeLabel
  return $resolved
}

function Initialize-PrivateEvidenceDirectory {
  Assert-True -Condition ([IO.Path]::IsPathFullyQualified($EvidenceDirectory)) -SafeMessage "EvidenceDirectory deve ser um caminho absoluto fora do repositório."
  $candidate = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $repository = $script:RepositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $prefix = $repository + [IO.Path]::DirectorySeparatorChar
  $insideRepository = $candidate.Equals($repository, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  Assert-True -Condition (-not $insideRepository) -SafeMessage "EvidenceDirectory deve ficar fora do repositório."
  $userProfile = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $exactProtectedRoots = @(
    [IO.Path]::GetPathRoot($candidate).TrimEnd([IO.Path]::DirectorySeparatorChar),
    $userProfile
  )
  $protectedTrees = @(
    [IO.Path]::GetFullPath((Join-Path $userProfile ".oci")).TrimEnd([IO.Path]::DirectorySeparatorChar),
    [IO.Path]::GetFullPath((Join-Path $userProfile ".ssh")).TrimEnd([IO.Path]::DirectorySeparatorChar),
    [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)).TrimEnd([IO.Path]::DirectorySeparatorChar),
    [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)).TrimEnd([IO.Path]::DirectorySeparatorChar),
    [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)).TrimEnd([IO.Path]::DirectorySeparatorChar)
  )
  $isExactProtectedRoot = @($exactProtectedRoots | Where-Object { $candidate.Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
  $isInsideProtectedTree = @($protectedTrees | Where-Object {
      $candidate.Equals($_, [StringComparison]::OrdinalIgnoreCase) -or
      $candidate.StartsWith(($_ + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
  Assert-True -Condition (-not ($isExactProtectedRoot -or $isInsideProtectedTree)) -SafeMessage "EvidenceDirectory aponta para um diretório amplo ou sensível."
  Assert-NoReparsePointInExistingPath -Path $candidate

  $candidateAlreadyExists = Test-Path -LiteralPath $candidate
  if (-not $candidateAlreadyExists) {
    [void](New-Item -ItemType Directory -Path $candidate)
  } else {
    $expectedChildren = @(
      "set-livre-oracle-provisioning.json",
      "set-livre-oracle-plan.json",
      "set-livre-oracle-state.json",
      ".requests"
    )
    $unexpectedChildren = @(Get-ChildItem -LiteralPath $candidate -Force | Where-Object { $_.Name -notin $expectedChildren })
    Assert-True -Condition ($unexpectedChildren.Count -eq 0) -SafeMessage "EvidenceDirectory existente contém itens fora do contrato Set Livre."
  }
  $item = Get-Item -LiteralPath $candidate -Force
  Assert-True -Condition $item.PSIsContainer -SafeMessage "EvidenceDirectory não é um diretório físico."
  Assert-True -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "EvidenceDirectory não pode ser um reparse point."
  if ($candidateAlreadyExists) {
    Assert-PrivateDirectoryAclContract -Path $candidate -SafeLabel "EvidenceDirectory"
  } else {
    Set-PrivateDirectoryAcl -Path $candidate
  }

  $script:EvidencePath = $candidate
  $script:EvidenceFile = Join-Path $candidate "set-livre-oracle-provisioning.json"
  $script:PlanFile = Join-Path $candidate "set-livre-oracle-plan.json"
  $script:StateFile = Join-Path $candidate "set-livre-oracle-state.json"
  $script:ScratchPath = Join-Path $candidate ".requests"
  $scratchAlreadyExists = Test-Path -LiteralPath $script:ScratchPath
  if (-not $scratchAlreadyExists) {
    [void](New-Item -ItemType Directory -Path $script:ScratchPath)
  }
  $scratchItem = Get-Item -LiteralPath $script:ScratchPath -Force
  Assert-True -Condition ($scratchItem.PSIsContainer -and ($scratchItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "O diretório privado de requests não é físico."
  if ($scratchAlreadyExists) {
    Assert-PrivateDirectoryAclContract -Path $script:ScratchPath -SafeLabel "O diretório privado de requests"
  } else {
    Set-PrivateDirectoryAcl -Path $script:ScratchPath
  }
  if (Test-Path -LiteralPath $script:EvidenceFile) {
    $evidenceItem = Get-Item -LiteralPath $script:EvidenceFile -Force
    Assert-True -Condition (-not $evidenceItem.PSIsContainer -and ($evidenceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "O arquivo privado de evidência existente não é físico."
  }
}

function Write-PrivateJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 64
  Write-PrivateTextFile -Path $Path -Text ($json + [Environment]::NewLine)
}

function Write-PrivateTextFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
  )

  $parent = Split-Path -Parent $Path
  Assert-True -Condition (Test-Path -LiteralPath $parent -PathType Container) -SafeMessage "O diretório privado de destino não existe."
  $temporary = Join-Path $parent (".write-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
    Set-PrivateFileAcl -Path $temporary
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Assert-PrivateFileAclContract -Path $Path -SafeLabel "O arquivo privado persistido"
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Read-PrivateJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  Assert-PrivateFileAclContract -Path $Path -SafeLabel $SafeLabel
  $item = Get-Item -LiteralPath $Path -Force
  Assert-True -Condition ($item.Length -gt 0 -and $item.Length -le 1048576) -SafeMessage "$SafeLabel possui tamanho inválido."
  $raw = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
  try {
    $value = $raw | ConvertFrom-Json -Depth 64 -AsHashtable
  } catch {
    throw "$SafeLabel não contém JSON válido."
  }
  return [ordered]@{ raw = $raw; value = $value }
}

function Acquire-GlobalProvisioningLock {
  Assert-True -Condition ($null -eq $script:GlobalMutex -and -not $script:GlobalMutexOwned -and $null -eq $script:GlobalLockStream) -SafeMessage "O lock global OCI já está mantido por este processo."
  $mutex = [Threading.Mutex]::new($false, "Global\SetLivre.OracleProvisioning.v1")
  $mutexOwned = $false
  try {
    try {
      $mutexOwned = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $mutexOwned = $true
    }
    Assert-True -Condition $mutexOwned -SafeMessage "Outro processo Set Livre já mantém o mutex global de provisionamento OCI."
    $script:GlobalMutex = $mutex
    $script:GlobalMutexOwned = $true

  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($localAppData)) -SafeMessage "LocalAppData não pôde ser resolvido pelo Windows."
  $lockDirectory = [IO.Path]::GetFullPath((Join-Path $localAppData "SetLivre\OracleProvisioning"))
  Assert-NoReparsePointInExistingPath -Path $lockDirectory
  $lockDirectoryAlreadyExists = Test-Path -LiteralPath $lockDirectory
  if (-not $lockDirectoryAlreadyExists) {
    [void](New-Item -ItemType Directory -Path $lockDirectory)
  }
  $lockDirectoryItem = Get-Item -LiteralPath $lockDirectory -Force
  Assert-True -Condition ($lockDirectoryItem.PSIsContainer -and ($lockDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -SafeMessage "O diretório do lock global não é físico."
  if ($lockDirectoryAlreadyExists) {
    Assert-PrivateDirectoryAclContract -Path $lockDirectory -SafeLabel "O diretório do lock global"
  } else {
    Set-PrivateDirectoryAcl -Path $lockDirectory
  }

  $lockPath = Join-Path $lockDirectory "set-livre-oracle-provisioning.lock"
  if (-not (Test-Path -LiteralPath $lockPath)) {
    [IO.File]::WriteAllText($lockPath, "set-livre-oracle-provisioning" + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Set-PrivateFileAcl -Path $lockPath
  } else {
    Assert-PrivateFileAclContract -Path $lockPath -SafeLabel "O lock global de provisionamento OCI"
  }
  try {
    $script:GlobalLockStream = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw "Outro processo Set Livre já mantém o lock global de provisionamento OCI."
  }
  } catch {
    if ($null -ne $script:GlobalLockStream) {
      $script:GlobalLockStream.Dispose()
      $script:GlobalLockStream = $null
    }
    if ($script:GlobalMutexOwned) {
      $script:GlobalMutex.ReleaseMutex()
      $script:GlobalMutexOwned = $false
    }
    if ($null -ne $script:GlobalMutex) {
      $script:GlobalMutex.Dispose()
      $script:GlobalMutex = $null
    } elseif ($null -ne $mutex) {
      $mutex.Dispose()
    }
    throw
  }
}

function Release-GlobalProvisioningLock {
  if ($null -ne $script:GlobalLockStream) {
    $script:GlobalLockStream.Dispose()
    $script:GlobalLockStream = $null
  }
  if ($script:GlobalMutexOwned) {
    $script:GlobalMutex.ReleaseMutex()
    $script:GlobalMutexOwned = $false
  }
  if ($null -ne $script:GlobalMutex) {
    $script:GlobalMutex.Dispose()
    $script:GlobalMutex = $null
  }
}

function New-PrivateProvisioningState {
  return [ordered]@{
    schemaVersion = $script:Contract.stateSchemaVersion
    project = "set-livre"
    region = $script:Contract.region
    resources = [ordered]@{}
    pendingTagNormalizations = [ordered]@{}
    retryTokens = [ordered]@{}
    mutationJournal = [ordered]@{}
    lastApprovedPlanSha256 = $null
  }
}

function Upgrade-PrivateProvisioningState {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$State)

  $version = [int]$State.schemaVersion
  if ($version -eq $script:Contract.stateSchemaVersion) {
    return $false
  }
  Assert-True -Condition ($version -in @(1, 2, 3) -and $script:Contract.stateSchemaVersion -eq 4) -SafeMessage "O schema do estado privado OCI é incompatível."

  if ($version -eq 1) {
    Assert-True -Condition ($State.retryTokens -is [Collections.IDictionary]) -SafeMessage "O estado legado não contém retry tokens válidos."
    foreach ($entry in $State.retryTokens.GetEnumerator()) {
      $record = $entry.Value
      Assert-True -Condition ($record -is [Collections.IDictionary]) -SafeMessage "O estado legado contém um retry token inválido."
      $record.status = "pending"
      $record.originApprovedPlanSha256 = [string]$record.approvedPlanSha256
      $record.createdAtUnixSeconds = 0L
      $record.expiresAtUnixSeconds = 0L
      $record.request = $null
    }
    $State.mutationJournal = [ordered]@{}
    $version = 2
  }

  if ($version -eq 2) {
    Assert-True -Condition ($State.resources -is [Collections.IDictionary] -and $State.retryTokens -is [Collections.IDictionary] -and $State.mutationJournal -is [Collections.IDictionary]) -SafeMessage "O estado privado OCI v2 está incompleto."
    foreach ($obsoleteMutationKey in @("launch-a1-always-free-2x12", "assign-ephemeral-public-ipv4")) {
      if (-not $State.retryTokens.Contains($obsoleteMutationKey)) {
        continue
      }
      $obsolete = $State.retryTokens[$obsoleteMutationKey]
      Assert-True -Condition ($obsolete -is [Collections.IDictionary]) -SafeMessage "Uma mutação A1 legada possui estado inválido."
      $token = [string]$obsolete.token
      Assert-True -Condition ($token -match "^[0-9a-f-]{36}$") -SafeMessage "Uma mutação A1 legada possui token inválido."
      $State.mutationJournal[$token] = [ordered]@{
        token = $token
        mutationKey = $obsoleteMutationKey
        status = "expired"
        requestSha256 = [string]$obsolete.requestSha256
        originApprovedPlanSha256 = [string]$obsolete.originApprovedPlanSha256
        completedAtUnixSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        reason = "human-approved-contract-migration-from-a1-to-e2"
      }
      $State.retryTokens.Remove($obsoleteMutationKey)
    }
    foreach ($obsoleteResourceKind in @("instance", "public-ip")) {
      $State.resources.Remove($obsoleteResourceKind)
    }
    $State.lastApprovedPlanSha256 = $null
    $State.schemaVersion = 3
    $version = 3
  }

  Assert-True -Condition ($version -eq 3) -SafeMessage "O estado privado OCI não pode ser migrado com segurança para o contrato de normalização de tags."
  Assert-True -Condition ($State.resources -is [Collections.IDictionary] -and $State.retryTokens -is [Collections.IDictionary] -and $State.mutationJournal -is [Collections.IDictionary]) -SafeMessage "O estado privado OCI v3 está incompleto."
  Assert-True -Condition (-not $State.Contains("pendingTagNormalizations")) -SafeMessage "O estado privado OCI v3 contém uma fila de normalização ambígua."
  $State.pendingTagNormalizations = [ordered]@{}
  foreach ($resourceKind in @($State.resources.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
    $record = $State.resources[$resourceKind]
    Assert-True -Condition ($record -is [Collections.IDictionary]) -SafeMessage "Um recurso OCI v3 possui registro inválido."
    if ([string]$record.ownershipProof -cne "legacy-v1-tags") {
      continue
    }
    Assert-True -Condition ($script:Contract.tagNormalization.resourceKinds -ccontains $resourceKind) -SafeMessage "Uma prova de tags v1 existe fora da transição única aprovada."
    Assert-True -Condition ([string]$record.kind -ceq $resourceKind) -SafeMessage "Uma prova de tags v1 possui tipo divergente."
    Assert-True -Condition ([string]$record.id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "Uma prova de tags v1 possui OCID inválido."
    $State.pendingTagNormalizations[$resourceKind] = [ordered]@{
      kind = $resourceKind
      id = [string]$record.id
      transitionContract = $script:Contract.tagNormalization.transitionContract
      sourceManagedBy = $script:Contract.tagNormalization.sourceManagedBy
      targetManagedBy = $script:Contract.managedBy
    }
    $State.resources.Remove($resourceKind)
  }
  $State.lastApprovedPlanSha256 = $null
  $State.schemaVersion = $script:Contract.stateSchemaVersion
  return $true
}

function Assert-PrivateProvisioningState {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$State)

  Assert-True -Condition ([int]$State.schemaVersion -eq $script:Contract.stateSchemaVersion) -SafeMessage "O schema do estado privado OCI é incompatível."
  Assert-True -Condition ([string]$State.project -ceq "set-livre") -SafeMessage "O estado privado OCI pertence a outro projeto."
  Assert-True -Condition ([string]$State.region -ceq $script:Contract.region) -SafeMessage "O estado privado OCI pertence a outra região."
  Assert-True -Condition ($State.resources -is [Collections.IDictionary]) -SafeMessage "O mapa privado de recursos OCI é inválido."
  Assert-True -Condition ($State.pendingTagNormalizations -is [Collections.IDictionary]) -SafeMessage "A fila privada de normalização de tags OCI é inválida."
  Assert-True -Condition ($State.retryTokens -is [Collections.IDictionary]) -SafeMessage "O mapa privado de retry tokens OCI é inválido."
  Assert-True -Condition ($State.mutationJournal -is [Collections.IDictionary]) -SafeMessage "O journal privado de mutações OCI é inválido."
  Assert-True -Condition ($State.mutationJournal.Count -le $script:Contract.mutationJournalMaximumEntries) -SafeMessage "O journal privado de mutações OCI excede o limite."
  Assert-True -Condition ($null -eq $State.lastApprovedPlanSha256 -or [string]$State.lastApprovedPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O estado privado contém SHA-256 de Plan inválido."

  foreach ($entry in $State.resources.GetEnumerator()) {
    $record = $entry.Value
    Assert-True -Condition ($record -is [Collections.IDictionary]) -SafeMessage "Um registro privado de recurso OCI é inválido."
    Assert-True -Condition ([string]$record.kind -ceq [string]$entry.Key) -SafeMessage "Um registro privado de recurso OCI possui tipo divergente."
    Assert-True -Condition ([string]$record.id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "Um registro privado de recurso OCI possui OCID inválido."
    Assert-True -Condition ([string]$record.ownershipProof -in @("exact-tags", "created-by-approved-plan")) -SafeMessage "Um registro privado de recurso OCI não possui prova de propriedade aceita."
    if ([string]$record.ownershipProof -ceq "created-by-approved-plan") {
      Assert-True -Condition ([string]$record.approvedPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "Um OCID criado não está vinculado a um Plan aprovado."
    }
  }

  foreach ($entry in $State.pendingTagNormalizations.GetEnumerator()) {
    $resourceKind = [string]$entry.Key
    $record = $entry.Value
    Assert-True -Condition ($record -is [Collections.IDictionary]) -SafeMessage "Uma normalização de tags pendente possui registro inválido."
    Assert-True -Condition ($script:Contract.tagNormalization.resourceKinds -ccontains $resourceKind) -SafeMessage "Uma normalização de tags pendente possui tipo não autorizado."
    Assert-True -Condition ([string]$record.kind -ceq $resourceKind) -SafeMessage "Uma normalização de tags pendente possui tipo divergente."
    Assert-True -Condition ([string]$record.id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "Uma normalização de tags pendente possui OCID inválido."
    Assert-True -Condition ([string]$record.transitionContract -ceq $script:Contract.tagNormalization.transitionContract) -SafeMessage "Uma normalização de tags pendente não usa o contrato aprovado."
    Assert-True -Condition ([string]$record.sourceManagedBy -ceq $script:Contract.tagNormalization.sourceManagedBy) -SafeMessage "Uma normalização de tags pendente possui origem divergente."
    Assert-True -Condition ([string]$record.targetManagedBy -ceq $script:Contract.managedBy) -SafeMessage "Uma normalização de tags pendente possui destino divergente."
    Assert-True -Condition (-not $State.resources.Contains($resourceKind)) -SafeMessage "Um recurso não pode ser simultaneamente aprovado e pendente de normalização."
  }

  foreach ($entry in $State.retryTokens.GetEnumerator()) {
    Assert-True -Condition ([string]$entry.Key -match "^[a-z0-9]+(?:-[a-z0-9]+)*$") -SafeMessage "O estado contém uma chave de retry inválida."
    $retryRecord = $entry.Value
    Assert-True -Condition ($retryRecord -is [Collections.IDictionary]) -SafeMessage "O estado contém um registro de retry inválido."
    $token = [string]$retryRecord.token
    $parsed = [Guid]::Empty
    Assert-True -Condition ([Guid]::TryParseExact($token, "D", [ref]$parsed)) -SafeMessage "O estado contém um retry token inválido."
    Assert-True -Condition ([string]$retryRecord.status -ceq "pending") -SafeMessage "O estado contém um retry token fora do estado pending."
    Assert-True -Condition ([string]$retryRecord.requestSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O estado contém um retry token sem fingerprint do request."
    Assert-True -Condition ([string]$retryRecord.approvedPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O estado contém um retry token sem Plan aprovado."
    Assert-True -Condition ([string]$retryRecord.originApprovedPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O estado contém um retry token sem Plan de origem."
    $createdAt = [long]$retryRecord.createdAtUnixSeconds
    $expiresAt = [long]$retryRecord.expiresAtUnixSeconds
    Assert-True -Condition ($createdAt -ge 0 -and $expiresAt -ge $createdAt) -SafeMessage "O estado contém um retry token com validade inválida."
    Assert-True -Condition ($null -eq $retryRecord.request -or $retryRecord.request -is [Collections.IDictionary]) -SafeMessage "O estado contém um retry token sem envelope de request válido."
  }

  foreach ($entry in $State.mutationJournal.GetEnumerator()) {
    $terminal = $entry.Value
    Assert-True -Condition ($terminal -is [Collections.IDictionary]) -SafeMessage "O journal contém uma mutação terminal inválida."
    $terminalToken = [string]$terminal.token
    $parsed = [Guid]::Empty
    Assert-True -Condition ([Guid]::TryParseExact($terminalToken, "D", [ref]$parsed) -and $terminalToken -ceq [string]$entry.Key) -SafeMessage "O journal contém identidade terminal inválida."
    Assert-True -Condition ([string]$terminal.mutationKey -match "^[a-z0-9]+(?:-[a-z0-9]+)*$") -SafeMessage "O journal contém chave de mutação inválida."
    Assert-True -Condition ([string]$terminal.status -in @("reconciled", "expired")) -SafeMessage "O journal contém estado terminal inválido."
    Assert-True -Condition ([string]$terminal.requestSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O journal contém fingerprint terminal inválido."
    Assert-True -Condition ([string]$terminal.originApprovedPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O journal contém Plan de origem inválido."
    Assert-True -Condition ([long]$terminal.completedAtUnixSeconds -gt 0) -SafeMessage "O journal contém timestamp terminal inválido."
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$terminal.reason)) -SafeMessage "O journal contém terminal sem motivo."
  }
}

function Initialize-PrivateProvisioningState {
  if (Test-Path -LiteralPath $script:StateFile -PathType Leaf) {
    $loaded = Read-PrivateJsonFile -Path $script:StateFile -SafeLabel "O estado privado OCI"
    $script:PrivateState = $loaded.value
    $upgraded = Upgrade-PrivateProvisioningState -State $script:PrivateState
    Assert-PrivateProvisioningState -State $script:PrivateState
    if ($upgraded) {
      Save-PrivateProvisioningState
    }
  } else {
    $script:PrivateState = New-PrivateProvisioningState
    Save-PrivateProvisioningState
  }
}

function Save-PrivateProvisioningState {
  Assert-True -Condition ($null -ne $script:GlobalLockStream) -SafeMessage "O estado privado OCI não pode ser gravado sem o lock global."
  Assert-PrivateProvisioningState -State $script:PrivateState
  Write-PrivateTextFile -Path $script:StateFile -Text (ConvertTo-CanonicalJson -Value $script:PrivateState)
}

function Get-PersistedApprovedOcid {
  param([Parameter(Mandatory = $true)][string]$ResourceKind)

  if ($null -eq $script:PrivateState -or -not $script:PrivateState.resources.Contains($ResourceKind)) {
    return $null
  }
  $record = $script:PrivateState.resources[$ResourceKind]
  Assert-True -Condition ([string]$record.kind -ceq $ResourceKind) -SafeMessage "O OCID persistido possui tipo divergente."
  Assert-True -Condition ([string]$record.id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "O OCID persistido é inválido."
  return [string]$record.id
}

function Get-PendingTagNormalization {
  param([Parameter(Mandatory = $true)][string]$ResourceKind)

  if ($null -eq $script:PrivateState -or -not $script:PrivateState.pendingTagNormalizations.Contains($ResourceKind)) {
    return $null
  }
  $record = $script:PrivateState.pendingTagNormalizations[$ResourceKind]
  Assert-True -Condition ([string]$record.kind -ceq $ResourceKind) -SafeMessage "A normalização de tags pendente possui tipo divergente."
  Assert-True -Condition ([string]$record.id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "A normalização de tags pendente possui OCID inválido."
  return $record
}

function Set-ApprovedResourceState {
  param(
    [Parameter(Mandatory = $true)][string]$ResourceKind,
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][ValidateSet("exact-tags", "created-by-approved-plan")][string]$OwnershipProof
  )

  $id = [string](Get-Field -InputObject $Resource -Name "id")
  Assert-True -Condition ($id -match "^ocid1[.][a-z0-9-]+[.]") -SafeMessage "O recurso $ResourceKind não possui OCID válido."
  $record = [ordered]@{
    kind = $ResourceKind
    id = $id
    ownershipProof = $OwnershipProof
    approvedPlanSha256 = if ($OwnershipProof -ceq "created-by-approved-plan") { $script:CurrentPlanSha256 } else { $null }
  }
  if ($OwnershipProof -ceq "created-by-approved-plan") {
    Assert-True -Condition ([string]$script:CurrentPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "Um recurso criado não pode ser persistido sem Plan aprovado."
  }
  $script:PrivateState.resources[$ResourceKind] = $record
  Save-PrivateProvisioningState
}

function Move-PendingMutationToTerminal {
  param(
    [Parameter(Mandatory = $true)][string]$MutationKey,
    [Parameter(Mandatory = $true)][ValidateSet("reconciled", "expired")][string]$Status,
    [Parameter(Mandatory = $true)][string]$Reason
  )

  if (-not $script:PrivateState.retryTokens.Contains($MutationKey)) {
    return $false
  }
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($Reason)) -SafeMessage "Uma mutação terminal exige motivo seguro."
  $pending = $script:PrivateState.retryTokens[$MutationKey]
  $token = [string]$pending.token
  $script:PrivateState.retryTokens.Remove($MutationKey)
  $script:PrivateState.mutationJournal[$token] = [ordered]@{
    mutationKey = $MutationKey
    token = $token
    requestSha256 = [string]$pending.requestSha256
    originApprovedPlanSha256 = [string]$pending.originApprovedPlanSha256
    finalApprovedPlanSha256 = [string]$pending.approvedPlanSha256
    status = $Status
    reason = $Reason
    completedAtUnixSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  }
  while ($script:PrivateState.mutationJournal.Count -gt $script:Contract.mutationJournalMaximumEntries) {
    $oldest = $script:PrivateState.mutationJournal.GetEnumerator() |
      Sort-Object { [long]$_.Value.completedAtUnixSeconds }, { [string]$_.Key } |
      Select-Object -First 1
    $script:PrivateState.mutationJournal.Remove([string]$oldest.Key)
  }
  Save-PrivateProvisioningState
  return $true
}

function Complete-PendingMutationFromObservedState {
  param(
    [Parameter(Mandatory = $true)][string]$MutationKey,
    [Parameter(Mandatory = $true)][string]$Reason
  )

  if ($null -eq $script:PrivateState) {
    return $false
  }
  return Move-PendingMutationToTerminal -MutationKey $MutationKey -Status "reconciled" -Reason $Reason
}

function Get-OrCreateMutationRetryContext {
  param(
    [Parameter(Mandatory = $true)][string]$MutationKey,
    [Parameter(Mandatory = $true)][string[]]$Command,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Payload,
    [Parameter(Mandatory = $true)][string]$RequestSha256,
    [Parameter(Mandatory = $true)][switch]$RemoteStateObserved,
    [AllowNull()][scriptblock]$PendingRequestCompatibility
  )

  Assert-True -Condition ($MutationKey -match "^[a-z0-9]+(?:-[a-z0-9]+)*$") -SafeMessage "A chave de retry OCI é inválida."
  Assert-True -Condition ($RequestSha256 -match "^[0-9a-f]{64}$") -SafeMessage "O fingerprint do request OCI é inválido."
  Assert-True -Condition ([string]$script:CurrentPlanSha256 -match "^[0-9a-f]{64}$") -SafeMessage "Uma mutação OCI não pode criar retry sem Plan atual."
  Assert-True -Condition $RemoteStateObserved -SafeMessage "Uma mutação OCI não pode gerir retry sem observar primeiro o estado remoto."
  $currentRequest = [ordered]@{ command = @($Command); payload = $Payload }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

  if ($script:PrivateState.retryTokens.Contains($MutationKey)) {
    $existing = $script:PrivateState.retryTokens[$MutationKey]
    if ([long]$existing.expiresAtUnixSeconds -le $now) {
      [void](Move-PendingMutationToTerminal -MutationKey $MutationKey -Status "expired" -Reason "retry-window-expired-after-remote-state-observation")
    } else {
      $selectedRequest = $null
      if ([string]$existing.requestSha256 -ceq $RequestSha256) {
        $selectedRequest = if ($null -ne $existing.request) { $existing.request } else { $currentRequest }
      } elseif ($null -ne $existing.request -and $null -ne $PendingRequestCompatibility) {
        $compatible = [bool](& $PendingRequestCompatibility $existing.request $currentRequest)
        Assert-True -Condition $compatible -SafeMessage "Uma mutação OCI pendente não é compatível com a retomada parcial atual."
        $selectedRequest = $existing.request
      } else {
        throw "Uma mutação OCI pendente não corresponde ao request atual e ainda não expirou."
      }

      $selectedFingerprint = Get-Sha256HexForText -Text (ConvertTo-CanonicalJson -Value $selectedRequest)
      Assert-True -Condition ($selectedFingerprint -ceq [string]$existing.requestSha256) -SafeMessage "O envelope persistido do retry OCI diverge do fingerprint aprovado."
      $existing.request = $selectedRequest
      $existing.approvedPlanSha256 = $script:CurrentPlanSha256
      Save-PrivateProvisioningState
      return [ordered]@{
        token = [string]$existing.token
        request = $selectedRequest
        requestSha256 = [string]$existing.requestSha256
        resumed = $true
      }
    }
  }

  $token = [Guid]::NewGuid().ToString("D")
  $script:PrivateState.retryTokens[$MutationKey] = [ordered]@{
    status = "pending"
    token = $token
    requestSha256 = $RequestSha256
    originApprovedPlanSha256 = $script:CurrentPlanSha256
    approvedPlanSha256 = $script:CurrentPlanSha256
    createdAtUnixSeconds = $now
    expiresAtUnixSeconds = $now + $script:Contract.retryTokenMaximumAgeSeconds
    request = $currentRequest
  }
  Save-PrivateProvisioningState
  return [ordered]@{
    token = $token
    request = $currentRequest
    requestSha256 = $RequestSha256
    resumed = $false
  }
}

function Complete-MutationRetryToken {
  param([Parameter(Mandatory = $true)][string]$MutationKey)

  [void](Move-PendingMutationToTerminal -MutationKey $MutationKey -Status "reconciled" -Reason "post-state-reconciled-by-current-apply")
}

function Write-Evidence {
  $script:Evidence.generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
  $temporary = Join-Path $script:EvidencePath (".evidence-" + [Guid]::NewGuid().ToString("N") + ".json")
  Write-PrivateJsonFile -Path $temporary -Value $script:Evidence
  Move-Item -LiteralPath $temporary -Destination $script:EvidenceFile -Force
  Assert-PrivateFileAclContract -Path $script:EvidenceFile -SafeLabel "O bundle privado de evidência"
  return (Get-FileHash -LiteralPath $script:EvidenceFile -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OciProfileContract {
  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $configPath = Join-Path $userProfile ".oci\config"
  Assert-True -Condition (Test-Path -LiteralPath $configPath -PathType Leaf) -SafeMessage "O arquivo de configuração da OCI CLI não existe."
  $ociRoot = [IO.Path]::GetFullPath((Join-Path $userProfile ".oci"))
  Assert-PrivatePathAncestorAclContract -Path $configPath -TrustedRoot $ociRoot -SafeLabel "O arquivo de configuração da OCI CLI"
  Assert-PrivateFileAclContract -Path $configPath -SafeLabel "O arquivo de configuração da OCI CLI"

  $sections = [Collections.Generic.List[hashtable]]::new()
  $current = $null
  foreach ($line in [IO.File]::ReadAllLines($configPath)) {
    if ($line -match "^\s*\[(?<name>[^]]+)\]\s*$") {
      $current = @{ Name = $Matches.name; Values = @{} }
      $sections.Add($current)
      continue
    }
    if ($null -ne $current -and $line -match "^\s*(?<key>[A-Za-z0-9_]+)\s*=\s*(?<value>.*?)\s*$") {
      if ($current.Values.ContainsKey($Matches.key)) {
        throw "O profile OCI contém uma chave duplicada."
      }
      $current.Values[$Matches.key] = $Matches.value
    }
  }

  $profiles = @($sections | Where-Object { $_.Name -ceq $script:Contract.profile })
  Assert-True -Condition ($profiles.Count -eq 1) -SafeMessage "O profile OCI SET_LIVRE deve existir exatamente uma vez."
  $values = $profiles[0].Values
  Assert-True -Condition ($values.ContainsKey("tenancy")) -SafeMessage "O profile OCI SET_LIVRE não contém tenancy."
  Assert-True -Condition ($values.ContainsKey("fingerprint")) -SafeMessage "O profile OCI SET_LIVRE não contém fingerprint."
  Assert-True -Condition ($values.ContainsKey("key_file")) -SafeMessage "O profile OCI SET_LIVRE não contém key_file."
  Assert-True -Condition ($values.ContainsKey("security_token_file")) -SafeMessage "O profile OCI SET_LIVRE não contém security_token_file."
  Assert-True -Condition ($values.ContainsKey("region")) -SafeMessage "O profile OCI SET_LIVRE não contém region."
  Assert-True -Condition ([string]$values.region -ceq $script:Contract.region) -SafeMessage "O profile OCI SET_LIVRE não aponta para sa-saopaulo-1."
  Assert-True -Condition ([string]$values.tenancy -match "^ocid1[.]tenancy[.]") -SafeMessage "O tenancy do profile OCI não tem formato válido."
  Assert-True -Condition ([string]$values.fingerprint -match "^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$") -SafeMessage "O fingerprint do profile OCI não tem formato válido."
  $keyFile = Resolve-PrivateOciProfileFile -ConfiguredPath ([string]$values.key_file) -UserProfile $userProfile -SafeLabel "A chave da sessão OCI"
  $tokenFile = Resolve-PrivateOciProfileFile -ConfiguredPath ([string]$values.security_token_file) -UserProfile $userProfile -SafeLabel "O token da sessão OCI"
  return [ordered]@{
    configFile = $configPath
    tenancyId = [string]$values.tenancy
    region = [string]$values.region
    keyFile = $keyFile
    tokenFile = $tokenFile
  }
}

function ConvertTo-SafeOciStderr {
  param([AllowEmptyString()][string]$Stderr)

  if ([string]::IsNullOrWhiteSpace($Stderr)) {
    return "(stderr vazio)"
  }
  $safe = $Stderr.Trim()
  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
    $safe = [Regex]::Replace($safe, [Regex]::Escape($userProfile), "%USERPROFILE%", [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  $safe = [Regex]::Replace($safe, "(?i)ocid1[.][a-z0-9._-]+", "[ocid-redacted]")
  $safe = [Regex]::Replace($safe, "(?i)(security[_ -]?token|authorization|password|secret)(\s*[:=]\s*)\S+", '$1$2[redacted]')
  $safe = [Regex]::Replace($safe, "(?i)\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}(?:[.][A-Za-z0-9_-]{8,}){1,2}\b", "[token-redacted]")
  $safe = [Regex]::Replace($safe, "[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "")
  if ($safe.Length -gt 2048) {
    $fullHash = Get-Sha256HexForText -Text $safe
    $safe = $safe.Substring(0, 2048) + "...[stderr-sha256=$fullHash]"
  }
  return $safe
}

function Invoke-OciProcess {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Operation,
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 45,
    [switch]$Json,
    [switch]$AllowEmptyData
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $script:OciPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  Initialize-OciProcessEnvironment -StartInfo $startInfo
  foreach ($argument in $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  foreach ($argument in @(
      "--config-file", $script:OciConfigPath,
      "--profile", $script:Contract.profile,
      "--auth", "security_token",
      "--region", $script:Contract.region,
      "--no-retry",
      "--connection-timeout", "10",
      "--read-timeout", "30"
    )) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  if ($Json) {
    [void]$startInfo.ArgumentList.Add("--output")
    [void]$startInfo.ArgumentList.Add("json")
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    Assert-True -Condition $process.Start() -SafeMessage "A OCI CLI não pôde ser iniciada para $Operation."
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      $process.WaitForExit()
      [void]$stdoutTask.GetAwaiter().GetResult()
      $stderr = $stderrTask.GetAwaiter().GetResult()
      $safeStderr = ConvertTo-SafeOciStderr -Stderr $stderr
      throw "A OCI CLI excedeu o timeout em $Operation; stderr: $safeStderr"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      $safeStderr = ConvertTo-SafeOciStderr -Stderr $stderr
      throw "A OCI CLI falhou em $Operation com código $($process.ExitCode); stderr: $safeStderr"
    }
    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
      $safeStderr = ConvertTo-SafeOciStderr -Stderr $stderr
      Write-Information "A OCI CLI escreveu em stderr durante ${Operation}: $safeStderr"
    }
    if (-not $Json) {
      return $null
    }
    if ([string]::IsNullOrWhiteSpace($stdout)) {
      if ($AllowEmptyData) {
        return [pscustomobject]@{ data = @() }
      }
      throw "A OCI CLI não retornou JSON em $Operation."
    }
    try {
      return ($stdout | ConvertFrom-Json -Depth 100)
    } catch {
      throw "A OCI CLI retornou JSON inválido em $Operation."
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-OciJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Operation,
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 45,
    [switch]$AllowEmptyData
  )
  return Invoke-OciProcess -Arguments $Arguments -Operation $Operation -TimeoutSeconds $TimeoutSeconds -Json -AllowEmptyData:$AllowEmptyData
}

function Invoke-AllowlistedPlanRemoteProbe {
  param(
    [Parameter(Mandatory = $true)][string]$ProbeName,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Operation,
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 45
  )

  Assert-True -Condition $script:PlanningPhase -SafeMessage "Um probe remoto não persistente foi solicitado fora do preflight do Plan."
  Assert-True -Condition ($script:Contract.planRemoteProbes.Contains($ProbeName)) -SafeMessage "O probe remoto não está na allowlist do Plan."
  $contract = $script:Contract.planRemoteProbes[$ProbeName]
  Assert-True -Condition (-not [bool]$contract.persistentMutation) -SafeMessage "O Plan recusou um probe classificado como mutação persistente."
  $expectedCommand = @($contract.command)
  Assert-True -Condition ($Arguments.Count -ge $expectedCommand.Count) -SafeMessage "O comando do probe remoto está incompleto."
  $actualCommand = @($Arguments[0..($expectedCommand.Count - 1)])
  Assert-True -Condition ((ConvertTo-CanonicalJson -Value $actualCommand) -ceq (ConvertTo-CanonicalJson -Value $expectedCommand)) -SafeMessage "O comando do probe remoto diverge da allowlist não persistente."
  Assert-True -Condition ($Arguments -cnotcontains "--from-json" -and $Arguments -cnotcontains "--opc-retry-token") -SafeMessage "O probe remoto do Plan não pode transportar payload de mutação ou retry token."
  return Invoke-OciJson -Arguments $Arguments -Operation $Operation -TimeoutSeconds $TimeoutSeconds
}

function Assert-ApplyIntent {
  Assert-True -Condition $Apply -SafeMessage "A autorização de Apply foi solicitada fora do modo Apply."
  Assert-True -Condition ($ConfirmationToken -ceq $script:Contract.confirmationToken) -SafeMessage "O token literal de confirmação do modo Apply é inválido."
  Assert-True -Condition ($ApprovedPlanSha256 -cmatch "^[0-9a-f]{64}$") -SafeMessage "O SHA-256 aprovado do Plan é inválido."
  Assert-True -Condition ($ZeroCostConfirmation -ceq $script:Contract.zeroCostConfirmation) -SafeMessage "A confirmação humana do estimate/badge zero é inválida."
}

function Read-ApprovedPlanFile {
  Assert-ApplyIntent
  Assert-True -Condition (Test-Path -LiteralPath $script:PlanFile -PathType Leaf) -SafeMessage "O Apply exige o arquivo privado de Plan previamente gerado."
  $loaded = Read-PrivateJsonFile -Path $script:PlanFile -SafeLabel "O Plan privado OCI"
  $raw = $loaded.raw
  $plan = $loaded.value
  $canonical = ConvertTo-CanonicalJson -Value $plan
  Assert-True -Condition ($raw -ceq $canonical) -SafeMessage "O arquivo privado de Plan não está em forma canônica."
  $actualHash = Get-Sha256HexForText -Text $raw
  Assert-True -Condition ($actualHash -ceq $ApprovedPlanSha256) -SafeMessage "O Apply não corresponde ao SHA-256 do Plan privado aprovado."
  Assert-True -Condition ([int]$plan.schemaVersion -eq $script:Contract.planSchemaVersion) -SafeMessage "O schema do Plan privado é incompatível."
  Assert-True -Condition ([string]$plan.status -ceq "awaiting-human-zero-cost-confirmation") -SafeMessage "O Plan privado não está apto para aprovação humana."
  Assert-True -Condition ([string]$plan.project -ceq "set-livre" -and [string]$plan.region -ceq $script:Contract.region) -SafeMessage "O Plan privado pertence a outro alvo."
  Assert-True -Condition ([string]$plan.administrativeCidr -ceq $AdministrativeCidr) -SafeMessage "O CIDR administrativo mudou desde o Plan aprovado."
  $createdAtUnixSeconds = [long]$plan.createdAtUnixSeconds
  $expiresAtUnixSeconds = [long]$plan.expiresAtUnixSeconds
  $nowUnixSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Assert-True -Condition ($createdAtUnixSeconds -le $nowUnixSeconds -and $expiresAtUnixSeconds -gt $nowUnixSeconds -and ($expiresAtUnixSeconds - $createdAtUnixSeconds) -eq $script:Contract.preflightMaximumAgeSeconds) -SafeMessage "O Plan privado expirou ou possui janela de validade inválida."
  Assert-True -Condition ([string]$plan.planId -match "^[0-9a-f]{32}$") -SafeMessage "O identificador do Plan privado é inválido."

  $script:ApprovedPlan = $plan
  $script:ApprovedPlanRaw = $raw
  $script:CurrentPlanSha256 = $actualHash
}

function Assert-ApplyAuthorized {
  Assert-ApplyIntent
  Assert-True -Condition (-not $script:PlanningPhase) -SafeMessage "Uma mutação OCI foi recusada durante a fase de planejamento."
  Assert-True -Condition ($null -ne $script:ApprovedPlan -and $null -ne $script:ApprovedPlanRaw) -SafeMessage "Uma mutação OCI foi recusada sem Plan privado aprovado."
  Assert-True -Condition ($script:CurrentPlanSha256 -ceq $ApprovedPlanSha256) -SafeMessage "Uma mutação OCI foi recusada por divergência do SHA-256 aprovado."
}

function Assert-CurrentOciMutationPreflight {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [switch]$RequireLaunchCapacity
  )

  $proof = $script:OciMutationPreflight
  Assert-True -Condition ($null -ne $proof) -SafeMessage "A mutação OCI em $Operation foi bloqueada porque o preflight Always Free não foi concluído."
  Assert-True -Condition ($proof.validatedAtUtc -is [DateTimeOffset]) -SafeMessage "A mutação OCI em $Operation foi bloqueada porque a validade do preflight é ambígua."
  $age = [DateTimeOffset]::UtcNow - [DateTimeOffset]$proof.validatedAtUtc
  Assert-True -Condition ($age.TotalSeconds -ge 0 -and $age.TotalSeconds -le $script:Contract.preflightMaximumAgeSeconds) -SafeMessage "A mutação OCI em $Operation foi bloqueada porque o preflight Always Free expirou."
  Assert-True -Condition (
    [bool]$proof.humanZeroCostConfirmed -and
    [bool]$proof.quotaProven -and
    [bool]$proof.capacityProven -and
    [string]$proof.region -ceq $script:Contract.region -and
    [string]$proof.shape -ceq $script:Contract.shape -and
    [double]$proof.ocpus -eq $script:Contract.ocpus -and
    [double]$proof.memoryInGBs -eq $script:Contract.memoryInGBs -and
    [double]$proof.bootVolumeInGBs -eq $script:Contract.bootVolumeInGBs -and
    [double]$proof.bootVolumeVpusPerGB -eq $script:Contract.bootVolumeVpusPerGB
  ) -SafeMessage "A mutação OCI em $Operation foi bloqueada porque a confirmação humana de custo zero, quota ou capacidade não estão comprovadas."
  if ($RequireLaunchCapacity) {
    Assert-True -Condition ([bool]$proof.launchCapacityProven) -SafeMessage "O launch foi bloqueado porque a capacidade E2.1.Micro atual não foi comprovada."
  }
}

function Invoke-OciMutation {
  param(
    [Parameter(Mandatory = $true)][string[]]$Command,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Payload,
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][string]$MutationKey,
    [Parameter(Mandatory = $true)][scriptblock]$Reconcile,
    [switch]$SupportsRetryToken,
    [AllowNull()][scriptblock]$PendingRequestCompatibility,
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 330
  )

  Assert-ApplyAuthorized
  Assert-CurrentOciMutationPreflight -Operation $Operation
  $approvedActions = @($script:ApprovedPlan.plannedActions)
  Assert-True -Condition ($approvedActions -ccontains $MutationKey) -SafeMessage "A mutação OCI em $Operation não consta do Plan aprovado."
  $currentRequest = [ordered]@{ command = @($Command); payload = $Payload }
  $requestFingerprint = Get-Sha256HexForText -Text (ConvertTo-CanonicalJson -Value $currentRequest)
  $retryContext = if ($SupportsRetryToken) {
    Get-OrCreateMutationRetryContext -MutationKey $MutationKey -Command $Command -Payload $Payload -RequestSha256 $requestFingerprint -RemoteStateObserved -PendingRequestCompatibility $PendingRequestCompatibility
  } else {
    [ordered]@{ token = $null; request = $currentRequest; requestSha256 = $requestFingerprint; resumed = $false }
  }
  $executionCommand = @($retryContext.request.command)
  $executionPayload = $retryContext.request.payload
  $requestPath = Join-Path $script:ScratchPath (([Guid]::NewGuid().ToString("N")) + ".json")
  try {
    Write-PrivateJsonFile -Path $requestPath -Value $executionPayload
    $requestUri = [Uri]::new($requestPath).AbsoluteUri
    $arguments = @($executionCommand + @("--from-json", $requestUri))
    if ($SupportsRetryToken) {
      $arguments += @("--opc-retry-token", [string]$retryContext.token)
    }
    $ambiguousCliResult = $false
    try {
      $response = Invoke-OciJson -Arguments $arguments -Operation $Operation -TimeoutSeconds $TimeoutSeconds
    } catch {
      $ambiguousCliResult = $true
      $response = $null
    }
    $reconciled = Invoke-ReconciliationProof -Reconcile $Reconcile -Operation $Operation
    if ($null -eq $reconciled) {
      throw "A mutação OCI em $Operation não apresentou um pós-estado reconciliado inequívoco."
    }
    if ($ambiguousCliResult) {
      $script:Evidence.limitations.Add("mutation-reconciled-after-ambiguous-cli-result:$MutationKey")
    }
    $response = [ordered]@{ data = $reconciled; reconciled = $true; cliResultWasAmbiguous = $ambiguousCliResult }
    if ($SupportsRetryToken) {
      Complete-MutationRetryToken -MutationKey $MutationKey
    }
    return $response
  } finally {
    if (Test-Path -LiteralPath $requestPath) {
      Remove-Item -LiteralPath $requestPath -Force
    }
  }
}

function Get-FreeformTag {
  param(
    [AllowNull()][object]$Resource,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $tags = Get-Field -InputObject $Resource -Name "freeform-tags"
  return Get-Field -InputObject $tags -Name $Name
}

function New-ResourceTags {
  param([Parameter(Mandatory = $true)][string]$ResourceKind)
  $tags = @{
    "set-livre-project" = "set-livre"
    "set-livre-environment" = "production"
    "set-livre-managed-by" = $script:Contract.managedBy
    "set-livre-resource" = $ResourceKind
  }
  if ($ResourceKind -ceq "instance") {
    $tags["set-livre-shape-contract"] = $script:Contract.shapeContract
  }
  return $tags
}

function Invoke-ReconciliationProof {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Reconcile,
    [Parameter(Mandatory = $true)][string]$Operation,
    [ValidateRange(1, 10)][int]$MaximumAttempts = 6
  )

  for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
    try {
      $result = & $Reconcile
      if ($null -ne $result) {
        return $result
      }
    } catch {
      $result = $null
    }
    if ($attempt -lt $MaximumAttempts) {
      Start-Sleep -Seconds 2
    }
  }
  Write-Information "A reconciliação segura não comprovou o pós-estado de $Operation em $MaximumAttempts tentativas."
  return $null
}

function Test-ExactResourceTags {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind
  )

  foreach ($pair in @(
      @{ Name = "set-livre-project"; Value = "set-livre" },
      @{ Name = "set-livre-environment"; Value = "production" },
      @{ Name = "set-livre-managed-by"; Value = $script:Contract.managedBy },
      @{ Name = "set-livre-resource"; Value = $ResourceKind },
      @{ Name = "set-livre-shape-contract"; Value = $(if ($ResourceKind -ceq "instance") { $script:Contract.shapeContract } else { $null }) }
    )) {
    if ($null -eq $pair.Value) { continue }
    if ([string](Get-FreeformTag -Resource $Resource -Name $pair.Name) -cne $pair.Value) {
      return $false
    }
  }
  return $true
}

function ConvertTo-FreeformTagMap {
  param([Parameter(Mandatory = $true)][object]$Resource)

  $tags = Get-Field -InputObject $Resource -Name "freeform-tags"
  Assert-True -Condition ($null -ne $tags) -SafeMessage "O recurso não retornou um mapa de freeform tags inequívoco."
  $result = [ordered]@{}
  if ($tags -is [Collections.IDictionary]) {
    [string[]]$names = @($tags.Keys | ForEach-Object { [string]$_ })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    foreach ($name in $names) {
      Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($name) -and $null -ne $tags[$name]) -SafeMessage "O recurso contém uma freeform tag inválida."
      $result[$name] = [string]$tags[$name]
    }
    return $result
  }

  $properties = @($tags.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") })
  [string[]]$names = @($properties.Name)
  [Array]::Sort($names, [StringComparer]::Ordinal)
  foreach ($name in $names) {
    $value = $tags.PSObject.Properties[$name].Value
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($name) -and $null -ne $value) -SafeMessage "O recurso contém uma freeform tag inválida."
    $result[$name] = [string]$value
  }
  return $result
}

function Test-ExactFreeformTagMap {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$ExpectedTags
  )

  $actualTags = ConvertTo-FreeformTagMap -Resource $Resource
  return (ConvertTo-CanonicalJson -Value $actualTags) -ceq (ConvertTo-CanonicalJson -Value $ExpectedTags)
}

function Test-V1TagSourceContract {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind
  )

  foreach ($pair in @(
      @{ Name = "set-livre-project"; Value = "set-livre" },
      @{ Name = "set-livre-environment"; Value = "production" },
      @{ Name = "set-livre-managed-by"; Value = $script:Contract.tagNormalization.sourceManagedBy },
      @{ Name = "set-livre-resource"; Value = $ResourceKind }
    )) {
    if ([string](Get-FreeformTag -Resource $Resource -Name $pair.Name) -cne $pair.Value) {
      return $false
    }
  }
  return $true
}

function Assert-PendingTagNormalizationSource {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Pending
  )

  Assert-True -Condition ($script:Contract.tagNormalization.resourceKinds -ccontains $ResourceKind) -SafeMessage "O recurso não pertence à transição única de tags aprovada."
  Assert-True -Condition ([string]$Pending.kind -ceq $ResourceKind) -SafeMessage "A normalização de tags pendente possui tipo divergente."
  Assert-True -Condition ([string](Get-Field -InputObject $Resource -Name "id") -ceq [string]$Pending.id) -SafeMessage "O recurso diverge do OCID privado aprovado para normalização."
  Assert-True -Condition ([string]$Pending.transitionContract -ceq $script:Contract.tagNormalization.transitionContract) -SafeMessage "A normalização de tags não usa o contrato aprovado."
  Assert-True -Condition ([string]$Pending.sourceManagedBy -ceq $script:Contract.tagNormalization.sourceManagedBy) -SafeMessage "A origem da normalização de tags diverge do contrato aprovado."
  Assert-True -Condition ([string]$Pending.targetManagedBy -ceq $script:Contract.managedBy) -SafeMessage "O destino da normalização de tags diverge do contrato aprovado."
  Assert-True -Condition (Test-V1TagSourceContract -Resource $Resource -ResourceKind $ResourceKind) -SafeMessage "O recurso pendente não preserva exatamente a origem de tags v1 aprovada."
}

function New-NormalizedResourceTags {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Pending
  )

  Assert-PendingTagNormalizationSource -Resource $Resource -ResourceKind $ResourceKind -Pending $Pending
  $normalized = ConvertTo-FreeformTagMap -Resource $Resource
  foreach ($entry in (New-ResourceTags -ResourceKind $ResourceKind).GetEnumerator()) {
    $normalized[[string]$entry.Key] = [string]$entry.Value
  }
  return $normalized
}

function Resolve-UniqueResource {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Items,
    [Parameter(Mandatory = $true)][string]$ResourceKind
  )

  $persistedId = Get-PersistedApprovedOcid -ResourceKind $ResourceKind
  $pending = Get-PendingTagNormalization -ResourceKind $ResourceKind
  $pendingId = if ($null -eq $pending) { $null } else { [string]$pending.id }
  Assert-True -Condition ([string]::IsNullOrWhiteSpace($persistedId) -or [string]::IsNullOrWhiteSpace($pendingId)) -SafeMessage "O recurso $ResourceKind possui ownership aprovado e normalização pendente simultaneamente."
  $candidates = [Collections.Generic.List[object]]::new()
  $persistedWasObserved = [string]::IsNullOrWhiteSpace($persistedId)
  $pendingWasObserved = [string]::IsNullOrWhiteSpace($pendingId)
  foreach ($item in $Items) {
    $lifecycle = [string](Get-Field -InputObject $item -Name "lifecycle-state")
    if ($lifecycle -ceq "TERMINATED" -or $lifecycle -ceq "TERMINATING") {
      continue
    }
    $id = [string](Get-Field -InputObject $item -Name "id")
    if (-not [string]::IsNullOrWhiteSpace($persistedId) -and $id -ceq $persistedId) {
      $persistedWasObserved = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($pendingId) -and $id -ceq $pendingId) {
      $pendingWasObserved = $true
    }
    $tagMatch = Test-ExactResourceTags -Resource $item -ResourceKind $ResourceKind
    $v1SourceMatch = Test-V1TagSourceContract -Resource $item -ResourceKind $ResourceKind
    $persistedMatch = -not [string]::IsNullOrWhiteSpace($persistedId) -and $id -ceq $persistedId
    $pendingMatch = -not [string]::IsNullOrWhiteSpace($pendingId) -and $id -ceq $pendingId
    Assert-True -Condition (-not $v1SourceMatch -or $pendingMatch) -SafeMessage "Um recurso com tags v1 foi encontrado sem transição privada aprovada."
    if ($pendingMatch) {
      Assert-True -Condition ($tagMatch -or $v1SourceMatch) -SafeMessage "O recurso pendente de normalização divergiu das tags de origem e destino aprovadas."
    }
    if ($tagMatch -or $persistedMatch -or $pendingMatch) {
      Assert-NoForbiddenTargetName -Resource $item -ResourceLabel $ResourceKind
      $candidates.Add($item)
    }
  }

  Assert-True -Condition $persistedWasObserved -SafeMessage "O OCID persistido de $ResourceKind não existe mais no inventário consultado."
  Assert-True -Condition $pendingWasObserved -SafeMessage "O OCID pendente de normalização de $ResourceKind não existe mais no inventário consultado."
  Assert-True -Condition ($candidates.Count -le 1) -SafeMessage "Mais de um recurso candidato foi encontrado para $ResourceKind."
  if ($candidates.Count -eq 0) {
    return $null
  }
  $candidate = $candidates[0]
  $candidateId = [string](Get-Field -InputObject $candidate -Name "id")
  $hasExactTags = Test-ExactResourceTags -Resource $candidate -ResourceKind $ResourceKind
  $hasPersistedApproval = -not [string]::IsNullOrWhiteSpace($persistedId) -and $candidateId -ceq $persistedId
  $hasPendingNormalization = -not [string]::IsNullOrWhiteSpace($pendingId) -and $candidateId -ceq $pendingId
  Assert-True -Condition ($hasExactTags -or $hasPersistedApproval -or $hasPendingNormalization) -SafeMessage "O recurso $ResourceKind não possui prova de propriedade aceita."
  if ($hasPendingNormalization -and -not $hasExactTags) {
    Assert-PendingTagNormalizationSource -Resource $candidate -ResourceKind $ResourceKind -Pending $pending
  }
  return $candidate
}

function Assert-AndRecordOwnedResource {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind
  )

  $nameKeys = [ordered]@{
    vcn = "vcn"
    "internet-gateway" = "internetGateway"
    "route-table" = "routeTable"
    "security-list" = "securityList"
    subnet = "subnet"
    nsg = "nsg"
    instance = "instance"
  }
  $expectedName = if ($ResourceKind -ceq "compartment") {
    $script:Contract.compartmentName
  } else {
    $nameKey = $nameKeys[$ResourceKind]
    [string]$script:Contract.names[$nameKey]
  }
  $actualName = if ($ResourceKind -ceq "compartment") {
    [string](Get-Field -InputObject $Resource -Name "name")
  } else {
    [string](Get-Field -InputObject $Resource -Name "display-name")
  }
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($expectedName)) -SafeMessage "O contrato não define nome para $ResourceKind."
  Assert-True -Condition ($actualName -ceq $expectedName) -SafeMessage "O recurso $ResourceKind não usa o nome canônico Set Livre."
  $id = [string](Get-Field -InputObject $Resource -Name "id")
  $pending = Get-PendingTagNormalization -ResourceKind $ResourceKind
  if ($null -ne $pending) {
    Assert-True -Condition ($id -ceq [string]$pending.id) -SafeMessage "O recurso $ResourceKind diverge do OCID pendente de normalização."
    if (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) {
      Complete-PendingTagNormalizationState -ResourceKind $ResourceKind -Resource $Resource
    } else {
      Assert-PendingTagNormalizationSource -Resource $Resource -ResourceKind $ResourceKind -Pending $pending
    }
    return
  }
  if (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) {
    if (
      -not $script:PrivateState.resources.Contains($ResourceKind) -or
      [string]$script:PrivateState.resources[$ResourceKind].id -cne $id
    ) {
      Set-ApprovedResourceState -ResourceKind $ResourceKind -Resource $Resource -OwnershipProof "exact-tags"
    }
    return
  }
  $persistedId = Get-PersistedApprovedOcid -ResourceKind $ResourceKind
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($persistedId) -and $id -ceq $persistedId) -SafeMessage "O recurso $ResourceKind não possui tags v2 exatas nem OCID privado aprovado."
}

function Complete-PendingTagNormalizationState {
  param(
    [Parameter(Mandatory = $true)][string]$ResourceKind,
    [Parameter(Mandatory = $true)][object]$Resource
  )

  $pending = Get-PendingTagNormalization -ResourceKind $ResourceKind
  Assert-True -Condition ($null -ne $pending) -SafeMessage "Não existe normalização de tags pendente para $ResourceKind."
  $id = [string](Get-Field -InputObject $Resource -Name "id")
  Assert-True -Condition ($id -ceq [string]$pending.id) -SafeMessage "O pós-estado de tags diverge do OCID privado aprovado."
  Assert-True -Condition (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) -SafeMessage "O pós-estado não comprova as tags v2 exatas."
  [void]$script:PrivateState.pendingTagNormalizations.Remove($ResourceKind)
  $script:PrivateState.resources[$ResourceKind] = [ordered]@{
    kind = $ResourceKind
    id = $id
    ownershipProof = "exact-tags"
    approvedPlanSha256 = $null
  }
  Save-PrivateProvisioningState
}

function Find-OwnedResource {
  param(
    [Parameter(Mandatory = $true)][string[]]$ListArguments,
    [Parameter(Mandatory = $true)][string]$ResourceKind,
    [Parameter(Mandatory = $true)][string]$Operation
  )

  $response = Invoke-OciJson -Arguments $ListArguments -Operation $Operation
  return Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind $ResourceKind
}

function Get-RequiredOciEtag {
  param(
    [Parameter(Mandatory = $true)][object]$Response,
    [Parameter(Mandatory = $true)][string]$SafeLabel
  )

  $etag = [string](Get-Field -InputObject $Response -Name "etag")
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($etag) -and $etag.Length -le 512 -and $etag -notmatch "[\r\n]") -SafeMessage "$SafeLabel não retornou ETag inequívoco para controle concorrente."
  return $etag
}

function Get-TagNormalizationApiContract {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("compartment", "vcn")][string]$ResourceKind,
    [Parameter(Mandatory = $true)][string]$ResourceId
  )

  switch ($ResourceKind) {
    "compartment" {
      return [ordered]@{
        mutationKey = "normalize-v1-compartment-tags"
        getArguments = @("iam", "compartment", "get", "--compartment-id", $ResourceId)
        updateCommand = @("iam", "compartment", "update")
        idPayloadName = "compartmentId"
        safeLabel = "O compartment SetLivre"
      }
    }
    "vcn" {
      return [ordered]@{
        mutationKey = "normalize-v1-vcn-tags"
        getArguments = @("network", "vcn", "get", "--vcn-id", $ResourceId)
        updateCommand = @("network", "vcn", "update")
        idPayloadName = "vcnId"
        safeLabel = "A VCN Set Livre"
      }
    }
  }
}

function Ensure-V2ResourceTags {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][ValidateSet("compartment", "vcn")][string]$ResourceKind
  )

  $resourceId = [string](Get-Field -InputObject $Resource -Name "id")
  $pending = Get-PendingTagNormalization -ResourceKind $ResourceKind
  if ($null -eq $pending) {
    Assert-True -Condition (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) -SafeMessage "O recurso $ResourceKind não possui tags v2 exatas nem transição privada pendente."
    return $Resource
  }

  Assert-True -Condition ($resourceId -ceq [string]$pending.id) -SafeMessage "O recurso $ResourceKind diverge do OCID privado aprovado para normalização."
  if (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) {
    Complete-PendingTagNormalizationState -ResourceKind $ResourceKind -Resource $Resource
    return $Resource
  }
  Assert-PendingTagNormalizationSource -Resource $Resource -ResourceKind $ResourceKind -Pending $pending

  $api = Get-TagNormalizationApiContract -ResourceKind $ResourceKind -ResourceId $resourceId
  Add-PlannedAction -Action $api.mutationKey
  if (-not (Test-MutationExecutionEnabled)) {
    return $Resource
  }

  $currentResponse = Invoke-OciJson -Arguments $api.getArguments -Operation "obter ETag para normalizar tags de $ResourceKind"
  $current = Get-Field -InputObject $currentResponse -Name "data"
  Assert-True -Condition ([string](Get-Field -InputObject $current -Name "id") -ceq $resourceId) -SafeMessage "O recurso $ResourceKind mudou antes da normalização concorrente de tags."
  if (Test-ExactResourceTags -Resource $current -ResourceKind $ResourceKind) {
    Complete-PendingTagNormalizationState -ResourceKind $ResourceKind -Resource $current
    return $current
  }
  Assert-PendingTagNormalizationSource -Resource $current -ResourceKind $ResourceKind -Pending $pending
  $normalizedTags = New-NormalizedResourceTags -Resource $current -ResourceKind $ResourceKind -Pending $pending
  $etag = Get-RequiredOciEtag -Response $currentResponse -SafeLabel $api.safeLabel
  $payload = [ordered]@{
    freeformTags = $normalizedTags
    ifMatch = $etag
  }
  $payload[$api.idPayloadName] = $resourceId
  $updatedResponse = Invoke-OciMutation -Command $api.updateCommand -Operation "normalizar tags v1 para v2 de $ResourceKind" -MutationKey $api.mutationKey -Reconcile {
    $reconciledResponse = Invoke-OciJson -Arguments $api.getArguments -Operation "reconciliar tags v2 de $ResourceKind"
    $candidate = Get-Field -InputObject $reconciledResponse -Name "data"
    if (
      [string](Get-Field -InputObject $candidate -Name "id") -ceq $resourceId -and
      (Test-ExactResourceTags -Resource $candidate -ResourceKind $ResourceKind) -and
      (Test-ExactFreeformTagMap -Resource $candidate -ExpectedTags $normalizedTags)
    ) {
      return $candidate
    }
    return $null
  } -Payload $payload
  $updated = Get-Field -InputObject $updatedResponse -Name "data"
  Assert-True -Condition (
    [string](Get-Field -InputObject $updated -Name "id") -ceq $resourceId -and
    (Test-ExactResourceTags -Resource $updated -ResourceKind $ResourceKind) -and
    (Test-ExactFreeformTagMap -Resource $updated -ExpectedTags $normalizedTags)
  ) -SafeMessage "A normalização de tags de $ResourceKind não produziu o pós-estado exato."
  Complete-PendingTagNormalizationState -ResourceKind $ResourceKind -Resource $updated
  return $updated
}

function Assert-AvailableLifecycle {
  param(
    [Parameter(Mandatory = $true)][object]$Resource,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-True -Condition ([string](Get-Field -InputObject $Resource -Name "lifecycle-state") -ceq "AVAILABLE") -SafeMessage "O recurso $Label não está em estado AVAILABLE."
}

function Get-CompartmentContract {
  param([Parameter(Mandatory = $true)][string]$TenancyId)

  $response = Invoke-OciJson -Arguments @(
    "iam", "compartment", "list",
    "--compartment-id", $TenancyId,
    "--compartment-id-in-subtree", "true",
    "--include-root",
    "--access-level", "ANY",
    "--all"
  ) -Operation "listar compartments"
  $items = @(Get-OciItems -Response $response)
  $target = Resolve-UniqueResource -Items $items -ResourceKind "compartment"
  Assert-True -Condition ($null -ne $target) -SafeMessage "O compartment SetLivre deve ser adotado por tags exatas ou OCID privado aprovado."
  Assert-True -Condition ([string](Get-Field -InputObject $target -Name "name") -ceq $script:Contract.compartmentName) -SafeMessage "O compartment aprovado não usa o nome canônico SetLivre."
  Assert-True -Condition ([string](Get-Field -InputObject $target -Name "compartment-id") -ceq $TenancyId) -SafeMessage "O compartment aprovado não está diretamente sob o tenancy root."
  Assert-True -Condition ([string](Get-Field -InputObject $target -Name "lifecycle-state") -ceq "ACTIVE") -SafeMessage "O compartment aprovado não está ACTIVE."
  Assert-AndRecordOwnedResource -Resource $target -ResourceKind "compartment"
  $forbidden = @($items | Where-Object { [string](Get-Field -InputObject $_ -Name "name") -match "(?i)^(SpensesApp|piadas)$" })
  foreach ($other in $forbidden) {
    Assert-True -Condition ([string](Get-Field -InputObject $other -Name "id") -cne [string](Get-Field -InputObject $target -Name "id")) -SafeMessage "O compartment SetLivre não pode reutilizar outro projeto."
  }
  return [ordered]@{ target = $target; all = $items }
}

function Assert-HomeRegionAndTenancy {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Profile)

  [void](Invoke-OciProcess -Arguments @("session", "validate", "--local") -Operation "validar expiração local da sessão")
  [void](Invoke-OciProcess -Arguments @("session", "validate") -Operation "validar sessão OCI remotamente")
  $tenancy = Invoke-OciJson -Arguments @("iam", "tenancy", "get", "--tenancy-id", $Profile.tenancyId) -Operation "validar tenancy root"
  Assert-True -Condition ([string](Get-Field -InputObject (Get-Field -InputObject $tenancy -Name "data") -Name "id") -ceq $Profile.tenancyId) -SafeMessage "A resposta do tenancy root diverge do profile SET_LIVRE."
  $subscriptions = Invoke-OciJson -Arguments @("iam", "region-subscription", "list", "--tenancy-id", $Profile.tenancyId, "--all") -Operation "validar home region"
  $homeRegions = @((Get-OciItems -Response $subscriptions) | Where-Object { [bool](Get-Field -InputObject $_ -Name "is-home-region") })
  Assert-True -Condition ($homeRegions.Count -eq 1) -SafeMessage "A tenancy deve expor exatamente uma home region."
  Assert-True -Condition ([string](Get-Field -InputObject $homeRegions[0] -Name "region-name") -ceq $script:Contract.region) -SafeMessage "A home region da tenancy não é sa-saopaulo-1."
}

function Test-NoMarketplaceImageListing {
  param([Parameter(Mandatory = $true)][object]$Image)

  $listingType = Get-Field -InputObject $Image -Name "listing-type"
  return $null -eq $listingType -or
    [string]::IsNullOrWhiteSpace([string]$listingType) -or
    [string]$listingType -ceq "NONE"
}

function Get-AvailabilityDomainAndImage {
  param(
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )

  $adsResponse = Invoke-OciJson -Arguments @("iam", "availability-domain", "list", "--compartment-id", $CompartmentId, "--all") -Operation "listar availability domains"
  $ads = @(Get-OciItems -Response $adsResponse)
  Assert-True -Condition ($ads.Count -eq 1) -SafeMessage "O alvo Set Livre exige exatamente uma availability domain inequívoca na região."
  $adName = [string](Get-Field -InputObject $ads[0] -Name "name")
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($adName)) -SafeMessage "A availability domain retornada é inválida."

  $shapeResponse = Invoke-OciJson -Arguments @(
    "compute", "shape", "list",
    "--compartment-id", $CompartmentId,
    "--availability-domain", $adName,
    "--shape", $script:Contract.shape,
    "--all"
  ) -Operation "validar shape E2.1.Micro"
  $shapes = @((Get-OciItems -Response $shapeResponse) | Where-Object { [string](Get-Field -InputObject $_ -Name "shape") -ceq $script:Contract.shape })
  Assert-True -Condition ($shapes.Count -eq 1) -SafeMessage "O shape VM.Standard.E2.1.Micro deve existir exatamente uma vez na AD."
  $shape = $shapes[0]
  Assert-True -Condition (-not [bool](Get-Field -InputObject $shape -Name "is-flexible")) -SafeMessage "O shape E2.1.Micro deve ser fixo, não flexível."
  $processor = [string](Get-Field -InputObject $shape -Name "processor-description")
  Assert-True -Condition ($processor -match "(?i)(AMD|Intel|x86)") -SafeMessage "O processador do shape não comprova a família x86_64 aprovada."
  Assert-True -Condition ([double](Get-Field -InputObject $shape -Name "ocpus") -eq $script:Contract.ocpus) -SafeMessage "A metadata OCPU do shape E2.1.Micro diverge do contrato fixo esperado."
  Assert-True -Condition ([double](Get-Field -InputObject $shape -Name "memory-in-gbs") -eq $script:Contract.memoryInGBs) -SafeMessage "O shape E2.1.Micro não expõe exatamente 1 GB."

  $imagesResponse = Invoke-OciJson -Arguments @(
    "compute", "image", "list",
    "--compartment-id", $CompartmentId,
    "--shape", $script:Contract.shape,
    "--sort-by", "TIMECREATED",
    "--sort-order", "DESC",
    "--all"
  ) -Operation "listar imagens Ubuntu x86_64 compatíveis com E2.1.Micro"
  $images = @((Get-OciItems -Response $imagesResponse) | Where-Object {
      [string](Get-Field -InputObject $_ -Name "display-name") -cmatch $script:Contract.imagePattern -and
      [string](Get-Field -InputObject $_ -Name "lifecycle-state") -ceq "AVAILABLE" -and
      [string](Get-Field -InputObject $_ -Name "operating-system") -match "(?i)Ubuntu" -and
      [string](Get-Field -InputObject $_ -Name "operating-system-version") -match "^24[.]04" -and
      (Test-NoMarketplaceImageListing -Image $_)
    })
  Assert-True -Condition ($images.Count -ge 1) -SafeMessage "Nenhuma imagem Ubuntu 24.04 x86_64 sem licença, compatível com E2.1.Micro, está disponível."
  $latestImage = $images | Sort-Object { [DateTimeOffset](Get-Field -InputObject $_ -Name "time-created") } -Descending | Select-Object -First 1
  return [ordered]@{ availabilityDomain = $adName; shape = $shape; image = $latestImage }
}

function Get-NetworkState {
  param([Parameter(Mandatory = $true)][string]$CompartmentId)

  $vcnResponse = Invoke-OciJson -Arguments @("network", "vcn", "list", "--compartment-id", $CompartmentId, "--all") -Operation "listar VCNs Set Livre"
  $vcn = Resolve-UniqueResource -Items @(Get-OciItems -Response $vcnResponse) -ResourceKind "vcn"
  if ($null -ne $vcn) {
    Assert-AndRecordOwnedResource -Resource $vcn -ResourceKind "vcn"
    Assert-AvailableLifecycle -Resource $vcn -Label "VCN"
    Assert-True -Condition ([string](Get-Field -InputObject $vcn -Name "compartment-id") -ceq $CompartmentId) -SafeMessage "A VCN não pertence ao compartment SetLivre."
    Assert-True -Condition ([string](Get-Field -InputObject $vcn -Name "cidr-block") -ceq $script:Contract.vcnCidr) -SafeMessage "A VCN não usa 10.20.0.0/16."
  }
  return [ordered]@{ vcn = $vcn; internetGateway = $null; routeTable = $null; securityList = $null; subnet = $null; nsg = $null }
}

function Ensure-Vcn {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -ne $Network.vcn) {
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-vcn" -Reason "owned-vcn-observed-after-startup")
    return
  }
  Add-PlannedAction -Action "create-vcn"
  if (-not (Test-MutationExecutionEnabled)) { return }
  $response = Invoke-OciMutation -Command @("network", "vcn", "create") -Operation "criar VCN Set Livre" -MutationKey "create-vcn" -SupportsRetryToken -Reconcile {
    $candidate = Find-OwnedResource -ListArguments @("network", "vcn", "list", "--compartment-id", $CompartmentId, "--all") -ResourceKind "vcn" -Operation "reconciliar criação da VCN Set Livre"
    if ($null -ne $candidate -and [string](Get-Field -InputObject $candidate -Name "cidr-block") -ceq $script:Contract.vcnCidr) { return $candidate }
    return $null
  } -Payload @{
    compartmentId = $CompartmentId
    cidrBlock = $script:Contract.vcnCidr
    displayName = $script:Contract.names.vcn
    dnsLabel = "setlivre"
    isIpv6Enabled = $false
    freeformTags = New-ResourceTags -ResourceKind "vcn"
    waitForState = @("AVAILABLE")
    maxWaitSeconds = 300
    waitIntervalSeconds = 5
  }
  $Network.vcn = Get-Field -InputObject $response -Name "data"
  Assert-AndRecordOwnedResource -Resource $Network.vcn -ResourceKind "vcn"
  Set-ApprovedResourceState -ResourceKind "vcn" -Resource $Network.vcn -OwnershipProof "created-by-approved-plan"
  Assert-AvailableLifecycle -Resource $Network.vcn -Label "VCN recém-criada"
}

function Ensure-InternetGateway {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -eq $Network.vcn) {
    Add-PlannedAction -Action "create-internet-gateway"
    return
  }
  $vcnId = [string](Get-Field -InputObject $Network.vcn -Name "id")
  $response = Invoke-OciJson -Arguments @("network", "internet-gateway", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -Operation "listar internet gateways Set Livre"
  $gateway = Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind "internet-gateway"
  if ($null -eq $gateway) {
    Add-PlannedAction -Action "create-internet-gateway"
    if (Test-MutationExecutionEnabled) {
      $created = Invoke-OciMutation -Command @("network", "internet-gateway", "create") -Operation "criar internet gateway Set Livre" -MutationKey "create-internet-gateway" -SupportsRetryToken -Reconcile {
        $candidate = Find-OwnedResource -ListArguments @("network", "internet-gateway", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -ResourceKind "internet-gateway" -Operation "reconciliar criação do internet gateway"
        if ($null -ne $candidate -and [bool](Get-Field -InputObject $candidate -Name "is-enabled") -and [string](Get-Field -InputObject $candidate -Name "vcn-id") -ceq $vcnId) { return $candidate }
        return $null
      } -Payload @{
        compartmentId = $CompartmentId
        vcnId = $vcnId
        isEnabled = $true
        displayName = $script:Contract.names.internetGateway
        freeformTags = New-ResourceTags -ResourceKind "internet-gateway"
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $gateway = Get-Field -InputObject $created -Name "data"
      Assert-AndRecordOwnedResource -Resource $gateway -ResourceKind "internet-gateway"
      Set-ApprovedResourceState -ResourceKind "internet-gateway" -Resource $gateway -OwnershipProof "created-by-approved-plan"
    }
  } elseif (-not [bool](Get-Field -InputObject $gateway -Name "is-enabled")) {
    Add-PlannedAction -Action "enable-internet-gateway"
    if (Test-MutationExecutionEnabled) {
      $gatewayId = [string](Get-Field -InputObject $gateway -Name "id")
      $currentResponse = Invoke-OciJson -Arguments @("network", "internet-gateway", "get", "--ig-id", $gatewayId) -Operation "obter ETag do internet gateway"
      $currentGateway = Get-Field -InputObject $currentResponse -Name "data"
      Assert-True -Condition ([string](Get-Field -InputObject $currentGateway -Name "id") -ceq $gatewayId -and -not [bool](Get-Field -InputObject $currentGateway -Name "is-enabled")) -SafeMessage "O internet gateway mudou antes do update concorrente."
      $etag = Get-RequiredOciEtag -Response $currentResponse -SafeLabel "O internet gateway"
      $updated = Invoke-OciMutation -Command @("network", "internet-gateway", "update") -Operation "habilitar internet gateway Set Livre" -MutationKey "enable-internet-gateway" -Reconcile {
        $reconciledResponse = Invoke-OciJson -Arguments @("network", "internet-gateway", "get", "--ig-id", $gatewayId) -Operation "reconciliar update do internet gateway"
        $candidate = Get-Field -InputObject $reconciledResponse -Name "data"
        if ([string](Get-Field -InputObject $candidate -Name "id") -ceq $gatewayId -and [bool](Get-Field -InputObject $candidate -Name "is-enabled")) { return $candidate }
        return $null
      } -Payload @{
        igId = $gatewayId
        isEnabled = $true
        ifMatch = $etag
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $gateway = Get-Field -InputObject $updated -Name "data"
    }
  }
  if ($null -ne $gateway) {
    Assert-AndRecordOwnedResource -Resource $gateway -ResourceKind "internet-gateway"
    Assert-AvailableLifecycle -Resource $gateway -Label "internet gateway"
    Assert-True -Condition ([string](Get-Field -InputObject $gateway -Name "vcn-id") -ceq $vcnId) -SafeMessage "O internet gateway não pertence à VCN Set Livre."
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-internet-gateway" -Reason "owned-internet-gateway-observed-after-startup")
    if ((Test-MutationExecutionEnabled) -or -not ($script:Evidence.plannedActions -ccontains "enable-internet-gateway")) {
      Assert-True -Condition ([bool](Get-Field -InputObject $gateway -Name "is-enabled")) -SafeMessage "O internet gateway não está habilitado."
    }
    if ([bool](Get-Field -InputObject $gateway -Name "is-enabled")) {
      [void](Complete-PendingMutationFromObservedState -MutationKey "enable-internet-gateway" -Reason "enabled-internet-gateway-observed-after-startup")
    }
  }
  $Network.internetGateway = $gateway
}

function Test-ExactRouteRule {
  param(
    [Parameter(Mandatory = $true)][object]$Rule,
    [Parameter(Mandatory = $true)][string]$GatewayId
  )
  return [string](Get-Field -InputObject $Rule -Name "destination") -ceq "0.0.0.0/0" -and
    [string](Get-Field -InputObject $Rule -Name "destination-type") -ceq "CIDR_BLOCK" -and
    [string](Get-Field -InputObject $Rule -Name "network-entity-id") -ceq $GatewayId
}

function Ensure-RouteTable {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -eq $Network.vcn) {
    Add-PlannedAction -Action "create-public-route-table"
    return
  }
  $vcnId = [string](Get-Field -InputObject $Network.vcn -Name "id")
  $response = Invoke-OciJson -Arguments @("network", "route-table", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -Operation "listar route tables Set Livre"
  $routeTable = Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind "route-table"
  if ($null -eq $Network.internetGateway) {
    if ($null -eq $routeTable) {
      Add-PlannedAction -Action "create-public-route-table"
    } else {
      Assert-AndRecordOwnedResource -Resource $routeTable -ResourceKind "route-table"
      Assert-AvailableLifecycle -Resource $routeTable -Label "route table"
      Assert-True -Condition ([string](Get-Field -InputObject $routeTable -Name "vcn-id") -ceq $vcnId) -SafeMessage "A route table não pertence à VCN Set Livre."
      Assert-True -Condition (@(Get-Field -InputObject $routeTable -Name "route-rules").Count -eq 0) -SafeMessage "A route table parcial contém regra antes da criação do gateway aprovado."
      Add-PlannedAction -Action "configure-public-route"
    }
    $Network.routeTable = $routeTable
    return
  }
  $gatewayId = [string](Get-Field -InputObject $Network.internetGateway -Name "id")
  $routeRules = @(@{ destination = "0.0.0.0/0"; destinationType = "CIDR_BLOCK"; networkEntityId = $gatewayId; description = "Set Livre public internet" })
  if ($null -eq $routeTable) {
    Add-PlannedAction -Action "create-public-route-table"
    if (Test-MutationExecutionEnabled) {
      $created = Invoke-OciMutation -Command @("network", "route-table", "create") -Operation "criar route table pública Set Livre" -MutationKey "create-public-route-table" -SupportsRetryToken -Reconcile {
        $candidate = Find-OwnedResource -ListArguments @("network", "route-table", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -ResourceKind "route-table" -Operation "reconciliar criação da route table"
        $candidateRules = if ($null -ne $candidate) { @(Get-Field -InputObject $candidate -Name "route-rules") } else { @() }
        if ($null -ne $candidate -and $candidateRules.Count -eq 1 -and (Test-ExactRouteRule -Rule $candidateRules[0] -GatewayId $gatewayId)) { return $candidate }
        return $null
      } -Payload @{
        compartmentId = $CompartmentId
        vcnId = $vcnId
        displayName = $script:Contract.names.routeTable
        routeRules = $routeRules
        freeformTags = New-ResourceTags -ResourceKind "route-table"
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $routeTable = Get-Field -InputObject $created -Name "data"
      Assert-AndRecordOwnedResource -Resource $routeTable -ResourceKind "route-table"
      Set-ApprovedResourceState -ResourceKind "route-table" -Resource $routeTable -OwnershipProof "created-by-approved-plan"
    }
  } else {
    $existingRules = @(Get-Field -InputObject $routeTable -Name "route-rules")
    if ($existingRules.Count -eq 0) {
      Add-PlannedAction -Action "configure-public-route"
      if (Test-MutationExecutionEnabled) {
        $routeTableId = [string](Get-Field -InputObject $routeTable -Name "id")
        $currentResponse = Invoke-OciJson -Arguments @("network", "route-table", "get", "--rt-id", $routeTableId) -Operation "obter ETag da route table"
        $currentRouteTable = Get-Field -InputObject $currentResponse -Name "data"
        Assert-True -Condition ([string](Get-Field -InputObject $currentRouteTable -Name "id") -ceq $routeTableId -and @(Get-Field -InputObject $currentRouteTable -Name "route-rules").Count -eq 0) -SafeMessage "A route table mudou antes do update concorrente."
        $etag = Get-RequiredOciEtag -Response $currentResponse -SafeLabel "A route table"
        $updated = Invoke-OciMutation -Command @("network", "route-table", "update") -Operation "configurar rota pública Set Livre" -MutationKey "configure-public-route" -Reconcile {
          $reconciledResponse = Invoke-OciJson -Arguments @("network", "route-table", "get", "--rt-id", $routeTableId) -Operation "reconciliar update da route table"
          $candidate = Get-Field -InputObject $reconciledResponse -Name "data"
          $candidateRules = @(Get-Field -InputObject $candidate -Name "route-rules")
          if ([string](Get-Field -InputObject $candidate -Name "id") -ceq $routeTableId -and $candidateRules.Count -eq 1 -and (Test-ExactRouteRule -Rule $candidateRules[0] -GatewayId $gatewayId)) { return $candidate }
          return $null
        } -Payload @{
          rtId = $routeTableId
          routeRules = $routeRules
          ifMatch = $etag
          waitForState = @("AVAILABLE")
          maxWaitSeconds = 300
          waitIntervalSeconds = 5
        }
        $routeTable = Get-Field -InputObject $updated -Name "data"
      }
    } else {
      Assert-True -Condition ($existingRules.Count -eq 1 -and (Test-ExactRouteRule -Rule $existingRules[0] -GatewayId $gatewayId)) -SafeMessage "A route table contém rota extra ou divergente."
    }
  }
  if ($null -ne $routeTable) {
    Assert-AndRecordOwnedResource -Resource $routeTable -ResourceKind "route-table"
    Assert-AvailableLifecycle -Resource $routeTable -Label "route table"
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-public-route-table" -Reason "owned-route-table-observed-after-startup")
    $effectiveRules = @(Get-Field -InputObject $routeTable -Name "route-rules")
    if ((Test-MutationExecutionEnabled) -or -not ($script:Evidence.plannedActions -ccontains "configure-public-route")) {
      Assert-True -Condition ($effectiveRules.Count -eq 1 -and (Test-ExactRouteRule -Rule $effectiveRules[0] -GatewayId $gatewayId)) -SafeMessage "A route table não contém somente a rota 0/0 pelo IGW."
    }
    if ($effectiveRules.Count -eq 1 -and (Test-ExactRouteRule -Rule $effectiveRules[0] -GatewayId $gatewayId)) {
      [void](Complete-PendingMutationFromObservedState -MutationKey "configure-public-route" -Reason "exact-public-route-observed-after-startup")
    }
  }
  $Network.routeTable = $routeTable
}

function Ensure-SecurityList {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -eq $Network.vcn) {
    Add-PlannedAction -Action "create-no-ingress-security-list"
    return
  }
  $vcnId = [string](Get-Field -InputObject $Network.vcn -Name "id")
  $response = Invoke-OciJson -Arguments @("network", "security-list", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -Operation "listar security lists Set Livre"
  $securityList = Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind "security-list"
  if ($null -eq $securityList) {
    Add-PlannedAction -Action "create-no-ingress-security-list"
    if (Test-MutationExecutionEnabled) {
      $created = Invoke-OciMutation -Command @("network", "security-list", "create") -Operation "criar security list sem ingress" -MutationKey "create-no-ingress-security-list" -SupportsRetryToken -Reconcile {
        $candidate = Find-OwnedResource -ListArguments @("network", "security-list", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -ResourceKind "security-list" -Operation "reconciliar criação da security list"
        if ($null -ne $candidate -and @(Get-Field -InputObject $candidate -Name "ingress-security-rules").Count -eq 0 -and @(Get-Field -InputObject $candidate -Name "egress-security-rules").Count -eq 0) { return $candidate }
        return $null
      } -Payload @{
        compartmentId = $CompartmentId
        vcnId = $vcnId
        displayName = $script:Contract.names.securityList
        ingressSecurityRules = @()
        egressSecurityRules = @()
        freeformTags = New-ResourceTags -ResourceKind "security-list"
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $securityList = Get-Field -InputObject $created -Name "data"
      Assert-AndRecordOwnedResource -Resource $securityList -ResourceKind "security-list"
      Set-ApprovedResourceState -ResourceKind "security-list" -Resource $securityList -OwnershipProof "created-by-approved-plan"
    }
  }
  if ($null -ne $securityList) {
    Assert-AndRecordOwnedResource -Resource $securityList -ResourceKind "security-list"
    Assert-AvailableLifecycle -Resource $securityList -Label "security list"
    Assert-True -Condition (@(Get-Field -InputObject $securityList -Name "ingress-security-rules").Count -eq 0) -SafeMessage "A security list dedicada contém ingress."
    $egress = @(Get-Field -InputObject $securityList -Name "egress-security-rules")
    Assert-True -Condition ($egress.Count -le 1) -SafeMessage "A security list dedicada contém egress extra."
    if ($egress.Count -eq 1) {
      Assert-True -Condition ([string](Get-Field -InputObject $egress[0] -Name "protocol") -ceq "all" -and [string](Get-Field -InputObject $egress[0] -Name "destination") -ceq "0.0.0.0/0" -and -not [bool](Get-Field -InputObject $egress[0] -Name "is-stateless")) -SafeMessage "O único egress da security list não é o allow-all stateful tolerado."
    }
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-no-ingress-security-list" -Reason "owned-security-list-observed-after-startup")
  }
  $Network.securityList = $securityList
}

function Get-ExpectedNsgRules {
  return @(
    @{ direction = "INGRESS"; protocol = "6"; source = "0.0.0.0/0"; sourceType = "CIDR_BLOCK"; isStateless = $false; tcpOptions = @{ destinationPortRange = @{ min = 80; max = 80 } }; description = "Set Livre HTTP" },
    @{ direction = "INGRESS"; protocol = "6"; source = "0.0.0.0/0"; sourceType = "CIDR_BLOCK"; isStateless = $false; tcpOptions = @{ destinationPortRange = @{ min = 443; max = 443 } }; description = "Set Livre HTTPS" },
    @{ direction = "INGRESS"; protocol = "6"; source = $AdministrativeCidr; sourceType = "CIDR_BLOCK"; isStateless = $false; tcpOptions = @{ destinationPortRange = @{ min = 22; max = 22 } }; description = "Set Livre administrative SSH" },
    @{ direction = "INGRESS"; protocol = "1"; source = "0.0.0.0/0"; sourceType = "CIDR_BLOCK"; isStateless = $false; icmpOptions = @{ type = 3; code = 4 }; description = "Set Livre ICMP PMTU" },
    @{ direction = "EGRESS"; protocol = "all"; destination = "0.0.0.0/0"; destinationType = "CIDR_BLOCK"; isStateless = $false; description = "Set Livre outbound" }
  )
}

function ConvertTo-NsgRuleKey {
  param([Parameter(Mandatory = $true)][object]$Rule)
  $tcp = Get-Field -InputObject $Rule -Name "tcp-options"
  $portRange = Get-Field -InputObject $tcp -Name "destination-port-range"
  if ($null -eq $portRange) { $portRange = Get-Field -InputObject $tcp -Name "destinationPortRange" }
  $icmp = Get-Field -InputObject $Rule -Name "icmp-options"
  if ($null -eq $icmp) { $icmp = Get-Field -InputObject $Rule -Name "icmpOptions" }
  $sourceType = Get-Field -InputObject $Rule -Name "source-type"
  if ($null -eq $sourceType) { $sourceType = Get-Field -InputObject $Rule -Name "sourceType" }
  $destinationType = Get-Field -InputObject $Rule -Name "destination-type"
  if ($null -eq $destinationType) { $destinationType = Get-Field -InputObject $Rule -Name "destinationType" }
  $isStateless = Get-Field -InputObject $Rule -Name "is-stateless"
  if ($null -eq $isStateless) { $isStateless = Get-Field -InputObject $Rule -Name "isStateless" }
  return @(
    [string](Get-Field -InputObject $Rule -Name "direction"),
    [string](Get-Field -InputObject $Rule -Name "protocol"),
    [string](Get-Field -InputObject $Rule -Name "source"),
    [string]$sourceType,
    [string](Get-Field -InputObject $Rule -Name "destination"),
    [string]$destinationType,
    [string](Get-Field -InputObject $portRange -Name "min"),
    [string](Get-Field -InputObject $portRange -Name "max"),
    [string](Get-Field -InputObject $icmp -Name "type"),
    [string](Get-Field -InputObject $icmp -Name "code"),
    [string][bool]$isStateless
  ) -join "|"
}

function Test-CompatiblePendingNsgRuleRequest {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$PendingRequest,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$CurrentRequest
  )

  if ((ConvertTo-CanonicalJson -Value @($PendingRequest.command)) -cne (ConvertTo-CanonicalJson -Value @($CurrentRequest.command))) {
    return $false
  }
  $pendingPayload = $PendingRequest.payload
  $currentPayload = $CurrentRequest.payload
  if (
    $pendingPayload -isnot [Collections.IDictionary] -or
    $currentPayload -isnot [Collections.IDictionary] -or
    [string](Get-Field -InputObject $pendingPayload -Name "nsgId") -cne [string](Get-Field -InputObject $currentPayload -Name "nsgId")
  ) {
    return $false
  }

  $expectedKeys = @(Get-ExpectedNsgRules | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
  $pendingKeys = @((Get-Field -InputObject $pendingPayload -Name "securityRules") | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
  $currentKeys = @((Get-Field -InputObject $currentPayload -Name "securityRules") | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
  if ($pendingKeys.Count -eq 0 -or $currentKeys.Count -eq 0) {
    return $false
  }
  if (@($pendingKeys | Where-Object { $expectedKeys -cnotcontains $_ }).Count -gt 0) {
    return $false
  }
  return @($currentKeys | Where-Object { $pendingKeys -cnotcontains $_ }).Count -eq 0
}

function Ensure-Nsg {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -eq $Network.vcn) {
    Add-PlannedAction -Action "create-production-nsg"
    return
  }
  $vcnId = [string](Get-Field -InputObject $Network.vcn -Name "id")
  $response = Invoke-OciJson -Arguments @("network", "nsg", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -Operation "listar NSGs Set Livre"
  $nsg = Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind "nsg"
  if ($null -eq $nsg) {
    Add-PlannedAction -Action "create-production-nsg"
    if (Test-MutationExecutionEnabled) {
      $created = Invoke-OciMutation -Command @("network", "nsg", "create") -Operation "criar NSG Set Livre" -MutationKey "create-production-nsg" -SupportsRetryToken -Reconcile {
        $candidate = Find-OwnedResource -ListArguments @("network", "nsg", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -ResourceKind "nsg" -Operation "reconciliar criação do NSG"
        if ($null -ne $candidate -and [string](Get-Field -InputObject $candidate -Name "vcn-id") -ceq $vcnId) { return $candidate }
        return $null
      } -Payload @{
        compartmentId = $CompartmentId
        vcnId = $vcnId
        displayName = $script:Contract.names.nsg
        freeformTags = New-ResourceTags -ResourceKind "nsg"
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $nsg = Get-Field -InputObject $created -Name "data"
      Assert-AndRecordOwnedResource -Resource $nsg -ResourceKind "nsg"
      Set-ApprovedResourceState -ResourceKind "nsg" -Resource $nsg -OwnershipProof "created-by-approved-plan"
    }
  }
  if ($null -ne $nsg) {
    Assert-AndRecordOwnedResource -Resource $nsg -ResourceKind "nsg"
    Assert-AvailableLifecycle -Resource $nsg -Label "NSG"
    Assert-True -Condition ([string](Get-Field -InputObject $nsg -Name "vcn-id") -ceq $vcnId) -SafeMessage "O NSG não pertence à VCN Set Livre."
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-production-nsg" -Reason "owned-nsg-observed-after-startup")
    $nsgId = [string](Get-Field -InputObject $nsg -Name "id")
    $rulesResponse = Invoke-OciJson -Arguments @("network", "nsg", "rules", "list", "--nsg-id", $nsgId, "--all") -Operation "listar regras do NSG Set Livre"
    $actualRules = @(Get-OciItems -Response $rulesResponse)
    $expectedRules = @(Get-ExpectedNsgRules)
    $expectedKeys = @($expectedRules | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
    $actualKeys = @($actualRules | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
    $unexpected = @($actualKeys | Where-Object { $expectedKeys -cnotcontains $_ })
    Assert-True -Condition ($unexpected.Count -eq 0) -SafeMessage "O NSG contém regra extra ou divergente."
    $missingRules = @($expectedRules | Where-Object { $actualKeys -cnotcontains (ConvertTo-NsgRuleKey -Rule $_) })
    if ($missingRules.Count -gt 0) {
      Add-PlannedAction -Action "add-missing-production-nsg-rules"
      if (Test-MutationExecutionEnabled) {
        [void](Invoke-OciMutation -Command @("network", "nsg", "rules", "add") -Operation "adicionar regras mínimas ao NSG" -MutationKey "add-missing-production-nsg-rules" -SupportsRetryToken -PendingRequestCompatibility {
            param($PendingRequest, $CurrentRequest)
            return Test-CompatiblePendingNsgRuleRequest -PendingRequest $PendingRequest -CurrentRequest $CurrentRequest
          } -Reconcile {
            $reconciledRulesResponse = Invoke-OciJson -Arguments @("network", "nsg", "rules", "list", "--nsg-id", $nsgId, "--all") -Operation "reconciliar regras do NSG"
            $reconciledKeys = @((Get-OciItems -Response $reconciledRulesResponse) | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
            if ($reconciledKeys.Count -eq $expectedKeys.Count -and @($expectedKeys | Where-Object { $reconciledKeys -cnotcontains $_ }).Count -eq 0) { return $nsg }
            return $null
          } -Payload @{ nsgId = $nsgId; securityRules = $missingRules })
        $rulesResponse = Invoke-OciJson -Arguments @("network", "nsg", "rules", "list", "--nsg-id", $nsgId, "--all") -Operation "revalidar regras do NSG Set Livre"
        $actualRules = @(Get-OciItems -Response $rulesResponse)
        $actualKeys = @($actualRules | ForEach-Object { ConvertTo-NsgRuleKey -Rule $_ })
      }
    }
    if ((Test-MutationExecutionEnabled) -or $missingRules.Count -eq 0) {
      Assert-True -Condition ($actualKeys.Count -eq $expectedKeys.Count -and (@($expectedKeys | Where-Object { $actualKeys -cnotcontains $_ }).Count -eq 0)) -SafeMessage "O NSG não corresponde às cinco regras mínimas exatas."
    }
    if ($actualKeys.Count -eq $expectedKeys.Count -and (@($expectedKeys | Where-Object { $actualKeys -cnotcontains $_ }).Count -eq 0)) {
      [void](Complete-PendingMutationFromObservedState -MutationKey "add-missing-production-nsg-rules" -Reason "exact-nsg-rules-observed-after-startup")
    }
  }
  $Network.nsg = $nsg
}

function Ensure-Subnet {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][string]$CompartmentId
  )
  if ($null -eq $Network.vcn) {
    Add-PlannedAction -Action "create-regional-public-subnet"
    return
  }
  $vcnId = [string](Get-Field -InputObject $Network.vcn -Name "id")
  $response = Invoke-OciJson -Arguments @("network", "subnet", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -Operation "listar subnets Set Livre"
  $subnet = Resolve-UniqueResource -Items @(Get-OciItems -Response $response) -ResourceKind "subnet"
  if ($null -eq $Network.routeTable -or $null -eq $Network.securityList) {
    Assert-True -Condition ($null -eq $subnet) -SafeMessage "Uma subnet Set Livre existente não pode depender de route table ou security list ainda inexistente."
    Add-PlannedAction -Action "create-regional-public-subnet"
    return
  }
  $routeTableId = [string](Get-Field -InputObject $Network.routeTable -Name "id")
  $securityListId = [string](Get-Field -InputObject $Network.securityList -Name "id")
  if ($null -eq $subnet) {
    Add-PlannedAction -Action "create-regional-public-subnet"
    if (Test-MutationExecutionEnabled) {
      $created = Invoke-OciMutation -Command @("network", "subnet", "create") -Operation "criar subnet pública regional Set Livre" -MutationKey "create-regional-public-subnet" -SupportsRetryToken -Reconcile {
        $candidate = Find-OwnedResource -ListArguments @("network", "subnet", "list", "--compartment-id", $CompartmentId, "--vcn-id", $vcnId, "--all") -ResourceKind "subnet" -Operation "reconciliar criação da subnet"
        $candidateSecurityLists = if ($null -ne $candidate) { @((Get-Field -InputObject $candidate -Name "security-list-ids") | Sort-Object) } else { @() }
        if (
          $null -ne $candidate -and
          [string](Get-Field -InputObject $candidate -Name "cidr-block") -ceq $script:Contract.subnetCidr -and
          [string](Get-Field -InputObject $candidate -Name "route-table-id") -ceq $routeTableId -and
          $candidateSecurityLists.Count -eq 1 -and [string]$candidateSecurityLists[0] -ceq $securityListId
        ) { return $candidate }
        return $null
      } -Payload @{
        compartmentId = $CompartmentId
        vcnId = $vcnId
        cidrBlock = $script:Contract.subnetCidr
        displayName = $script:Contract.names.subnet
        dnsLabel = "public"
        routeTableId = $routeTableId
        securityListIds = @($securityListId)
        prohibitPublicIpOnVnic = $false
        prohibitInternetIngress = $false
        freeformTags = New-ResourceTags -ResourceKind "subnet"
        waitForState = @("AVAILABLE")
        maxWaitSeconds = 300
        waitIntervalSeconds = 5
      }
      $subnet = Get-Field -InputObject $created -Name "data"
      Assert-AndRecordOwnedResource -Resource $subnet -ResourceKind "subnet"
      Set-ApprovedResourceState -ResourceKind "subnet" -Resource $subnet -OwnershipProof "created-by-approved-plan"
    }
  }
  if ($null -ne $subnet) {
    Assert-AndRecordOwnedResource -Resource $subnet -ResourceKind "subnet"
    Assert-AvailableLifecycle -Resource $subnet -Label "subnet"
    Assert-True -Condition ($null -eq (Get-Field -InputObject $subnet -Name "availability-domain")) -SafeMessage "A subnet deve ser regional."
    Assert-True -Condition ([string](Get-Field -InputObject $subnet -Name "cidr-block") -ceq $script:Contract.subnetCidr) -SafeMessage "A subnet não usa 10.20.1.0/24."
    Assert-True -Condition ([string](Get-Field -InputObject $subnet -Name "vcn-id") -ceq $vcnId) -SafeMessage "A subnet não pertence à VCN Set Livre."
    Assert-True -Condition ([string](Get-Field -InputObject $subnet -Name "route-table-id") -ceq $routeTableId) -SafeMessage "A subnet não usa a route table dedicada."
    Assert-True -Condition (-not [bool](Get-Field -InputObject $subnet -Name "prohibit-public-ip-on-vnic")) -SafeMessage "A subnet não permite IPv4 público na VNIC."
    Assert-True -Condition (-not [bool](Get-Field -InputObject $subnet -Name "prohibit-internet-ingress")) -SafeMessage "A subnet não está marcada como pública."
    $securityListIds = @((Get-Field -InputObject $subnet -Name "security-list-ids") | Sort-Object)
    Assert-True -Condition ($securityListIds.Count -eq 1 -and [string]$securityListIds[0] -ceq $securityListId) -SafeMessage "A subnet não usa exclusivamente a security list sem ingress."
    [void](Complete-PendingMutationFromObservedState -MutationKey "create-regional-public-subnet" -Reason "owned-subnet-observed-after-startup")
  }
  $Network.subnet = $subnet
}

function ConvertTo-PrivateResourceEvidence {
  param([AllowNull()][object]$Resource)
  if ($null -eq $Resource) { return $null }
  return [ordered]@{
    id = [string](Get-Field -InputObject $Resource -Name "id")
    displayName = [string](Get-Field -InputObject $Resource -Name "display-name")
    lifecycleState = [string](Get-Field -InputObject $Resource -Name "lifecycle-state")
  }
}

function Save-NetworkEvidence {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Network)
  $script:Evidence.facts.network = [ordered]@{
    vcn = ConvertTo-PrivateResourceEvidence -Resource $Network.vcn
    internetGateway = ConvertTo-PrivateResourceEvidence -Resource $Network.internetGateway
    routeTable = ConvertTo-PrivateResourceEvidence -Resource $Network.routeTable
    securityList = ConvertTo-PrivateResourceEvidence -Resource $Network.securityList
    subnet = ConvertTo-PrivateResourceEvidence -Resource $Network.subnet
    nsg = ConvertTo-PrivateResourceEvidence -Resource $Network.nsg
  }
}

function Get-CurrentLimitProof {
  param(
    [Parameter(Mandatory = $true)][string]$TenancyId,
    [Parameter(Mandatory = $true)][string]$TargetCompartmentId,
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [Parameter(Mandatory = $true)][string]$LimitName,
    [Parameter(Mandatory = $true)][ValidateSet("AD", "REGION")][string]$ScopeType,
    [Parameter(Mandatory = $true)][double]$AlwaysFreeCeiling,
    [Parameter(Mandatory = $true)][double]$RequiredIncrement,
    [AllowNull()][string]$AvailabilityDomain
  )

  $definitionsResponse = Invoke-OciJson -Arguments @(
    "limits", "definition", "list",
    "--compartment-id", $TenancyId,
    "--service-name", $ServiceName,
    "--name", $LimitName,
    "--all"
  ) -Operation "validar definição atual do limite $LimitName"
  $definitions = @((Get-OciItems -Response $definitionsResponse) | Where-Object {
      [string](Get-Field -InputObject $_ -Name "service-name") -ceq $ServiceName -and
      [string](Get-Field -InputObject $_ -Name "name") -ceq $LimitName
    })
  Assert-True -Condition ($definitions.Count -eq 1) -SafeMessage "A definição do limite $LimitName não foi resolvida de forma inequívoca."
  $definition = $definitions[0]
  Assert-True -Condition ([string](Get-Field -InputObject $definition -Name "scope-type") -ceq $ScopeType) -SafeMessage "O escopo do limite $LimitName diverge do contrato Always Free."
  Assert-True -Condition ([bool](Get-Field -InputObject $definition -Name "are-quotas-supported")) -SafeMessage "O limite $LimitName não permite comprovar quotas efetivas."
  Assert-True -Condition ([bool](Get-Field -InputObject $definition -Name "is-resource-availability-supported")) -SafeMessage "O limite $LimitName não permite comprovar disponibilidade efetiva."
  $isDeprecated = Get-Field -InputObject $definition -Name "is-deprecated"
  Assert-True -Condition ($null -ne $isDeprecated -and -not [bool]$isDeprecated) -SafeMessage "O limite $LimitName está ausente ou obsoleto."

  [string[]]$valueArguments = @(
    "limits", "value", "list",
    "--compartment-id", $TenancyId,
    "--service-name", $ServiceName,
    "--scope-type", $ScopeType,
    "--name", $LimitName,
    "--all"
  )
  if ($ScopeType -ceq "AD") {
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($AvailabilityDomain)) -SafeMessage "O limite $LimitName exige uma availability domain inequívoca."
    $valueArguments += @("--availability-domain", $AvailabilityDomain)
  }
  $valuesResponse = Invoke-OciJson -Arguments $valueArguments -Operation "validar valor atual do limite $LimitName"
  $values = @((Get-OciItems -Response $valuesResponse) | Where-Object { [string](Get-Field -InputObject $_ -Name "name") -ceq $LimitName })
  Assert-True -Condition ($values.Count -eq 1) -SafeMessage "O valor do limite $LimitName não foi resolvido de forma inequívoca."
  $limitValue = Get-Field -InputObject $values[0] -Name "value"
  Assert-True -Condition ($null -ne $limitValue -and [double]$limitValue -ge $AlwaysFreeCeiling) -SafeMessage "O limite $LimitName não comporta o teto Always Free publicado; nenhum fallback pago é permitido."

  [string[]]$availabilityArguments = @(
    "limits", "resource-availability", "get",
    "--compartment-id", $TargetCompartmentId,
    "--service-name", $ServiceName,
    "--limit-name", $LimitName
  )
  if ($ScopeType -ceq "AD") {
    $availabilityArguments += @("--availability-domain", $AvailabilityDomain)
  }
  $availabilityResponse = Invoke-OciJson -Arguments $availabilityArguments -Operation "validar quota efetiva atual de $LimitName"
  $availability = Get-Field -InputObject $availabilityResponse -Name "data"
  $wholeAvailable = Get-Field -InputObject $availability -Name "available"
  $wholeUsed = Get-Field -InputObject $availability -Name "used"
  Assert-True -Condition ($null -ne $wholeAvailable -and $null -ne $wholeUsed) -SafeMessage "A disponibilidade do limite $LimitName é incerta."
  $fractionalAvailable = Get-Field -InputObject $availability -Name "fractional-availability"
  $fractionalUsed = Get-Field -InputObject $availability -Name "fractional-usage"
  $effectiveAvailable = if ($null -ne $fractionalAvailable) { [double]$fractionalAvailable } else { [double]$wholeAvailable }
  $effectiveUsed = if ($null -ne $fractionalUsed) { [double]$fractionalUsed } else { [double]$wholeUsed }
  Assert-True -Condition ($effectiveAvailable -ge $RequiredIncrement) -SafeMessage "A quota efetiva de $LimitName não comporta o incremento Always Free."
  $effectiveQuotaValue = Get-Field -InputObject $availability -Name "effective-quota-value"
  if ($null -ne $effectiveQuotaValue) {
    Assert-True -Condition ([double]$effectiveQuotaValue -ge ($effectiveUsed + $RequiredIncrement)) -SafeMessage "A quota de compartment para $LimitName bloqueia o alvo Always Free."
  }

  return [ordered]@{
    service = $ServiceName
    name = $LimitName
    scope = $ScopeType
    serviceLimit = [double]$limitValue
    alwaysFreeCeiling = $AlwaysFreeCeiling
    available = $effectiveAvailable
    used = $effectiveUsed
    requiredIncrement = $RequiredIncrement
    effectiveQuotaValue = if ($null -ne $effectiveQuotaValue) { [double]$effectiveQuotaValue } else { $null }
  }
}

function Assert-ServiceLimitsAndAlwaysFreeEnvelope {
  param(
    [Parameter(Mandatory = $true)][string]$TenancyId,
    [Parameter(Mandatory = $true)][string]$TargetCompartmentId,
    [Parameter(Mandatory = $true)][string]$AvailabilityDomain,
    [Parameter(Mandatory = $true)][object[]]$Compartments,
    [AllowNull()][object]$ExistingTarget,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Platform
  )

  Assert-True -Condition (
    $script:Contract.shape -ceq "VM.Standard.E2.1.Micro" -and
    $script:Contract.architecture -ceq "x86_64" -and
    $script:Contract.ocpus -eq 1.0 -and
    $script:Contract.memoryInGBs -eq 1.0 -and
    $script:Contract.alwaysFreeInstanceCeiling -eq 2.0 -and
    $script:Contract.bootVolumeInGBs -eq 50 -and
    $script:Contract.bootVolumeVpusPerGB -eq 10 -and
    $script:Contract.bootVolumePerformanceClass -ceq "BALANCED"
  ) -SafeMessage "O contrato local não corresponde ao alvo Always Free E2.1.Micro x86_64 com boot volume Balanced de 50 GB."
  Assert-True -Condition ([string](Get-Field -InputObject $Platform.shape -Name "shape") -ceq $script:Contract.shape) -SafeMessage "O shape atual não corresponde ao alvo E2.1.Micro Always Free."
  Assert-True -Condition (Test-NoMarketplaceImageListing -Image $Platform.image) -SafeMessage "A imagem selecionada não comprova ausência de licença Marketplace."
  $rawImageListingType = Get-Field -InputObject $Platform.image -Name "listing-type"
  $imageListingType = if ($null -eq $rawImageListingType -or [string]::IsNullOrWhiteSpace([string]$rawImageListingType)) { "NONE" } else { [string]$rawImageListingType }

  $limitFacts = [ordered]@{}
  $instanceRequired = if ($null -eq $ExistingTarget) { 1.0 } else { 0.0 }
  foreach ($limit in @(
      @{ Name = "standard-e2-micro-core-count" },
      @{ Name = "vm-standard-e2-1-micro-count" }
    )) {
    $limitFacts[$limit.Name] = Get-CurrentLimitProof -TenancyId $TenancyId -TargetCompartmentId $TargetCompartmentId -ServiceName "compute" -LimitName $limit.Name -ScopeType "AD" -AlwaysFreeCeiling $script:Contract.alwaysFreeInstanceCeiling -RequiredIncrement $instanceRequired -AvailabilityDomain $AvailabilityDomain
  }
  $computeAliasFacts = @($limitFacts["standard-e2-micro-core-count"], $limitFacts["vm-standard-e2-1-micro-count"])
  $conservativeAliasAvailable = [double](($computeAliasFacts | ForEach-Object { [double]$_.available } | Measure-Object -Minimum).Minimum)
  $conservativeAliasUsed = [double](($computeAliasFacts | ForEach-Object { [double]$_.used } | Measure-Object -Maximum).Maximum)
  Assert-True -Condition ($conservativeAliasUsed -le $script:Contract.alwaysFreeInstanceCeiling) -SafeMessage "Os aliases de limite E2 indicam uso superior ao teto Always Free."
  Assert-True -Condition ($conservativeAliasAvailable -ge $instanceRequired) -SafeMessage "A menor disponibilidade entre os aliases E2 não comporta a alocação planejada."

  $vcnRequired = if ($null -eq $Network.vcn) { 1.0 } else { 0.0 }
  $limitFacts["vcn-count"] = Get-CurrentLimitProof -TenancyId $TenancyId -TargetCompartmentId $TargetCompartmentId -ServiceName "vcn" -LimitName "vcn-count" -ScopeType "REGION" -AlwaysFreeCeiling $script:Contract.alwaysFreeVcnCeiling -RequiredIncrement $vcnRequired

  $allE2MicroInstances = [Collections.Generic.List[object]]::new()
  $bootVolumeTotal = 0.0
  $blockVolumeTotal = 0.0
  foreach ($compartment in $Compartments) {
    $state = [string](Get-Field -InputObject $compartment -Name "lifecycle-state")
    if ($state -and $state -cne "ACTIVE") { continue }
    $compartmentId = [string](Get-Field -InputObject $compartment -Name "id")
    if ([string]::IsNullOrWhiteSpace($compartmentId)) { continue }
    $instancesResponse = Invoke-OciJson -Arguments @("compute", "instance", "list", "--compartment-id", $compartmentId, "--all") -Operation "inventariar uso E2.1.Micro da tenancy" -AllowEmptyData
    foreach ($instance in @(Get-OciItems -Response $instancesResponse)) {
      $lifecycle = [string](Get-Field -InputObject $instance -Name "lifecycle-state")
      if ($lifecycle -notin @("TERMINATED", "TERMINATING") -and [string](Get-Field -InputObject $instance -Name "shape") -ceq $script:Contract.shape) {
        $allE2MicroInstances.Add($instance)
      }
    }
    $bootResponse = Invoke-OciJson -Arguments @("bv", "boot-volume", "list", "--compartment-id", $compartmentId, "--availability-domain", $AvailabilityDomain, "--all") -Operation "inventariar boot volumes Always Free" -AllowEmptyData
    foreach ($volume in @(Get-OciItems -Response $bootResponse)) {
      if ([string](Get-Field -InputObject $volume -Name "lifecycle-state") -notin @("TERMINATED", "TERMINATING")) {
        $bootVolumeTotal += [double](Get-Field -InputObject $volume -Name "size-in-gbs")
      }
    }
    $blockResponse = Invoke-OciJson -Arguments @("bv", "volume", "list", "--compartment-id", $compartmentId, "--all") -Operation "inventariar block volumes Always Free" -AllowEmptyData
    foreach ($volume in @(Get-OciItems -Response $blockResponse)) {
      if ([string](Get-Field -InputObject $volume -Name "lifecycle-state") -notin @("TERMINATED", "TERMINATING")) {
        $blockVolumeTotal += [double](Get-Field -InputObject $volume -Name "size-in-gbs")
      }
    }
  }

  if ($null -ne $ExistingTarget) {
    $targetId = [string](Get-Field -InputObject $ExistingTarget -Name "id")
    $targetMatches = @($allE2MicroInstances | Where-Object { [string](Get-Field -InputObject $_ -Name "id") -ceq $targetId })
    Assert-True -Condition ($targetMatches.Count -eq 1) -SafeMessage "A VM E2 existente não aparece exatamente uma vez no inventário agregado da tenancy."
  }
  $plannedInstanceCount = $allE2MicroInstances.Count + $(if ($null -eq $ExistingTarget) { 1 } else { 0 })
  $plannedStorage = $bootVolumeTotal + $blockVolumeTotal + $(if ($null -eq $ExistingTarget) { $script:Contract.bootVolumeInGBs } else { 0 })
  Assert-True -Condition ($plannedInstanceCount -le $script:Contract.alwaysFreeInstanceCeiling) -SafeMessage "O uso E2.1.Micro agregado ultrapassaria duas VMs Always Free na tenancy."
  Assert-True -Condition ($plannedStorage -le $script:Contract.alwaysFreeVolumeCeilingInGBs) -SafeMessage "O uso agregado de volumes ultrapassaria 200 GB Always Free."

  $storageRequired = if ($null -eq $ExistingTarget) { [double]$script:Contract.bootVolumeInGBs } else { 0.0 }
  $limitFacts["total-storage-gb"] = Get-CurrentLimitProof -TenancyId $TenancyId -TargetCompartmentId $TargetCompartmentId -ServiceName "block-storage" -LimitName "total-storage-gb" -ScopeType "AD" -AlwaysFreeCeiling $script:Contract.alwaysFreeVolumeCeilingInGBs -RequiredIncrement $storageRequired -AvailabilityDomain $AvailabilityDomain

  $facts = [ordered]@{
    quotaContract = "OCI tenancy limits inspected for two fixed E2.1.Micro instances, 200 GB combined volumes, and two VCNs in the home region"
    desiredFreeTierEnvelope = [ordered]@{
      architecture = $script:Contract.architecture
      imageListingType = $imageListingType
      bootVolumePerformanceClass = $script:Contract.bootVolumePerformanceClass
      bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
      publicIpv4 = "one-ephemeral-address-attached-to-validated-target"
      paidFallbackAllowed = $false
    }
    automatedBillingOrPriceProof = $false
    serviceLimits = $limitFacts
    computeLimitAliasEnvelope = [ordered]@{
      strategy = "minimum-available-maximum-used-aliases-not-summed"
      available = $conservativeAliasAvailable
      used = $conservativeAliasUsed
      chargedIncrement = $instanceRequired
    }
    existingE2MicroInstanceCount = $allE2MicroInstances.Count
    aggregateAfterPlan = [ordered]@{ instanceCount = $plannedInstanceCount; combinedVolumeInGBs = $plannedStorage }
  }
  $script:Evidence.facts.alwaysFree = $facts
  return [ordered]@{ automatedZeroCostProven = $false; quotaProven = $true; facts = $facts }
}

function Resolve-UniqueTargetInstance {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Items)

  $persistedId = Get-PersistedApprovedOcid -ResourceKind "instance"
  $persistedWasObserved = [string]::IsNullOrWhiteSpace($persistedId)
  $candidates = [Collections.Generic.List[object]]::new()
  $unapprovedNameCollisions = [Collections.Generic.List[object]]::new()
  foreach ($item in $Items) {
    $lifecycle = [string](Get-Field -InputObject $item -Name "lifecycle-state")
    if ($lifecycle -in @("TERMINATED", "TERMINATING")) { continue }
    $id = [string](Get-Field -InputObject $item -Name "id")
    $nameMatches = [string](Get-Field -InputObject $item -Name "display-name") -ceq $script:Contract.names.instance
    $persistedMatches = -not [string]::IsNullOrWhiteSpace($persistedId) -and $id -ceq $persistedId
    if ($persistedMatches) { $persistedWasObserved = $true }
    $tagMatches = Test-ExactResourceTags -Resource $item -ResourceKind "instance"
    if ($persistedMatches -or $tagMatches) {
      Assert-True -Condition $nameMatches -SafeMessage "Uma instância identificada como Set Livre não usa o display name E2 canônico."
      Assert-NoForbiddenTargetName -Resource $item -ResourceLabel "instance"
      $candidates.Add($item)
    } elseif ($nameMatches) {
      $unapprovedNameCollisions.Add($item)
    }
  }

  Assert-True -Condition $persistedWasObserved -SafeMessage "O OCID persistido da VM E2 não existe mais no inventário consultado."
  Assert-True -Condition ($unapprovedNameCollisions.Count -eq 0) -SafeMessage "Existe uma instância com o display name Set Livre, mas sem as tags E2 aprovadas."
  Assert-True -Condition ($candidates.Count -le 1) -SafeMessage "Mais de uma instância candidata foi encontrada para a VM E2 Set Livre."
  if ($candidates.Count -eq 0) { return $null }
  return $candidates[0]
}

function Assert-TargetInstanceOwnershipCandidate {
  param([Parameter(Mandatory = $true)][object]$Instance)

  $id = [string](Get-Field -InputObject $Instance -Name "id")
  $persistedId = Get-PersistedApprovedOcid -ResourceKind "instance"
  $persistedMatches = -not [string]::IsNullOrWhiteSpace($persistedId) -and $id -ceq $persistedId
  $tagMatches = Test-ExactResourceTags -Resource $Instance -ResourceKind "instance"
  Assert-True -Condition ($tagMatches -or $persistedMatches) -SafeMessage "A VM E2 não possui tags aprovadas nem OCID privado previamente validado."
  Assert-True -Condition ([string](Get-Field -InputObject $Instance -Name "display-name") -ceq $script:Contract.names.instance) -SafeMessage "A VM E2 não usa o display name canônico Set Livre."
}

function Assert-UbuntuE2ImageContract {
  param(
    [Parameter(Mandatory = $true)][object]$Image,
    [switch]$VerifyShapeCompatibility
  )

  $imageId = [string](Get-Field -InputObject $Image -Name "id")
  Assert-True -Condition ($imageId -match "^ocid1[.]image[.]") -SafeMessage "A imagem Ubuntu não possui OCID inequívoco."
  Assert-True -Condition (
    [string](Get-Field -InputObject $Image -Name "display-name") -cmatch $script:Contract.imagePattern -and
    [string](Get-Field -InputObject $Image -Name "operating-system") -match "(?i)Ubuntu" -and
    [string](Get-Field -InputObject $Image -Name "operating-system-version") -match "^24[.]04" -and
    (Test-NoMarketplaceImageListing -Image $Image)
  ) -SafeMessage "A imagem não comprova Ubuntu 24.04 x86_64 sem licença Marketplace."
  if ($VerifyShapeCompatibility) {
    $compatibilityResponse = Invoke-OciJson -Arguments @(
      "compute", "image-shape-compatibility-entry", "get",
      "--image-id", $imageId,
      "--shape-name", $script:Contract.shape
    ) -Operation "comprovar compatibilidade x86_64 entre imagem e E2.1.Micro"
    Assert-True -Condition ($null -ne (Get-Field -InputObject $compatibilityResponse -Name "data")) -SafeMessage "A imagem não possui entrada de compatibilidade com E2.1.Micro."
  }
}

function Get-TargetInstance {
  param([Parameter(Mandatory = $true)][string]$CompartmentId)
  $response = Invoke-OciJson -Arguments @("compute", "instance", "list", "--compartment-id", $CompartmentId, "--all") -Operation "listar instâncias Set Livre" -AllowEmptyData
  return Resolve-UniqueTargetInstance -Items @(Get-OciItems -Response $response)
}

function Assert-CapacityAvailable {
  param(
    [Parameter(Mandatory = $true)][string]$TenancyId,
    [Parameter(Mandatory = $true)][string]$AvailabilityDomain
  )
  # Compute capacity reports use a POST but create no infrastructure resource; this is a read-only planning probe.
  $response = Invoke-AllowlistedPlanRemoteProbe -ProbeName "compute-capacity-report" -Arguments @(
    "compute", "compute-capacity-report", "create",
    "--compartment-id", $TenancyId,
    "--availability-domain", $AvailabilityDomain,
    "--shape-availabilities", (@(@{ instanceShape = $script:Contract.shape }) | ConvertTo-Json -Depth 8 -Compress -AsArray)
  ) -Operation "consultar capacity report E2.1.Micro"
  $data = Get-Field -InputObject $response -Name "data"
  $capacityCreatedAtText = [string](Get-Field -InputObject $data -Name "time-created")
  try {
    $capacityCreatedAt = [DateTimeOffset]::Parse($capacityCreatedAtText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  } catch {
    throw "O capacity report E2.1.Micro não possui timestamp atual inequívoco."
  }
  $capacityAge = [DateTimeOffset]::UtcNow - $capacityCreatedAt
  Assert-True -Condition ($capacityAge.TotalSeconds -ge 0 -and $capacityAge.TotalSeconds -le $script:Contract.preflightMaximumAgeSeconds) -SafeMessage "O capacity report E2.1.Micro está expirado; o launch foi bloqueado."
  $entries = @(Get-Field -InputObject $data -Name "shape-availabilities")
  Assert-True -Condition ($entries.Count -eq 1) -SafeMessage "O capacity report E2.1.Micro não retornou uma entrada inequívoca."
  $status = [string](Get-Field -InputObject $entries[0] -Name "availability-status")
  $fact = [ordered]@{
    shape = $script:Contract.shape
    architecture = $script:Contract.architecture
    status = $status
    newAllocationRequired = $true
    validatedAtUtc = $capacityCreatedAt
    probe = "compute-capacity-report"
    persistentMutation = $false
  }
  $script:Evidence.facts.capacity = $fact
  if ($status -ceq "OUT_OF_HOST_CAPACITY") {
    $script:Evidence.status = "blocked-out-of-host-capacity"
    [void](Write-Evidence)
    throw "OUT_OF_HOST_CAPACITY para E2.1.Micro; nenhum fallback pago ou de outro shape foi tentado."
  }
  Assert-True -Condition ($status -ceq "AVAILABLE") -SafeMessage "A capacidade E2.1.Micro está incerta; o launch foi bloqueado."
  return $fact
}

function Get-ExistingTargetCapacityProof {
  param(
    [Parameter(Mandatory = $true)][object]$ExistingTarget,
    [Parameter(Mandatory = $true)][string]$CompartmentId,
    [Parameter(Mandatory = $true)][string]$AvailabilityDomain
  )

  $instanceId = [string](Get-Field -InputObject $ExistingTarget -Name "id")
  Assert-True -Condition ($instanceId -match "^ocid1[.]instance[.]") -SafeMessage "A instância existente não possui identidade inequívoca."
  $instanceResponse = Invoke-OciJson -Arguments @("compute", "instance", "get", "--instance-id", $instanceId) -Operation "atualizar estado da instância Set Livre"
  $instance = Get-Field -InputObject $instanceResponse -Name "data"
  Assert-True -Condition ([string](Get-Field -InputObject $instance -Name "id") -ceq $instanceId) -SafeMessage "A leitura atual da instância Set Livre diverge do inventário."
  Assert-TargetInstanceOwnershipCandidate -Instance $instance
  $lifecycle = [string](Get-Field -InputObject $instance -Name "lifecycle-state")
  Assert-True -Condition ($lifecycle -in @("RUNNING", "STOPPED")) -SafeMessage "A instância existente não comprova capacidade utilizável atual."
  Assert-True -Condition ([string](Get-Field -InputObject $instance -Name "compartment-id") -ceq $CompartmentId) -SafeMessage "A instância existente não pertence ao compartment SetLivre."
  Assert-True -Condition ([string](Get-Field -InputObject $instance -Name "availability-domain") -ceq $AvailabilityDomain) -SafeMessage "A instância existente não pertence à availability domain esperada."
  Assert-True -Condition ([string](Get-Field -InputObject $instance -Name "shape") -ceq $script:Contract.shape) -SafeMessage "A instância existente não usa o shape fixo E2.1.Micro."

  $imageResponse = Invoke-OciJson -Arguments @("compute", "image", "get", "--image-id", [string](Get-Field -InputObject $instance -Name "image-id")) -Operation "validar custo da imagem existente"
  $image = Get-Field -InputObject $imageResponse -Name "data"
  Assert-UbuntuE2ImageContract -Image $image -VerifyShapeCompatibility

  $attachmentsResponse = Invoke-OciJson -Arguments @("compute", "boot-volume-attachment", "list", "--compartment-id", $CompartmentId, "--availability-domain", $AvailabilityDomain, "--instance-id", $instanceId, "--all") -Operation "validar boot volume existente antes do preflight"
  $attachments = @((Get-OciItems -Response $attachmentsResponse) | Where-Object { [string](Get-Field -InputObject $_ -Name "lifecycle-state") -notin @("DETACHED", "TERMINATED") })
  Assert-True -Condition ($attachments.Count -eq 1) -SafeMessage "A instância existente não possui boot volume inequívoco."
  $bootResponse = Invoke-OciJson -Arguments @("bv", "boot-volume", "get", "--boot-volume-id", [string](Get-Field -InputObject $attachments[0] -Name "boot-volume-id")) -Operation "validar custo do boot volume existente"
  $bootVolume = Get-Field -InputObject $bootResponse -Name "data"
  Assert-True -Condition ([double](Get-Field -InputObject $bootVolume -Name "size-in-gbs") -eq $script:Contract.bootVolumeInGBs) -SafeMessage "O boot volume existente não possui exatamente 50 GB."
  Assert-True -Condition ([double](Get-Field -InputObject $bootVolume -Name "vpus-per-gb") -eq $script:Contract.bootVolumeVpusPerGB) -SafeMessage "O boot volume existente não usa desempenho Balanced de 10 VPUs/GB."
  $autoTuneEnabled = Get-Field -InputObject $bootVolume -Name "is-auto-tune-enabled"
  Assert-True -Condition ($null -ne $autoTuneEnabled -and -not [bool]$autoTuneEnabled) -SafeMessage "O estado de autotune do boot volume existente é ambíguo ou está habilitado."

  $fact = [ordered]@{
    shape = $script:Contract.shape
    architecture = $script:Contract.architecture
    status = "EXISTING_TARGET_NO_NEW_ALLOCATION"
    newAllocationRequired = $false
    validatedAtUtc = [DateTimeOffset]::UtcNow
  }
  $script:Evidence.facts.capacity = $fact
  return [ordered]@{ instance = $instance; fact = $fact }
}

function Complete-AlwaysFreePreflight {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$AlwaysFreeProof,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$CapacityProof
  )

  Assert-True -Condition (-not [bool]$AlwaysFreeProof.automatedZeroCostProven -and [bool]$AlwaysFreeProof.quotaProven) -SafeMessage "O preflight automatizado deve comprovar quotas sem alegar prova de preço zero."
  $capacityStatus = [string]$CapacityProof.status
  Assert-True -Condition ($capacityStatus -in @("AVAILABLE", "EXISTING_TARGET_NO_NEW_ALLOCATION")) -SafeMessage "O preflight não comprovou capacidade atual."
  Assert-True -Condition ($CapacityProof.validatedAtUtc -is [DateTimeOffset]) -SafeMessage "O timestamp da prova de capacidade é ambíguo."
  $capacityAge = [DateTimeOffset]::UtcNow - [DateTimeOffset]$CapacityProof.validatedAtUtc
  Assert-True -Condition ($capacityAge.TotalSeconds -ge 0 -and $capacityAge.TotalSeconds -le $script:Contract.preflightMaximumAgeSeconds) -SafeMessage "A prova de capacidade expirou antes da conclusão do preflight."
  $validatedAt = [DateTimeOffset]::UtcNow
  $script:OciMutationPreflight = [ordered]@{
    validatedAtUtc = $validatedAt
    region = $script:Contract.region
    shape = $script:Contract.shape
    ocpus = $script:Contract.ocpus
    memoryInGBs = $script:Contract.memoryInGBs
    bootVolumeInGBs = $script:Contract.bootVolumeInGBs
    bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
    automatedZeroCostProven = $false
    humanZeroCostConfirmed = [bool]($Apply -and $ZeroCostConfirmation -ceq $script:Contract.zeroCostConfirmation)
    quotaProven = $true
    capacityProven = $true
    launchCapacityProven = $capacityStatus -ceq "AVAILABLE"
    publicIpv4IncludedInHumanEstimate = [bool]($Apply -and $ZeroCostConfirmation -ceq $script:Contract.zeroCostConfirmation)
  }
  $script:Evidence.facts.preflight = [ordered]@{
    validatedAtUtc = $validatedAt.ToString("o")
    maximumAgeSeconds = $script:Contract.preflightMaximumAgeSeconds
    automatedZeroCostProven = $false
    humanZeroCostConfirmed = [bool]$script:OciMutationPreflight.humanZeroCostConfirmed
    quotaProven = $true
    capacityStatus = $capacityStatus
    launchCapacityProven = [bool]$script:OciMutationPreflight.launchCapacityProven
    publicIpv4IncludedInHumanEstimate = [bool]$script:OciMutationPreflight.publicIpv4IncludedInHumanEstimate
  }
}

function ConvertTo-PlanResourceSnapshot {
  param(
    [AllowNull()][object]$Resource,
    [Parameter(Mandatory = $true)][string]$ResourceKind
  )

  if ($null -eq $Resource) {
    return $null
  }
  $id = [string](Get-Field -InputObject $Resource -Name "id")
  $persistedId = Get-PersistedApprovedOcid -ResourceKind $ResourceKind
  $pending = Get-PendingTagNormalization -ResourceKind $ResourceKind
  $pendingId = if ($null -eq $pending) { $null } else { [string]$pending.id }
  $ownershipProof = if (Test-ExactResourceTags -Resource $Resource -ResourceKind $ResourceKind) {
    "exact-tags"
  } elseif (-not [string]::IsNullOrWhiteSpace($pendingId) -and $id -ceq $pendingId -and (Test-V1TagSourceContract -Resource $Resource -ResourceKind $ResourceKind)) {
    "v1-to-v2-normalization-required"
  } elseif ($id -ceq $persistedId) {
    "persisted-approved-ocid"
  } else {
    "invalid"
  }
  return [ordered]@{
    id = $id
    displayName = [string](Get-Field -InputObject $Resource -Name "display-name")
    lifecycleState = [string](Get-Field -InputObject $Resource -Name "lifecycle-state")
    ownershipProof = $ownershipProof
  }
}

function Get-PendingTagNormalizationPlanSnapshot {
  $snapshot = [Collections.Generic.List[object]]::new()
  foreach ($resourceKind in @($script:PrivateState.pendingTagNormalizations.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
    $record = $script:PrivateState.pendingTagNormalizations[$resourceKind]
    $api = Get-TagNormalizationApiContract -ResourceKind $resourceKind -ResourceId ([string]$record.id)
    Assert-True -Condition ($script:Evidence.plannedActions -ccontains [string]$api.mutationKey) -SafeMessage "Uma normalização de tags pendente não corresponde a nenhuma ação do Plan atual."
    $snapshot.Add([ordered]@{
        resourceKind = $resourceKind
        id = [string]$record.id
        mutationKey = [string]$api.mutationKey
        transitionContract = [string]$record.transitionContract
        sourceManagedBy = [string]$record.sourceManagedBy
        targetManagedBy = [string]$record.targetManagedBy
        concurrencyControl = "etag-if-match"
        postStateProof = "exact-tags"
      })
  }
  return @($snapshot)
}

function Get-PendingMutationPlanSnapshot {
  $snapshot = [Collections.Generic.List[object]]::new()
  foreach ($entry in @($script:PrivateState.retryTokens.GetEnumerator() | Sort-Object { [string]$_.Key })) {
    $record = $entry.Value
    Assert-True -Condition ($script:Evidence.plannedActions -ccontains [string]$entry.Key) -SafeMessage "Uma mutação OCI pendente não corresponde a nenhuma ação do Plan atual."
    $snapshot.Add([ordered]@{
        mutationKey = [string]$entry.Key
        requestSha256 = [string]$record.requestSha256
        originApprovedPlanSha256 = [string]$record.originApprovedPlanSha256
        createdAtUnixSeconds = [long]$record.createdAtUnixSeconds
        expiresAtUnixSeconds = [long]$record.expiresAtUnixSeconds
      })
  }
  return , @($snapshot)
}

function New-CanonicalPlanDocument {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [AllowNull()][object]$ExistingInstance,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$PublicKey,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Platform,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$AlwaysFreeProof,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$CapacityProof
  )

  if ($Apply) {
    Assert-True -Condition ($null -ne $script:ApprovedPlan) -SafeMessage "O Apply não carregou um Plan privado aprovado."
    $planId = [string]$script:ApprovedPlan.planId
    $createdAtUnixSeconds = [long]$script:ApprovedPlan.createdAtUnixSeconds
    $expiresAtUnixSeconds = [long]$script:ApprovedPlan.expiresAtUnixSeconds
  } else {
    $createdAt = [DateTimeOffset]::UtcNow
    $planId = [Guid]::NewGuid().ToString("N")
    $createdAtUnixSeconds = $createdAt.ToUnixTimeSeconds()
    $expiresAtUnixSeconds = $createdAt.AddSeconds($script:Contract.preflightMaximumAgeSeconds).ToUnixTimeSeconds()
  }

  return [ordered]@{
    schemaVersion = $script:Contract.planSchemaVersion
    status = "awaiting-human-zero-cost-confirmation"
    planId = $planId
    createdAtUnixSeconds = $createdAtUnixSeconds
    expiresAtUnixSeconds = $expiresAtUnixSeconds
    project = "set-livre"
    region = $script:Contract.region
    administrativeCidr = $AdministrativeCidr
    identity = [ordered]@{
      tenancyId = [string]$script:Evidence.facts.identity.tenancyId
      compartmentId = [string]$script:Evidence.facts.identity.compartmentId
    }
    desired = [ordered]@{
      vcnCidr = $script:Contract.vcnCidr
      subnetCidr = $script:Contract.subnetCidr
      shape = $script:Contract.shape
      architecture = $script:Contract.architecture
      ocpus = $script:Contract.ocpus
      memoryInGBs = $script:Contract.memoryInGBs
      bootVolumeInGBs = $script:Contract.bootVolumeInGBs
      bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
      imageId = [string](Get-Field -InputObject $Platform.image -Name "id")
      publicKeySha256 = [string]$PublicKey.sha256
      publicIpv4Lifetime = "EPHEMERAL"
      paidFallbackAllowed = $false
    }
    currentResources = [ordered]@{
      vcn = ConvertTo-PlanResourceSnapshot -Resource $Network.vcn -ResourceKind "vcn"
      internetGateway = ConvertTo-PlanResourceSnapshot -Resource $Network.internetGateway -ResourceKind "internet-gateway"
      routeTable = ConvertTo-PlanResourceSnapshot -Resource $Network.routeTable -ResourceKind "route-table"
      securityList = ConvertTo-PlanResourceSnapshot -Resource $Network.securityList -ResourceKind "security-list"
      nsg = ConvertTo-PlanResourceSnapshot -Resource $Network.nsg -ResourceKind "nsg"
      subnet = ConvertTo-PlanResourceSnapshot -Resource $Network.subnet -ResourceKind "subnet"
      instance = ConvertTo-PlanResourceSnapshot -Resource $ExistingInstance -ResourceKind "instance"
    }
    tagNormalizations = @(Get-PendingTagNormalizationPlanSnapshot)
    quotaAndCapacity = [ordered]@{
      quotaProven = [bool]$AlwaysFreeProof.quotaProven
      automatedZeroCostProven = [bool]$AlwaysFreeProof.automatedZeroCostProven
      serviceLimits = $AlwaysFreeProof.facts.serviceLimits
      aggregateAfterPlan = $AlwaysFreeProof.facts.aggregateAfterPlan
      capacityStatus = [string]$CapacityProof.status
      newAllocationRequired = [bool]$CapacityProof.newAllocationRequired
    }
    humanCostGate = [ordered]@{
      automatedPriceOrBillingProof = $false
      oracleEstimateAndAlwaysFreeBadgeMustBeReviewed = $true
      requiredConfirmation = $script:Contract.zeroCostConfirmation
      includesEphemeralPublicIpv4 = $true
    }
    pendingMutations = @(Get-PendingMutationPlanSnapshot)
    plannedActions = @($script:Evidence.plannedActions)
  }
}

function Seal-OrVerifyCurrentPlan {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$CurrentPlan)

  $canonical = ConvertTo-CanonicalJson -Value $CurrentPlan
  $hash = Get-Sha256HexForText -Text $canonical
  if ($Apply) {
    Assert-True -Condition ($hash -ceq $ApprovedPlanSha256) -SafeMessage "O estado OCI atual diverge do SHA-256 do Plan aprovado."
    Assert-True -Condition ($canonical -ceq $script:ApprovedPlanRaw) -SafeMessage "O estado OCI atual diverge do conteúdo canônico do Plan aprovado."
    $script:CurrentPlanSha256 = $hash
    $script:PrivateState.lastApprovedPlanSha256 = $hash
    Save-PrivateProvisioningState
    return $hash
  }

  Write-PrivateTextFile -Path $script:PlanFile -Text $canonical
  $persistedHash = (Get-FileHash -LiteralPath $script:PlanFile -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True -Condition ($persistedHash -ceq $hash) -SafeMessage "O hash do Plan privado persistido diverge do conteúdo canônico."
  $script:CurrentPlanSha256 = $hash
  return $hash
}

function Assert-PhysicalPublicKey {
  param(
    [string]$UserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
    [AllowNull()][string]$SshKeygenPath
  )

  $sshRoot = [IO.Path]::GetFullPath((Join-Path $UserProfile ".ssh"))
  $privateKey = [IO.Path]::GetFullPath((Join-Path $sshRoot "set-livre-production-admin"))
  $publicKey = [IO.Path]::GetFullPath((Join-Path $sshRoot "set-livre-production-admin.pub"))
  Assert-PrivatePathAncestorAclContract -Path $privateKey -TrustedRoot $sshRoot -SafeLabel "A chave privada SSH Set Livre"
  Assert-PrivatePathAncestorAclContract -Path $publicKey -TrustedRoot $sshRoot -SafeLabel "A chave pública SSH Set Livre"
  Assert-PrivateFileAclContract -Path $privateKey -SafeLabel "A chave privada SSH Set Livre"
  Assert-NoUntrustedFileWriters -Path $publicKey -SafeLabel "A chave pública SSH Set Livre" -AllowCurrentUser
  $privateItem = Get-Item -LiteralPath $privateKey -Force
  $publicItem = Get-Item -LiteralPath $publicKey -Force
  Assert-True -Condition ($privateItem.Length -gt 0 -and $privateItem.Length -le 65536) -SafeMessage "O arquivo de chave privada SSH tem tamanho inválido."
  Assert-True -Condition ($publicItem.Length -gt 0 -and $publicItem.Length -le 16384) -SafeMessage "O arquivo de chave pública SSH tem tamanho inválido."
  $publicKeyRaw = [IO.File]::ReadAllText($publicKey, [Text.UTF8Encoding]::new($false))
  $lines = @($publicKeyRaw -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  Assert-True -Condition ($lines.Count -eq 1 -and $lines[0] -match "^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: .*)?$") -SafeMessage "A chave pública deve conter exatamente uma chave Ed25519."
  if ([string]::IsNullOrWhiteSpace($SshKeygenPath)) {
    $SshKeygenPath = Resolve-TrustedSshKeygen
  }
  $derivedPublicKey = Get-PublicKeyFromPrivateKey -PrivateKeyPath $privateKey -SshKeygenPath $SshKeygenPath
  $publicKeyFields = $lines[0].Trim() -split "\s+"
  $derivedFields = $derivedPublicKey -split "\s+"
  Assert-True -Condition ($publicKeyFields.Count -ge 2 -and $derivedFields.Count -eq 2 -and $publicKeyFields[0] -ceq $derivedFields[0] -and $publicKeyFields[1] -ceq $derivedFields[1]) -SafeMessage "A chave pública SSH não corresponde à chave privada protegida."

  $validatedPublicKey = $publicKeyFields[0] + " " + $publicKeyFields[1]
  $publicKeyHash = Get-Sha256HexForText -Text $validatedPublicKey
  $script:Evidence.facts.publicKey = [ordered]@{
    path = $publicKey
    sha256 = $publicKeyHash
    type = "ssh-ed25519"
    privateKeyAclValidated = $true
    keyPairValidated = $true
  }
  return [ordered]@{ path = $publicKey; text = $validatedPublicKey; sha256 = $publicKeyHash }
}

function Select-OnlyPrimaryVnic {
  param([Parameter(Mandatory = $true)][object[]]$Vnics)

  Assert-True -Condition ($Vnics.Count -eq 1) -SafeMessage "A instância deve possuir exatamente uma VNIC total."
  Assert-True -Condition ([bool](Get-Field -InputObject $Vnics[0] -Name "is-primary")) -SafeMessage "A única VNIC da instância deve ser primária."
  return $Vnics[0]
}

function Assert-InstanceContract {
  param(
    [Parameter(Mandatory = $true)][object]$Instance,
    [Parameter(Mandatory = $true)][string]$CompartmentId,
    [Parameter(Mandatory = $true)][string]$AvailabilityDomain,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$PublicKey
  )
  Assert-NoForbiddenTargetName -Resource $Instance -ResourceLabel "instance"
  Assert-TargetInstanceOwnershipCandidate -Instance $Instance
  $lifecycle = [string](Get-Field -InputObject $Instance -Name "lifecycle-state")
  Assert-True -Condition ($lifecycle -in @("RUNNING", "STOPPED")) -SafeMessage "A instância existente está em estado ambíguo."
  Assert-True -Condition ([string](Get-Field -InputObject $Instance -Name "compartment-id") -ceq $CompartmentId) -SafeMessage "A instância não pertence ao compartment SetLivre."
  Assert-True -Condition ([string](Get-Field -InputObject $Instance -Name "availability-domain") -ceq $AvailabilityDomain) -SafeMessage "A instância não pertence à AD esperada."
  Assert-True -Condition ([string](Get-Field -InputObject $Instance -Name "shape") -ceq $script:Contract.shape) -SafeMessage "A instância não usa o shape fixo VM.Standard.E2.1.Micro."
  $instanceOptions = Get-Field -InputObject $Instance -Name "instance-options"
  Assert-True -Condition ([bool](Get-Field -InputObject $instanceOptions -Name "are-legacy-imds-endpoints-disabled")) -SafeMessage "A instância não está em IMDSv2-only."
  $metadata = Get-Field -InputObject $Instance -Name "metadata"
  $remotePublicKey = [string](Get-Field -InputObject $metadata -Name "ssh_authorized_keys")
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($remotePublicKey) -and $remotePublicKey.Trim() -ceq $PublicKey.text) -SafeMessage "A chave pública da instância diverge da chave física esperada."

  $instanceId = [string](Get-Field -InputObject $Instance -Name "id")
  $imageId = [string](Get-Field -InputObject $Instance -Name "image-id")
  $imageResponse = Invoke-OciJson -Arguments @("compute", "image", "get", "--image-id", $imageId) -Operation "validar imagem da instância"
  $image = Get-Field -InputObject $imageResponse -Name "data"
  Assert-UbuntuE2ImageContract -Image $image -VerifyShapeCompatibility

  $vnicsResponse = Invoke-OciJson -Arguments @("compute", "instance", "list-vnics", "--instance-id", $instanceId, "--all") -Operation "validar VNIC da instância"
  $vnics = @(Get-OciItems -Response $vnicsResponse)
  $vnic = Select-OnlyPrimaryVnic -Vnics $vnics
  Assert-True -Condition ([string](Get-Field -InputObject $vnic -Name "subnet-id") -ceq [string](Get-Field -InputObject $Network.subnet -Name "id")) -SafeMessage "A VNIC não usa a subnet Set Livre."
  $nsgIds = @((Get-Field -InputObject $vnic -Name "nsg-ids") | Sort-Object)
  Assert-True -Condition ($nsgIds.Count -eq 1 -and [string]$nsgIds[0] -ceq [string](Get-Field -InputObject $Network.nsg -Name "id")) -SafeMessage "A VNIC não usa exclusivamente o NSG Set Livre."

  $attachmentsResponse = Invoke-OciJson -Arguments @("compute", "boot-volume-attachment", "list", "--compartment-id", $CompartmentId, "--availability-domain", $AvailabilityDomain, "--instance-id", $instanceId, "--all") -Operation "validar boot volume attachment"
  $attachments = @((Get-OciItems -Response $attachmentsResponse) | Where-Object { [string](Get-Field -InputObject $_ -Name "lifecycle-state") -notin @("DETACHED", "TERMINATED") })
  Assert-True -Condition ($attachments.Count -eq 1) -SafeMessage "A instância não possui um boot volume inequívoco."
  $bootResponse = Invoke-OciJson -Arguments @("bv", "boot-volume", "get", "--boot-volume-id", [string](Get-Field -InputObject $attachments[0] -Name "boot-volume-id")) -Operation "validar tamanho do boot volume"
  $bootVolume = Get-Field -InputObject $bootResponse -Name "data"
  Assert-True -Condition ([double](Get-Field -InputObject $bootVolume -Name "size-in-gbs") -eq $script:Contract.bootVolumeInGBs) -SafeMessage "O boot volume não possui exatamente 50 GB."
  Assert-True -Condition ([double](Get-Field -InputObject $bootVolume -Name "vpus-per-gb") -eq $script:Contract.bootVolumeVpusPerGB) -SafeMessage "O boot volume não usa desempenho Balanced de 10 VPUs/GB."
  $autoTuneEnabled = Get-Field -InputObject $bootVolume -Name "is-auto-tune-enabled"
  Assert-True -Condition ($null -ne $autoTuneEnabled -and -not [bool]$autoTuneEnabled) -SafeMessage "O estado de autotune do boot volume é ambíguo ou está habilitado."
  Assert-AndRecordOwnedResource -Resource $Instance -ResourceKind "instance"
  [void](Complete-PendingMutationFromObservedState -MutationKey "launch-e2-micro-always-free" -Reason "validated-target-instance-observed-after-startup")
  return [ordered]@{ instance = $Instance; vnic = $vnic; bootVolume = $bootVolume }
}

function Ensure-PublicIpv4 {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$ValidatedInstance)

  $vnicId = [string](Get-Field -InputObject $ValidatedInstance.vnic -Name "id")
  $privateResponse = Invoke-OciJson -Arguments @("network", "private-ip", "list", "--vnic-id", $vnicId, "--all") -Operation "listar private IPs da VNIC"
  $allPrivateIps = @(Get-OciItems -Response $privateResponse)
  $privateIps = @($allPrivateIps | Where-Object { [bool](Get-Field -InputObject $_ -Name "is-primary") })
  Assert-True -Condition ($allPrivateIps.Count -eq 1 -and $privateIps.Count -eq 1) -SafeMessage "A VNIC deve possuir somente o private IPv4 primário, sem endereços secundários ambíguos."
  $privateIpId = [string](Get-Field -InputObject $privateIps[0] -Name "id")
  $vnicPublicAddress = [string](Get-Field -InputObject $ValidatedInstance.vnic -Name "public-ip")
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($vnicPublicAddress) -and (Test-ExactPublicIpv4Cidr32 -Cidr "$vnicPublicAddress/32")) -SafeMessage "A VNIC primária não possui IPv4 público efêmero canônico."
  $publicResponse = Invoke-OciJson -Arguments @("network", "public-ip", "get", "--private-ip-id", $privateIpId) -Operation "consultar IPv4 público efêmero da VNIC primária"
  $publicIp = Get-Field -InputObject $publicResponse -Name "data"
  Assert-True -Condition ($null -ne $publicIp) -SafeMessage "O IPv4 público efêmero da VNIC não foi resolvido."
  $address = [string](Get-Field -InputObject $publicIp -Name "ip-address")
  Assert-True -Condition ($address -ceq $vnicPublicAddress) -SafeMessage "O objeto do IPv4 público diverge da VNIC."
  $lifetime = [string](Get-Field -InputObject $publicIp -Name "lifetime")
  Assert-True -Condition ($lifetime -ceq "EPHEMERAL") -SafeMessage "Somente o IPv4 público efêmero incluído na confirmação humana de estimate é aceito."
  Assert-True -Condition ([string](Get-Field -InputObject $publicIp -Name "assigned-entity-id") -ceq $privateIpId -or [string](Get-Field -InputObject $publicIp -Name "private-ip-id") -ceq $privateIpId) -SafeMessage "O IPv4 público não está atribuído ao private IP esperado."
  Assert-True -Condition ([string](Get-Field -InputObject $publicIp -Name "lifecycle-state") -ceq "ASSIGNED") -SafeMessage "O IPv4 público efêmero não está em estado ASSIGNED."
  $instanceCompartmentId = [string](Get-Field -InputObject $ValidatedInstance.instance -Name "compartment-id")
  Assert-True -Condition ([string](Get-Field -InputObject $publicIp -Name "compartment-id") -ceq $instanceCompartmentId) -SafeMessage "O IPv4 público efêmero não pertence ao compartment da VM validada."
  return [ordered]@{
    id = [string](Get-Field -InputObject $publicIp -Name "id")
    address = $address
    lifetime = $lifetime
    lifecycleState = [string](Get-Field -InputObject $publicIp -Name "lifecycle-state")
    dnsConfigured = $false
  }
}

function New-TargetInstance {
  param(
    [Parameter(Mandatory = $true)][string]$CompartmentId,
    [Parameter(Mandatory = $true)][string]$AvailabilityDomain,
    [Parameter(Mandatory = $true)][object]$Image,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Network,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$PublicKey
  )
  Add-PlannedAction -Action "launch-e2-micro-always-free"
  if (-not (Test-MutationExecutionEnabled)) { return $null }
  Assert-True -Condition ($null -ne $Network.subnet -and $null -ne $Network.nsg) -SafeMessage "A rede Set Livre não está completa para o launch."
  Assert-CurrentOciMutationPreflight -Operation "lançar VM E2.1.Micro Always Free" -RequireLaunchCapacity
  $response = Invoke-OciMutation -Command @("compute", "instance", "launch") -Operation "lançar VM E2.1.Micro Always Free" -MutationKey "launch-e2-micro-always-free" -SupportsRetryToken -Reconcile {
    $candidate = Get-TargetInstance -CompartmentId $CompartmentId
    if (
      $null -ne $candidate -and
      [string](Get-Field -InputObject $candidate -Name "shape") -ceq $script:Contract.shape
    ) { return $candidate }
    return $null
  } -TimeoutSeconds 960 -Payload @{
    availabilityDomain = $AvailabilityDomain
    compartmentId = $CompartmentId
    displayName = $script:Contract.names.instance
    shape = $script:Contract.shape
    sourceDetails = @{
      sourceType = "image"
      imageId = [string](Get-Field -InputObject $Image -Name "id")
      bootVolumeSizeInGBs = $script:Contract.bootVolumeInGBs
      bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
    }
    subnetId = [string](Get-Field -InputObject $Network.subnet -Name "id")
    nsgIds = @([string](Get-Field -InputObject $Network.nsg -Name "id"))
    assignPublicIp = $true
    assignPrivateDnsRecord = $true
    metadata = @{ ssh_authorized_keys = $PublicKey.text }
    instanceOptions = @{ areLegacyImdsEndpointsDisabled = $true }
    freeformTags = New-ResourceTags -ResourceKind "instance"
    waitForState = @("RUNNING")
    maxWaitSeconds = 900
    waitIntervalSeconds = 10
  }
  $instance = Get-Field -InputObject $response -Name "data"
  Assert-AndRecordOwnedResource -Resource $instance -ResourceKind "instance"
  Set-ApprovedResourceState -ResourceKind "instance" -Resource $instance -OwnershipProof "created-by-approved-plan"
  return $instance
}

function Start-ExistingInstanceIfRequested {
  param([Parameter(Mandatory = $true)][object]$Instance)
  if ([string](Get-Field -InputObject $Instance -Name "lifecycle-state") -cne "STOPPED") {
    if ([string](Get-Field -InputObject $Instance -Name "lifecycle-state") -ceq "RUNNING") {
      [void](Complete-PendingMutationFromObservedState -MutationKey "start-existing-safe-instance" -Reason "running-instance-observed-after-startup")
    }
    return $Instance
  }
  Add-PlannedAction -Action "start-existing-safe-instance"
  if (-not (Test-MutationExecutionEnabled)) { return $Instance }
  $instanceId = [string](Get-Field -InputObject $Instance -Name "id")
  $response = Invoke-OciMutation -Command @("compute", "instance", "action") -Operation "iniciar instância Set Livre validada" -MutationKey "start-existing-safe-instance" -SupportsRetryToken -Reconcile {
    $reconciledResponse = Invoke-OciJson -Arguments @("compute", "instance", "get", "--instance-id", $instanceId) -Operation "reconciliar start da instância Set Livre"
    $candidate = Get-Field -InputObject $reconciledResponse -Name "data"
    if ([string](Get-Field -InputObject $candidate -Name "id") -ceq $instanceId -and [string](Get-Field -InputObject $candidate -Name "lifecycle-state") -ceq "RUNNING") { return $candidate }
    return $null
  } -TimeoutSeconds 660 -Payload @{
    instanceId = $instanceId
    action = "START"
    waitForState = @("RUNNING")
    maxWaitSeconds = 600
    waitIntervalSeconds = 10
  }
  return Get-Field -InputObject $response -Name "data"
}

function Save-InstanceEvidence {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$ValidatedInstance,
    [AllowNull()][object]$PublicIp
  )

  $instance = $ValidatedInstance.instance
  $script:Evidence.facts.instance = [ordered]@{
    id = [string](Get-Field -InputObject $instance -Name "id")
    displayName = [string](Get-Field -InputObject $instance -Name "display-name")
    lifecycleState = [string](Get-Field -InputObject $instance -Name "lifecycle-state")
    shape = $script:Contract.shape
    architecture = $script:Contract.architecture
    ocpus = $script:Contract.ocpus
    memoryInGBs = $script:Contract.memoryInGBs
    bootVolumeInGBs = $script:Contract.bootVolumeInGBs
    bootVolumeVpusPerGB = $script:Contract.bootVolumeVpusPerGB
    bootVolumePerformanceClass = $script:Contract.bootVolumePerformanceClass
    imdsv2Only = $true
    agentPlugins = "provider-default"
    operatingSystem = "Ubuntu 24.04 x86_64"
    publicIpv4 = $PublicIp
    osBootstrapPerformed = $false
    dnsConfigured = $false
  }
}

function Invoke-OracleProvisioningWorkflow {
 try {
  Assert-True -Condition (Test-ExactPublicIpv4Cidr32 -Cidr $AdministrativeCidr) -SafeMessage "AdministrativeCidr deve ser um IPv4 público canônico /32."
  if ($Apply) {
    Assert-ApplyIntent
  }
  Acquire-GlobalProvisioningLock
  Initialize-PrivateEvidenceDirectory
  Initialize-PrivateProvisioningState
  if ($Apply) {
    Read-ApprovedPlanFile
  }

  $script:OciPath = Resolve-TrustedOciCli
  $profile = Get-OciProfileContract
  $script:OciConfigPath = $profile.configFile
  Assert-HomeRegionAndTenancy -Profile $profile
  $compartmentContract = Get-CompartmentContract -TenancyId $profile.tenancyId
  $targetCompartment = $compartmentContract.target
  $targetCompartment = Ensure-V2ResourceTags -Resource $targetCompartment -ResourceKind "compartment"
  $compartmentContract.target = $targetCompartment
  $targetCompartmentId = [string](Get-Field -InputObject $targetCompartment -Name "id")
  $script:Evidence.facts.identity = [ordered]@{
    tenancyId = $profile.tenancyId
    compartmentId = $targetCompartmentId
    compartmentName = [string](Get-Field -InputObject $targetCompartment -Name "name")
    region = $script:Contract.region
    homeRegion = $true
  }

  $platform = Get-AvailabilityDomainAndImage -CompartmentId $targetCompartmentId
  $script:Evidence.facts.platform = [ordered]@{
    availabilityDomain = $platform.availabilityDomain
    shape = $script:Contract.shape
    imageId = [string](Get-Field -InputObject $platform.image -Name "id")
    imageDisplayName = [string](Get-Field -InputObject $platform.image -Name "display-name")
  }
  $publicKey = Assert-PhysicalPublicKey

  $network = Get-NetworkState -CompartmentId $targetCompartmentId
  if ($null -ne $network.vcn) {
    $network.vcn = Ensure-V2ResourceTags -Resource $network.vcn -ResourceKind "vcn"
  }
  $existingCandidate = Get-TargetInstance -CompartmentId $targetCompartmentId
  if ($null -eq $existingCandidate) {
    $existingInstance = $null
    $capacityProof = Assert-CapacityAvailable -TenancyId $profile.tenancyId -AvailabilityDomain $platform.availabilityDomain
  } else {
    $existingProof = Get-ExistingTargetCapacityProof -ExistingTarget $existingCandidate -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain
    $existingInstance = $existingProof.instance
    $capacityProof = $existingProof.fact
  }
  $alwaysFreeProof = Assert-ServiceLimitsAndAlwaysFreeEnvelope -TenancyId $profile.tenancyId -TargetCompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Compartments $compartmentContract.all -ExistingTarget $existingInstance -Network $network -Platform $platform
  Complete-AlwaysFreePreflight -AlwaysFreeProof $alwaysFreeProof -CapacityProof $capacityProof

  $script:PlanningPhase = $true
  Ensure-Vcn -Network $network -CompartmentId $targetCompartmentId
  Ensure-InternetGateway -Network $network -CompartmentId $targetCompartmentId
  Ensure-RouteTable -Network $network -CompartmentId $targetCompartmentId
  Ensure-SecurityList -Network $network -CompartmentId $targetCompartmentId
  Ensure-Nsg -Network $network -CompartmentId $targetCompartmentId
  Ensure-Subnet -Network $network -CompartmentId $targetCompartmentId
  Save-NetworkEvidence -Network $network

  if ($null -eq $existingInstance) {
    [void](New-TargetInstance -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Image $platform.image -Network $network -PublicKey $publicKey)
  } else {
    $plannedValidated = Assert-InstanceContract -Instance $existingInstance -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Network $network -PublicKey $publicKey
    [void](Start-ExistingInstanceIfRequested -Instance $plannedValidated.instance)
    [void](Ensure-PublicIpv4 -ValidatedInstance $plannedValidated)
  }

  $currentPlan = New-CanonicalPlanDocument -Network $network -ExistingInstance $existingInstance -PublicKey $publicKey -Platform $platform -AlwaysFreeProof $alwaysFreeProof -CapacityProof $capacityProof
  $planHash = Seal-OrVerifyCurrentPlan -CurrentPlan $currentPlan
  if (-not $Apply) {
    $script:Evidence.status = "planned-awaiting-human-zero-cost-confirmation"
    $script:Evidence.limitations.Add("pricing-and-account-billing-are-not-provable-through-the-provisioner;review-the-current-OCI-estimate-and-always-free-badge-before-Apply")
    $evidenceHash = Write-Evidence
    Write-Information "Plan OCI concluído sem mutações persistentes; o Apply exige o SHA privado e confirmação humana do estimate/badge zero."
    Write-Output "plan-sha256=$planHash"
    Write-Output "evidence-sha256=$evidenceHash"
    return
  }

  $script:PlanningPhase = $false
  $targetCompartment = Ensure-V2ResourceTags -Resource $targetCompartment -ResourceKind "compartment"
  $compartmentContract.target = $targetCompartment
  if ($null -ne $network.vcn) {
    $network.vcn = Ensure-V2ResourceTags -Resource $network.vcn -ResourceKind "vcn"
  }
  Ensure-Vcn -Network $network -CompartmentId $targetCompartmentId
  Ensure-InternetGateway -Network $network -CompartmentId $targetCompartmentId
  Ensure-RouteTable -Network $network -CompartmentId $targetCompartmentId
  Ensure-SecurityList -Network $network -CompartmentId $targetCompartmentId
  Ensure-Nsg -Network $network -CompartmentId $targetCompartmentId
  Ensure-Subnet -Network $network -CompartmentId $targetCompartmentId
  Save-NetworkEvidence -Network $network

  if ($null -eq $existingInstance) {
    $existingInstance = New-TargetInstance -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Image $platform.image -Network $network -PublicKey $publicKey
  }

  if ($null -ne $existingInstance) {
    $validated = Assert-InstanceContract -Instance $existingInstance -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Network $network -PublicKey $publicKey
    $runningInstance = Start-ExistingInstanceIfRequested -Instance $validated.instance
    if ([string](Get-Field -InputObject $runningInstance -Name "lifecycle-state") -ceq "RUNNING" -and [string](Get-Field -InputObject $validated.instance -Name "lifecycle-state") -ceq "STOPPED") {
      $validated = Assert-InstanceContract -Instance $runningInstance -CompartmentId $targetCompartmentId -AvailabilityDomain $platform.availabilityDomain -Network $network -PublicKey $publicKey
    }
    $publicIp = Ensure-PublicIpv4 -ValidatedInstance $validated
    Save-InstanceEvidence -ValidatedInstance $validated -PublicIp $publicIp
  } else {
    throw "O Apply terminou sem uma instância Set Livre validada."
  }

  Assert-True -Condition ($script:PrivateState.retryTokens.Count -eq 0) -SafeMessage "O Apply não pode concluir com mutações OCI pendentes."
  $script:Evidence.status = "applied-and-validated"
  $script:Evidence.facts.approvedPlanSha256 = $planHash
  $evidenceHash = Write-Evidence
  Write-Information "Provisionamento OCI concluído em modo $($script:Evidence.mode); OCIDs e fatos permanecem somente no bundle privado."
  Write-Output "approved-plan-sha256=$planHash"
  Write-Output "evidence-sha256=$evidenceHash"
 } catch {
  if ($null -ne $script:EvidencePath) {
    $script:Evidence.status = if ($script:Evidence.status -eq "blocked-out-of-host-capacity") { $script:Evidence.status } else { "failed-closed" }
    $script:Evidence.failure = [ordered]@{ message = $_.Exception.Message; type = $_.Exception.GetType().FullName }
    try {
      $failureHash = Write-Evidence
      Write-Output "evidence-sha256=$failureHash"
    } catch {
      throw "O provisionamento falhou fechado e o bundle privado de evidência também não pôde ser escrito."
    }
  }
  throw
 } finally {
  if ($null -ne $script:ScratchPath -and (Test-Path -LiteralPath $script:ScratchPath)) {
    $remaining = @(Get-ChildItem -LiteralPath $script:ScratchPath -Force)
    foreach ($item in $remaining) {
      if (-not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-Item -LiteralPath $item.FullName -Force
      }
    }
  }
  Release-GlobalProvisioningLock
 }
}

if ($LibraryOnly) {
  Assert-True -Condition ($MyInvocation.InvocationName -ceq ".") -SafeMessage "LibraryOnly somente pode ser usado por dot-source em testes locais."
  return
}

Invoke-OracleProvisioningWorkflow
