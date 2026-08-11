"use client";

import { useId, useState, type ComponentPropsWithRef } from "react";

import formStyles from "./form-controls.module.css";
import styles from "./password-input.module.css";

export type PasswordRequirementStatus = "met" | "neutral" | "unmet";

export type PasswordRequirement = {
  id: string;
  label: string;
  status?: PasswordRequirementStatus;
};

export type PasswordInputProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  hideLabel?: string;
  requirements?: readonly PasswordRequirement[];
  requirementsLabel?: string;
  showLabel?: string;
};

const requirementStatusLabels: Record<PasswordRequirementStatus, string> = {
  met: "Atendido",
  neutral: "Requisito",
  unmet: "Pendente",
};

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joinedIds = ids.filter((id) => id !== undefined && id !== "").join(" ");
  return joinedIds === "" ? undefined : joinedIds;
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function PasswordInput({
  "aria-describedby": ariaDescribedBy,
  className,
  disabled = false,
  hideLabel = "Ocultar senha",
  id,
  requirements = [],
  requirementsLabel = "Requisitos da senha",
  showLabel = "Mostrar senha",
  ...inputProps
}: PasswordInputProps) {
  const generatedId = useId();
  const resolvedId = id ?? generatedId;
  const requirementsId = requirements.length === 0 ? undefined : `${resolvedId}-requirements`;
  const [isVisible, setIsVisible] = useState(false);

  return (
    <>
      <div className={styles.control}>
        <input
          {...inputProps}
          aria-describedby={joinIds(ariaDescribedBy, requirementsId)}
          className={joinClassNames(formStyles.input, className)}
          disabled={disabled}
          id={resolvedId}
          type={isVisible ? "text" : "password"}
        />
        <button
          aria-controls={resolvedId}
          aria-pressed={isVisible}
          className={styles.toggle}
          disabled={disabled}
          onClick={() => setIsVisible((currentValue) => !currentValue)}
          type="button"
        >
          {isVisible ? hideLabel : showLabel}
        </button>
      </div>
      {requirements.length === 0 ? null : (
        <ul aria-label={requirementsLabel} className={styles.requirements} id={requirementsId}>
          {requirements.map((requirement) => {
            const status = requirement.status ?? "neutral";
            return (
              <li className={styles.requirement} key={requirement.id}>
                <span className={styles[status]}>{requirementStatusLabels[status]}:</span>
                <span>{requirement.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
