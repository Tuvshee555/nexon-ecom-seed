const PAGE_ID = process.env.FACEBOOK_PAGE_ID?.trim();
const PAGE_TOKEN = process.env.TOKEN_PAGE?.trim();
const SUBSCRIBED_FIELDS =
  process.env.FACEBOOK_SUBSCRIBED_FIELDS?.trim() ||
  "messages,messaging_postbacks";

if (!PAGE_ID) {
  console.error(
    "Missing FACEBOOK_PAGE_ID. Set it in your environment before running this script.",
  );
  process.exit(1);
}

if (!PAGE_TOKEN) {
  console.error(
    "Missing TOKEN_PAGE. Set it in your environment before running this script.",
  );
  process.exit(1);
}

const url = new URL(`https://graph.facebook.com/v25.0/${PAGE_ID}/subscribed_apps`);

console.log("Subscribing page to app webhook fields...", {
  pageId: PAGE_ID,
  subscribedFields: SUBSCRIBED_FIELDS,
});

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    subscribed_fields: SUBSCRIBED_FIELDS,
    access_token: PAGE_TOKEN,
  }),
});
const payload = await response.json().catch(() => null);

if (!response.ok) {
  console.error("Failed to subscribe page to app", {
    status: response.status,
    payload,
  });
  process.exit(1);
}

console.log("Page subscription succeeded", payload);
