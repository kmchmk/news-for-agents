/** Shared constants and environment-driven settings. */

export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);
export const EMBEDDING_DIM = 768;

export const CATEGORIES = [
  "politics",
  "economy",
  "business",
  "crime",
  "courts",
  "accidents",
  "weather_disaster",
  "health",
  "education",
  "sports",
  "entertainment",
  "international",
  "technology",
  "environment",
  "society",
  "opinion",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ENTITY_TYPES = ["person", "organization", "location", "event", "topic"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const LANGUAGES = ["si", "ta", "en"] as const;
