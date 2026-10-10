// Vercel serverless entry point (web-standard handlers). All routes are rewritten here (see vercel.json).
import { handle } from "hono/vercel";
import { app } from "../src/api/app.js";

const handler = handle(app);
export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
