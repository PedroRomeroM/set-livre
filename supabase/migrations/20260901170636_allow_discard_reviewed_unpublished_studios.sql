alter table public.studio_review_events
  drop constraint studio_review_events_studio_id_fkey,
  drop constraint studio_review_events_revision_id_fkey,
  add constraint studio_review_events_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete cascade,
  add constraint studio_review_events_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete cascade;

alter table public.email_outbox
  drop constraint email_outbox_studio_id_fkey,
  drop constraint email_outbox_revision_id_fkey,
  add constraint email_outbox_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete cascade,
  add constraint email_outbox_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete cascade;

comment on constraint studio_review_events_studio_id_fkey on public.studio_review_events is
  'Evento pertence ao agregado; exclusao canonica de estudio nunca publicado remove seu historico editorial.';
comment on constraint studio_review_events_revision_id_fkey on public.studio_review_events is
  'Evento acompanha a revisao quando o agregado nunca publicado e descartado integralmente.';
comment on constraint email_outbox_studio_id_fkey on public.email_outbox is
  'Intencao pendente nao sobrevive a exclusao canonica do estudio nunca publicado.';
comment on constraint email_outbox_revision_id_fkey on public.email_outbox is
  'Intencao pendente nao sobrevive a exclusao canonica da revisao e de seu agregado.';
