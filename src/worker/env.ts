export type AppEnv = {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  TAVILY_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  APP_URL?: string;
  GEMINI_MODEL?: string;
};

