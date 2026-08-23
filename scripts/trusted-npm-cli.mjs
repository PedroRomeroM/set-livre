import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep, win32 } from "node:path";

const windowsSecurityInspectionTimeoutMilliseconds = 30_000;
const windowsEnvironmentAllowlist = new Map(
  [
    "APPDATA",
    "CI",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LANGUAGE",
    "LC_ADDRESS",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
  ].map((name) => [name, name]),
);
const forbiddenNodeEnvironmentNames = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "SUPABASE_CLI_BINARY_OVERRIDE",
]);

const windowsTrustedPathInspectionScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Read-Request {
  $source = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($source)) {
    throw 'invalid request'
  }
  return $source | ConvertFrom-Json
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

function Get-PathChain([string] $Root, [string] $Path) {
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (
    -not $fullPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'path escapes trusted root'
  }

  $chain = New-Object 'System.Collections.Generic.List[string]'
  $chain.Add($rootPath)
  if ($fullPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $chain.ToArray()
  }

  $current = $rootPath
  $relativePath = $fullPath.Substring($prefix.Length)
  foreach ($component in $relativePath.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [System.IO.Path]::Combine($current, $component)
    $chain.Add($current)
  }
  return $chain.ToArray()
}

function Assert-TrustedAcl([string] $Path) {
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentUser) {
    throw 'current user has no SID'
  }

  $trustedOwners = @{
    $currentUser.Value = $true
    'S-1-5-18' = $true
    'S-1-5-32-544' = $true
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' = $true
  }
  $trustedWriters = @{}
  foreach ($sid in $trustedOwners.Keys) {
    $trustedWriters[$sid] = $true
  }
  $trustedWriters['S-1-3-0'] = $true
  $trustedWriters['S-1-3-4'] = $true

  $item = Get-Item -LiteralPath $Path -Force
  $security = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or -not $trustedOwners.ContainsKey($owner.Value)) {
    throw 'untrusted owner'
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
      throw 'untrusted writable ACL'
    }
  }
}

