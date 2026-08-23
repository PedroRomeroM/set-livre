import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(root, "scripts/provision-oracle-always-free.ps1");
const source = readFileSync(scriptPath, "utf8");

function resolveWindowsPowerShellExecutable() {
  if (process.platform !== "win32") {
    return null;
  }

  const candidates = [];
  const registry = spawnSync(
    "reg.exe",
    [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions",
      "/s",
      "/v",
      "InstallLocation",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  for (const line of (registry.stdout ?? "").split(/\r?\n/u)) {
    const match = line.match(/InstallLocation\s+REG_SZ\s+(.+)$/u);
    if (match?.[1] !== undefined) {
      candidates.push(resolve(match[1].trim(), "pwsh.exe"));
    }
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const powershellRoot = resolve(programFiles, "PowerShell");
  candidates.push(resolve(powershellRoot, "7/pwsh.exe"));
  if (existsSync(powershellRoot)) {
    for (const entry of readdirSync(powershellRoot, { withFileTypes: true })
      .filter((value) => value.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))) {
      candidates.push(resolve(powershellRoot, entry.name, "pwsh.exe"));
    }
  }

  const located = spawnSync("where.exe", ["pwsh.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  candidates.push(...(located.stdout ?? "").split(/\r?\n/u).filter(Boolean));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const physicalCandidate = realpathSync.native(candidate);
      if (physicalCandidate.toLowerCase().includes("\\windowsapps\\")) {
        continue;
      }
      return physicalCandidate;
    } catch {
      continue;
    }
  }
  return null;
}

const windowsPwsh = resolveWindowsPowerShellExecutable();
const windowsDirectory = process.env.SystemRoot ?? "C:\\Windows";
const windowsSshKeygen = resolve(windowsDirectory, "System32/OpenSSH/ssh-keygen.exe");
const canRunWindowsBehavior =
  process.platform === "win32" &&
  windowsPwsh !== null &&
  spawnSync(
    windowsPwsh,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  ).status === 0;

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(body) {
  if (windowsPwsh === null) {
    throw new Error("PowerShell 7 executable was not found");
  }
  const command = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShellLiteral(scriptPath)} -Plan -AdministrativeCidr '198.51.100.10/32' -EvidenceDirectory 'C:\\set-livre-library-only' -LibraryOnly
$InformationPreference = 'SilentlyContinue'
${body}
`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync(
    windowsPwsh,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `PowerShell harness failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function runPowerShellJson(body) {
  const output = runPowerShell(body);
  const lastLine = output.split(/\r?\n/u).filter(Boolean).at(-1);
  if (lastLine === undefined) {
    throw new Error("PowerShell harness returned no JSON");
  }
  return JSON.parse(lastLine);
}

function getFunctionSource(name) {
  const marker = `function ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`PowerShell function not found: ${name}`);
  }
  const next = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe("Oracle Always Free provisioning contract", () => {
  it.runIf(process.platform === "win32")(
    "finds a physical PowerShell 7 executable from MSI metadata or PATH",
    () => {
      expect(windowsPwsh).not.toBeNull();
      if (windowsPwsh === null) {
        throw new Error("A physical PowerShell 7 executable is required on Windows");
      }
      const version = spawnSync(
        windowsPwsh,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
        { encoding: "utf8", windowsHide: true },
      );
      expect(version.status, version.stderr).toBe(0);
      expect(Number.parseInt(version.stdout.trim(), 10)).toBeGreaterThanOrEqual(7);
      expect(windowsPwsh.toLowerCase()).not.toContain("windowsapps");
    },
  );

  it("keeps the production target pinned and every mutation non-destructive, planned and reconcilable", () => {
    expect(source).toContain('profile = "SET_LIVRE"');
    expect(source).toContain('region = "sa-saopaulo-1"');
    expect(source).toContain('compartmentName = "SetLivre"');
    expect(source).toContain('shape = "VM.Standard.E2.1.Micro"');
    expect(source).toContain('architecture = "x86_64"');
    expect(source).toContain("ocpus = 1.0");
    expect(source).toContain("memoryInGBs = 1.0");
    expect(source).toContain('managedBy = "provision-oracle-always-free-v2"');
    expect(source).toContain('shapeContract = "always-free-e2-micro"');
    expect(source).toContain('confirmationToken = "SET_LIVRE_ALWAYS_FREE"');
    expect(source).toContain('zeroCostConfirmation = "OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED"');
    expect(source).toContain('$values.ContainsKey("security_token_file")');
    expect(source).not.toContain('$values.ContainsKey("user")');
    expect(source).not.toContain("$values.user -match");
    expect(source).toContain("$homeRegions = @(");
    expect(source).not.toMatch(/^\s*\$home\s*=/mu);
    expect(source).not.toContain("shapeConfig");
    expect(source).not.toContain("shape-config");
    expect(source).not.toContain("memory-options");
    expect(source).not.toContain("ocpu-options");
    expect(getFunctionSource("Invoke-OciProcess")).toContain(
      "return [pscustomobject]@{ data = @() }",
    );
    expect(source.match(/-AllowEmptyData$/gmu)).toHaveLength(4);
    expect(getFunctionSource("Assert-CapacityAvailable")).toContain(
      "ConvertTo-Json -Depth 8 -Compress -AsArray",
    );
    expect(getFunctionSource("Assert-CapacityAvailable")).not.toContain("instanceShapeConfig");
    expect(getFunctionSource("Invoke-OciProcess")).toContain(
      'throw "A OCI CLI não retornou JSON em $Operation."',
    );
    expect(source).toContain('[ValidatePattern("^[0-9a-f]{64}$")]');
    expect(source).toContain("Read-ApprovedPlanFile");
    expect(source).toContain("Seal-OrVerifyCurrentPlan");
    expect(source).toContain("Invoke-AllowlistedPlanRemoteProbe");
    expect(source).toContain("persistentMutation = $false");
    expect(source).toContain("metadata = @{ ssh_authorized_keys = $PublicKey.text }");
    expect(getFunctionSource("New-TargetInstance")).toContain("assignPublicIp = $true");
    expect(getFunctionSource("New-TargetInstance")).not.toContain("agentConfig");
    expect(source).not.toContain('Invoke-OciMutation -Command @("network", "public-ip", "create")');
    expect(source).not.toContain("sshAuthorizedKeysFile");
    expect(source).not.toMatch(/"(?:delete|terminate)"|\b(?:Delete|Terminate)-/u);

    const mutationCalls =
      source.match(/Invoke-OciMutation -Command[\s\S]*?\s-Payload\s+(?:@\{|\$payload)/gu) ?? [];
    expect(mutationCalls).toHaveLength(12);
    for (const mutationCall of mutationCalls) {
      expect(mutationCall).toContain("-MutationKey");
      expect(mutationCall).toContain("-Reconcile");
    }
    const workflow = getFunctionSource("Invoke-OracleProvisioningWorkflow");
    const applyPhase = workflow.indexOf("$script:PlanningPhase = $false");
    const compartmentNormalization = workflow.indexOf(
      'Ensure-V2ResourceTags -Resource $targetCompartment -ResourceKind "compartment"',
      applyPhase,
    );
    const vcnNormalization = workflow.indexOf(
      'Ensure-V2ResourceTags -Resource $network.vcn -ResourceKind "vcn"',
      compartmentNormalization,
    );
    const firstAllocation = workflow.indexOf("Ensure-Vcn -Network $network", vcnNormalization);
    const instanceAllocation = workflow.indexOf(
      "New-TargetInstance -CompartmentId",
      firstAllocation,
    );
    expect(applyPhase).toBeGreaterThan(-1);
    expect(compartmentNormalization).toBeGreaterThan(applyPhase);
    expect(vcnNormalization).toBeGreaterThan(compartmentNormalization);
    expect(firstAllocation).toBeGreaterThan(vcnNormalization);
    expect(instanceAllocation).toBeGreaterThan(firstAllocation);
  });

  it("uses exact ownership proofs instead of names or topology for adoption", () => {
    const resolver = getFunctionSource("Resolve-UniqueResource");
    expect(resolver).toContain("Test-ExactResourceTags");
    expect(resolver).toContain("Get-PersistedApprovedOcid");
    expect(resolver).toContain("Get-PendingTagNormalization");
    expect(resolver).toContain("Assert-PendingTagNormalizationSource");
    expect(resolver).not.toContain("AcceptedNames");
    expect(resolver).not.toContain("TopologyMatch");
    expect(getFunctionSource("Assert-PrivateProvisioningState")).not.toContain('"legacy-v1-tags",');
    expect(getFunctionSource("Set-ApprovedResourceState")).not.toContain("legacy-v1-tags");
    const targetResolver = getFunctionSource("Resolve-UniqueTargetInstance");
    expect(targetResolver).toContain("Test-ExactResourceTags");
    expect(targetResolver).not.toContain("Legacy");
    expect(targetResolver).toContain("Get-PersistedApprovedOcid");
    expect(targetResolver).toContain("unapprovedNameCollisions");
    expect(source).not.toContain("legacyManagedBy");
    expect(source).not.toContain("legacyInstanceManagedBy");
    expect(source).not.toContain("codex-windows-v1");
    expect(source).not.toContain("normalize-e2-instance-tags");
  });

  it("separates automated quota and capacity checks from the human billing decision", () => {
    expect(source).toContain("automatedZeroCostProven = $false");
    expect(source).toContain("automatedBillingOrPriceProof = $false");
    expect(source).toContain("oracleEstimateAndAlwaysFreeBadgeMustBeReviewed = $true");
    expect(source).toContain("humanZeroCostConfirmed");
    expect(source).not.toContain("zeroCostProven = $true");
    expect(source).not.toContain("publicIpv4ZeroCostProven = $true");
  });

  it.runIf(canRunWindowsBehavior)(
    "normalizes the omitted OCI platform-image listing default without accepting Marketplace images",
    () => {
      const result = runPowerShellJson(`
function New-TestImage([object]$ListingType) {
  return [pscustomobject]@{
    id = 'ocid1.image.oc1.sa-saopaulo-1.fixture'
    'display-name' = 'Canonical-Ubuntu-24.04-2026.08.18-0'
    'operating-system' = 'Canonical Ubuntu'
    'operating-system-version' = '24.04'
    'listing-type' = $ListingType
  }
}
$nullListing = New-TestImage $null
$noneListing = New-TestImage 'NONE'
$communityListing = New-TestImage 'COMMUNITY'
$unknownListing = New-TestImage 'UNKNOWN_ENUM_VALUE'
$communityRejected = $false
$unknownRejected = $false
try { Assert-UbuntuE2ImageContract -Image $communityListing } catch { $communityRejected = $true }
try { Assert-UbuntuE2ImageContract -Image $unknownListing } catch { $unknownRejected = $true }
[ordered]@{
  nullAccepted = Test-NoMarketplaceImageListing -Image $nullListing
  noneAccepted = Test-NoMarketplaceImageListing -Image $noneListing
  communityRejected = $communityRejected
  unknownRejected = $unknownRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        nullAccepted: true,
        noneAccepted: true,
        communityRejected: true,
        unknownRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "verifies both E2 limit aliases conservatively without summing them and caps tenancy at two",
    () => {
      const result = runPowerShellJson(`
$script:LimitCalls = [Collections.Generic.List[object]]::new()
$script:InventoryCount = 1
function Get-CurrentLimitProof {
  param(
    [string]$TenancyId,
    [string]$TargetCompartmentId,
    [string]$ServiceName,
    [string]$LimitName,
    [string]$ScopeType,
    [double]$AlwaysFreeCeiling,
    [double]$RequiredIncrement,
    [string]$AvailabilityDomain
  )
  $script:LimitCalls.Add([ordered]@{ name = $LimitName; required = $RequiredIncrement })
  $available = if ($LimitName -ceq 'standard-e2-micro-core-count') { 1.0 } elseif ($LimitName -ceq 'vm-standard-e2-1-micro-count') { 2.0 } else { 200.0 }
  $used = if ($LimitName -ceq 'standard-e2-micro-core-count') { 1.0 } else { 0.0 }
  return [ordered]@{
    service = $ServiceName
    name = $LimitName
    scope = $ScopeType
    serviceLimit = $AlwaysFreeCeiling
    alwaysFreeCeiling = $AlwaysFreeCeiling
    available = $available
    used = $used
    requiredIncrement = $RequiredIncrement
    effectiveQuotaValue = $AlwaysFreeCeiling
  }
}
function Invoke-OciJson {
  param([string[]]$Arguments, [string]$Operation, [int]$TimeoutSeconds, [switch]$AllowEmptyData)
  $command = @($Arguments[0..2]) -join ' '
  if ($command -ceq 'compute instance list') {
    $items = @()
    for ($index = 0; $index -lt $script:InventoryCount; $index++) {
      $items += [pscustomobject]@{
        id = ('ocid1.instance.oc1.sa-saopaulo-1.fixture' + $index)
        shape = 'VM.Standard.E2.1.Micro'
        'lifecycle-state' = 'RUNNING'
      }
    }
    return [ordered]@{ data = $items }
  }
  if ($command -in @('bv boot-volume list', 'bv volume list')) {
    return [ordered]@{ data = @() }
  }
  throw ('unexpected fixture command: ' + $command)
}
$platform = [ordered]@{
  shape = [pscustomobject]@{ shape = 'VM.Standard.E2.1.Micro' }
  image = [pscustomobject]@{ 'listing-type' = 'NONE' }
}
$network = [ordered]@{ vcn = [pscustomobject]@{ id = 'ocid1.vcn.oc1..fixture' } }
$compartments = @([pscustomobject]@{ id = 'ocid1.compartment.oc1..fixture'; 'lifecycle-state' = 'ACTIVE' })
$proof = Assert-ServiceLimitsAndAlwaysFreeEnvelope -TenancyId 'ocid1.tenancy.oc1..fixture' -TargetCompartmentId 'ocid1.compartment.oc1..fixture' -AvailabilityDomain 'AD-1' -Compartments $compartments -ExistingTarget $null -Network $network -Platform $platform
$computeCalls = @($script:LimitCalls | Where-Object { $_.name -in @('standard-e2-micro-core-count', 'vm-standard-e2-1-micro-count') })
$script:InventoryCount = 2
$capRejected = $false
try {
  [void](Assert-ServiceLimitsAndAlwaysFreeEnvelope -TenancyId 'ocid1.tenancy.oc1..fixture' -TargetCompartmentId 'ocid1.compartment.oc1..fixture' -AvailabilityDomain 'AD-1' -Compartments $compartments -ExistingTarget $null -Network $network -Platform $platform)
} catch { $capRejected = $true }
[ordered]@{
  aliases = @($computeCalls.name | Sort-Object)
  eachAliasCheckedForOne = @($computeCalls | Where-Object { [double]$_.required -eq 1.0 }).Count -eq 2
  strategy = [string]$proof.facts.computeLimitAliasEnvelope.strategy
  conservativeAvailable = [double]$proof.facts.computeLimitAliasEnvelope.available
  conservativeUsed = [double]$proof.facts.computeLimitAliasEnvelope.used
  chargedIncrement = [double]$proof.facts.computeLimitAliasEnvelope.chargedIncrement
  plannedInstanceCount = [int]$proof.facts.aggregateAfterPlan.instanceCount
  capRejected = $capRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        aliases: ["standard-e2-micro-core-count", "vm-standard-e2-1-micro-count"],
        eachAliasCheckedForOne: true,
        strategy: "minimum-available-maximum-used-aliases-not-summed",
        conservativeAvailable: 1,
        conservativeUsed: 1,
        chargedIncrement: 1,
        plannedInstanceCount: 2,
        capRejected: true,
      });
    },
  );

  it("pins the OCI executable and applies ETag concurrency control to every update", () => {
    expect(source).toContain('ociCliVersion = "3.90.1"');
    expect(source).toContain(
      'ociCliSha256 = "69775c7147b42af55e25e357670f3414795b7fc78afb5bc201ba5239664673e8"',
    );
    expect(source).toContain('"--auth", "security_token"');
    expect(source).toContain('"--no-retry"');
    expect(source).toContain('"--opc-retry-token", [string]$retryContext.token');
    expect(source).toContain('status = "pending"');
    expect(source).toContain('Status "reconciled"');
    expect(source).toContain('Status "expired"');
    expect(source.match(/ifMatch = \$etag/gu)).toHaveLength(3);
    expect(source).toContain('@("iam", "compartment", "update")');
    expect(source).toContain('@("network", "vcn", "update")');
    expect(source).toContain('@("iam", "compartment", "get", "--compartment-id"');
    expect(source).toContain('@("network", "vcn", "get", "--vcn-id"');
    expect(source).toContain('"internet-gateway", "get", "--ig-id"');
    expect(source).toContain('"route-table", "get", "--rt-id"');
    expect(source).toContain('"compute", "instance", "get", "--instance-id"');
  });

  it.runIf(canRunWindowsBehavior)(
    "reconstructs the child environment and removes every inherited OCI identity or endpoint override",
    () => {
      const result = runPowerShellJson(`
$script:OciPath = 'C:\\Program Files (x86)\\Oracle\\oci_cli\\oci.exe'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
foreach ($name in @(
  'OCI_CLI_SECURITY_TOKEN_FILE', 'OCI_CLI_ENDPOINT', 'OCI_CLI_CERT_BUNDLE',
  'OCI_CLI_RC_FILE', 'OCI_CLI_USER', 'OCI_CLI_TENANCY', 'OCI_CLI_PROFILE',
  'OCI_CLI_CONFIG_FILE', 'OCI_REGION', 'OCI_CLI_AUTH', 'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE', 'HTTPS_PROXY', 'PSModulePath'
)) { $startInfo.Environment[$name] = 'poison' }
Initialize-OciProcessEnvironment -StartInfo $startInfo
$ociKeys = @($startInfo.Environment.Keys | Where-Object { $_ -match '^(?i:OCI)' } | Sort-Object)
$expectedModulePath = @(
  (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) 'Documents\\WindowsPowerShell\\Modules'),
  (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'WindowsPowerShell\\Modules'),
  (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\\WindowsPowerShell\\v1.0\\Modules')
) | ForEach-Object { [IO.Path]::GetFullPath($_) } | Join-String -Separator ([IO.Path]::PathSeparator)
$childModulePath = [string]$startInfo.Environment['PSModulePath']
$oldProcessOverride = [Environment]::GetEnvironmentVariable('OCI_CLI_CONFIG_FILE', 'Process')
$profilePathEnvironmentRejected = $false
try {
  [Environment]::SetEnvironmentVariable('OCI_CLI_CONFIG_FILE', 'C:\\poisoned-oci-config', 'Process')
  try {
    [void](Resolve-PrivateOciProfileFile -ConfiguredPath '%OCI_CLI_CONFIG_FILE%\\session.pem' -UserProfile ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) -SafeLabel 'fixture')
  } catch { $profilePathEnvironmentRejected = $true }
} finally {
  [Environment]::SetEnvironmentVariable('OCI_CLI_CONFIG_FILE', $oldProcessOverride, 'Process')
}
[ordered]@{
  ociKeys = $ociKeys
  retry = $startInfo.Environment['OCI_CLI_RETRY_ENABLED']
  poisonedValuesRemain = @($startInfo.Environment.Values | Where-Object { $_ -ceq 'poison' }).Count
  hasSafePath = -not [string]::IsNullOrWhiteSpace($startInfo.Environment['Path'])
  psModulePathMatchesNative = $childModulePath -ceq $expectedModulePath
  codexPs7ModulesRemoved =
    -not $childModulePath.Contains('codex-runtimes', [StringComparison]::OrdinalIgnoreCase) -and
    -not $childModulePath.Contains('\\Documents\\PowerShell\\Modules', [StringComparison]::OrdinalIgnoreCase) -and
    -not $childModulePath.Contains('\\PowerShell\\7\\Modules', [StringComparison]::OrdinalIgnoreCase)
  profilePathEnvironmentRejected = $profilePathEnvironmentRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        ociKeys: ["OCI_CLI_RETRY_ENABLED"],
        retry: "false",
        poisonedValuesRemain: 0,
        hasSafePath: true,
        psModulePathMatchesNative: true,
        codexPs7ModulesRemoved: true,
        profilePathEnvironmentRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "preserves actionable OCI stderr while redacting private identifiers and credentials",
    () => {
      const invocation = getFunctionSource("Invoke-OciProcess");
      expect(invocation).toContain("ConvertTo-SafeOciStderr -Stderr $stderr");
      expect(invocation).toContain('Write-Information "A OCI CLI escreveu em stderr');
      expect(invocation).not.toContain("saída foi suprimida");
      const result = runPowerShellJson(`
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$fixture = 'Session has expired' + [Environment]::NewLine + 'resource=ocid1.instance.oc1..fixture' + [Environment]::NewLine + 'security_token=super-secret' + [Environment]::NewLine + "path=$userProfile\\.oci\\sessions\\token"
$safe = ConvertTo-SafeOciStderr -Stderr $fixture
[ordered]@{
  sessionMessagePreserved = $safe -match 'Session has expired'
  ocidRedacted = $safe -notmatch 'ocid1[.]instance'
  secretRedacted = $safe -notmatch 'super-secret'
  privatePathRedacted = $safe -notmatch [Regex]::Escape($userProfile)
  userPlaceholderPresent = $safe -match '%USERPROFILE%'
  emptyIsExplicit = [string](ConvertTo-SafeOciStderr -Stderr '') -ceq '(stderr vazio)'
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        sessionMessagePreserved: true,
        ocidRedacted: true,
        secretRedacted: true,
        privatePathRedacted: true,
        userPlaceholderPresent: true,
        emptyIsExplicit: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "rejects writable physical ancestors for OCI config and session credentials",
    () => {
      const result = runPowerShellJson(`
$temporary = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('set-livre-oci-acl-test-' + [Guid]::NewGuid().ToString('N'))
try {
  $ociRoot = Join-Path $temporary '.oci'
  $sessionRoot = Join-Path $ociRoot 'sessions'
  [void](New-Item -ItemType Directory -Path $sessionRoot)
  Set-PrivateDirectoryAcl -Path $ociRoot
  Set-PrivateDirectoryAcl -Path $sessionRoot
  $config = Join-Path $ociRoot 'config'
  $token = Join-Path $sessionRoot 'security_token'
  [IO.File]::WriteAllText($config, '[SET_LIVRE]', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($token, 'token', [Text.UTF8Encoding]::new($false))
  Set-PrivateFileAcl -Path $config
  Set-PrivateFileAcl -Path $token
  $resolvedToken = Resolve-PrivateOciProfileFile -ConfiguredPath $token -UserProfile $temporary -SafeLabel 'fixture token'
  Assert-PrivatePathAncestorAclContract -Path $config -TrustedRoot $ociRoot -SafeLabel 'fixture config'

  $icacls = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\\icacls.exe'
  & $icacls $ociRoot /grant '*S-1-5-11:(F)' /Q | Out-Null
  Assert-True -Condition ($LASTEXITCODE -eq 0) -SafeMessage 'A fixture não conseguiu tornar o ancestral OCI gravável.'
  $configAncestorRejected = $false
  $tokenAncestorRejected = $false
  try { Assert-PrivatePathAncestorAclContract -Path $config -TrustedRoot $ociRoot -SafeLabel 'fixture config' } catch { $configAncestorRejected = $true }
  try { [void](Resolve-PrivateOciProfileFile -ConfiguredPath $token -UserProfile $temporary -SafeLabel 'fixture token') } catch { $tokenAncestorRejected = $true }
  [ordered]@{
    resolvedToken = $resolvedToken
    configAncestorRejected = $configAncestorRejected
    tokenAncestorRejected = $tokenAncestorRejected
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
`);
      expect(result).toEqual({
        resolvedToken: expect.stringContaining("security_token"),
        configAncestorRejected: true,
        tokenAncestorRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "accepts v1 tags only through the one-time private OCID transition",
    () => {
      const result = runPowerShellJson(`
function New-TestVcn([string]$Id, [object]$Tags) {
  return [pscustomobject]@{
    id = $Id
    'display-name' = 'set-livre-vcn'
    'lifecycle-state' = 'AVAILABLE'
    'cidr-block' = '10.20.0.0/16'
    'freeform-tags' = $Tags
  }
}
$script:PrivateState = New-PrivateProvisioningState
$exactTags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = $script:Contract.managedBy
  'set-livre-resource' = 'vcn'
}
$wrongTags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = 'foreign-tool'
  'set-livre-resource' = 'vcn'
}
$legacyTags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = $script:Contract.tagNormalization.sourceManagedBy
  'set-livre-resource' = 'vcn'
}
$foreign = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.foreign' ([pscustomobject]@{})
$wrongManagedBy = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.wrong' $wrongTags
$owned = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.owned' $exactTags
$legacy = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.legacy' $legacyTags
$foreignIgnored = $null -eq (Resolve-UniqueResource -Items @($foreign) -ResourceKind 'vcn')
$wrongManagedByIgnored = $null -eq (Resolve-UniqueResource -Items @($wrongManagedBy) -ResourceKind 'vcn')
$taggedId = (Resolve-UniqueResource -Items @($foreign, $owned) -ResourceKind 'vcn').id
$unapprovedV1Rejected = $false
try { [void](Resolve-UniqueResource -Items @($legacy) -ResourceKind 'vcn') } catch { $unapprovedV1Rejected = $true }

$v3State = [ordered]@{
  schemaVersion = 3
  project = 'set-livre'
  region = 'sa-saopaulo-1'
  resources = [ordered]@{
    vcn = [ordered]@{ kind = 'vcn'; id = $legacy.id; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
  }
  retryTokens = [ordered]@{}
  mutationJournal = [ordered]@{}
  lastApprovedPlanSha256 = ('a' * 64)
}
$transitionCreated = Upgrade-PrivateProvisioningState -State $v3State
$script:PrivateState = $v3State
$pendingV1Id = (Resolve-UniqueResource -Items @($legacy) -ResourceKind 'vcn').id
$wrongPendingOcidRejected = $false
$wrongPendingOcid = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.wrongpending' $legacyTags
try { [void](Resolve-UniqueResource -Items @($wrongPendingOcid) -ResourceKind 'vcn') } catch { $wrongPendingOcidRejected = $true }

$script:PrivateState = New-PrivateProvisioningState
$script:PrivateState.resources['vcn'] = [ordered]@{
  kind = 'vcn'
  id = $foreign.id
  ownershipProof = 'created-by-approved-plan'
  approvedPlanSha256 = ('a' * 64)
}
$persistedId = (Resolve-UniqueResource -Items @($foreign) -ResourceKind 'vcn').id
$staleRejected = $false
try { [void](Resolve-UniqueResource -Items @($owned) -ResourceKind 'vcn') } catch { $staleRejected = $true }

$script:PrivateState = New-PrivateProvisioningState
$duplicateRejected = $false
try {
  $duplicate = New-TestVcn 'ocid1.vcn.oc1.sa-saopaulo-1.duplicate' $exactTags
  [void](Resolve-UniqueResource -Items @($owned, $duplicate) -ResourceKind 'vcn')
} catch { $duplicateRejected = $true }

function Save-PrivateProvisioningState {}
$exactCompartmentTags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = $script:Contract.managedBy
  'set-livre-resource' = 'compartment'
}
$sameNameCompartment = [pscustomobject]@{
  id = 'ocid1.compartment.oc1..same_name_only'
  name = 'SetLivre'
  'compartment-id' = 'ocid1.tenancy.oc1..test'
  'lifecycle-state' = 'ACTIVE'
  'freeform-tags' = [pscustomobject]@{}
}
$ownedCompartment = [pscustomobject]@{
  id = 'ocid1.compartment.oc1..owned'
  name = 'SetLivre'
  'compartment-id' = 'ocid1.tenancy.oc1..test'
  'lifecycle-state' = 'ACTIVE'
  'freeform-tags' = $exactCompartmentTags
}
$script:CompartmentItems = @($sameNameCompartment, $ownedCompartment)
function Invoke-OciJson { return [ordered]@{ data = $script:CompartmentItems } }
$script:PrivateState = New-PrivateProvisioningState
$compartmentId = (Get-CompartmentContract -TenancyId 'ocid1.tenancy.oc1..test').target.id
$script:CompartmentItems = @($sameNameCompartment)
$script:PrivateState = New-PrivateProvisioningState
$untaggedCompartmentRejected = $false
try { [void](Get-CompartmentContract -TenancyId 'ocid1.tenancy.oc1..test') } catch { $untaggedCompartmentRejected = $true }
[ordered]@{
  foreignIgnored = $foreignIgnored
  wrongManagedByIgnored = $wrongManagedByIgnored
  taggedId = $taggedId
  unapprovedV1Rejected = $unapprovedV1Rejected
  transitionCreated = $transitionCreated
  pendingV1Id = $pendingV1Id
  wrongPendingOcidRejected = $wrongPendingOcidRejected
  persistedId = $persistedId
  staleRejected = $staleRejected
  duplicateRejected = $duplicateRejected
  compartmentId = $compartmentId
  untaggedCompartmentRejected = $untaggedCompartmentRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        foreignIgnored: true,
        wrongManagedByIgnored: true,
        taggedId: "ocid1.vcn.oc1.sa-saopaulo-1.owned",
        unapprovedV1Rejected: true,
        transitionCreated: true,
        pendingV1Id: "ocid1.vcn.oc1.sa-saopaulo-1.legacy",
        wrongPendingOcidRejected: true,
        persistedId: "ocid1.vcn.oc1.sa-saopaulo-1.foreign",
        staleRejected: true,
        duplicateRejected: true,
        compartmentId: "ocid1.compartment.oc1..owned",
        untaggedCompartmentRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "rejects retired diagnostic instance tags and accepts only exact v2 ownership",
    () => {
      const result = runPowerShellJson(`
function New-TestInstance([string]$Id, [string]$Name, [object]$Tags) {
  return [pscustomobject]@{
    id = $Id
    'display-name' = $Name
    'lifecycle-state' = 'RUNNING'
    shape = 'VM.Standard.E2.1.Micro'
    'freeform-tags' = $Tags
  }
}
$legacyTags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = 'codex-windows-v1'
  'set-livre-resource' = 'instance'
  'set-livre-shape-contract' = 'always-free-e2-micro'
}
$v2Tags = [pscustomobject]@{
  'set-livre-project' = 'set-livre'
  'set-livre-environment' = 'production'
  'set-livre-managed-by' = 'provision-oracle-always-free-v2'
  'set-livre-resource' = 'instance'
  'set-livre-shape-contract' = 'always-free-e2-micro'
}
$legacy = New-TestInstance 'ocid1.instance.oc1.sa-saopaulo-1.legacy' 'set-livre-production' $legacyTags
$v2 = New-TestInstance 'ocid1.instance.oc1.sa-saopaulo-1.v2' 'set-livre-production' $v2Tags
$foreignSameName = New-TestInstance 'ocid1.instance.oc1.sa-saopaulo-1.foreign' 'set-livre-production' ([pscustomobject]@{})
$taggedWrongName = New-TestInstance 'ocid1.instance.oc1.sa-saopaulo-1.wrongname' 'other-production' $v2Tags

$script:PrivateState = New-PrivateProvisioningState
$legacyRejected = $false
try { [void](Resolve-UniqueTargetInstance -Items @($legacy)) } catch { $legacyRejected = $true }
$script:PrivateState = New-PrivateProvisioningState
$v2Id = (Resolve-UniqueTargetInstance -Items @($v2)).id
$script:PrivateState = New-PrivateProvisioningState
$collisionRejected = $false
try { [void](Resolve-UniqueTargetInstance -Items @($foreignSameName)) } catch { $collisionRejected = $true }
$script:PrivateState = New-PrivateProvisioningState
$duplicateRejected = $false
try {
  $otherV2 = New-TestInstance 'ocid1.instance.oc1.sa-saopaulo-1.v2duplicate' 'set-livre-production' $v2Tags
  [void](Resolve-UniqueTargetInstance -Items @($v2, $otherV2))
} catch { $duplicateRejected = $true }
$script:PrivateState = New-PrivateProvisioningState
$wrongNameRejected = $false
try { [void](Resolve-UniqueTargetInstance -Items @($taggedWrongName)) } catch { $wrongNameRejected = $true }
[ordered]@{
  legacyRejected = $legacyRejected
  v2Id = $v2Id
  collisionRejected = $collisionRejected
  duplicateRejected = $duplicateRejected
  wrongNameRejected = $wrongNameRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        legacyRejected: true,
        v2Id: "ocid1.instance.oc1.sa-saopaulo-1.v2",
        collisionRejected: true,
        duplicateRejected: true,
        wrongNameRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "migrates v3 ownership into a deterministic no-mutation tag-normalization plan",
    () => {
      const result = runPowerShellJson(`
function New-V1Tags([string]$Kind) {
  return [pscustomobject]@{
    'set-livre-project' = 'set-livre'
    'set-livre-environment' = 'production'
    'set-livre-managed-by' = 'provision-oracle-always-free-v1'
    'set-livre-resource' = $Kind
    'preserved-external-tag' = 'keep-me'
  }
}
$compartmentId = 'ocid1.compartment.oc1..legacy'
$vcnId = 'ocid1.vcn.oc1.sa-saopaulo-1.legacy'
$state = [ordered]@{
  schemaVersion = 3
  project = 'set-livre'
  region = 'sa-saopaulo-1'
  resources = [ordered]@{
    compartment = [ordered]@{ kind = 'compartment'; id = $compartmentId; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
    vcn = [ordered]@{ kind = 'vcn'; id = $vcnId; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
  }
  retryTokens = [ordered]@{}
  mutationJournal = [ordered]@{}
  lastApprovedPlanSha256 = ('a' * 64)
}
$upgraded = Upgrade-PrivateProvisioningState -State $state
Assert-PrivateProvisioningState -State $state
$script:PrivateState = $state
$script:Evidence.plannedActions = [Collections.Generic.List[string]]::new()
$script:MutationWasInvoked = $false
function Invoke-OciMutation { $script:MutationWasInvoked = $true; throw 'Plan attempted a mutation' }
$compartment = [pscustomobject]@{
  id = $compartmentId
  name = 'SetLivre'
  'lifecycle-state' = 'ACTIVE'
  'freeform-tags' = New-V1Tags 'compartment'
}
$vcn = [pscustomobject]@{
  id = $vcnId
  'display-name' = 'set-livre-vcn'
  'lifecycle-state' = 'AVAILABLE'
  'freeform-tags' = New-V1Tags 'vcn'
}
[void](Ensure-V2ResourceTags -Resource $compartment -ResourceKind 'compartment')
[void](Ensure-V2ResourceTags -Resource $vcn -ResourceKind 'vcn')
$normalizations = @(Get-PendingTagNormalizationPlanSnapshot)
$invalidState = New-PrivateProvisioningState
$invalidState.resources['vcn'] = [ordered]@{ kind = 'vcn'; id = $vcnId; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
$legacyOwnershipRejected = $false
try { Assert-PrivateProvisioningState -State $invalidState } catch { $legacyOwnershipRejected = $true }
[ordered]@{
  upgraded = $upgraded
  schemaVersion = [int]$state.schemaVersion
  approvedResourceCount = $state.resources.Count
  pendingKinds = @($state.pendingTagNormalizations.Keys)
  plannedActions = @($script:Evidence.plannedActions)
  normalizationKinds = @($normalizations.resourceKind)
  concurrencyControls = @($normalizations.concurrencyControl)
  postStateProofs = @($normalizations.postStateProof)
  compartmentOwnership = [string](ConvertTo-PlanResourceSnapshot -Resource $compartment -ResourceKind 'compartment').ownershipProof
  vcnOwnership = [string](ConvertTo-PlanResourceSnapshot -Resource $vcn -ResourceKind 'vcn').ownershipProof
  mutationWasInvoked = $script:MutationWasInvoked
  legacyOwnershipRejected = $legacyOwnershipRejected
} | ConvertTo-Json -Depth 8 -Compress
`);
      expect(result).toEqual({
        upgraded: true,
        schemaVersion: 4,
        approvedResourceCount: 0,
        pendingKinds: ["compartment", "vcn"],
        plannedActions: ["normalize-v1-compartment-tags", "normalize-v1-vcn-tags"],
        normalizationKinds: ["compartment", "vcn"],
        concurrencyControls: ["etag-if-match", "etag-if-match"],
        postStateProofs: ["exact-tags", "exact-tags"],
        compartmentOwnership: "v1-to-v2-normalization-required",
        vcnOwnership: "v1-to-v2-normalization-required",
        mutationWasInvoked: false,
        legacyOwnershipRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "normalizes compartment and VCN with their OCI APIs, ETags and reconciled exact state",
    () => {
      const result = runPowerShellJson(`
$temporary = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('set-livre-tag-normalization-test-' + [Guid]::NewGuid().ToString('N'))
try {
  [void](New-Item -ItemType Directory -Path $temporary)
  Set-PrivateDirectoryAcl -Path $temporary
  $script:ScratchPath = $temporary
  $script:StateFile = Join-Path $temporary 'state.json'
  $script:GlobalLockStream = [IO.MemoryStream]::new()
  $compartmentId = 'ocid1.compartment.oc1..legacy'
  $vcnId = 'ocid1.vcn.oc1.sa-saopaulo-1.legacy'
  $script:PrivateState = [ordered]@{
    schemaVersion = 3
    project = 'set-livre'
    region = 'sa-saopaulo-1'
    resources = [ordered]@{
      compartment = [ordered]@{ kind = 'compartment'; id = $compartmentId; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
      vcn = [ordered]@{ kind = 'vcn'; id = $vcnId; ownershipProof = 'legacy-v1-tags'; approvedPlanSha256 = $null }
    }
    retryTokens = [ordered]@{}
    mutationJournal = [ordered]@{}
    lastApprovedPlanSha256 = $null
  }
  [void](Upgrade-PrivateProvisioningState -State $script:PrivateState)
  Save-PrivateProvisioningState
  function New-RemoteResource([string]$Kind, [string]$Id) {
    $tags = [pscustomobject]@{
      'set-livre-project' = 'set-livre'
      'set-livre-environment' = 'production'
      'set-livre-managed-by' = 'provision-oracle-always-free-v1'
      'set-livre-resource' = $Kind
      'preserved-external-tag' = ('keep-' + $Kind)
    }
    if ($Kind -ceq 'compartment') {
      return [pscustomobject]@{ id = $Id; name = 'SetLivre'; 'lifecycle-state' = 'ACTIVE'; 'freeform-tags' = $tags }
    }
    return [pscustomobject]@{ id = $Id; 'display-name' = 'set-livre-vcn'; 'lifecycle-state' = 'AVAILABLE'; 'freeform-tags' = $tags }
  }
  $script:RemoteResources = [ordered]@{
    compartment = New-RemoteResource -Kind 'compartment' -Id $compartmentId
    vcn = New-RemoteResource -Kind 'vcn' -Id $vcnId
  }
  $script:CapturedUpdates = [Collections.Generic.List[object]]::new()
  function Invoke-OciJson {
    param([string[]]$Arguments, [string]$Operation, [int]$TimeoutSeconds, [switch]$AllowEmptyData)
    $kind = if ($Arguments[0] -ceq 'iam') { 'compartment' } else { 'vcn' }
    $fromJsonIndex = [Array]::IndexOf([object[]]$Arguments, '--from-json')
    if ($fromJsonIndex -ge 0) {
      $requestUri = [Uri]$Arguments[$fromJsonIndex + 1]
      $payload = [IO.File]::ReadAllText($requestUri.LocalPath) | ConvertFrom-Json -AsHashtable
      $script:RemoteResources[$kind].'freeform-tags' = [pscustomobject]$payload.freeformTags
      $script:CapturedUpdates.Add([ordered]@{
          command = @($Arguments[0..2])
          payload = $payload
        })
      return [ordered]@{ data = $script:RemoteResources[$kind] }
    }
    return [ordered]@{ data = $script:RemoteResources[$kind]; etag = ('etag-' + $kind) }
  }
  $Apply = $true
  $Plan = $false
  $ConfirmationToken = 'SET_LIVRE_ALWAYS_FREE'
  $ApprovedPlanSha256 = ('a' * 64)
  $ZeroCostConfirmation = 'OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED'
  $script:CurrentPlanSha256 = $ApprovedPlanSha256
  $script:PlanningPhase = $false
  $script:ApprovedPlan = [ordered]@{ plannedActions = @('normalize-v1-compartment-tags', 'normalize-v1-vcn-tags') }
  $script:ApprovedPlanRaw = '{}'
  $script:OciMutationPreflight = [ordered]@{
    validatedAtUtc = [DateTimeOffset]::UtcNow
    humanZeroCostConfirmed = $true
    quotaProven = $true
    capacityProven = $true
    region = 'sa-saopaulo-1'
    shape = 'VM.Standard.E2.1.Micro'
    ocpus = 1.0
    memoryInGBs = 1.0
    bootVolumeInGBs = 50.0
    bootVolumeVpusPerGB = 10.0
    launchCapacityProven = $true
    publicIpv4IncludedInHumanEstimate = $true
  }
  $script:Evidence.plannedActions = [Collections.Generic.List[string]]::new()
  $script:Evidence.plannedActions.Add('normalize-v1-compartment-tags')
  $script:Evidence.plannedActions.Add('normalize-v1-vcn-tags')
  $script:Evidence.limitations = [Collections.Generic.List[string]]::new()
  [void](Ensure-V2ResourceTags -Resource $script:RemoteResources.compartment -ResourceKind 'compartment')
  [void](Ensure-V2ResourceTags -Resource $script:RemoteResources.vcn -ResourceKind 'vcn')
  $persisted = [IO.File]::ReadAllText($script:StateFile) | ConvertFrom-Json -AsHashtable
  [ordered]@{
    commands = @($script:CapturedUpdates | ForEach-Object { $_.command -join ' ' })
    ifMatches = @($script:CapturedUpdates | ForEach-Object { [string]$_.payload.ifMatch })
    compartmentIdBound = [string]$script:CapturedUpdates[0].payload.compartmentId -ceq $compartmentId
    vcnIdBound = [string]$script:CapturedUpdates[1].payload.vcnId -ceq $vcnId
    compartmentExtraPreserved = [string]$script:CapturedUpdates[0].payload.freeformTags['preserved-external-tag']
    vcnExtraPreserved = [string]$script:CapturedUpdates[1].payload.freeformTags['preserved-external-tag']
    managedByValues = @($script:CapturedUpdates | ForEach-Object { [string]$_.payload.freeformTags['set-livre-managed-by'] })
    pendingCount = $script:PrivateState.pendingTagNormalizations.Count
    proofs = @($script:PrivateState.resources.Values | ForEach-Object { [string]$_.ownershipProof })
    persistedPendingCount = $persisted.pendingTagNormalizations.Count
    persistedProofs = @($persisted.resources.Values | ForEach-Object { [string]$_.ownershipProof })
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($null -ne $script:GlobalLockStream) { $script:GlobalLockStream.Dispose() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
`);
      expect(result).toEqual({
        commands: ["iam compartment update", "network vcn update"],
        ifMatches: ["etag-compartment", "etag-vcn"],
        compartmentIdBound: true,
        vcnIdBound: true,
        compartmentExtraPreserved: "keep-compartment",
        vcnExtraPreserved: "keep-vcn",
        managedByValues: ["provision-oracle-always-free-v2", "provision-oracle-always-free-v2"],
        pendingCount: 0,
        proofs: ["exact-tags", "exact-tags"],
        persistedPendingCount: 0,
        persistedProofs: ["exact-tags", "exact-tags"],
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "builds a complete no-mutation plan for absent and partial network state",
    () => {
      const result = runPowerShellJson(`
$script:PrivateState = New-PrivateProvisioningState
$script:Evidence.plannedActions = [Collections.Generic.List[string]]::new()
$network = [ordered]@{ vcn = $null; internetGateway = $null; routeTable = $null; securityList = $null; subnet = $null; nsg = $null }
Ensure-Vcn -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
Ensure-InternetGateway -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
Ensure-RouteTable -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
Ensure-SecurityList -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
Ensure-Nsg -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
Ensure-Subnet -Network $network -CompartmentId 'ocid1.compartment.oc1..setlivre'
[void](New-TargetInstance -CompartmentId 'ocid1.compartment.oc1..setlivre' -AvailabilityDomain 'AD-1' -Image ([pscustomobject]@{ id = 'ocid1.image.oc1..ubuntu' }) -Network $network -PublicKey ([ordered]@{ path = 'unused'; text = 'unused'; sha256 = ('b' * 64) }))
$absentActions = @($script:Evidence.plannedActions)

function Invoke-OciJson { return [ordered]@{ data = @() } }
$script:Evidence.plannedActions = [Collections.Generic.List[string]]::new()
$partial = [ordered]@{
  vcn = [pscustomobject]@{ id = 'ocid1.vcn.oc1..owned' }
  internetGateway = $null
  routeTable = $null
  securityList = $null
  subnet = $null
  nsg = $null
}
Ensure-RouteTable -Network $partial -CompartmentId 'ocid1.compartment.oc1..setlivre'
[ordered]@{ absentActions = $absentActions; partialActions = @($script:Evidence.plannedActions) } | ConvertTo-Json -Compress
`);
      expect(result.absentActions).toEqual([
        "create-vcn",
        "create-internet-gateway",
        "create-public-route-table",
        "create-no-ingress-security-list",
        "create-production-nsg",
        "create-regional-public-subnet",
        "launch-e2-micro-always-free",
      ]);
      expect(result.partialActions).toEqual(["create-public-route-table"]);
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "runs the complete Plan workflow with only the allowlisted non-persistent capacity probe",
    () => {
      const result = runPowerShellJson(`
$temporary = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('set-livre-full-plan-test-' + [Guid]::NewGuid().ToString('N'))
try {
  $EvidenceDirectory = $temporary
  $script:PlanningPhase = $true
  $script:ProbeCalls = [Collections.Generic.List[object]]::new()
  $script:MutationWasInvoked = $false
  function Resolve-TrustedOciCli { return 'C:\Program Files (x86)\Oracle\oci_cli\oci.exe' }
  function Get-OciProfileContract {
    return [ordered]@{
      configFile = 'C:\fixture\.oci\config'
      tenancyId = 'ocid1.tenancy.oc1..fixture'
      region = 'sa-saopaulo-1'
    }
  }
  function Assert-HomeRegionAndTenancy {}
  function Get-CompartmentContract {
    $target = [pscustomobject]@{
      id = 'ocid1.compartment.oc1..setlivre'
      name = 'SetLivre'
      'lifecycle-state' = 'ACTIVE'
      'freeform-tags' = [pscustomobject]@{
        'set-livre-project' = 'set-livre'
        'set-livre-environment' = 'production'
        'set-livre-managed-by' = 'provision-oracle-always-free-v2'
        'set-livre-resource' = 'compartment'
      }
    }
    return [ordered]@{ target = $target; all = @($target) }
  }
  function Get-AvailabilityDomainAndImage {
    return [ordered]@{
      availabilityDomain = 'AD-1'
      shape = [pscustomobject]@{ shape = 'VM.Standard.E2.1.Micro' }
      image = [pscustomobject]@{
        id = 'ocid1.image.oc1..ubuntu'
        'display-name' = 'Canonical-Ubuntu-24.04-2026.08.18-0'
        'listing-type' = 'NONE'
      }
    }
  }
  function Assert-PhysicalPublicKey {
    $key = [ordered]@{ path = 'unused'; text = 'ssh-ed25519 AAAAfixture'; sha256 = ('b' * 64) }
    $script:Evidence.facts.publicKey = $key
    return $key
  }
  function Get-NetworkState {
    return [ordered]@{ vcn = $null; internetGateway = $null; routeTable = $null; securityList = $null; subnet = $null; nsg = $null }
  }
  function Get-TargetInstance { return $null }
  function Assert-ServiceLimitsAndAlwaysFreeEnvelope {
    return [ordered]@{
      automatedZeroCostProven = $false
      quotaProven = $true
      facts = [ordered]@{
        serviceLimits = [ordered]@{}
        aggregateAfterPlan = [ordered]@{ instanceCount = 1; combinedVolumeInGBs = 50.0 }
      }
    }
  }
  function Invoke-OciJson {
    param([string[]]$Arguments, [string]$Operation, [int]$TimeoutSeconds)
    $script:ProbeCalls.Add([ordered]@{ arguments = @($Arguments); operation = $Operation })
    return [ordered]@{
      data = [pscustomobject]@{
        'time-created' = [DateTimeOffset]::UtcNow.ToString('o')
        'shape-availabilities' = @([pscustomobject]@{ 'availability-status' = 'AVAILABLE' })
      }
    }
  }
  function Invoke-OciMutation {
    $script:MutationWasInvoked = $true
    throw 'Plan attempted an OCI mutation'
  }

  $allowlistRejected = $false
  try {
    [void](Invoke-AllowlistedPlanRemoteProbe -ProbeName 'compute-capacity-report' -Arguments @('compute', 'instance', 'launch') -Operation 'forbidden fixture')
  } catch { $allowlistRejected = $true }

  Invoke-OracleProvisioningWorkflow
  $planDocument = [IO.File]::ReadAllText($script:PlanFile) | ConvertFrom-Json -AsHashtable
  [ordered]@{
    status = $script:Evidence.status
    mutationWasInvoked = $script:MutationWasInvoked
    allowlistRejected = $allowlistRejected
    probeCount = $script:ProbeCalls.Count
    probeCommand = @($script:ProbeCalls[0].arguments[0..2])
    persistentMutation = [bool]$script:Evidence.facts.capacity.persistentMutation
    plannedActions = @($planDocument.plannedActions)
    planExists = Test-Path -LiteralPath $script:PlanFile -PathType Leaf
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
`);
      expect(result).toEqual({
        status: "planned-awaiting-human-zero-cost-confirmation",
        mutationWasInvoked: false,
        allowlistRejected: true,
        probeCount: 1,
        probeCommand: ["compute", "compute-capacity-report", "create"],
        persistentMutation: false,
        plannedActions: [
          "create-vcn",
          "create-internet-gateway",
          "create-public-route-table",
          "create-no-ingress-security-list",
          "create-production-nsg",
          "create-regional-public-subnet",
          "launch-e2-micro-always-free",
        ],
        planExists: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "binds Apply to the exact canonical private Plan and explicit zero-cost confirmation",
    () => {
      const result = runPowerShellJson(`
$temporary = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('set-livre-plan-test-' + [Guid]::NewGuid().ToString('N'))
try {
  $EvidenceDirectory = $temporary
  Initialize-PrivateEvidenceDirectory
  $script:GlobalLockStream = [IO.MemoryStream]::new()
  Initialize-PrivateProvisioningState
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $document = [ordered]@{
    schemaVersion = 3
    status = 'awaiting-human-zero-cost-confirmation'
    planId = [Guid]::NewGuid().ToString('N')
    createdAtUnixSeconds = $now
    expiresAtUnixSeconds = $now + 900
    project = 'set-livre'
    region = 'sa-saopaulo-1'
    administrativeCidr = '198.51.100.10/32'
    plannedActions = @('create-vcn')
  }
  $canonical = ConvertTo-CanonicalJson -Value $document
  Write-PrivateTextFile -Path $script:PlanFile -Text $canonical
  $hash = Get-Sha256HexForText -Text $canonical
  $Apply = $true
  $Plan = $false
  $ConfirmationToken = 'SET_LIVRE_ALWAYS_FREE'
  $ApprovedPlanSha256 = $hash
  $ZeroCostConfirmation = 'OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED'
  Read-ApprovedPlanFile
  [void](Seal-OrVerifyCurrentPlan -CurrentPlan $document)

  $drifted = $canonical | ConvertFrom-Json -AsHashtable
  $drifted.plannedActions = @('create-vcn', 'launch-e2-micro-always-free')
  $driftRejected = $false
  try { [void](Seal-OrVerifyCurrentPlan -CurrentPlan $drifted) } catch { $driftRejected = $true }

  $wrongHashRejected = $false
  $ApprovedPlanSha256 = ('0' * 64)
  try { Read-ApprovedPlanFile } catch { $wrongHashRejected = $true }
  $ApprovedPlanSha256 = $hash
  $ZeroCostConfirmation = 'NOT_REVIEWED'
  $missingHumanConfirmationRejected = $false
  try { Assert-ApplyIntent } catch { $missingHumanConfirmationRejected = $true }

  [ordered]@{
    bound = $script:PrivateState.lastApprovedPlanSha256 -ceq $hash
    driftRejected = $driftRejected
    wrongHashRejected = $wrongHashRejected
    missingHumanConfirmationRejected = $missingHumanConfirmationRejected
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $script:GlobalLockStream) { $script:GlobalLockStream.Dispose() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
`);
      expect(result).toEqual({
        bound: true,
        driftRejected: true,
        wrongHashRejected: true,
        missingHumanConfirmationRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "invalidates A1 plans and retires obsolete ambiguous mutations during the v4 state upgrade",
    () => {
      const result = runPowerShellJson(`
$launchToken = [Guid]::NewGuid().ToString('D')
$ipToken = [Guid]::NewGuid().ToString('D')
function New-ObsoleteRetry([string]$Token, [string]$Key) {
  return [ordered]@{
    token = $Token
    status = 'pending'
    mutationKey = $Key
    requestSha256 = ('b' * 64)
    approvedPlanSha256 = ('a' * 64)
    originApprovedPlanSha256 = ('a' * 64)
    createdAtUnixSeconds = 1L
    expiresAtUnixSeconds = 2L
    request = [ordered]@{ command = @('fixture'); payload = [ordered]@{} }
  }
}
$state = [ordered]@{
  schemaVersion = 2
  project = 'set-livre'
  region = 'sa-saopaulo-1'
  resources = [ordered]@{
    vcn = [ordered]@{ kind = 'vcn'; id = 'ocid1.vcn.oc1..keep'; ownershipProof = 'exact-tags'; approvedPlanSha256 = $null }
    instance = [ordered]@{ kind = 'instance'; id = 'ocid1.instance.oc1..obsolete'; ownershipProof = 'exact-tags'; approvedPlanSha256 = $null }
    'public-ip' = [ordered]@{ kind = 'public-ip'; id = 'ocid1.publicip.oc1..obsolete'; ownershipProof = 'exact-tags'; approvedPlanSha256 = $null }
  }
  retryTokens = [ordered]@{
    'launch-a1-always-free-2x12' = New-ObsoleteRetry -Token $launchToken -Key 'launch-a1-always-free-2x12'
    'assign-ephemeral-public-ipv4' = New-ObsoleteRetry -Token $ipToken -Key 'assign-ephemeral-public-ipv4'
  }
  mutationJournal = [ordered]@{}
  lastApprovedPlanSha256 = ('a' * 64)
}
$upgraded = Upgrade-PrivateProvisioningState -State $state
Assert-PrivateProvisioningState -State $state
[ordered]@{
  upgraded = $upgraded
  schemaVersion = [int]$state.schemaVersion
  pendingCount = $state.retryTokens.Count
  expiredCount = @($state.mutationJournal.Values | Where-Object { $_.status -ceq 'expired' }).Count
  obsoleteResourcesRemoved = -not $state.resources.Contains('instance') -and -not $state.resources.Contains('public-ip')
  networkResourceRetained = $state.resources.Contains('vcn')
  priorPlanInvalidated = $null -eq $state.lastApprovedPlanSha256
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        upgraded: true,
        schemaVersion: 4,
        pendingCount: 0,
        expiredCount: 2,
        obsoleteResourcesRemoved: true,
        networkResourceRetained: true,
        priorPlanInvalidated: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "reconciles startup retries, expires stale tokens and safely resumes a partial NSG payload",
    () => {
      const result = runPowerShellJson(`
$temporary = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('set-livre-retry-test-' + [Guid]::NewGuid().ToString('N'))
try {
  [void](New-Item -ItemType Directory -Path $temporary)
  Set-PrivateDirectoryAcl -Path $temporary
  $script:ScratchPath = $temporary
  $script:StateFile = Join-Path $temporary 'state.json'
  $script:GlobalLockStream = [IO.MemoryStream]::new()
  $legacyToken = [Guid]::NewGuid().ToString('D')
  $legacyState = [ordered]@{
    schemaVersion = 1
    project = 'set-livre'
    region = 'sa-saopaulo-1'
    resources = [ordered]@{}
    retryTokens = [ordered]@{
      'legacy-probe' = [ordered]@{
        token = $legacyToken
        requestSha256 = ('b' * 64)
        approvedPlanSha256 = ('a' * 64)
      }
    }
    lastApprovedPlanSha256 = $null
  }
  $legacyUpgraded = Upgrade-PrivateProvisioningState -State $legacyState
  Assert-PrivateProvisioningState -State $legacyState
  $script:PrivateState = New-PrivateProvisioningState
  $script:CurrentPlanSha256 = ('a' * 64)
  $probeCommand = @('network', 'vcn', 'create')
  $probePayload = @{ displayName = 'set-livre-vcn' }
  $probeFingerprint = Get-Sha256HexForText -Text (ConvertTo-CanonicalJson -Value ([ordered]@{ command = $probeCommand; payload = $probePayload }))
  $firstContext = Get-OrCreateMutationRetryContext -MutationKey 'probe-create' -Command $probeCommand -Payload $probePayload -RequestSha256 $probeFingerprint -RemoteStateObserved
  $sameContext = Get-OrCreateMutationRetryContext -MutationKey 'probe-create' -Command $probeCommand -Payload $probePayload -RequestSha256 $probeFingerprint -RemoteStateObserved
  $changedRequestRejected = $false
  $changedPayload = @{ displayName = 'different-vcn' }
  $changedFingerprint = Get-Sha256HexForText -Text (ConvertTo-CanonicalJson -Value ([ordered]@{ command = $probeCommand; payload = $changedPayload }))
  try { [void](Get-OrCreateMutationRetryContext -MutationKey 'probe-create' -Command $probeCommand -Payload $changedPayload -RequestSha256 $changedFingerprint -RemoteStateObserved) } catch { $changedRequestRejected = $true }
  $startupReconciled = Complete-PendingMutationFromObservedState -MutationKey 'probe-create' -Reason 'fixture-observed-after-startup'

  $expiredContext = Get-OrCreateMutationRetryContext -MutationKey 'probe-expiry' -Command $probeCommand -Payload $probePayload -RequestSha256 $probeFingerprint -RemoteStateObserved
  $expiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 1
  $script:PrivateState.retryTokens['probe-expiry'].createdAtUnixSeconds = $expiredAt - $script:Contract.retryTokenMaximumAgeSeconds
  $script:PrivateState.retryTokens['probe-expiry'].expiresAtUnixSeconds = $expiredAt
  Save-PrivateProvisioningState
  $replacementContext = Get-OrCreateMutationRetryContext -MutationKey 'probe-expiry' -Command $probeCommand -Payload $changedPayload -RequestSha256 $changedFingerprint -RemoteStateObserved
  $expiredTerminal = [string]$script:PrivateState.mutationJournal[$expiredContext.token].status
  [void](Complete-PendingMutationFromObservedState -MutationKey 'probe-expiry' -Reason 'fixture-replacement-observed')

  $Apply = $true
  $Plan = $false
  $ConfirmationToken = 'SET_LIVRE_ALWAYS_FREE'
  $ApprovedPlanSha256 = ('a' * 64)
  $ZeroCostConfirmation = 'OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED'
  $script:PlanningPhase = $false
  $script:ApprovedPlan = [ordered]@{ plannedActions = @('create-vcn') }
  $script:ApprovedPlanRaw = '{}'
  $script:OciMutationPreflight = [ordered]@{
    validatedAtUtc = [DateTimeOffset]::UtcNow
    humanZeroCostConfirmed = $true
    quotaProven = $true
    capacityProven = $true
    region = 'sa-saopaulo-1'
    shape = 'VM.Standard.E2.1.Micro'
    ocpus = 1.0
    memoryInGBs = 1.0
    bootVolumeInGBs = 50.0
    bootVolumeVpusPerGB = 10.0
    launchCapacityProven = $true
    publicIpv4IncludedInHumanEstimate = $true
  }
  $script:Evidence.limitations = [Collections.Generic.List[string]]::new()
  function Invoke-OciJson {
    param([string[]]$Arguments, [string]$Operation, [int]$TimeoutSeconds)
    $script:CapturedArguments = @($Arguments)
    $fromJsonIndex = [Array]::IndexOf([object[]]$Arguments, '--from-json')
    if ($fromJsonIndex -ge 0) {
      $requestUri = [Uri]$Arguments[$fromJsonIndex + 1]
      $script:CapturedPayload = [IO.File]::ReadAllText($requestUri.LocalPath) | ConvertFrom-Json -AsHashtable
    }
    throw [TimeoutException]::new('simulated timeout')
  }
  $resource = [pscustomobject]@{ id = 'ocid1.vcn.oc1.sa-saopaulo-1.reconciled' }
  $response = Invoke-OciMutation -Command @('network', 'vcn', 'create') -Operation 'simulated create' -MutationKey 'create-vcn' -SupportsRetryToken -Reconcile { return $resource } -Payload @{ displayName = 'set-livre-vcn' }
  $retryIndex = [Array]::IndexOf([object[]]$script:CapturedArguments, '--opc-retry-token')
  $createRetryArgumentPresent = $retryIndex -ge 0 -and [Guid]::Parse($script:CapturedArguments[$retryIndex + 1]) -ne [Guid]::Empty

  $expectedRules = @(Get-ExpectedNsgRules)
  $fullNsgPayload = @{ nsgId = 'ocid1.networksecuritygroup.oc1..fixture'; securityRules = $expectedRules }
  $nsgCommand = @('network', 'nsg', 'rules', 'add')
  $fullNsgFingerprint = Get-Sha256HexForText -Text (ConvertTo-CanonicalJson -Value ([ordered]@{ command = $nsgCommand; payload = $fullNsgPayload }))
  $script:CurrentPlanSha256 = ('c' * 64)
  $pendingNsg = Get-OrCreateMutationRetryContext -MutationKey 'add-missing-production-nsg-rules' -Command $nsgCommand -Payload $fullNsgPayload -RequestSha256 $fullNsgFingerprint -RemoteStateObserved
  $script:CurrentPlanSha256 = ('d' * 64)
  $ApprovedPlanSha256 = $script:CurrentPlanSha256
  $script:ApprovedPlan = [ordered]@{ plannedActions = @('add-missing-production-nsg-rules') }
  $partialPayload = @{ nsgId = 'ocid1.networksecuritygroup.oc1..fixture'; securityRules = @($expectedRules[2..4]) }
  $nsg = [pscustomobject]@{ id = 'ocid1.networksecuritygroup.oc1..fixture' }
  $nsgResponse = Invoke-OciMutation -Command $nsgCommand -Operation 'resume partial NSG' -MutationKey 'add-missing-production-nsg-rules' -SupportsRetryToken -PendingRequestCompatibility {
    param($PendingRequest, $CurrentRequest)
    return Test-CompatiblePendingNsgRuleRequest -PendingRequest $PendingRequest -CurrentRequest $CurrentRequest
  } -Reconcile { return $nsg } -Payload $partialPayload
  $nsgRetryIndex = [Array]::IndexOf([object[]]$script:CapturedArguments, '--opc-retry-token')
  $nsgTerminal = [string]$script:PrivateState.mutationJournal[$pendingNsg.token].status

  $validEtag = Get-RequiredOciEtag -Response ([pscustomobject]@{ etag = 'safe-etag' }) -SafeLabel 'fixture'
  $missingEtagRejected = $false
  try { [void](Get-RequiredOciEtag -Response ([pscustomobject]@{}) -SafeLabel 'fixture') } catch { $missingEtagRejected = $true }
  [ordered]@{
    legacyUpgraded = $legacyUpgraded
    legacyStatus = [string]$legacyState.retryTokens['legacy-probe'].status
    legacyRequestIsNull = $null -eq $legacyState.retryTokens['legacy-probe'].request
    tokenStable = $firstContext.token -ceq $sameContext.token
    changedRequestRejected = $changedRequestRejected
    startupReconciled = $startupReconciled
    startupTerminal = [string]$script:PrivateState.mutationJournal[$firstContext.token].status
    expiryRotated = $expiredContext.token -cne $replacementContext.token
    expiredTerminal = $expiredTerminal
    reconciled = [bool]$response.reconciled
    reconciledId = [string](Get-Field -InputObject $response -Name 'data').id
    ambiguous = [bool]$response.cliResultWasAmbiguous
    retryArgumentPresent = $createRetryArgumentPresent
    completedRetryRemoved = -not $script:PrivateState.retryTokens.Contains('create-vcn')
    limitationRecorded = $script:Evidence.limitations -ccontains 'mutation-reconciled-after-ambiguous-cli-result:create-vcn'
    nsgReconciled = [bool]$nsgResponse.reconciled
    nsgReplayedOriginalRuleCount = @($script:CapturedPayload.securityRules).Count
    nsgRetainedToken = $nsgRetryIndex -ge 0 -and [string]$script:CapturedArguments[$nsgRetryIndex + 1] -ceq [string]$pendingNsg.token
    nsgTerminal = $nsgTerminal
    allPendingCleared = $script:PrivateState.retryTokens.Count -eq 0
    validEtag = $validEtag
    missingEtagRejected = $missingEtagRejected
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $script:GlobalLockStream) { $script:GlobalLockStream.Dispose() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
`);
      expect(result).toEqual({
        legacyUpgraded: true,
        legacyStatus: "pending",
        legacyRequestIsNull: true,
        tokenStable: true,
        changedRequestRejected: true,
        startupReconciled: true,
        startupTerminal: "reconciled",
        expiryRotated: true,
        expiredTerminal: "expired",
        reconciled: true,
        reconciledId: "ocid1.vcn.oc1.sa-saopaulo-1.reconciled",
        ambiguous: true,
        retryArgumentPresent: true,
        completedRetryRemoved: true,
        limitationRecorded: true,
        nsgReconciled: true,
        nsgReplayedOriginalRuleCount: 5,
        nsgRetainedToken: true,
        nsgTerminal: "reconciled",
        allPendingCleared: true,
        validEtag: "safe-etag",
        missingEtagRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)("holds one host-global exclusive lock", () => {
    const result = runPowerShellJson(`
$childCommand = @'
$ErrorActionPreference = 'Stop'
. ${quotePowerShellLiteral(scriptPath)} -Plan -AdministrativeCidr '198.51.100.10/32' -EvidenceDirectory 'C:\set-livre-child-lock-probe' -LibraryOnly
try {
  Acquire-GlobalProvisioningLock
  try { Write-Output 'acquired'; exit 0 } finally { Release-GlobalProvisioningLock }
} catch {
  Write-Output 'rejected'
  exit 73
}
'@
function Invoke-LockChild {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = Join-Path $PSHOME 'pwsh.exe'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw 'lock child timed out'
    }
    return [ordered]@{
      exitCode = $process.ExitCode
      stdout = $stdout.GetAwaiter().GetResult().Trim()
      stderr = $stderr.GetAwaiter().GetResult().Trim()
    }
  } finally {
    $process.Dispose()
  }
}

try {
  Acquire-GlobalProvisioningLock
  $blocked = Invoke-LockChild
  $parentStillHeld = $null -ne $script:GlobalLockStream -and [bool]$script:GlobalMutexOwned
} finally {
  Release-GlobalProvisioningLock
}
$afterRelease = Invoke-LockChild
[ordered]@{
  blockedExitCode = $blocked.exitCode
  blockedOutput = $blocked.stdout
  parentStillHeld = $parentStillHeld
  acquiredExitCode = $afterRelease.exitCode
  acquiredOutput = $afterRelease.stdout
} | ConvertTo-Json -Compress
`);
    expect(result).toEqual({
      blockedExitCode: 73,
      blockedOutput: "rejected",
      parentStillHeld: true,
      acquiredExitCode: 0,
      acquiredOutput: "acquired",
    });
  });

  it.runIf(canRunWindowsBehavior)(
    "requires exactly one total VNIC and that VNIC to be primary",
    () => {
      const result = runPowerShellJson(`
$single = Select-OnlyPrimaryVnic -Vnics @([pscustomobject]@{ id = 'vnic-1'; 'is-primary' = $true })
$secondaryRejected = $false
try {
  [void](Select-OnlyPrimaryVnic -Vnics @(
    [pscustomobject]@{ id = 'vnic-1'; 'is-primary' = $true },
    [pscustomobject]@{ id = 'vnic-2'; 'is-primary' = $false }
  ))
} catch { $secondaryRejected = $true }
$nonPrimaryRejected = $false
try { [void](Select-OnlyPrimaryVnic -Vnics @([pscustomobject]@{ id = 'vnic-1'; 'is-primary' = $false })) } catch { $nonPrimaryRejected = $true }
[ordered]@{ id = $single.id; secondaryRejected = $secondaryRejected; nonPrimaryRejected = $nonPrimaryRejected } | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        id: "vnic-1",
        secondaryRejected: true,
        nonPrimaryRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "accepts the untagged ephemeral public IP attached to the exact primary VNIC",
    () => {
      const result = runPowerShellJson(`
$script:Evidence.plannedActions = [Collections.Generic.List[string]]::new()
function Invoke-OciJson {
  param([string[]]$Arguments, [string]$Operation, [int]$TimeoutSeconds, [switch]$AllowEmptyData)
  $command = @($Arguments[0..2]) -join ' '
  if ($command -ceq 'network private-ip list') {
    return [ordered]@{ data = @([pscustomobject]@{ id = 'ocid1.privateip.oc1..fixture'; 'is-primary' = $true }) }
  }
  if ($command -ceq 'network public-ip get') {
    return [ordered]@{ data = [pscustomobject]@{
      id = 'ocid1.publicip.oc1..fixture'
      'ip-address' = '8.8.8.8'
      lifetime = 'EPHEMERAL'
      'assigned-entity-id' = 'ocid1.privateip.oc1..fixture'
      'lifecycle-state' = 'ASSIGNED'
      'compartment-id' = 'ocid1.compartment.oc1..fixture'
      'freeform-tags' = [pscustomobject]@{}
    } }
  }
  throw ('unexpected fixture command: ' + $command)
}
$validated = [ordered]@{
  instance = [pscustomobject]@{ 'compartment-id' = 'ocid1.compartment.oc1..fixture' }
  vnic = [pscustomobject]@{ id = 'ocid1.vnic.oc1..fixture'; 'public-ip' = '8.8.8.8' }
}
$publicIp = Ensure-PublicIpv4 -ValidatedInstance $validated
$validated.vnic = [pscustomobject]@{ id = 'ocid1.vnic.oc1..fixture'; 'public-ip' = $null }
$missingRejected = $false
try { [void](Ensure-PublicIpv4 -ValidatedInstance $validated) } catch { $missingRejected = $true }
[ordered]@{
  address = $publicIp.address
  lifetime = $publicIp.lifetime
  plannedActions = @($script:Evidence.plannedActions)
  missingRejected = $missingRejected
} | ConvertTo-Json -Compress
`);
      expect(result).toEqual({
        address: "8.8.8.8",
        lifetime: "EPHEMERAL",
        plannedActions: [],
        missingRejected: true,
      });
    },
  );

  it.runIf(canRunWindowsBehavior)(
    "validates the private-key ACL and proves that the Ed25519 public key is its pair",
    () => {
      const temporaryProfile = mkdtempSync(join(tmpdir(), "set-livre-ssh-pair-"));
      const sshDirectory = join(temporaryProfile, ".ssh");
      const privateKey = join(sshDirectory, "set-livre-production-admin");
      const sourcePrivateKey = join(sshDirectory, "source-key");
      const otherPrivateKey = join(sshDirectory, "other-key");
      mkdirSync(sshDirectory);
      try {
        for (const keyPath of [sourcePrivateKey, otherPrivateKey]) {
          const generated = spawnSync(
            windowsSshKeygen,
            ["-q", "-t", "ed25519", "-N", "", "-f", keyPath],
            { encoding: "utf8", windowsHide: true },
          );
          expect(generated.status, generated.stderr).toBe(0);
        }

        const result = runPowerShellJson(`
$profile = ${quotePowerShellLiteral(temporaryProfile)}
$privateKey = ${quotePowerShellLiteral(privateKey)}
$publicKey = ${quotePowerShellLiteral(`${privateKey}.pub`)}
$sourcePrivateKey = ${quotePowerShellLiteral(sourcePrivateKey)}
$sourcePublicKey = ${quotePowerShellLiteral(`${sourcePrivateKey}.pub`)}
$otherPublicKey = ${quotePowerShellLiteral(`${otherPrivateKey}.pub`)}
Set-PrivateDirectoryAcl -Path (Split-Path -Parent $privateKey)
[IO.File]::WriteAllBytes($privateKey, [IO.File]::ReadAllBytes($sourcePrivateKey))
[IO.File]::WriteAllText($publicKey, [IO.File]::ReadAllText($sourcePublicKey), [Text.UTF8Encoding]::new($false))
Set-PrivateFileAcl -Path $privateKey
Set-PrivateFileAcl -Path $publicKey
$trustedKeygen = Resolve-TrustedSshKeygen
$validated = Assert-PhysicalPublicKey -UserProfile $profile -SshKeygenPath $trustedKeygen
$otherText = [IO.File]::ReadAllText($otherPublicKey)
[IO.File]::WriteAllText($publicKey, $otherText, [Text.UTF8Encoding]::new($false))
$mismatchRejected = $false
try { [void](Assert-PhysicalPublicKey -UserProfile $profile -SshKeygenPath $trustedKeygen) } catch { $mismatchRejected = $true }
$icacls = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\\icacls.exe'
& $icacls (Split-Path -Parent $privateKey) /grant '*S-1-5-11:(F)' /Q | Out-Null
Assert-True -Condition ($LASTEXITCODE -eq 0) -SafeMessage 'A fixture não conseguiu tornar o ancestral SSH gravável.'
$ancestorRejected = $false
try { [void](Assert-PhysicalPublicKey -UserProfile $profile -SshKeygenPath $trustedKeygen) } catch { $ancestorRejected = $true }
[ordered]@{
  type = ($validated.text -split '\\s+')[0]
  hashBoundToPayload = $validated.sha256 -ceq (Get-Sha256HexForText -Text $validated.text)
  privateAclValidated = [bool]$script:Evidence.facts.publicKey.privateKeyAclValidated
  pairValidated = [bool]$script:Evidence.facts.publicKey.keyPairValidated
  mismatchRejected = $mismatchRejected
  ancestorRejected = $ancestorRejected
} | ConvertTo-Json -Compress
`);
        expect(result).toEqual({
          type: "ssh-ed25519",
          hashBoundToPayload: true,
          privateAclValidated: true,
          pairValidated: true,
          mismatchRejected: true,
          ancestorRejected: true,
        });
      } finally {
        rmSync(temporaryProfile, { recursive: true, force: true });
      }
    },
  );
});
