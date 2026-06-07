# Nexon Shop AI — marketing website prompt

Copy everything in the code block below into Claude Code in a NEW empty folder. It
builds the marketing site. Fill in the contact placeholders ([FACEBOOK_PAGE_LINK],
[PHONE], [EMAIL]) afterward.

---

```
Build a marketing website for "Nexon Shop AI" — an AI sales assistant chatbot for
online shops (e-commerce) in Mongolia. It answers customers' Facebook/Instagram
messages instantly using the shop's live product catalog and stock, and sends a buy
link to the shop's website. This is a single-page informational marketing site, NOT a
web app: no login, no signup, no payment, no dashboard. Its only job is to explain
what the product does, show pricing, build trust, and get the visitor to contact us.

COMPANY: Nexon Digital Nova (legal entity). PRODUCT/BRAND shown to visitors: "Nexon
Shop AI".

LANGUAGE: Mongolian (Cyrillic) as the primary language — customers are Mongolian shop
owners. Natural, persuasive copy, not machine-translated.

TECH STACK: Next.js (App Router) + TypeScript + Tailwind CSS. Static site, deployable
to Vercel. No backend — the contact action is a Messenger/phone/email link, not a form
that hits a server.

DESIGN: Premium, modern, trustworthy — like a real SaaS company, not a template.
Clean, commerce-y feeling without being cheesy. Confident hero, generous spacing,
subtle motion. Mobile-first (shop owners open it on a phone). Avoid generic
AI-startup gradient slop.

SECTIONS (in order):
1. HERO — one-line value headline: the bot answers every customer's "do you have
   this? how much? in stock?" instantly, 24/7, from your live stock, and sends a buy
   link — so you stop losing sales to slow replies. Subheadline + one clear CTA button
   ("Холбоо барих" / Contact us) → Messenger or phone.
2. PROBLEM — the pain: customers flood your DMs and comments with "price?", "байгаа
   юу?", "size?" all day and night; you reply late; buyers go to a faster shop; you're
   stuck glued to Messenger instead of running your business.
3. WHAT IT DOES — feature cards: answers product questions automatically from your
   live catalog; knows real-time stock ("3 left", "sold out"); sends a buy link to
   your website; you edit products & stock in a simple admin panel; works on Messenger
   AND Instagram; Mongolian language; you can pause it and take over anytime.
4. HOW IT WORKS — 3 steps: (1) We connect your Facebook/Instagram page, (2) We load
   your products & stock (or you upload your catalog), (3) The bot answers customers
   24/7 and sends them to buy.
5. THE CLEAN-CHAT DEMO — show a short sample chat:
     Customer: "Энэ гутал 42 размертэй байгаа юу?"
     Bot: "Тийм, [Бүтээгдэхүүн] — 189,000₮, 42 размер 3 ширхэг үлдсэн. Худалдаж авах: [линк]"
     Customer: "Улаан өнгөтэй юу?"
     Bot: "Улаан дууссан байна, хар болон цагаан байгаа. [линк]"
   Emphasize: clean text, instant, no photos/video needed, always knows live stock.
6. PRICING — show these exact tiers in a clean pricing table/cards. Currency ₮ (MNT),
   per month ("/сар"). Mark "Өсөлт" as most popular / recommended:

   | Tier (Mongolian)        | ₮/сар   | Бүтээгдэхүүн | Харилцагч/сар |
   | Эхлэл (Starter)         | 49,000  | 50 хүртэл    | 250    |
   | Өсөлт (Growth) ⭐        | 69,000  | 150 хүртэл   | 800    |
   | Бизнес (Business)       | 99,000  | 500 хүртэл   | 2,500  |
   | Про (Pro)               | 229,000 | 2,000 хүртэл | 7,500  |
   | Байгууллага (Enterprise)| 449,000 | Хязгааргүй   | 25,000 |

   Add-ons note: Нэмэлт хуудас (FB/IG) +30,000₮/сар. Нэг удаагийн суурилуулалтын
   төлбөр 100,000–250,000₮ (хуудас холбох + бараа оруулах). 25,000+ харилцагч/сар бол
   "Захиалгат үнэ — холбоо барина уу".

7. CONTACT / CTA — strong final call to action with contact method (Messenger link to
   the Nexon Shop AI Facebook page, phone, email). Leave clear placeholders:
   [FACEBOOK_PAGE_LINK], [PHONE], [EMAIL].
8. FOOTER — "Nexon Shop AI", small "Nexon Digital Nova-н бүтээгдэхүүн" line, year.

IMPORTANT:
- This site does NOT collect payments or have user accounts. Purely informational so
  shop owners can read what we offer and contact us. Do NOT build login/checkout.
- Real, persuasive Mongolian marketing copy, not lorem ipsum.
- Make the pricing section and the clean-chat demo the visual centerpieces — those are
  what convince a shop owner.
- Leave obvious placeholders for contact details and any logo.
```
