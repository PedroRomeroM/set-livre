# Performance, SEO e custos

## 1. Public rendering

- Server Components by default;
- home static/revalidated;
- listing SSR based on query;
- detail cached by published revision/version;
- authenticated no public cache;
- backoffice private/noindex.

## 2. Data

- read models;
- server filters;
- cursor;
- max 24 public, 50 admin;
- availability max 31 days;
- no N+1;
- no full base download;
- stale time by domain;
- invalidation map.

## 3. Images

- dimensions;
- responsive sizes;
- LCP preload one;
- lazy rest;
- original storage;
- immutable path/cache;
- monitor egress;
- no transform explosion.

## 4. JS

- client components only interactive edge;
- lazy calendar/lightbox/provider widgets;
- no global domain provider;
- bundle analysis at release;
- backoffice separate prevents public bundle contamination.

## 5. SEO

Indexable:

- home;
- base listing;
- studio detail.

Rules:

- canonical;
- filtered combinations generally canonical/noindex as defined;
- title/description;
- OG;
- sitemap published studios;
- robots;
- JSON-LD;
- 404/removed behavior;
- public content SSR without session/JS.

Detail URL uses ID in baseline. If slug is introduced later, ADR/migration/canonical required.

## 6. Web vitals

Monitor p75 real-user or provider:

- LCP;
- INP;
- CLS;
- TTFB.

Budgets:

- no unbounded client bundle;
- no layout shift gallery/card;
- no synchronous third-party scripts on initial page except necessary;
- YouTube click/lazy placeholder.

## 7. Database performance

- EXPLAIN with volume;
- structural indexes only initially;
- RLS measured;
- pagination stable;
- calendar range query;
- outbox indexes;
- slow query log/advisor.

## 8. Costs

Track:

- Supabase DB/storage/egress/transform;
- Oracle compute/storage/egress;
- payment fees;
- e-mail;
- Sentry/logs;
- backups.

High-quality media makes Supabase Free unsuitable quickly. Cost dashboard/threshold is part of production readiness.
