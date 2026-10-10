-- News for Agents: Postgres schema (Neon compatible).
-- Idempotent: safe to run repeatedly via `npm run db:migrate`.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Configured news sources (synced from config/sources.yaml).
create table if not exists sources (
  id              text primary key,
  name            text not null,
  kind            text not null,            -- rss | html | youtube | reddit
  url             text not null,
  home_url        text,
  language        text not null,            -- si | ta | en
  enabled         boolean not null default true,
  last_fetched_at timestamptz,
  last_error      text
);

-- A story is a cluster of articles about the same real-world event/thread.
-- Stories are the unit of retention: a story (and all its articles) lives
-- until it stops receiving updates for RETENTION_DAYS.
create table if not exists stories (
  id               bigserial primary key,
  title            text not null,
  summary          text not null,
  category         text,
  status           text not null default 'developing', -- developing | ongoing | concluded
  keywords         text[] not null default '{}',
  importance       smallint not null default 2,
  article_count    integer not null default 0,
  source_count     integer not null default 0,
  first_seen_at    timestamptz not null,
  last_updated_at  timestamptz not null,
  summary_stale    boolean not null default false,
  community        integer,                  -- Louvain community over the story graph
  embedding        vector(768),
  search           tsvector
);
create index if not exists stories_last_updated_idx on stories (last_updated_at desc);
create index if not exists stories_search_idx on stories using gin (search);
create index if not exists stories_title_trgm_idx on stories using gin (title gin_trgm_ops);

create table if not exists articles (
  id              bigserial primary key,
  source_id       text not null references sources(id) on delete cascade,
  url             text not null unique,
  status          text not null default 'pending', -- pending | analyzed | skipped | failed
  language        text,
  original_title  text,
  raw_text        text,                     -- extracted page text; cleared after analysis
  title           text,                     -- English title
  summary         text,                     -- English summary
  category        text,
  keywords        text[] not null default '{}',
  importance      smallint,
  image_url       text,                     -- original image URL
  image_cdn_url   text,                     -- mirrored copy on R2 (optional)
  published_at    timestamptz,
  fetched_at      timestamptz not null default now(),
  analyzed_at     timestamptz,
  analysis_model  text,
  error           text,
  attempts        smallint not null default 0,
  story_id        bigint references stories(id) on delete cascade,
  embedding       vector(768),
  search          tsvector
);
create index if not exists articles_status_idx on articles (status);
create index if not exists articles_published_idx on articles (published_at desc);
create index if not exists articles_story_idx on articles (story_id);
create index if not exists articles_search_idx on articles using gin (search);

-- Named entities (people, organizations, places, events, topics), canonical English names.
create table if not exists entities (
  id       bigserial primary key,
  slug     text not null unique,           -- "<type>:<normalized-name>"
  name     text not null,
  type     text not null,                  -- person | organization | location | event | topic
  aliases  text[] not null default '{}'
);
create index if not exists entities_name_trgm_idx on entities using gin (name gin_trgm_ops);

create table if not exists article_entities (
  article_id bigint not null references articles(id) on delete cascade,
  entity_id  bigint not null references entities(id) on delete cascade,
  primary key (article_id, entity_id)
);
create index if not exists article_entities_entity_idx on article_entities (entity_id);

-- Derived: how strongly each story involves each entity (rebuilt by `news link`).
create table if not exists story_entities (
  story_id  bigint not null references stories(id) on delete cascade,
  entity_id bigint not null references entities(id) on delete cascade,
  mentions  integer not null,
  primary key (story_id, entity_id)
);
create index if not exists story_entities_entity_idx on story_entities (entity_id);

-- Derived: story-to-story edges (rebuilt by `news link`). Stored once with story_a < story_b.
create table if not exists story_links (
  story_a  bigint not null references stories(id) on delete cascade,
  story_b  bigint not null references stories(id) on delete cascade,
  relation text not null,                  -- shared_entities | similar
  weight   real not null,
  shared   text[] not null default '{}',   -- names of shared entities (explains the link)
  primary key (story_a, story_b),
  check (story_a < story_b)
);
create index if not exists story_links_b_idx on story_links (story_b);

-- Pipeline bookkeeping (served by /v1/status so agents know data freshness).
create table if not exists pipeline_runs (
  id          bigserial primary key,
  step        text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb
);
