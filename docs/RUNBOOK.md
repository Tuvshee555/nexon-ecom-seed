# Operational Runbook — deploying & running a tenant

> Practical "how do I actually run this for a paying customer" guide.
> This is the Nexon Travel AI **seed template** — clone it per agency, fill in their
> env vars, deploy. See [SEED.md](../SEED.md) for the clone-a-new-client workflow.

---

## 1. What this app is (one paragraph)

A Next.js app that runs as a Facebook/Instagram Messenger AI receptionist for a
travel agency. It receives messages via a Meta webhook, answers using Gemini with
the agency's own trip/price data (stored in Neon Postgres, editable from the admin
panel), captures booking leads, and lets staff pause the bot per-conversation.
Optional Redis (Upstash) gives it durable rate-limiting, replay protection,
conversation state, and pause state across serverless invocations.

---

## 2. Deploy a new tenant (Phase 1 = one Vercel project per agency)

Until true multi-tenancy (Phase 2) exists, **each agency = its own Vercel
deployment with its own env vars.** Ugly but real, and correct for customers #2–#3.

### Step-by-step

1. **Fork the deploy**: create a new Vercel project from this repo (or `vercel
   --prod` from a clone). One project per agency.
2. **Database**: create a fresh Neon project (or a new database) for this agency so
   their trips/leads/settings are fully isolated. Copy its connection string into
   `NEON_DATABASE_URL`. Run the schema setup (see §4).
3. **Redis (recommended for production)**: create an Upstash Redis database. Either:
   - paste the full `rediss://default:<token>@<host>:6379` string into `REDIS_URL`, **or**
   - paste `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` and the app derives
     the connection string automatically. Setting either one **auto-enables** Redis
     state — you don't have to flip `REDIS_STATE_ENABLED` yourself.
4. **Meta wiring** (the slow part — see §3): get the agency's Page ID, page access
   token, app secret, and a verify token of your choosing. Fill:
   `FACEBOOK_PAGE_ID`, `TOKEN_PAGE`, `META_APP_SECRET`, `VERIFY_TOKEN`.
5. **Admin access**: set a strong `ADMIN_SECRET` (this is the agency's admin login).
   Keep `ADMIN_OPEN_ACCESS=false` and `ALLOW_ADMIN_SECRET_QUERY=false` in production.
6. **Deploy**, then point the agency's Meta webhook at `https://<their-domain>/api/webhook`.
7. **Smoke test** (see §6) before telling the customer it's live.

### Required env vars (minimum to run)

| Var | What it is |
|-----|-----------|
| `GEMINI_API_KEY` | AI model key (or `GOOGLE_API_KEY`) |
| `VERIFY_TOKEN` | Webhook verify token (you choose it; must match Meta) |
| `TOKEN_PAGE` | Page access token from Meta |
| `FACEBOOK_PAGE_ID` | The agency's Facebook Page ID |
| `META_APP_SECRET` | App secret — used to verify webhook signatures |
| `ADMIN_SECRET` | Admin panel password for this agency |
| `NEON_DATABASE_URL` | Postgres connection string |

Everything else has safe defaults — see [.env.example](../.env.example).

---

## 3. Meta / Facebook approval (the real bottleneck)

This is outside our code and is the #1 onboarding cost. Budget **days to weeks**,
not minutes. Per agency:

1. The agency's Facebook Page must be connected to a Meta app (yours or theirs).
2. Request the permissions the bot needs: `pages_messaging`,
   `pages_manage_metadata`, `pages_read_engagement` (and the Instagram equivalents
   if IG DMs are in scope).
3. Submit for **App Review** with a screencast showing the bot answering a real
   message. Meta wants to see the actual use case.
4. While in review, only Page admins/testers can message the bot — fine for the
   smoke test, not for the public.
5. After approval, the bot works for everyone messaging the Page.

**Known pain point:** Meta approval is the main onboarding friction. Each new agency repeats
it. There is no code shortcut — only a good screencast and accurate permission
requests. Keep a saved screencast template to reuse.

---

## 4. Database setup

- Schema migrations live in [supabase/migrations/](../supabase/migrations/).
  The app also self-creates/uses these tables: `travel_bot_settings`,
  `travel_trip_entries`, `travel_leads`, `travel_ai_change_requests`.
- `travel_bot_settings` is single-tenant by design (`id BOOLEAN PRIMARY KEY DEFAULT
  TRUE` → exactly one row). That's why each agency needs its own database today.
- **Backups**: Neon keeps automatic point-in-time backups — confirm the retention
  window on the agency's Neon plan. This is your "we won't lose their data" promise.

---

## 5. Token rotation (the #1 silent failure)

Meta **Page access tokens expire**. When `TOKEN_PAGE` expires, the bot silently
stops replying — webhooks still arrive, but every send fails. Prevent the 3am
mystery outage:

- Use a **long-lived / system-user token** where possible (doesn't expire on the
  60-day cadence of short-lived tokens).
- Watch the metric `webhook.send.failed_total` and the log event
  `webhook.send.primary_failed`. A spike with auth errors = expired token.
- Rotation = generate a new token in Meta, update `TOKEN_PAGE` in Vercel env, redeploy.
- Set an observability error sink (`OBSERVABILITY_ERROR_SINK_URL`) so these failures
  page you instead of sitting silent.

---

## 6. Smoke test (run before saying "it's live")

1. `GET /api/ping` → expect `200`, healthy.
2. Webhook verify: Meta's GET challenge to `/api/webhook` with the right
   `VERIFY_TOKEN` should echo the challenge.
3. Send a real DM to the Page → bot replies within a few seconds.
4. Log into the admin panel with `ADMIN_SECRET`; confirm trips/settings load and a
   test edit saves.
5. Trigger a booking-intent message → confirm a lead lands in the leads dashboard.
6. Check `/api/metrics` for `redis.connected=1` (if Redis is configured) and no
   error spikes.

---

## 7. When something breaks — where to look

| Symptom | First place to look |
|--------|---------------------|
| Bot stopped replying | `TOKEN_PAGE` expired (§5); check `webhook.send.failed_total` |
| Bot replies wrong/empty | Gemini failure → `webhook.ai_fallback_reply` log; check `GEMINI_API_KEY` + quota |
| "Invalid signature" / no messages processed | `META_APP_SECRET` mismatch |
| Webhook returns 400 invalid_json | Malformed payload — usually a Meta test, safe to ignore |
| Rate-limit / pause state resets randomly | Redis not connected → `redis.connected` gauge, `redis.operation_failed` log |
| Admin panel locked out | `ADMIN_SECRET` wrong, or `ADMIN_AUTH_RATE_LIMIT` tripped — wait and retry |

The webhook is built to **always return 200 on success** so Meta doesn't
retry-storm, and to degrade gracefully (AI failure → fallback reply, Redis down →
in-memory fallback). A single failure rarely takes the whole bot down.

---

## 8. Validate before every deploy

```bash
npm run validate   # lint + typecheck + tests + build
```

`prebuild` also runs a preflight script that fails the build on missing/invalid
config, so a misconfigured tenant won't deploy silently broken.
