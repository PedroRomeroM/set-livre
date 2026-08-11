import type { z } from "zod";

export type FieldErrors = Readonly<Record<string, string>>;

export function firstFieldErrors(error: z.ZodError): FieldErrors {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (
      (typeof field === "string" || typeof field === "number") &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[String(field)] = issue.message;
    }
  }
  return fieldErrors;
}

export function fieldError(errors: FieldErrors, field: string) {
  return errors[field];
}

export function fieldErrorProp(errors: FieldErrors, field: string): { error?: string } {
  const error = fieldError(errors, field);
  return error === undefined ? {} : { error };
}

export function formValue(form: FormData, field: string) {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}
