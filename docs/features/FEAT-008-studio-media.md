# FEAT-008 — Galeria de fotos, capa e ordenação

## Metadados

| Campo            | Valor                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                  |
| Prioridade       | P0                                                                                                         |
| Domínio          | `media`                                                                                                    |
| Specs Playwright | `tests/e2e/critical/feat-008-studio-media.spec.ts`<br>`tests/e2e/regression/feat-008-studio-media.spec.ts` |

## Objetivo

Permitir fotos de alta qualidade com upload direto seguro, capa e ordenação, sem expor mídia não aprovada.

## Papéis

- dono
- reviewer
- visitante

## Rotas e superfícies

- /dono/estudios/[studioId]/midia

## Dependências

- FEAT-006
- Supabase Storage
- FEAT-030

## Incluído

- Preparação e finalização do upload.
- 1–20 fotos.
- JPEG/PNG/WebP/AVIF até 15MB.
- Capa.
- Ordenação.
- Remoção segura.
- Pré-visualização para dono/revisor e entrega pública após aprovação.

## Fora desta feature

- upload de vídeo
- editor de imagem
- SVG/GIF

## Regras de produto e domínio

- Somente revisão em rascunho.
- A capa é obrigatória no envio para revisão.
- Objeto não finalizado limpa em 24h.
- Original preservado.
- A reordenação é transacional.
- Mídia antiga não some da revisão publicada.

## Dados canônicos afetados

- studio_media
- Storage bucket privado

## Read models

- media URLs assinadas/públicas por revisão

## Comandos e integrações

- studio.media.upload.prepare
- finalize
- reorder
- cover.set
- delete

## UX e estados obrigatórios

- Progress por arquivo.
- Erro individual.
- Reordenação por arrastar com alternativa por botões e teclado.
- Pré-visualização em lightbox.
- Mobile grid.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Signed URL curta.
- MIME real/dimensões/checksum.
- Path derivado.
- RLS Storage.
- Sem SVG.

## Critérios de aceitação

- Um upload válido é finalizado.
- Arquivo spoof/maior falha.
- Uma capa.
- Mídia pendente não é pública.
- Approved entrega responsiva.
- Orphan cleanup.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                           | Spec                                                 |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------------- | ---------------------------------------------------- |
| SL-F008-E2E-001 | P0         | critical   | desktop  | fazer upload, finalizar, definir capa e reordenar | `tests/e2e/critical/feat-008-studio-media.spec.ts`   |
| SL-F008-E2E-002 | P0         | critical   | desktop  | MIME forjado e tamanho excedido são rejeitados    | `tests/e2e/critical/feat-008-studio-media.spec.ts`   |
| SL-F008-E2E-003 | P0         | critical   | desktop  | mídia em rascunho não é pública                   | `tests/e2e/critical/feat-008-studio-media.spec.ts`   |
| SL-F008-E2E-004 | P1         | regression | mobile   | reordenar por alternativa acessível               | `tests/e2e/regression/feat-008-studio-media.spec.ts` |
| SL-F008-E2E-005 | P1         | regression | desktop  | galeria aprovada não causa CLS                    | `tests/e2e/regression/feat-008-studio-media.spec.ts` |
| SL-F008-E2E-006 | P0         | critical   | desktop  | dono A não obtém upload assinado para estúdio B   | `tests/e2e/critical/feat-008-studio-media.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: file policy/path
- integração: Storage fake/local
- banco: cover unique/RLS
- cleanup job

## Documentação viva afetada

- media.md
- security-privacy.md
- qa-test-plan.md

Enquanto este plano existir, qualquer mudança de escopo atualiza este arquivo e o catálogo QA.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.