$request = Read-Request
$root = [string]$request.trustedRoot
$path = [string]$request.path
$chain = @(Get-PathChain $root $path)
for ($index = 0; $index -lt $chain.Count; $index += 1) {
  $candidate = $chain[$index]
  $attributes = Get-SafeAttributes $candidate
  if ($null -eq $attributes -or ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'missing or reparsed path'
  }
  if ($index -lt ($chain.Count - 1) -and ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
    throw 'ancestor is not a directory'
  }
  Assert-TrustedAcl $candidate
}
[Console]::Out.Write('ok')
`;

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathApi(platform) {
  return platform === "win32"
    ? win32
    : { basename, dirname, isAbsolute, parse, relative, resolve, sep };
}

function canonicalPath(value, api) {
  return api.resolve(value) === value && !value.includes("\0");
}

function assertWindowsCanonicalPath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    !win32.isAbsolute(value) ||
    win32.resolve(value) !== value ||
    !/^[A-Za-z]:\\/u.test(value)
  ) {
    throw new Error(`${label} precisa usar caminho local absoluto canônico no Windows.`);
  }
}

function resolvePhysicalWindowsPowerShell(systemRoot, inspectPath) {
  assertWindowsCanonicalPath(systemRoot, "SystemRoot");
  const executable = win32.resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const information = inspectPath(executable, { throwIfNoEntry: false });
  if (information === undefined || !information.isFile() || information.isSymbolicLink()) {
    throw new Error("O Windows PowerShell do sistema não é um executável físico regular.");
  }
  return executable;
}

export function assertWindowsTrustedPathIntegrity(
  filePath,
  {
    execute = spawnSync,
    inspectPath = lstatSync,
    systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
    trustedRoot = dirname(filePath),
  } = {},
) {
  assertWindowsCanonicalPath(filePath, "O arquivo confiável");
  assertWindowsCanonicalPath(trustedRoot, "A raiz confiável");
  const relativePath = win32.relative(trustedRoot, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relativePath)
  ) {
    throw new Error("O arquivo confiável precisa permanecer dentro da raiz declarada.");
  }

  assertWindowsCanonicalPath(systemRoot, "SystemRoot");
  const trustedSystemRoot = win32.resolve(systemRoot);
  const executable = resolvePhysicalWindowsPowerShell(trustedSystemRoot, inspectPath);
  const encodedCommand = Buffer.from(windowsTrustedPathInspectionScript, "utf16le").toString(
    "base64",
  );
  const result = execute(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      env: {
        SystemRoot: trustedSystemRoot,
        WINDIR: trustedSystemRoot,
      },
      input: JSON.stringify({ path: filePath, trustedRoot }),
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: windowsSecurityInspectionTimeoutMilliseconds,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stdout !== "ok"
  ) {
    throw new Error("A integridade DACL do arquivo confiável não pôde ser comprovada.", {
      cause: result.error,
    });
  }
}

function sanitizedEnvironmentValue(name, value, platform) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    return undefined;
  }
  if (name !== "PATH") {
    return value;
  }

  const pathDelimiter = platform === "win32" ? win32.delimiter : sep;
  const sanitizedPath = value
    .split(pathDelimiter)
    .filter((entry) => entry !== "")
    .join(pathDelimiter);
  return sanitizedPath === "" ? undefined : sanitizedPath;
}

export function createTrustedCliEnvironment(
  environment,
  { additionalWindowsNames = [], platform = process.platform } = {},
) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("O ambiente da CLI precisa ser um mapa de variáveis.");
  }

  if (platform !== "win32") {
    const sanitized = { ...environment };
    for (const name of forbiddenNodeEnvironmentNames) {
      delete sanitized[name];
    }
    return sanitized;
  }

  const allowlist = new Map(windowsEnvironmentAllowlist);
  for (const name of additionalWindowsNames) {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error("A allowlist Windows da CLI contém um nome inválido.");
    }
    allowlist.set(name.toUpperCase(), name);
  }

  const sanitized = {};
  const seenValues = new Map();
  for (const [inheritedName, inheritedValue] of Object.entries(environment)) {
    const canonicalName = allowlist.get(inheritedName.toUpperCase());
    if (canonicalName === undefined) {
      continue;
    }
    const value = sanitizedEnvironmentValue(canonicalName, inheritedValue, platform);
    if (value === undefined) {
      continue;
    }
    const previousValue = seenValues.get(canonicalName);
    if (previousValue !== undefined && previousValue !== value) {
      throw new Error(`O ambiente Windows contém variantes conflitantes de ${canonicalName}.`);
    }
    seenValues.set(canonicalName, value);
    sanitized[canonicalName] = value;
  }
  return sanitized;
}

export function assertTrustedNpmPathShape({
  nodeExecutable,
  npmCliPath,
  platform = process.platform,
}) {
  const api = pathApi(platform);
  for (const [label, value] of [
    ["Node", nodeExecutable],
    ["npm CLI", npmCliPath],
  ]) {
    if (
      typeof value !== "string" ||
      value === "" ||
      !api.isAbsolute(value) ||
      !canonicalPath(value, api)
    ) {
      throw new Error(`${label} precisa usar caminho absoluto canônico.`);
    }
  }

  if (api.basename(npmCliPath).toLowerCase() !== "npm-cli.js") {
    throw new Error("A CLI npm precisa identificar npm-cli.js.");
  }
}

function assertPhysicalAncestry(filePath, platform) {
  const api = pathApi(platform);
  const root = api.parse(filePath).root;
  let current = root;
  const rootInformation = lstatSync(root, { throwIfNoEntry: false });
  if (
    rootInformation === undefined ||
    !rootInformation.isDirectory() ||
    rootInformation.isSymbolicLink()
  ) {
    throw new Error("A raiz do caminho npm precisa ser um diretório físico.");
  }

  const parentPath = api.dirname(filePath);
  const components = api.relative(root, parentPath).split(api.sep).filter(Boolean);
  for (const component of components) {
    current = api.resolve(current, component);
    const information = lstatSync(current, { throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("O caminho npm atravessa um diretório não físico.");
    }
  }
}

function inspectPhysicalFile(
  filePath,
  label,
  readContents = false,
  {
    assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
    platform = process.platform,
    trustedRoot = dirname(filePath),
  } = {},
) {
  assertPhysicalAncestry(filePath, platform);
  let descriptor;

  try {
    const pathInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      (platform !== "win32" && (pathInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} precisa ser um arquivo físico regular protegido.`);
    }

    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (platform !== "win32" && (openedInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a abertura.`);
    }

    const contents = readContents ? readFileSync(descriptor, "utf8") : undefined;
    const finalInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      !finalInformation.isFile() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      (platform !== "win32" && (finalInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a leitura.`);
    }

    if (platform === "win32") {
      assertWindowsIntegrity(filePath, { trustedRoot });
    }

    return { contents, information: openedInformation };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function parsePackageJson(contents, label) {
  try {
    const value = JSON.parse(contents);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid-package");
    }
    return value;
  } catch {
    throw new Error(`${label} não contém package.json válido.`);
  }
}

