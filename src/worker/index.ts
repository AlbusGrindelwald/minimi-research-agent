import { Hono } from "hono";
import { createAuth } from "./auth";
import { postChat } from "./chat";
import { getConversation, listConversations } from "./conversations";
import type { AppEnv } from "./env";
import { requestCountry, unpaidGeminiRegionRestricted } from "./regions";

type Variables = { userId: string };
export type AppContext = import("hono").Context<{ Bindings: AppEnv; Variables: Variables }>;

const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();

async function requireUser(c: AppContext, next: () => Promise<void>) {
  try {
    const auth = createAuth(c.env, c.req.url);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) return c.json({ error: "not_signed_in", message: "Sign in with Google to save and sync your conversations." }, 401);
    c.set("userId", session.user.id);
  } catch {
    return c.json({ error: "auth_not_configured", message: "Google sign-in is not configured yet. Follow the setup steps in README.md." }, 503);
  }
  await next();
}

app.get("/api/health", (c) => c.json({
  ok: true,
  configured: {
    gemini: Boolean(c.env.GEMINI_API_KEY),
    search: Boolean(c.env.TAVILY_API_KEY),
    googleAuth: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET && c.env.BETTER_AUTH_SECRET),
    regionAvailable: !unpaidGeminiRegionRestricted(requestCountry(c.req.raw)),
  },
}));

app.all("/api/auth/*", async (c) => {
  try {
    return await createAuth(c.env, c.req.url).handler(c.req.raw);
  } catch {
    return c.json({ error: "auth_not_configured", message: "Google sign-in is not configured yet. Follow the setup steps in README.md." }, 503);
  }
});

app.get("/api/conversations", requireUser, async (c) => {
  const conversations = await listConversations(c.env.DB, c.get("userId")!);
  return c.json({ conversations });
});

app.get("/api/conversations/:id", requireUser, async (c) => {
  const conversation = await getConversation(c.env.DB, c.get("userId")!, c.req.param("id")!);
  if (!conversation) return c.json({ error: "conversation_not_found", message: "This conversation does not exist." }, 404);
  return c.json({ conversation });
});

app.delete("/api/conversations/:id", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM conversations WHERE id = ? AND user_id = ?",
  ).bind(c.req.param("id")!, c.get("userId")!).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "conversation_not_found", message: "This conversation does not exist." }, 404);
  return c.json({ deleted: true });
});

app.delete("/api/conversations", requireUser, async (c) => {
  await c.env.DB.prepare("DELETE FROM conversations WHERE user_id = ?").bind(c.get("userId")!).run();
  return c.json({ deleted: true });
});

app.post("/api/chat", requireUser, postChat);

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  console.error("Request failed", { route: new URL(c.req.url).pathname, name: error.name });
  return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
});

export default app;

