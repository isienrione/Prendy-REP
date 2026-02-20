// netlify/functions/blueprint.js

import fs from "fs";
import path from "path";
import OpenAI from "openai";

/**
 * ============
 * LOAD CATALOG
 * ============
 */

const catalogPath = path.join(process.cwd(), "data", "party_catalog_v4.json");

let RAW_CATALOG;
let PARTY_ITEMS = [];

try {
  RAW_CATALOG = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  PARTY_ITEMS = RAW_CATALOG?.stores?.[0]?.items || [];
  console.log(
    `[Prendy] Loaded party_catalog_v4.json: version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency}, items=${PARTY_ITEMS.length}`
  );
} catch (err) {
  console.error(
    "[Prendy] Failed to load data/party_catalog_v4.json; falling back to empty catalog:",
    err
  );
  RAW_CATALOG = { version: "4.0", currency: "CLP", stores: [] };
  PARTY_ITEMS = [];
}

/**
 * ======================
 * LIGHTWEIGHT CATALOG IQ
 * ======================
 *
 * These helpers give the model a structured, pre‑filtered view instead
 * of dumping the raw catalog. This keeps tokens down and pushes it to
 * make specific, grounded choices.
 */

function normalizeTag(t) {
  return (t || "").toString().trim().toLowerCase();
}

function hasTag(item, tag) {
  const needle = normalizeTag(tag);
  return (item.tags || []).map(normalizeTag).includes(needle);
}

function scoresForEventType(item, eventType) {
  // Very simple scoring by tags and category.
  const tags = (item.tags || []).map(normalizeTag);
  const cat = normalizeTag(item.category);

  let score = 0;

  // Generic boosts
  if (["finger_food", "brunch_box", "cheese", "charcuterie"].includes(cat)) {
    score += 2;
  }
  if (["main_delivery", "main_prepared"].includes(cat)) {
    score += 3;
  }
  if (["dessert"].includes(cat)) {
    score += 2;
  }
  if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) {
    score += 1;
  }

  // Event‑specific boosts via tags
  if (eventType === "adult_birthday_home") {
    if (tags.includes("chilean")) score += 2;
    if (tags.includes("party")) score += 2;
    if (tags.includes("ready_to_heat")) score += 1;
    if (tags.includes("finger_food")) score += 1;
  }

  return score;
}

function categorizeItemsForEvent(eventType) {
  const buckets = {
    fingerFoods: [],
    mains: [],
    desserts: [],
    drinks: [],
    other: [],
  };

  PARTY_ITEMS.forEach((item) => {
    const cat = normalizeTag(item.category);
    const score = scoresForEventType(item, eventType);

    const enriched = { ...item, score };

    if (["finger_food", "cheese", "charcuterie", "brunch_box"].includes(cat)) {
      buckets.fingerFoods.push(enriched);
    } else if (["main_delivery", "main_prepared"].includes(cat)) {
      buckets.mains.push(enriched);
    } else if (["dessert"].includes(cat)) {
      buckets.desserts.push(enriched);
    } else if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) {
      buckets.drinks.push(enriched);
    } else {
      buckets.other.push(enriched);
    }
  });

  // Sort each bucket descending by score, then by name as tiebreaker.
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.name || "").localeCompare(b.name || "");
    });
  }

  return buckets;
}

function summarizeBucket(label, items, max = 40) {
  const lines = [];
  lines.push(`=== ${label} (top ${Math.min(max, items.length)} of ${items.length}) ===`);
  items.slice(0, max).forEach((it) => {
    lines.push(
      `- id=${it.id || "?"}, name=${it.name || "?"}, category=${it.category || "?"}, score=${it.score}, price=${it.price ?? "null"}, tags=${(it.tags || []).join(", ")}`
    );
  });
  return lines.join("\n");
}

function buildStructuredCatalogView(eventType) {
  const buckets = categorizeItemsForEvent(eventType);

  const lines = [];
  lines.push(
    `Catalog version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency}, totalItems=${PARTY_ITEMS.length}`
  );
  lines.push("");

  lines.push(summarizeBucket("Finger foods / brunch / cheese boards", buckets.fingerFoods));
  lines.push("");
  lines.push(summarizeBucket("Mains / main delivery / prepared mains", buckets.mains));
  lines.push("");
  lines.push(summarizeBucket("Desserts & sweets", buckets.desserts));
  lines.push("");
  lines.push(summarizeBucket("Drinks & coffee", buckets.drinks));
  lines.push("");
  lines.push(summarizeBucket("Other", buckets.other));

  return {
    text: lines.join("\n"),
    buckets,
  };
}

