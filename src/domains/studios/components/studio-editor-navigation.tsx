import Link from "next/link";

import styles from "./studio-editor-navigation.module.css";

const studioEditorSections = [
  { id: "dados", label: "Dados e conteúdo" },
  { id: "midia", label: "Fotos" },
  { id: "publicacao", label: "Publicação" },
] as const;

type StudioEditorSection = (typeof studioEditorSections)[number]["id"];

export function StudioEditorNavigation({
  current,
  studioId,
}: Readonly<{ current: StudioEditorSection; studioId: string }>) {
  return (
    <nav aria-label="Edição do estúdio" className={styles.navigation}>
      {studioEditorSections.map((section) => (
        <Link
          aria-current={current === section.id ? "page" : undefined}
          className={styles.link}
          href={`/dono/estudios/${studioId}/${section.id}`}
          key={section.id}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
