import type { ComponentPropsWithoutRef, ReactNode } from "react";

import styles from "./feedback.module.css";

export type AlertVariant = "error" | "status";

export type AlertProps = Omit<ComponentPropsWithoutRef<"div">, "role" | "title"> & {
  children: ReactNode;
  title?: ReactNode;
  variant?: AlertVariant;
};

const variantClassNames: Record<AlertVariant, string | undefined> = {
  error: styles.error,
  status: styles.status,
};

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function Alert({
  children,
  className,
  title,
  variant = "status",
  ...alertProps
}: AlertProps) {
  return (
    <div
      {...alertProps}
      aria-atomic="true"
      className={joinClassNames(styles.alert, variantClassNames[variant], className)}
      role={variant === "error" ? "alert" : "status"}
    >
      {title === undefined ? null : <p className={styles.title}>{title}</p>}
      <div
        className={joinClassNames(
          styles.content,
          title === undefined ? styles.contentOnly : undefined,
        )}
      >
        {children}
      </div>
    </div>
  );
}