/**
 * ============
 * OPENAI CLIENT
 * ============
 */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * ==================
 * NETLIFY ENTRYPOINT
 * ==================
 */

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
  } catch (_err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const {
    eventType = "adult_birthday_home",
    guestCount = 20,
    budgetCLP = 0,
    location = "Santiago",
    notes = "",
  } = body;

  const requestSummary = [
    `Event type: ${eventType}`,
    `Guest count: ${guestCount}`,
    `Budget (CLP): ${budgetCLP}`,
    `Location: ${location}`,
    `User notes: ${notes || "none"}`,
  ].join("\n");

  const { text: catalogView, buckets } = buildStructuredCatalogView(eventType);

  // Build a tiny “planning skeleton” the model can refine
  const planningSkeleton = {
    idealFingerFoodItems: buckets.fingerFoods.slice(0, 10).map((i) => i.id),
    idealMainItems: buckets.mains.slice(0, 10).map((i) => i.id),
    idealDessertItems: buckets.desserts.slice(0, 10).map((i) => i.id),
    idealDrinkItems: buckets.drinks.slice(0, 10).map((i) => i.id),
  };

  const systemPrompt = `
You are Prendy, an expert party-planning assistant for Santiago, Chile.
You have access to a structured catalog of real products (food, drinks, equipment).
Your job is to design concrete, shoppable party plans using ONLY catalog items.

CATALOG STRUCTURE
-----------------
- You receive a catalog view with items grouped into buckets:
  - fingerFoods
  - mains
  - desserts
  - drinks
  - other
- There are also planning suggestions:
  - idealFingerFoodItems: array of top item ids for starters
  - idealMainItems: array of top item ids for mains
  - idealDessertItems: array of top item ids for desserts
  - idealDrinkItems: array of top item ids for drinks

Each catalog item has:
- id (string, unique)
- name (string)
- description (string)
- category, subcategory
- price (CLP) or null
- vendorName
- serviceType
- tags (string[])

HARD RULES
----------
1. You MUST ONLY recommend items that exist in the catalog and that appear in the catalog view I provide.
2. Every product line MUST mention its exact id in parentheses: "Product name (id=...)"
3. NEVER invent generic items like "main protein" or "dessert portions" without tying them to a specific catalog item.
4. If price is null, you can still recommend the item, but clearly note "price TBD, check vendor".
5. Respect the user's budget and guest count as much as possible:
   - For 20–40 guests, ensure there is enough variety and quantity.
   - Prefer ready-to-serve or ready-to-heat for home events.
6. Prefer items whose tags or category match the event type (for example "adult_birthday_home", "party", "chilean", "finger_food", "ready_to_heat").
7. Organize the answer into clear sections with headings:
   - Event overview
   - Food plan (starters, mains, sides, desserts)
   - Drinks plan
   - Equipment & serving
   - Shopping list summary
8. In each section, provide 2–5 SPECIFIC product recommendations with:
   - item name
   - id
   - suggested quantity (scaled to the guest count)
   - a short reason that ties back to tags or category.
9. If the catalog is sparse in a category, say so explicitly and suggest where the host might need to improvise.

Your goal: use the catalog as if you are a local party planner assembling a real order to place with vendors, not writing abstract advice.
`;

  const userPrompt = `
USER REQUEST
------------
${requestSummary}

CATALOG VIEW (GROUPED & SCORED)
--------------------------------
${catalogView}

PLANNING SKELETON (IDS ONLY)
----------------------------
${JSON.stringify(planningSkeleton, null, 2)}

TASK
----
Using ONLY items from the catalog view and IDs above, design a detailed party plan.
Make it very concrete and grounded in products:
- At least 3–5 different finger foods or appetizer items.
- At least 2–3 different mains or substantial dishes.
- At least 2 dessert/sweet options.
- A well-balanced drinks lineup (wine/beer/soft drinks/water/coffee as appropriate).
- Practical serving/equipment notes.

Remember: Every product line MUST include the exact catalog id in parentheses.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      max_tokens: 1400,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
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
    console.error("[Prendy] OpenAI error generating blueprint:", err);
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
