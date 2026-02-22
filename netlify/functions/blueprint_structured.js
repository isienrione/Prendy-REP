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
 */
function normalizeTag(t) {
  return (t || "").toString().trim().toLowerCase();
}

function scoreForEvent(item, eventType) {
  const tags = (item.tags || []).map(normalizeTag);
  const cat = normalizeTag(item.category);

  let score = 0;

  // Base on category
  if (["finger_food", "brunch_box", "cheese", "charcuterie"].includes(cat)) score += 3;
  if (["main_delivery", "main_prepared"].includes(cat)) score += 4;
  if (["dessert"].includes(cat)) score += 3;
  if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) score += 2;

  // Event-specific boosts
  if (eventType === "adult_birthday_home") {
    if (tags.includes("adult_birthday_home")) score += 3;
    if (tags.includes("big_home_party")) score += 2;
    if (tags.includes("party")) score += 2;
    if (tags.includes("chilean")) score += 2;
    if (tags.includes("ready_to_heat")) score += 1;
    if (tags.includes("finger_food")) score += 1;
  }

  return score;
}

function categorizeItemsForEvent(eventType) {
  const buckets = { fingerFoods: [], mains: [], desserts: [], drinks: [], other: [] };

  PARTY_ITEMS.forEach((item) => {
    const cat = normalizeTag(item.category);
    const scored = { ...item, score: scoreForEvent(item, eventType) };

    if (["finger_food", "cheese", "charcuterie", "brunch_box"].includes(cat)) buckets.fingerFoods.push(scored);
    else if (["main_delivery", "main_prepared"].includes(cat)) buckets.mains.push(scored);
    else if (["dessert"].includes(cat)) buckets.desserts.push(scored);
    else if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) buckets.drinks.push(scored);
    else buckets.other.push(scored);
  });

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => (b.score !== a.score ? b.score - a.score : (a.name || "").localeCompare(b.name || "")));
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
  lines.push(`Catalog version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency}, totalItems=${PARTY_ITEMS.length}`);
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
  return { text: lines.join("\n"), buckets };
}

/**
 * ============
 * OPENAI CLIENT
 * ============
 */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * ================
 * HELPERS
 * ================
 */
function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

function safeString(x, fallback = "") {
  return typeof x === "string" ? x : fallback;
}

// Ensure the response always has the shape the front-end can render
function normalizePlanShape(plan, guestCount) {
  const g = clamp(parseInt(guestCount, 10) || 20, 1, 500);

  const out = {
    ok: true,
    overview: plan?.overview && typeof plan.overview === "object"
      ? {
          title: safeString(plan.overview.title, "Event Blueprint"),
          summary: safeString(plan.overview.summary, ""),
        }
      : { title: "Event Blueprint", summary: "" },

    // Frontend expects timeline array (or will show text fallback)
    timeline: Array.isArray(plan?.timeline)
      ? plan.timeline
          .map((t) => ({
            time: safeString(t?.time, ""),
            task: safeString(t?.task, ""),
            owner: safeString(t?.owner, ""),
          }))
          .filter((t) => t.time || t.task)
      : [],

    // Frontend card UI expects supplies.{food|drinks|equipment} arrays of {item,quantity,unit,note}
    supplies: {
      food: Array.isArray(plan?.supplies?.food) ? plan.supplies.food : [],
      drinks: Array.isArray(plan?.supplies?.drinks) ? plan.supplies.drinks : [],
      equipment: Array.isArray(plan?.supplies?.equipment) ? plan.supplies.equipment : [],
    },

    // Keep a text blueprint too (useful for the Supplies tab pre-wrap view / debugging)
    blueprint: safeString(plan?.blueprint, ""),
  };

  // Normalize items
  for (const k of ["food", "drinks", "equipment"]) {
    out.supplies[k] = out.supplies[k]
      .map((it) => ({
        item: safeString(it?.item, safeString(it?.name, "")),
        quantity: Number.isFinite(it?.quantity) ? it.quantity : (parseFloat(it?.qty) || 0),
        unit: safeString(it?.unit, ""),
        note: safeString(it?.note, safeString(it?.detail, "")),
        preferred_store: safeString(it?.preferred_store, safeString(it?.store, "")) || undefined,
      }))
      .filter((it) => it.item);
  }

  // If model returned nothing structured, keep it safe
  if (!out.blueprint && out.supplies.food.length === 0 && out.supplies.drinks.length === 0) {
    out.blueprint = "No structured blueprint returned.";
  }

  // If no overview summary, add a generic one
  if (!out.overview.summary) {
    out.overview.summary = `Plan for ~${g} guests in Santiago.`;
  }

  return out;
}

/**
 * ==================
 * NETLIFY ENTRYPOINT
 * ==================
 */
export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
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

  const planningSkeleton = {
    fingerFoodIds: buckets.fingerFoods.slice(0, 12).map((i) => i.id),
    mainIds: buckets.mains.slice(0, 12).map((i) => i.id),
    dessertIds: buckets.desserts.slice(0, 12).map((i) => i.id),
    drinkIds: buckets.drinks.slice(0, 12).map((i) => i.id),
  };

  const systemPrompt = `
You are Prendy, an expert party-planning assistant in Santiago, Chile.
You have a structured catalog of real products (food, drinks, equipment).

Hard rules:
- ONLY recommend items that exist in the catalog view and include their id.
- Never invent generic items (e.g. "main protein") without a catalog id.
- Quantities must scale to guest count.

OUTPUT FORMAT (STRICT):
Return ONLY valid JSON (no markdown, no backticks). The JSON MUST match this schema:

{
  "overview": { "title": string, "summary": string },
  "timeline": [{ "time": string, "task": string, "owner": string }],
  "supplies": {
    "food": [{ "item": string, "quantity": number, "unit": string, "note": string, "preferred_store"?: string }],
    "drinks": [{ "item": string, "quantity": number, "unit": string, "note": string, "preferred_store"?: string }],
    "equipment": [{ "item": string, "quantity": number, "unit": string, "note": string, "preferred_store"?: string }]
  },
  "blueprint": string
}

Rules inside supplies:
- item must include the exact catalog id in parentheses: "Name (id=...)".
- unit should be one of: "pcs", "kg", "bottles", "cans", "packs", "trays", "liters".
- quantity must be a number (not a string).

Make the plan operational and realistic.
`;

  const userPrompt = `
USER REQUEST
------------
${requestSummary}

CATALOG VIEW (GROUPED & SCORED)
--------------------------------
${catalogView}

PLANNING SKELETON (TOP IDS)
---------------------------
${JSON.stringify(planningSkeleton, null, 2)}

TASK
----
1) Build a concrete menu and shopping plan using ONLY catalog items.
2) Fill supplies.food, supplies.drinks, supplies.equipment with quantities for ${guestCount} guests.
3) Provide a timeline with at least 6 steps, including setup, food service, and cleanup.
4) Also provide a readable "blueprint" string summarizing the plan.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      max_tokens: 1800,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt.trim() },
      ],
      // This asks the model to respond as a JSON object (no markdown).
      response_format: { type: "json_object" },
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // If parsing fails, return the raw text as blueprint so the UI at least shows something.
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          blueprint: raw,
          catalogVersion: RAW_CATALOG.version,
          catalogItemCount: PARTY_ITEMS.length,
        }),
      };
    }

    const plan = normalizePlanShape(parsed, guestCount);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ...plan,
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
        details: err?.message || String(err),
      }),
    };
  }
};
