/**
 * Pluggable LLM + embedding providers.
 *
 *   LLM_PROVIDER        gemini (default) | anthropic | openai | none
 *   EMBEDDING_PROVIDER  gemini (default) | openai | none | mock
 *
 * Gemini runs on Vertex AI (uses Google Cloud credits) with VERTEX_API_KEY (a Google Cloud
 * API key bound to a service account), or with GOOGLE_CLOUD_PROJECT and
 * `gcloud auth application-default login`; otherwise on the Gemini API with GEMINI_API_KEY. "openai" means any OpenAI-compatible endpoint (OpenAI, OpenRouter,
 * Ollama, Groq, vLLM...) via OPENAI_BASE_URL.
 */
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_DIM } from "../../lib/config.js";

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface LLM {
  id: string; // "provider/model", recorded on analyzed rows
  generateJSON<T>(req: JsonRequest<T>): Promise<T>;
}

export interface Embedder {
  id: string;
  /** Embed texts. `kind` lets providers use asymmetric (document vs query) embeddings. */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
}

/** Parse JSON from a model reply, tolerating ```json fences and surrounding prose. */
export function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = (fenced ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error(`Model did not return JSON: ${body.slice(0, 200)}`);
  }
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

function schemaHint(schema: z.ZodType): string {
  return `\n\nRespond with ONLY a JSON value matching this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- Gemini

let genai: GoogleGenAI | undefined;
function gemini(): GoogleGenAI {
  if (!genai) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const vertexKey = process.env.VERTEX_API_KEY;
    genai = vertexKey
      ? new GoogleGenAI({ vertexai: true, apiKey: vertexKey })
      : project
        ? new GoogleGenAI({ vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION ?? "global" })
        : new GoogleGenAI({ apiKey: env("GEMINI_API_KEY") });
  }
  return genai;
}

function geminiLLM(): LLM {
  const model = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
  return {
    id: `gemini/${model}`,
    async generateJSON({ system, prompt, schema }) {
      return withRetry(async () => {
        const res = await gemini().models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchemaOf(schema),
            temperature: 0.2,
          },
        });
        return schema.parse(parseJsonReply(res.text ?? ""));
      });
    },
  };
}

function geminiEmbedder(): Embedder {
  const model = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
  return {
    id: `gemini/${model}`,
    async embed(texts, kind) {
      const out: number[][] = [];
      // Embed one text per request: Vertex AI only accepts a single input for this model.
      for (const text of texts) {
        const res = await withRetry(() =>
          gemini().models.embedContent({
            model,
            contents: [text],
            config: {
              outputDimensionality: EMBEDDING_DIM,
              taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            },
          }),
        );
        out.push(normalize(res.embeddings?.[0]?.values ?? []));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- Anthropic

function anthropicLLM(): LLM {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
  const apiKey = env("ANTHROPIC_API_KEY");
  return {
    id: `anthropic/${model}`,
    async generateJSON({ system, prompt, schema }) {
      return withRetry(async () => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            system: system + schemaHint(schema),
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
        const data: any = await res.json();
        const text = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
        return schema.parse(parseJsonReply(text));
      });
    },
  };
}

// ---------------------------------------------------------------- OpenAI-compatible

function openaiBase(): { base: string; headers: Record<string, string> } {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.OPENAI_API_KEY) headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  return { base, headers };
}

function openaiLLM(): LLM {
  const model = env("OPENAI_MODEL", "gpt-5-mini");
  const { base, headers } = openaiBase();
  return {
    id: `openai/${model}`,
    async generateJSON({ system, prompt, schema }) {
      return withRetry(async () => {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system + schemaHint(schema) },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}: ${await res.text()}`);
        const data: any = await res.json();
        return schema.parse(parseJsonReply(data.choices?.[0]?.message?.content ?? ""));
      });
    },
  };
}

function openaiEmbedder(): Embedder {
  const model = env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small");
  const { base, headers } = openaiBase();
  return {
    id: `openai/${model}`,
    async embed(texts) {
      const res = await withRetry(async () => {
        const r = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIM }),
        });
        if (!r.ok) throw new Error(`OpenAI-compatible embeddings ${r.status}: ${await r.text()}`);
        return r.json() as Promise<any>;
      });
      return res.data.map((d: any) => normalize(d.embedding));
    },
  };
}

// ---------------------------------------------------------------- Mock (tests / dry runs)

/** Deterministic bag-of-words hashing embedder: similar texts get similar vectors. */
export function mockEmbedder(): Embedder {
  return {
    id: "mock/hash",
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(EMBEDDING_DIM).fill(0);
        for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
          let h = 2166136261;
          for (const c of w) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
          v[Math.abs(h) % EMBEDDING_DIM] += 1;
        }
        return normalize(v);
      });
    },
  };
}

export function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

// ---------------------------------------------------------------- factories

export function createLLM(provider = process.env.LLM_PROVIDER ?? "gemini"): LLM | null {
  switch (provider) {
    case "gemini":
      return geminiLLM();
    case "anthropic":
      return anthropicLLM();
    case "openai":
      return openaiLLM();
    case "none":
      return null;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" (use gemini | anthropic | openai | none)`);
  }
}

export function createEmbedder(provider = process.env.EMBEDDING_PROVIDER ?? "gemini"): Embedder | null {
  switch (provider) {
    case "gemini":
      return geminiEmbedder();
    case "openai":
      return openaiEmbedder();
    case "mock":
      return mockEmbedder();
    case "none":
      return null;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}" (use gemini | openai | none)`);
  }
}
