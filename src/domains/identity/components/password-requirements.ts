import type { PasswordRequirement } from "@set-livre/ui/password-input";

function requirementStatus(password: string, isMet: boolean) {
  if (password.length === 0) {
    return "neutral" as const;
  }
  return isMet ? ("met" as const) : ("unmet" as const);
}

export function passwordRequirements(password: string): readonly PasswordRequirement[] {
  return [
    {
      id: "length",
      label: "Pelo menos 10 caracteres",
      status: requirementStatus(password, password.length >= 10),
    },
    {
      id: "lowercase",
      label: "Uma letra minúscula",
      status: requirementStatus(password, /[a-z]/.test(password)),
    },
    {
      id: "uppercase",
      label: "Uma letra maiúscula",
      status: requirementStatus(password, /[A-Z]/.test(password)),
    },
    {
      id: "number",
      label: "Um número",
      status: requirementStatus(password, /[0-9]/.test(password)),
    },
  ];
}
