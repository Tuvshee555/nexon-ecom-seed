# Nexon E-com Bot

A Facebook/Instagram Messenger AI sales assistant for online shops. Customers DM
"do you have X? how much? in stock?" and the bot answers from the shop's live
catalog — product, price, stock, and a **buy link** to the shop's website. The owner
edits products and stock in an admin panel, can pause the bot and take over, and gets
notified of leads. No video needed; photos optional.

> Built by repurposing the hardened travel-bot engine (~80% reused). Internally some
> things are still named "trip/seats" — that's cosmetic and invisible to customers;
> a deeper rename to products/stock is planned. What the customer sees is product
> answers + a buy link.

Company: **Nexon Digital Nova**

## How it works for a shop

1. Owner connects their Facebook/Instagram page (env vars).
2. Owner adds products in the admin panel, or uploads a catalog/price list — the AI
   extracts product, price, stock, and any buy link.
3. Customer DMs a shopping question → bot answers from live data + sends the buy link.
4. Owner edits stock anytime ("3 left", "sold out"); the bot stays current.

## E-com specifics (what differs from the travel base)

- **Stock**: a product's `seats_left` is read as "In stock: N"; `status=sold_out`
  reads as "OUT OF STOCK".
- **Buy link**: each product can carry a `buy_url` (stored in `extra.buy_url`). The
  bot includes it so customers know exactly where to buy. The AI captures links from
  uploaded catalogs automatically.
- **Persona**: the shop's tone/behavior is set by the owner-editable system prompt in
  the admin panel — no code change to make it talk like a shop.

## Quick start (local)

```bash
cp .env.example .env.local   # fill AGENCY_NAME (= shop name) + keys + own DB
npm install
npm run dev                  # http://localhost:3004
```

See [.env.example](.env.example) for all vars and [docs/RUNBOOK.md](docs/RUNBOOK.md)
for deploy/Meta/token steps. The same two rules from the seed apply: code lives in
the master, clones differ by env only; each shop gets its own DB + Redis.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server on port 3004 |
| `npm run validate` | lint + typecheck + tests + build |
| `npm test` | Test suite |
| `npm run build` | Production build (preflight config check first) |
