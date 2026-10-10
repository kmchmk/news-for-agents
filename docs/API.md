# News for Agents API

Sri Lankan news as compact JSON, built for AI agents. The sources are in Sinhala, Tamil and English, and every
title and summary is in English. The API is read-only, needs no key, and is limited to 60 requests per minute per IP.
Responses are cached for about 2 minutes. Fields that are null or empty are omitted.

Base URL: `https://news-for-agents.vercel.app`

`GET /` returns a machine-readable description of every endpoint, so an agent can learn the API in one call.

## Concepts
- **Story**: one event or developing situation, merged from many articles across outlets and
  languages. Prefer stories: they deduplicate coverage and carry a running summary.
- **Article**: one outlet's report, with `url` linking to the original.
- **Entity**: a person, organization, location, event or topic.
- **Graph**: nodes are `story:<id>`, `article:<id>`, `entity:<id>` and `source:<id>`. Edges are `part_of`,
  `mentions`, `involves`, `related` and `published_by`.
- `importance`: 1 is trivial and 5 is critical national news. `status`: `developing`, `ongoing` or `concluded`.
- Time parameters accept durations (`90m`, `6h`, `2d`, `1w`) or ISO dates.

## Typical agent flows

**Daily briefing:** `GET /v1/digest?since=24h&limit=10`

**Polling for updates on topics:**
```
GET /v1/stories?keywords=fuel price,electricity tariff,IMF&since=6h
```
`keywords` matches any of the listed words. Save the time of each poll and send it as `since` next time.

**Drilling into a story:** `GET /v1/stories/123` returns the summary, the timeline of articles (newest first), the main
entities and related stories.

**Exploring connections:**
```
GET /v1/graph/neighbors?node=story:123&depth=2&types=story,entity
GET /v1/entities?q=central bank      →  GET /v1/entities/45   (every story involving it)
```

**Fuzzy questions:** `GET /v1/search?q=flood damage in the south&mode=hybrid`

## Endpoints

| Endpoint | Parameters |
|---|---|
| `GET /v1/digest` | `since` (default `24h`), `limit` (max 50) |
| `GET /v1/stories` | `q`, `keywords`, `category`, `language`, `source`, `status`, `since`, `until`, `min_importance`, `community`, `sort=recent\|importance`, `limit` (max 100), `offset` |
| `GET /v1/stories/{id}` | `timeline_limit` (max 100) |
| `GET /v1/news` | `q`, `keywords`, `category`, `language`, `source`, `since`, `until`, `min_importance`, `limit`, `offset` |
| `GET /v1/articles/{id}` | |
| `GET /v1/search` | `q` (required), `type=stories\|articles`, `mode=keyword\|semantic\|hybrid`, `since`, `limit` (max 50) |
| `GET /v1/entities` | `q`, `type`, `limit`, `offset` |
| `GET /v1/entities/{id}` | `limit` |
| `GET /v1/graph/node/{node}` | |
| `GET /v1/graph/neighbors` | `node` (required), `depth` (1–3), `types` (default `story,entity`), `max_nodes` (max 150) |
| `GET /v1/sources` | |
| `GET /v1/status` | |

Categories: `politics`, `economy`, `business`, `crime`, `courts`, `accidents`, `weather_disaster`, `health`,
`education`, `sports`, `entertainment`, `international`, `technology`, `environment`, `society`, `opinion`, `other`.

List endpoints return `{"results": [...], "next_offset": n | null}`.
Errors return `{"error": "...", "message": "..."}` with status 400, 404 or 429. A 429 response includes `Retry-After`.

## Example: story
```json
{
  "id": 45,
  "title": "SriLankan Airlines suspends Riyadh flights until October 18",
  "summary": "SriLankan Airlines suspended all flights to Riyadh until October 18 after a security incident at Riyadh airport…",
  "category": "business", "status": "developing", "importance": 3,
  "article_count": 2, "source_count": 2,
  "first_seen_at": "2026-10-10T12:57:00Z", "last_updated_at": "2026-10-10T13:01:45Z",
  "keywords": ["srilankan airlines", "riyadh", "flight suspension"],
  "timeline": [
    {"id": 23, "title": "…", "summary": "…", "source": "hirunews-si", "language": "si", "url": "https://hirunews.lk/…", "image": "https://…", "published_at": "…"}
  ],
  "entities": [{"id": 1, "name": "SriLankan Airlines", "type": "organization", "mentions": 2}],
  "related": [{"id": 35, "title": "Appeal filed in Saudi Supreme Court to commute Anojan Sivarasa's death sentence", "relation": "shared_entities", "weight": 3.4, "shared": ["Saudi Arabia"]}]
}
```
