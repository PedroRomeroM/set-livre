import { delimiter } from "node:path";

const operationalEnvironmentNames = [
  "CI",
  "COMSPEC",
  "HOME",
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
  "NEXT_TELEMETRY_DISABLED",
  "PATH",
  "PATHEXT",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
] as const;

const pathEnvironmentNames = new Set(["PATH", "Path"]);

export type ValidatedPlaywrightApplicationEnvironment = Readonly<{
  DATABASE_URL_APP_DAL: string;
  NEXT_PUBLIC_APP_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
}>;

function sanitizedOperationalValue(name: string, value: string | undefined) {
  if (value === undefined || value === "" || value.includes("\0")) {
    return undefined;
  }
  if (!pathEnvironmentNames.has(name)) {
    return value;
  }

  const sanitizedPath = value
    .split(delimiter)
    .filter((entry) => entry !== "")
    .join(delimiter);
  return sanitizedPath === "" ? undefined : sanitizedPath;
}

export function createPlaywrightWebServerEnvironmentOverlay(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  applicationEnvironment: ValidatedPlaywrightApplicationEnvironment,
) {
  const overlay: Record<string, string> = Object.fromEntries(
    Object.keys(inheritedEnvironment).map((name) => [name, ""]),
  );

  for (const name of operationalEnvironmentNames) {
    const value = sanitizedOperationalValue(name, inheritedEnvironment[name]);
    if (value !== undefined) {
      overlay[name] = value;
    }
  }

  Object.assign(overlay, applicationEnvironment);
  overlay.APP_ENV = "test";
  overlay.APP_RELEASE_SHA = "local";
  return overlay;
}
