# Nexon Shop AI — pricing (e-com)

> Adapted from the travel tier structure for online shops. Shops think in
> **products** and **customer conversations**, not "pages". Same logic: a usage cap
> protects your cost (Gemini/Redis), and a setup fee funds onboarding.
>
> Company: Nexon Digital Nova · Product: **Nexon Shop AI**

## Monthly tiers

| Tier | ₮/сар | Products | Харилцагч/сар (cap) | Pages |
|------|-------|----------|---------------------|-------|
| **Эхлэл** (Starter) | 49,000 | up to 50 | 250 | 1 |
| **Өсөлт** (Growth) ⭐ | 69,000 | up to 150 | 800 | 1 |
| **Бизнес** (Business) | 99,000 | up to 500 | 2,500 | 2 (FB+IG) |
| **Про** (Pro) | 229,000 | up to 2,000 | 7,500 | 4 |
| **Байгууллага** (Enterprise) | 449,000 | Unlimited | 25,000 | Unlimited |
| **Захиалгат** (Custom) | Тохиролцоно | Unlimited | 25,000+ | Unlimited |

## Add-ons (same on every tier)

| Add-on | Price |
|--------|-------|
| Extra page (FB/IG) | +30,000₮/сар each |
| Setup fee (one-time) | 100,000–250,000₮ — connect page(s), load catalog, smoke test |

## Why this structure (e-com specifics)

- **Products replace "pages" as the main value axis.** A shop with 30 items is a
  small shop; a shop with 1,000 items is a real business. Product count is what a shop
  owner intuitively understands as "size", and it tracks how much catalog the bot
  must know.
- **Conversation cap = your cost safety net** (Gemini/Redis), same as travel. It's a
  usage meter, not the headline.
- **Pages**: most shops = 1 page (Эхлэл/Өсөлт). 2 pages (FB + Instagram as separate
  pages) starts at Бизнес — that's the natural "I sell on both" shop.
- **Setup fee is lower than travel** (100–250k vs 150–300k) because e-com onboarding
  is lighter: less Meta-approval friction (text + buy-link works without heavy
  permissions), and loading a product catalog is faster than a travel data set.
- **The 69k Growth tier** closes the same gap travel had — a growing shop steps up
  comfortably instead of jumping 10× in volume.

### ⚠️ Watch the 449k Enterprise tier
25,000 conversations/month + a 2,000+ product catalog = heavy Gemini usage. Confirm
your real cost-per-conversation leaves margin before selling it to a high-volume shop.
For 25,000+ → Custom: quote off their real usage, not a guess.

## What each tier is "for" (quick sales reference)

| Shop type | Tier |
|-----------|------|
| Small shop, 1 page, <50 items, low volume | Эхлэл 49k |
| Growing shop, ~150 items | Өсөлт 69k |
| Established shop, FB + IG, ~500 items | Бизнес 99k |
| Busy shop / mini-chain, big catalog | Про 229k |
| High-volume / multi-page business | Байгууллага 449k |

## Pitch (anchor to value, not cost)

"Your customers ask 'do you have this? what's the price? is it in stock?' all day,
and you lose buyers when you reply late. Nexon Shop AI answers instantly 24/7 from
your live stock, and sends them a buy link. You stop losing sales to slow replies and
stop being glued to Messenger."
