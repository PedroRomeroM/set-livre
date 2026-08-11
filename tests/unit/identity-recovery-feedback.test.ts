import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IdentityRecoverySessionScope } from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import { IdentityApiError } from "../../src/domains/identity/components/identity-api";
import {
  reconcileRecoveryUpdateFeedback,
  recoveryUpdateFeedbackFromError,
} from "../../src/domains/identity/components/recovery-update-feedback";

const recoveryScope = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" satisfies IdentityRecoverySessionScope;
const otherRecoveryScope =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" satisfies IdentityRecoverySessionScope;

describe("identity recovery update feedback", () => {
  it("snapshots only public copy and allowlisted field errors", () => {
    const error = new IdentityApiError("INPUT_INVALID", "Revise os campos destacados.", {
      confirmPassword: "As senhas precisam ser iguais.",
      email: "private@example.test",
      password: "A nova senha não atende aos requisitos de segurança.",
      token: "private-recovery-token",
    });
    Object.assign(error, {
      confirmPassword: "PrivateConfirmPassword9",
      password: "PrivatePassword9",
    });

    const feedback = recoveryUpdateFeedbackFromError(error, recoveryScope);

    expect(feedback).toEqual({
      fieldErrors: {
        confirmPassword: "As senhas precisam ser iguais.",
        password: "A nova senha não atende aos requisitos de segurança.",
      },
      message: "Revise os campos destacados.",
      scope: recoveryScope,
    });
    expect(feedback).not.toBeInstanceOf(Error);
    expect(feedback).not.toHaveProperty("code");
    expect(feedback).not.toHaveProperty("confirmPassword");
    expect(feedback).not.toHaveProperty("password");
    expect(feedback).not.toHaveProperty("stack");
    expect(JSON.stringify(feedback)).not.toMatch(
      /INPUT_INVALID|private@example\.test|private-recovery-token|PrivateConfirmPassword9|PrivatePassword9/iu,
    );
    expect(
      recoveryUpdateFeedbackFromError(new Error("internal-provider-detail"), recoveryScope),
    ).toBeUndefined();
  });

  it("survives a fetching or paused refetch and returns only for the same allowed scope", () => {
    const feedback = recoveryUpdateFeedbackFromError(
      new IdentityApiError("RATE_LIMITED", "Aguarde alguns minutos e tente novamente."),
      recoveryScope,
    );
    const allowedStatus = { allowed: true, scope: recoveryScope } as const;

    expect(
      reconcileRecoveryUpdateFeedback(feedback, allowedStatus, recoveryScope, "fetching"),
    ).toBe(feedback);
    expect(reconcileRecoveryUpdateFeedback(feedback, allowedStatus, recoveryScope, "paused")).toBe(
      feedback,
    );
    expect(reconcileRecoveryUpdateFeedback(feedback, allowedStatus, recoveryScope, "idle")).toBe(
      feedback,
    );
    expect(
      reconcileRecoveryUpdateFeedback(feedback, allowedStatus, otherRecoveryScope, "idle"),
    ).toBeUndefined();
    expect(
      reconcileRecoveryUpdateFeedback(
        feedback,
        { allowed: true, scope: otherRecoveryScope },
        otherRecoveryScope,
        "idle",
      ),
    ).toBeUndefined();
    expect(
      reconcileRecoveryUpdateFeedback(
        feedback,
        { allowed: true, scope: otherRecoveryScope },
        otherRecoveryScope,
        "fetching",
      ),
    ).toBeUndefined();
    expect(
      reconcileRecoveryUpdateFeedback(
        feedback,
        { allowed: false, scope: recoveryScope },
        recoveryScope,
        "idle",
      ),
    ).toBeUndefined();
  });

  it("owns feedback above the unmounted form and clears it before new validation", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/recovery-flow.tsx"),
      "utf8",
    );
    const formStart = content.indexOf("function NewPasswordForm");
    const flowStart = content.indexOf("export function RecoveryFlow");
    const form = content.slice(formStart, flowStart);
    const flow = content.slice(flowStart);

    expect(formStart).toBeGreaterThan(-1);
    expect(flowStart).toBeGreaterThan(formStart);
    expect(form).not.toContain("useState<RecoveryUpdateFeedback");
    expect(flow).toContain("const [recoveryUpdateFeedback, setRecoveryUpdateFeedback] = useState<");
    expect(flow).toContain("recoveryUpdateFeedback={visibleRecoveryUpdateFeedback}");
    expect(flow).toContain("const scopeTransitionGuard = useRef(false);");
    expect(flow).toContain("if (!scopeChanged || scopeTransitionGuard.current)");
    expect(flow.indexOf("scopeTransitionGuard.current = true;")).toBeLessThan(
      flow.indexOf("queryClient.removeQueries({ queryKey: identityQueryKeys.recoveryStatuses });"),
    );
    expect(flow).toContain("if (scopeTransitionStarted || statusQuery.isPending || scopeChanged)");
    expect(form.indexOf("onError: (error) => {")).toBeLessThan(
      form.indexOf("onSettled: async (_data, error) => {"),
    );
    expect(form).toContain(
      "onFeedbackChange(recoveryUpdateFeedbackFromError(error, recoverySessionScope));",
    );
    expect(form).toContain(
      "recoveryUpdateFeedback?.scope === recoverySessionScope ? recoveryUpdateFeedback : undefined",
    );
    expect(form).toContain(
      "event.preventDefault();\n    onFeedbackChange(undefined);\n    mutation.reset();",
    );
    expect(form).not.toContain("setRecoveryUpdateFeedback");
  });
});
