# SEED.md — spinning up a new agency from this template

This repo is the **master template** for Nexon Travel AI. Every paying agency gets a
clone of this, with only their env vars changed. This is Phase 1 of the business
plan: hand-onboard the first ~10 agencies, *then* build the multi-tenant platform.

---

## ⛔ The two rules that keep copy-paste sane

Copy-paste across many clients is fine — but ONLY if you hold these two lines. Break
them and you get diverging codebases and data leaks.

### Rule 1 — Code lives in the master. Clones differ by env vars ONLY.
- All improvements and bug fixes happen **here, in the master**, first.
- A clone is *never* hand-edited in its code. You only ever change its `.env`.
- To give a clone an improvement: `git pull` from master into the clone.
- The moment you edit a clone's code directly, that clone can no longer cleanly pull
  updates — and now you maintain N codebases by hand. Don't.

### Rule 2 — Each agency gets its OWN database and Redis.
- Separate `NEON_DATABASE_URL` per agency. Never shared.
- Separate Upstash Redis per agency, or at minimum a unique `REDIS_KEY_PREFIX`.
- A shared database = Agency A sees Agency B's customers and prices. That's the #1
  thing that destroys trust and gets you sued. Always isolate.

---

## Clone a new agency (the workflow)

```bash
# 1. Clone the master into a new client repo
git clone <master-repo-url> nexon-travel-ai-<agencyslug>
cd nexon-travel-ai-<agencyslug>

# 2. Point it at the master so you can pull future improvements
git remote rename origin master      # the template is your upstream
# (later, create the client's own deploy remote if you want one)

# 3. Configure THIS agency — copy and fill env
cp .env.example .env.local
#   set: AGENCY_NAME, GEMINI_API_KEY, TOKEN_PAGE, VERIFY_TOKEN,
#        FACEBOOK_PAGE_ID, META_APP_SECRET, ADMIN_SECRET,
#        NEON_DATABASE_URL (their own DB!), Redis (their own / own prefix)

# 4. Validate, then deploy to a new Vercel project
npm install
npm run validate
#   deploy to Vercel, set the same env vars in the Vercel project settings
```

Then follow [docs/RUNBOOK.md](docs/RUNBOOK.md): wire the Meta webhook to
`https://<their-domain>/api/webhook`, get Meta app review, load their trips, smoke
test.

## What changes per agency (the whole list)

| What | Where | Notes |
|------|-------|-------|
| Agency name | `AGENCY_NAME` env | drives header detection + branding |
| AI key | `GEMINI_API_KEY` env | yours or theirs |
| Facebook page | `FACEBOOK_PAGE_ID`, `TOKEN_PAGE`, `META_APP_SECRET`, `VERIFY_TOKEN` env | their page, their Meta app review |
| Admin login | `ADMIN_SECRET` env | unique strong secret |
| Database | `NEON_DATABASE_URL` env | **their own DB** |
| Redis | `REDIS_URL`/Upstash + `REDIS_KEY_PREFIX` env | their own / own prefix |
| Trip & price data | loaded via admin panel | not code |

**Nothing else should change.** If you find yourself editing code for one agency,
stop — that's a signal it should become a config option in the master instead.

## Pulling a master improvement into all clones

```bash
# in each client repo:
git pull master main      # bring in the latest master code
npm install               # if deps changed
npm run validate
# redeploy
```

Because clones only differ by env (which lives in `.env.local`, gitignored), these
pulls stay conflict-free.

## When to stop cloning and build the real platform

Per the business plan: after ~10 paying agencies, the per-client clone overhead
justifies building true multi-tenancy (one deploy, `tenant_id` on every table,
agency login). Not before. This seed is the proving ground; the platform is the
graduation. Don't build the platform until the clones are clearly paying and the
manual overhead is the bottleneck.
