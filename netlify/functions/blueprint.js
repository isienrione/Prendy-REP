// netlify/functions/blueprint.js

import fs from "fs";
import path from "path";
import OpenAI from "openai";

// ---------- Load full party catalog v4 ----------
const catalogPath = path.join(process.cwd(), "data", "party_catalog_v4.json");

let RAW_CATALOG;
let PARTY_ITEMS = [];

try {
  RAW_CATALOG = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  PARTY_ITEMS = RAW_CATALOG?.stores?.[0]?.items || [];
  console.log(
    `[Prendy] Loaded party_catalog_v4.json with ${PARTY_ITEMS.length} items (version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency})`
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
function buildCatalogSummary(maxItems = 120) {
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

// ---------- Fallback generator ----------
function generateFallback(formData) {
  const g = parseInt(formData.guestCount) || 30;
  const b = parseInt(formData.budget) || 2000000;

  return {
    summary: `A ${(formData.vibe || "casual").toLowerCase()} ${(formData.type || "gathering").toLowerCase()} for ${g} guests in ${
      formData.setting === "outdoor"
        ? "an outdoor Santiago setting"
        : "a stylish indoor venue"
    }.`,
    supplies: {
      food: [
        {
          item: "Empanadas (assorted)",
          catalogId: "fallback-empanadas",
          quantity: g * 2,
          unit: "pcs",
          note: "Classic Chilean appetizer",
          preferred_vendor: "lider",
          estimatedPrice: g * 2 * 800,
        },
        {
          item: "Main protein",
          catalogId: "fallback-protein",
          quantity: Math.ceil(g * 0.3),
          unit: "kg",
          note: "300g per person",
          preferred_vendor: "jumbo",
          estimatedPrice: Math.ceil(g * 0.3) * 8000,
        },
      ],
      drinks: [
        {
          item: "Soft drinks",
          catalogId: "fallback-sodas",
          quantity: Math.ceil(g * 0.5),
          unit: "liters",
          note: "500ml per person",
          preferred_vendor: "lider",
          estimatedPrice: Math.ceil(g * 0.5) * 1200,
        },
      ],
      misc: [],
    },
    timeline: [
      { time: "14:00", task: "Vendor arrival & venue setup", owner: "Setup crew" },
      { time: "16:00", task: "Sound check & table dressing", owner: "Entertainment + Staff" },
      { time: "17:00", task: "Catering arrives, kitchen prep", owner: "Caterer" },
      { time: "18:30", task: "Final walkthrough & lighting", owner: "You" },
      { time: "19:00", task: "Guests arrive — welcome drinks", owner: "Bartender" },
      { time: "19:45", task: "Dinner service begins", owner: "Waitstaff" },
      { time: "21:00", task: "Dessert & toasts", owner: "You + Staff" },
      { time: "22:00", task: "Music & dancing", owner: "DJ / Band" },
      { time: "00:00", task: "Wind down, guest departure", owner: "You" },
      { time: "00:30", task: "Cleanup & teardown", owner: "Setup crew" },
    ],
    budget: {
      food: { pct: 40, amount: Math.round(b * 0.4) },
      drinks: { pct: 25, amount: Math.round(b * 0.25) },
      venue: { pct: 20, amount: Math.round(b * 0.2) },
      entertainment: { pct: 10, amount: Math.round(b * 0.1) },
      staff: { pct: 5, amount: Math.round(b * 0.05) },
    },
    staffing: {
      servers: Math.ceil(g / 20),
      bartenders: Math.ceil(g / 30),
      setup_crew: 2,
    },
    tips: [
      "Order groceries 2–3 days in advance.",
      "Confirm vendor bookings 48 hours before the event.",
    ],
    risks: [
      "Have a weather backup plan if outdoor.",
      "Confirm guest count 3 days prior.",
    ],
  };
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

  // Payload from frontend (Onboarding form)
  const {
    type,
    scenarioKey,
    hostingMode,
    tier,
    guestCount,
    budget,
    date,
    setting,
    vibe,
    dietary,
    notes,
  } = body;

  // Compact summary for the model
  const requestSummary = [
    `Event type: ${type || "unspecified"}`,
    `Scenario: ${scenarioKey || "unspecified"}`,
    `Hosting mode: ${hostingMode || "unspecified"}`,
    `Recommendation tier: ${tier || "unspecified"}`,
    `Guest count: ${guestCount || "unspecified"}`,
    `Budget (CLP): ${budget || "unspecified"}`,
    `Date: ${date || "unspecified"}`,
    `Setting: ${setting || "unspecified"}`,
    `Vibe: ${vibe || "unspecified"}`,
    `Dietary requirements: ${dietary || "none"}`,
    `User notes: ${notes || "none"}`,
  ].join("\n");

  const catalogSummary = buildCatalogSummary(150);

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
- id (string, unique) - USE THIS IN YOUR RECOMMENDATIONS
- name (string) - human friendly product or bundle name
- description (string) - scenarios/use cases encoded as comma-separated labels
- category (string) - high level type like "finger_food", "brunch_box", "main_delivery", "wine", etc.
- subcategory (string) - optional sub-type
- price (number | null) - price in CLP
- vendorName (string) - store or brand name, e.g. "novoandina.cl", "cafediario.cl"
- venueName (string) - optional, often empty
- serviceType (string) - e.g. "catering", "grocery", "drinks"
- tags (string[]) - tags like "chicken", "seafood", "gift", "premium", "ready_to_heat", etc.

OUTPUT FORMAT (CRITICAL!)
-------------------------
You MUST return a valid JSON object with this EXACT structure:

{
  "summary": "A brief 1–2 sentence summary of the event plan",
  "supplies": {
    "food": [
      {
        "item": "Product name from catalog",
        "catalogId": "exact-catalog-id-here",
        "quantity": 30,
        "unit": "pcs",
        "note": "Why this item fits (1 sentence, based on tags/description)",
        "preferred_vendor": "novoandina.cl",
        "estimatedPrice": 45000
      }
    ],
    "drinks": [
      {
        "item": "Product name from catalog",
        "catalogId": "exact-catalog-id-here",
        "quantity": 10,
        "unit": "bottles",
        "note": "Why this item fits",
        "preferred_vendor": "aperitivo.cl",
        "estimatedPrice": 25000
      }
    ],
    "misc": []
  },
  "timeline": [
    { "time": "14:00", "task": "Vendor arrival & setup", "owner": "Setup crew" },
    { "time": "19:00", "task": "Guests arrive", "owner": "Host" }
  ],
  "budget": {
    "food": { "pct": 40, "amount": 800000 },
    "drinks": { "pct": 25, "amount": 500000 },
    "venue": { "pct": 20, "amount": 400000 },
    "entertainment": { "pct": 10, "amount": 200000 },
    "staff": { "pct": 5, "amount": 100000 }
  },
  "staffing": {
    "servers": 2,
    "bartenders": 1,
    "setup_crew": 2
  },
  "tips": [
    "Short practical tip 1",
    "Short practical tip 2"
  ],
  "risks": [
    "Short risk/mitigation note 1"
  ]
}

RULES
-----
1. Only recommend items that exist in the catalog (use exact "id" as "catalogId").
2. Recommend AT LEAST 8–12 distinct items across food/drinks/misc categories when possible.
3. For every item, include:
   - item (name)
   - catalogId (exact catalog id)
   - quantity and unit (scaled to the guest count)
   - preferred_vendor (from vendorName)
   - estimatedPrice (price * quantity; if price null, estimate reasonably and say so in note).
4. Respect the user's budget and guest count.
5. Prefer items whose description/use cases match the scenario and vibe (e.g., "adult_birthday_home").
6. Prefer Chilean/local items when appropriate (tags like "chilean", "asado").
7. Explain WHY each item fits in the "note" field.
8. Return ONLY the JSON object, no markdown, no extra commentary.

CRITICAL: Your entire response must be valid JSON that can be parsed with JSON.parse().
`;

  const userPrompt = `
USER REQUEST
------------
${requestSummary}

CATALOG SUMMARY
---------------
${catalogSummary}

Now, using ONLY items from the catalog above, design a complete party blueprint as a JSON object.
Include specific catalog items with their exact IDs, quantities, vendors, and prices.
Return ONLY the JSON object, nothing else.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const text = completion.choices?.[0]?.message?.content || "{}";

    let blueprintObj;
    try {
      blueprintObj = JSON.parse(text);
    } catch (parseErr) {
      console.error("[Prendy] Failed to parse AI JSON response:", parseErr);
      console.error("[Prendy] Raw response:", text);
      blueprintObj = generateFallback(body);
    }

    if (!blueprintObj.supplies || !blueprintObj.timeline) {
      console.warn("[Prendy] AI response missing required fields, using fallback");
      blueprintObj = generateFallback(body);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        ...blueprintObj,
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
