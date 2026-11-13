import { betterAuth } from "better-auth";
import type { AppEnv } from "./env";

export function createAuth(env: AppEnv, requestUrl: string) {
  const appUrl = env.APP_URL || new URL(requestUrl).origin;
  const missing = [
    ["BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET],
    ["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing authentication configuration: ${missing.join(", ")}`);
  }

  return betterAuth({
    appName: "Minimi Research",
    baseURL: appUrl,
    secret: env.BETTER_AUTH_SECRET!,
    database: env.DB,
    trustedOrigins: [appUrl],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        scope: ["openid", "email", "profile"],
      },
    },
    advanced: {
      useSecureCookies: appUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
  });
}

