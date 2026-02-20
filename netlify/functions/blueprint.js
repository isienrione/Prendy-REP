// netlify/functions/blueprint.js

import fs from "fs";
import path from "path";
import OpenAI from "openai";

// ---------- Load full party catalog v4 ----------

// Resolve catalog path relative to the repo root
const catalogPath = path.join(process.cwd(), "data", "party_catalog_v4.json");

// Synchronously load catalog once at cold start
let RAW_CATALOG;
let PARTY_ITEMS = [];

try {
  RAW_CATALOG = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  PARTY_ITEMS = RAW_CATALOG?.stores?.[0]?.items || [];
  console.log(
    `[Prendy] Loaded party_catalog_v4.json with ${
      PARTY_ITEMS.length
    } items (version=${RAW_CATALOG.version}, currency=${
      RAW_CATALOG.currency
    })`
  );
} catch (err) {
  console.error(
    "[Prendy] Failed to load data/party_catalog_v4.json; using empty catalog:",
    err
  );
  RAW_CATALOG = { version: "4.0", currency: "CLP", stores: [] };
  PARTY_ITEMS = [];
}

// ---------- Helper: summarize catalog for the model ----------

function buildCatalogSummary(maxItems = 80) {
  if (!PARTY_ITEMS.length) {
    return "Catalog is empty (PARTY_ITEMS.length === 0).";
  }

  const total = PARTY_ITEMS.length;
  const sample = PARTY_ITEMS.slice(0, maxItems);

  const lines = [];
  lines.push(
    `Catalog version: ${RAW_CATALOG.version}, currency: ${RAW_CATALOG.currency}`
  );
  lines.push(`Total items: ${total}`);
  lines.push("");
  lines.push(
    "Each item has: id, name, description, category, subcategory, price (CLP), vendorName, venueName, serviceType, tags[]."
  );
  lines.push("");
  lines.push(`Sample of up to ${maxItems} items:`);
  sample.forEach((it) => {
    lines.push(
      `- id=${it.id || "?"}, name=${it.name || "?"}, category=${
        it.category || "?"
      }, subcategory=${it.subcategory || ""}, price=${
        it.price != null ? it.price : "null"
      }, vendor=${it.vendorName || ""}, tags=${(it.tags || []).join(", ")}`
    );
  });

  return lines.join("\n");
}

// ---------- OpenAI client ----------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Netlify Function handler ----------

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  // User request payload from the frontend form
  const {
    eventType, // e.g. "adult_birthday_home"
    guestCount,
    budgetCLP,
    location, // e.g. "Santiago"
    notes,
  } = body;

  // Build a compact representation of the request
  const requestSummary = [
    `Event type: ${eventType || "unspecified"}`,
    `Guest count: ${guestCount || "unspecified"}`,
    `Budget (CLP): ${budgetCLP || "unspecified"}`,
    `Location: ${location || "unspecified"}`,
    `User notes: ${notes || "none"}`,
  ].join("\n");

  // Catalog summary + instructions for how to use it
  const catalogSummary = buildCatalogSummary(120);

  const systemPrompt = `
You are Prendy, an AI party-planning assistant for Santiago, Chile.
You MUST base your concrete product recommendations ONLY on the structured catalog data I provide.

CATALOG FORMAT
--------------
The catalog is JSON with:
- version (string)
- currency (string, CLP)
- stores: array of stores; in this version we use a single synthetic "global" store.
- stores[0].items: array of item objects.

Each item object has:
- id (string, unique)
- name (string) - human friendly product or bundle name
- description (string) - when available, a short description or use case
- category (string) - high level type like "finger_food", "brunch_box", "main_delivery", "wine", etc.
- subcategory (string) - optional sub-type
- price (number | null) - price in CLP
- vendorName (string) - store or brand name, when available
- venueName (string) - optional, often empty
- serviceType (string) - optional, e.g. "catering_pack", "coffee", etc.
- tags (string[]) - tags like "chicken", "seafood", "gift", "premium", "ready_to_heat", etc.

RULES
-----
1. Only recommend items that exist in the catalog.
2. Whenever you name a product, you MUST include its exact "id" field in parentheses so it can be looked up later. Example:
   "Mini sándwich miga ave palta (id=novoandina-mini-sandwich-miga-ave-palta-12)".
3. Respect the user's budget and guest count as much as possible. When prices are null, describe them but flag that pricing must be checked manually.
4. Group recommendations into logical sections (e.g., Finger foods, Mains, Desserts, Drinks) using the category and tags.
5. You are planning events in Santiago, Chile, so prefer items and tags that look local (e.g., "chilean", "asado", local caterers).
6. Always explain briefly WHY each item is a good fit (based on tags/useCases/category), not just list names.

You will receive:
- A summary of the user's request.
- A structured summary of the catalog and a large sample of items.

Your task:
- Propose a concrete party menu and shopping/catering plan for this specific user, referencing real catalog items by name and id.
- Make at least 6–10 distinct item recommendations where possible, mixing categories (finger foods, mains, desserts, drinks, etc.).
- If there are many similar items, choose a representative subset but note that similar variants exist.
`;

  const userPrompt = `
USER REQUEST
------------
${requestSummary}

CATALOG SUMMARY
---------------
${catalogSummary}

Now, using ONLY items from the catalog above, design a party food & drink plan tailored to the user.
Return your answer in clear sections with bullet points and include item "id" for each referenced product.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 900,
    });

    const text = completion.choices?.[0]?.message?.content || "";

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        blueprint: text,
        catalogVersion: RAW_CATALOG.version,
        catalogItemCount: PARTY_ITEMS.length,
      }),
    };
  } catch (err) {
    console.error("[Prendy] OpenAI error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: "Failed to generate blueprint",
        details: err.message || String(err),
      }),
    };
  }
};
