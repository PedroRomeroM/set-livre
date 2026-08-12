import "server-only";

import { colorSchemePreferenceSchema, type ColorSchemePreference } from "@set-livre/contracts";
import { cookies } from "next/headers";

import { readSupabaseEnvironment } from "@/lib/supabase/config";

export const profilePreferenceCookieName = "sl-color-scheme";
const profilePreferenceCookieMaximumAgeSeconds = 365 * 24 * 60 * 60;

export type ProfilePreferenceCookieReader = Readonly<{
  get: (name: string) => { value?: string } | undefined;
}>;

export type ProfilePreferenceCookieWriter = ProfilePreferenceCookieReader &
  Readonly<{
    set: (
      name: string,
      value: string,
      options: Readonly<{
        httpOnly: true;
        maxAge: number;
        path: "/";
        sameSite: "lax";
        secure: boolean;
      }>,
    ) => unknown;
  }>;

export function profilePreferenceFromCookieStore(
  cookieStore: ProfilePreferenceCookieReader,
): ColorSchemePreference {
  const parsed = colorSchemePreferenceSchema.safeParse(
    cookieStore.get(profilePreferenceCookieName)?.value,
  );
  return parsed.success ? parsed.data : "system";
}

export async function readProfilePreferenceCookie() {
  return profilePreferenceFromCookieStore(await cookies());
}

export function writeProfilePreferenceCookie(
  cookieStore: ProfilePreferenceCookieWriter,
  preference: ColorSchemePreference,
) {
  const parsedPreference = colorSchemePreferenceSchema.parse(preference);
  cookieStore.set(profilePreferenceCookieName, parsedPreference, {
    httpOnly: true,
    maxAge: profilePreferenceCookieMaximumAgeSeconds,
    path: "/",
    sameSite: "lax",
    secure: readSupabaseEnvironment().cookieOptions.secure,
  });
  return parsedPreference;
}
