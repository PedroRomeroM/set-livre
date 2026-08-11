import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

import styles from "./layout.module.css";

export type PageFrameWidth = "narrow" | "wide";

export type PageFrameProps = ComponentPropsWithoutRef<"main"> & {
  width?: PageFrameWidth;
};

export type StackSpace = 2 | 3 | 4 | 5 | 6;

export type StackProps = ComponentPropsWithoutRef<"div"> & {
  space?: StackSpace;
};

export type PanelProps = ComponentPropsWithoutRef<"div">;

export type AuthFrameProps = {
  children: ReactNode;
  description: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
};

const widthClassNames: Record<PageFrameWidth, string | undefined> = {
  narrow: styles.narrow,
  wide: styles.wide,
};

const stackClassNames: Record<StackSpace, string | undefined> = {
  2: styles.space2,
  3: styles.space3,
  4: styles.space4,
  5: styles.space5,
  6: styles.space6,
};

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function PageFrame({ children, className, width = "wide", ...mainProps }: PageFrameProps) {
  return (
    <main {...mainProps} className={joinClassNames(styles.pageFrame, className)}>
      <div className={joinClassNames(styles.pageContent, widthClassNames[width])}>{children}</div>
    </main>
  );
}

export function Stack({ className, space = 4, ...stackProps }: StackProps) {
  return (
    <div
      {...stackProps}
      className={joinClassNames(styles.stack, stackClassNames[space], className)}
    />
  );
}

export function Panel({ className, ...panelProps }: PanelProps) {
  return <div {...panelProps} className={joinClassNames(styles.panel, className)} />;
}

export function AuthFrame({ children, description, eyebrow, title }: AuthFrameProps) {
  const titleId = useId();

  return (
    <PageFrame aria-labelledby={titleId}>
      <div className={styles.authGrid}>
        <header className={styles.authHeader}>
          {eyebrow === undefined ? null : <p className={styles.eyebrow}>{eyebrow}</p>}
          <h1 className={styles.title} id={titleId}>
            {title}
          </h1>
          <p className={styles.description}>{description}</p>
        </header>
        <Panel>{children}</Panel>
      </div>
    </PageFrame>
  );
}
