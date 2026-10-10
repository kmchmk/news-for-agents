/** Local development server: npm run dev */
import { serve } from "@hono/node-server";
import { app } from "./api/app.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`News for Agents API on http://localhost:${port}`));