function expectedRepositoryManifest(repositoryRoot, securityOptions) {
  const packagePath = resolve(repositoryRoot, "package.json");
  return parsePackageJson(
    inspectPhysicalFile(packagePath, "Manifesto raiz", true, {
      ...securityOptions,
      trustedRoot: repositoryRoot,
    }).contents,
    "Manifesto raiz",
  );
}

function expectedToolchainVersions(repositoryRoot, securityOptions) {
  const packageJson = expectedRepositoryManifest(repositoryRoot, securityOptions);
  const packageManager = packageJson.packageManager;
  const match =
    typeof packageManager === "string" ? /^npm@(\d+\.\d+\.\d+)$/u.exec(packageManager) : null;
  const devEngine = packageJson.devEngines?.packageManager;
  const runtimeEngine = packageJson.devEngines?.runtime;
  if (
    match === null ||
    devEngine?.name !== "npm" ||
    devEngine.version !== match[1] ||
    runtimeEngine?.name !== "node" ||
    !/^\d+\.\d+\.\d+$/u.test(runtimeEngine.version)
  ) {
    throw new Error("O manifesto raiz não fixa versões Node/npm válidas.");
  }
  return { node: runtimeEngine.version, npm: match[1] };
}

function validateNpmInstallation(
  npmCliPath,
  nodeExecutable,
  expectedVersion,
  platform,
  securityOptions,
) {
  const installationRoot = dirname(nodeExecutable);
  inspectPhysicalFile(npmCliPath, "npm CLI", false, {
    ...securityOptions,
    trustedRoot: installationRoot,
  });
  const npmPackageRoot = resolve(dirname(npmCliPath), "..");
  const expectedNpmPackageRoot =
    platform === "win32"
      ? resolve(dirname(nodeExecutable), "node_modules/npm")
      : resolve(dirname(nodeExecutable), "../lib/node_modules/npm");
  const normalizedNpmPackageRoot =
    platform === "win32" ? npmPackageRoot.toLowerCase() : npmPackageRoot;
  const normalizedExpectedRoot =
    platform === "win32" ? expectedNpmPackageRoot.toLowerCase() : expectedNpmPackageRoot;
  if (normalizedNpmPackageRoot !== normalizedExpectedRoot) {
    throw new Error("npm-cli.js não pertence à instalação do Node atual.");
  }
  const npmPackagePath = resolve(npmPackageRoot, "package.json");
  const npmPackage = parsePackageJson(
    inspectPhysicalFile(npmPackagePath, "Manifesto npm", true, {
      ...securityOptions,
      trustedRoot: installationRoot,
    }).contents,
    "Manifesto npm",
  );
  const declaredCli = npmPackage.bin?.npm;
  if (
    npmPackage.name !== "npm" ||
    npmPackage.version !== expectedVersion ||
    typeof declaredCli !== "string" ||
    resolve(npmPackageRoot, declaredCli) !== npmCliPath
  ) {
    throw new Error("npm-cli.js não corresponde à versão npm fixada pelo repositório.");
  }
}

