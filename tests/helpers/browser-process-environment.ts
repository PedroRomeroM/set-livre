const operationalEnvironmentNames = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_ADDRESS",
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
  "TZ",
  "CI",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

const pathEnvironmentNames = new Set(["PATH", "Path"]);
const snapPathSegment = /(?:^|[/\\])snap(?:\.[^/\\]*)?(?:[/\\]|$)/iu;

function containsSnapPath(value: string) {
  return snapPathSegment.test(value);
}

function sanitizeSearchPath(value: string) {
  const separator = value.includes(";") || /^[A-Za-z]:[/\\]/u.test(value) ? ";" : ":";

  return value
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && !containsSnapPath(segment))
    .join(separator);
}

export function createBrowserProcessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const browserEnvironment: Record<string, string> = {};

  for (const name of operationalEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value === "") {
      continue;
    }

    const sanitizedValue = pathEnvironmentNames.has(name) ? sanitizeSearchPath(value) : value;
    if (sanitizedValue === "" || containsSnapPath(sanitizedValue)) {
      continue;
    }

    browserEnvironment[name] = sanitizedValue;
  }

  return browserEnvironment;
}
