# Minimi Research Agent

A chat assistant for questions that deserve a follow-up. Minimi stores dated conversations and their web-search evidence, so it can find an earlier question and compare its answer with current sources.

## Stack

- React, TypeScript, Vite, Tailwind CSS, and Hono
- Cloudflare Workers for the same-origin API and free `workers.dev` hosting
- Cloudflare D1 for account-scoped conversations, search snapshots, and FTS5 memory search
- Better Auth with Google OAuth for account sessions
- Gemini 3.8 Flash for tool selection and grounded answers
- Tavily Search for current web evidence

Only `web_search` is exposed to the model. History retrieval is a server-side step; the agent does not receive a database tool. Each turn can run one batch of up to five focused searches. Current sources are saved with their retrieval time and publication date when available.

## Local setup

Requirements: Node.js 20.19+ (Node 22 recommended) and npm.

1. Install the dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.dev.vars` and add the credentials below. `.dev.vars` is ignored by git.

3. Configure a Google OAuth web client with this authorized redirect URI:

   ```text
   http://localhost:5173/api/auth/callback/google
   ```

4. Start the app:

   ```sh
   npm run dev
   ```

   `predev` applies D1 migrations to Wrangler's local database before Vite starts. The page still opens if credentials are missing, and the setup state identifies which keys are needed.

### Keys and provider setup

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini Developer API key from Google AI Studio |
| `TAVILY_API_KEY` | Tavily Search API key |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client secret |
| `BETTER_AUTH_SECRET` | Random server-side session signing secret (32+ characters) |
| `APP_URL` | Optional canonical app URL; otherwise derived from the request origin |
| `GEMINI_MODEL` | Optional model override; defaults to `gemini-3.8-flash` |

Gemini 3.8 Flash has a free API tier, subject to model-specific quotas. Use a Google AI Studio project with no billing account attached; Minimi has no paid fallback or automatic billing. On the unpaid tier, Google may use prompts and responses to improve products, and human reviewers may process them. Google requires users to be 18+ and prohibits sending sensitive, confidential, or personal information. Its terms also restrict unpaid API clients in the EEA, Switzerland, and UK; the chat API blocks requests from those regions. The first-use notice describes these data flows and limits.

Tavily's free Researcher plan currently includes 1,000 monthly API credits without a payment card and stops requests when the allowance runs out. Minimi sends search queries to Tavily, uses basic search by default, and limits batches to five queries. A global D1 budget reserves at most 800 credits per month (basic costs one per query; advanced costs two), leaving headroom below the provider limit. Free quotas can change or run out.

Generate a Better Auth secret with Node:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## Cloudflare preview deployment

1. Sign in to Cloudflare Wrangler and create a D1 database:

   ```sh
   npx wrangler login
   npx wrangler d1 create minimi-db
   ```

2. Copy the returned database ID into `wrangler.jsonc`, replacing the local placeholder.
3. Add each secret to the Worker (repeat the command for every value):

   ```sh
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put BETTER_AUTH_SECRET
   ```

4. Apply the D1 migrations remotely:

   ```sh
   npm run db:migrate:remote
   ```

5. Add the deployed `https://<worker>.<account>.workers.dev/api/auth/callback/google` URI to the Google OAuth client, then deploy:

   ```sh
   npm run deploy
   ```

Cloudflare Workers and D1 have free-plan request and storage limits. Gemini and Tavily quotas also apply. The app enforces a 30-message daily per-account demo limit and up to five searches per message. Quota exhaustion returns a visible error; it does not enable paid usage.

## Commands

```sh
npm run dev       # local app and local D1 migrations
npm run build     # type-check and production build
npm run test      # unit tests
npm run deploy    # build and deploy to Cloudflare Workers
```

## Privacy and account controls

Sign-in is required so conversations can sync across devices. Messages and search snapshots are stored in D1 under the signed-in account. Gemini receives conversation context needed to answer; Tavily receives only web-search queries. Do not use the public demo for sensitive or confidential work. Delete individual conversations from the history rail or clear the account's conversation history from the account controls.

