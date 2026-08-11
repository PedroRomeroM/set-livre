import type { ComponentPropsWithRef, ReactNode } from "react";

import styles from "./button.module.css";

export type ButtonVariant = "ghost" | "primary" | "secondary";

export type ButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-busy"> & {
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  variant?: ButtonVariant;
};

const variantClassNames: Record<ButtonVariant, string | undefined> = {
  ghost: styles.ghost,
  primary: styles.primary,
  secondary: styles.secondary,
};

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function Button({
  "aria-label": accessibleLabel,
  children,
  className,
  disabled = false,
  loading = false,
  loadingLabel = "Carregando",
  type = "button",
  variant = "primary",
  ...buttonProps
}: ButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-busy={loading}
      aria-label={loading ? loadingLabel : accessibleLabel}
      className={joinClassNames(styles.button, variantClassNames[variant], className)}
      disabled={disabled || loading}
      type={type}
    >
      <span className={joinClassNames(styles.content, loading ? styles.hiddenContent : undefined)}>
        {children}
      </span>
      {loading ? <span className={styles.loadingLabel}>{loadingLabel}</span> : null}
    </button>
  );
}