export function bundledNpmCliPath(nodeExecutable = process.execPath, platform = process.platform) {
  const api = pathApi(platform);
  return platform === "win32"
    ? api.resolve(api.dirname(nodeExecutable), "node_modules/npm/bin/npm-cli.js")
    : api.resolve(api.dirname(nodeExecutable), "../lib/node_modules/npm/bin/npm-cli.js");
}

export function resolveTrustedNpmCliLaunch({
  assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
  repositoryRoot = resolve(import.meta.dirname, ".."),
} = {}) {
  const securityOptions = { assertWindowsIntegrity, platform };
  const npmCliPath = bundledNpmCliPath(nodeExecutable, platform);
  assertTrustedNpmPathShape({ nodeExecutable, npmCliPath, platform });
  inspectPhysicalFile(nodeExecutable, "Node", false, {
    ...securityOptions,
    trustedRoot: dirname(nodeExecutable),
  });

  const expectedVersions = expectedToolchainVersions(repositoryRoot, securityOptions);
  if (nodeVersion !== expectedVersions.node) {
    throw new Error("O Node atual não corresponde à versão fixada pelo repositório.");
  }
  validateNpmInstallation(
    npmCliPath,
    nodeExecutable,
    expectedVersions.npm,
    platform,
    securityOptions,
  );
  return {
    argumentPrefix: [npmCliPath],
    command: nodeExecutable,
    npmCliPath,
    npmVersion: expectedVersions.npm,
  };
}

export function resolveTrustedRepositoryCliLaunch({
  assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
  cliRelativePath,
  dependencyName,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
  repositoryRoot = resolve(import.meta.dirname, ".."),
} = {}) {
  if (
    typeof dependencyName !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(dependencyName) ||
    typeof cliRelativePath !== "string" ||
    cliRelativePath === "" ||
    cliRelativePath.includes("\0") ||
    isAbsolute(cliRelativePath)
  ) {
    throw new Error("O contrato da CLI do repositório é inválido.");
  }

  const securityOptions = { assertWindowsIntegrity, platform };
  const packageJson = expectedRepositoryManifest(repositoryRoot, securityOptions);
  const expectedVersion =
    packageJson.dependencies?.[dependencyName] ?? packageJson.devDependencies?.[dependencyName];
  if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
    throw new Error("A CLI do repositório precisa ter versão exata fixada.");
  }

  const runtimeVersion = packageJson.devEngines?.runtime;
  if (
    runtimeVersion?.name !== "node" ||
    runtimeVersion.version !== nodeVersion ||
    typeof nodeExecutable !== "string"
  ) {
    throw new Error("O Node atual não corresponde à versão fixada pelo repositório.");
  }

  const packageRoot = resolve(repositoryRoot, "node_modules", dependencyName);
  const cliPath = resolve(packageRoot, cliRelativePath);
  const relativeCliPath = relative(packageRoot, cliPath);
  if (
    relativeCliPath === "" ||
    relativeCliPath === ".." ||
    relativeCliPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeCliPath)
  ) {
    throw new Error("O entrypoint da CLI escapa do pacote fixado.");
  }

  inspectPhysicalFile(nodeExecutable, "Node", false, {
    ...securityOptions,
    trustedRoot: dirname(nodeExecutable),
  });
  inspectPhysicalFile(cliPath, "Entrypoint da CLI", false, {
    ...securityOptions,
    trustedRoot: repositoryRoot,
  });
  const dependencyManifest = parsePackageJson(
    inspectPhysicalFile(resolve(packageRoot, "package.json"), "Manifesto da CLI", true, {
      ...securityOptions,
      trustedRoot: repositoryRoot,
    }).contents,
    "Manifesto da CLI",
  );
  if (
    dependencyManifest.name !== dependencyName ||
    dependencyManifest.version !== expectedVersion
  ) {
    throw new Error("A CLI instalada não corresponde à dependência fixada pelo repositório.");
  }

  return {
    argumentPrefix: [cliPath],
    cliPath,
    command: nodeExecutable,
    version: expectedVersion,
  };
}
