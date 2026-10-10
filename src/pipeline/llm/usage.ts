/**
 * Token usage and cost accounting for one pipeline process. Providers call record*();
 * the CLI prints and stores summary() per step.
 *
 * Prices are USD per 1M tokens (Vertex AI list prices, checked 2026-10-10). Thinking tokens
 * are billed as output. Override for any model with LLM_PRICE_IN / LLM_PRICE_OUT.
 */

type Price = { in: number; out: number };

function flashPrice(now: Date): Price {
  // Gemini 3.6/3.7/3.8 Flash introductory pricing until 2026-12-31.
  return now < new Date("2027-01-01T00:00:00Z") ? { in: 0.75, out: 3.75 } : { in: 1.5, out: 7.5 };
}

const PRICES: Record<string, (now: Date) => Price> = {
  "gemini-3.8-flash": flashPrice,
  "gemini-3.7-flash": flashPrice,
  "gemini-3.6-flash": flashPrice,
  "gemini-3.5-flash": () => ({ in: 1.5, out: 9 }),
  "gemini-3.5-flash-lite": () => ({ in: 0.3, out: 2.5 }),
  "gemini-2.5-flash": () => ({ in: 0.3, out: 2.5 }),
  "gemini-2.5-pro": () => ({ in: 1.25, out: 10 }),
  "gemini-3.1-pro-preview": () => ({ in: 2, out: 12 }),
  "gemini-embedding-001": () => ({ in: 0.15, out: 0 }),
};

export function priceFor(model: string, now = new Date()): Price | null {
  if (process.env.LLM_PRICE_IN && !model.includes("embedding")) {
    return { in: Number(process.env.LLM_PRICE_IN), out: Number(process.env.LLM_PRICE_OUT ?? 0) };
  }
  if (model.endsWith(":free")) return { in: 0, out: 0 };
  const key = model.split("/").pop()!;
  return PRICES[key]?.(now) ?? null;
}

interface Tally {
  calls: number;
  input: number;
  output: number;
  thinking: number;
}

const tallies = new Map<string, Tally>();

export function recordUsage(model: string, u: { input?: number; output?: number; thinking?: number }): void {
  const t = tallies.get(model) ?? { calls: 0, input: 0, output: 0, thinking: 0 };
  t.calls++;
  t.input += u.input ?? 0;
  t.output += u.output ?? 0;
  t.thinking += u.thinking ?? 0;
  tallies.set(model, t);
}

export interface UsageSummary {
  models: Record<string, Tally & { cost_usd: number | null }>;
  total_cost_usd: number;
  unpriced_models: string[];
}

export function usageSummary(): UsageSummary {
  const models: UsageSummary["models"] = {};
  let total = 0;
  const unpriced: string[] = [];
  for (const [model, t] of tallies) {
    const p = priceFor(model);
    const cost = p ? (t.input * p.in + (t.output + t.thinking) * p.out) / 1e6 : null;
    if (cost === null) unpriced.push(model);
    else total += cost;
    models[model] = { ...t, cost_usd: cost === null ? null : Math.round(cost * 1e5) / 1e5 };
  }
  return { models, total_cost_usd: Math.round(total * 1e5) / 1e5, unpriced_models: unpriced };
}

export function resetUsage(): void {
  tallies.clear();
}
