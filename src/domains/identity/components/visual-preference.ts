import { colorSchemePreferenceSchema, type ColorSchemePreference } from "@set-livre/contracts";

export const visualPreferenceOptions = [
  { label: "Usar preferência do dispositivo", value: "system" },
  { label: "Tema claro", value: "light" },
  { label: "Tema escuro", value: "dark" },
] as const satisfies ReadonlyArray<{
  label: string;
  value: ColorSchemePreference;
}>;

type VisualPreferenceTarget = {
  dataset: Record<string, string | undefined>;
};

export function applyVisualPreference(
  target: VisualPreferenceTarget,
  preference: ColorSchemePreference,
) {
  target.dataset.colorScheme = colorSchemePreferenceSchema.parse(preference);
}

export function visualPreferenceLabel(preference: ColorSchemePreference) {
  return (
    visualPreferenceOptions.find((option) => option.value === preference)?.label ??
    "Usar preferência do dispositivo"
  );
}
