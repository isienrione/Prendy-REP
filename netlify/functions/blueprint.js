// netlify/functions/blueprint.js

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
/**
 * ==========================================================
 * Catalog loader that supports BOTH schemas (your rename swap)
 * - Loads data/party_catalog_v4.json (which you made v5)
 * - Works if it is actually v4/older too
 * ==========================================================
 */

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function normalizePriceToNumber(price) {
  if (price == null) return null;
  if (typeof price === "number") return Number.isFinite(price) ? price : null;
  if (typeof price === "object" && typeof price.amount === "number") return price.amount;
  return null;
}

function normalizeItemsFromCatalog(rawCatalog) {
  // v5: { items: [...] }
  if (rawCatalog && Array.isArray(rawCatalog.items)) return rawCatalog.items;

  // v4-ish: { stores: [{ items: [...] }] }
  if (
    rawCatalog &&
    Array.isArray(rawCatalog.stores) &&
    rawCatalog.stores[0] &&
    Array.isArray(rawCatalog.stores[0].items)
  ) {
    return rawCatalog.stores[0].items;
  }

  // very old: raw is already an array
  if (Array.isArray(rawCatalog)) return rawCatalog;

  return [];
}

function normalizeStoresFromCatalog(rawCatalog) {
  if (rawCatalog && Array.isArray(rawCatalog.stores)) return rawCatalog.stores;
  return [];
}

const CATALOG_PATH = path.join(process.cwd(), "data", "party_catalog_v4.json");

const RAW = readJsonSafe(CATALOG_PATH) || { version: "unknown", currency: "CLP", items: [], stores: [] };
const STORES = normalizeStoresFromCatalog(RAW);
const STORE_NAME_BY_ID = new Map(STORES.map((s) => [s.id, s.name]));

const ITEMS_RAW = normalizeItemsFromCatalog(RAW);

// Normalize items into a consistent shape
const ITEMS = ITEMS_RAW
  .filter((x) => x && typeof x === "object")
  .map((it) => ({
    id: it.id,
    name: it.name || "",
    description: it.description || "",
    tags: Array.isArray(it.tags) ? it.tags : [],
    useCases: Array.isArray(it.useCases) ? it.useCases : [],
    category: it.category || "",
    subcategory: it.subcategory || "",
    vendorName: it.vendorName || "",
    storeId: it.storeId || "",
    serviceType: it.serviceType || "",
    format: it.format || null,
    // unified numeric price
    unitPriceCLP: normalizePriceToNumber(it.price),
    // keep original price object for reference
    price: it.price ?? null,
  }));

const VALID_IDS = new Set(ITEMS.map((x) => x.id).filter(Boolean));

/**
 * =========================
 * Utility helpers
 * =========================
 */
const norm = (s) => (s || "").toString().trim().toLowerCase();
const hasTag = (it, tag) => it.tags?.map(norm).includes(norm(tag));
const hasUseCase = (it, uc) => it.useCases?.map(norm).includes(norm(uc));

function mapStoreToPlatform(storeId, storeNameFallback = "") {
  const s = norm(storeId || storeNameFallback);
  if (s.includes("lider")) return "lider";
  if (s.includes("jumbo")) return "jumbo";
  if (s.includes("rappi")) return "rappi";
  if (s.includes("uber")) return "ubereats";
  if (s.includes("pedido")) return "pedidosya";
  return "mercadolibre";
}

function formatCLP(n) {
  if (n == null) return "";
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString("es-CL");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeInt(x, d = 0) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : d;
}

/**
 * ==================================
 * Detect event type / diet constraints
 * ==================================
 */
function detectEventType(form) {
  const type = norm(form.type);
  const vibe = norm(form.vibe);
  const g = safeInt(form.guestCount, 20);

  // Reuse your catalog useCases naming style (examples you mentioned)
  if (type.includes("adult") && type.includes("birthday")) return "adult_birthday_home";
  if (type.includes("kid") || type.includes("kids")) return "kids_birthday_home";
  if (vibe.includes("bbq") || vibe.includes("asado")) return "family_lunch_bbq_home";
  if (g >= 45) return "big_home_party";
  return "adult_birthday_home";
}

function dietarySet(form) {
  const d = norm(form.dietary || form.diet || "");
  const s = new Set();
  if (d.includes("vegan")) s.add("vegan");
  if (d.includes("vegetarian") || d.includes("veggie")) s.add("vegetarian");
  if (d.includes("gluten") || d.includes("sin gluten")) s.add("gluten_free");
  if (d.includes("lactose") || d.includes("sin lactosa")) s.add("lactose_free");
  return s;
}

/**
 * ==================================
 * Scoring: pick the best catalog items
 * ==================================
 */
function scoreItem(it, eventType, diet) {
  let score = 0;

  // Strong match to the requested useCase
  if (eventType && hasUseCase(it, eventType)) score += 10;

  // Party-friendly tags
  if (hasTag(it, "party")) score += 2;
  if (hasTag(it, "finger_food")) score += 3;
  if (hasTag(it, "ready_to_heat")) score += 2;
  if (hasTag(it, "bbq") || hasTag(it, "parrilla")) score += 3;

  // Diet alignment
  if (diet.has("vegan")) {
    if (hasTag(it, "vegan")) score += 6;
    if (hasTag(it, "vegetarian")) score += 2;
    // penalize animal products
    if (hasTag(it, "beef") || hasTag(it, "pork") || hasTag(it, "chicken") || hasTag(it, "seafood") || hasTag(it, "cheese")) {
      score -= 9;
    }
  } else if (diet.has("vegetarian")) {
    if (hasTag(it, "vegetarian")) score += 5;
    if (hasTag(it, "vegan")) score += 3;
    if (hasTag(it, "beef") || hasTag(it, "pork") || hasTag(it, "chicken") || hasTag(it, "seafood")) score -= 8;
  }

  if (diet.has("gluten_free") && (hasTag(it, "gluten_free") || hasTag(it, "sin_gluten"))) score += 2;
  if (diet.has("lactose_free") && hasTag(it, "lactose_free")) score += 1;

  // Prefer having a price
  if (it.unitPriceCLP != null) score += 1;

  return score;
}

function pickTop(filterFn, eventType, diet, n) {
  return ITEMS
    .filter(filterFn)
    .map((it) => ({ ...it, _score: scoreItem(it, eventType, diet) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, n);
}

/**
 * ==================================
 * Quantities: produce realistic counts
 * ==================================
 */
function inferUnit(it) {
  // Use format.unitType if present, else infer from name
  const unitType = it?.format?.unitType;
  if (unitType) return unitType;

  const name = norm(it.name);
  if (name.includes("kg") || name.includes(" kilo")) return "kg";
  if (name.includes("lt") || name.includes("liter") || name.includes("litro")) return "L";
  if (name.includes("pack") || name.includes("caja")) return "pack";
  return "unit";
}

function qtyFor(it, guestCount, bucket) {
  const g = clamp(safeInt(guestCount, 20), 2, 500);
  const name = norm(it.name);
  const cat = norm(it.category);

  // BBQ / meat buckets
  if (bucket === "mains") {
    // Aim ~250g/person total across 2-3 proteins.
    // We approximate SKU quantity by "1 unit per ~6 people" when item looks like 1kg packs.
    if (name.includes("1kg") || name.includes(" kg") || inferUnit(it) === "kg") return Math.max(1, Math.ceil(g / 6));
    return Math.max(4, Math.ceil(g / 8));
  }

  // Starters: 4-7 SKUs, each ~1 unit per 10-14 people
  if (bucket === "starters") return Math.max(1, Math.ceil(g / 12));

  // Desserts: 2-4 SKUs, each ~1 unit per 10-14 people
  if (bucket === "desserts") return Math.max(1, Math.ceil(g / 12));

  // Drinks: rough party math
  if (bucket === "drinks") {
    if (cat.includes("wine")) return Math.max(2, Math.ceil(g / 5));
    if (cat.includes("beer")) return Math.max(6, Math.ceil(g * 1.2));
    if (cat.includes("spirits")) return Math.max(1, Math.ceil(g / 18));
    return Math.max(4, Math.ceil(g / 6));
  }

  return 1;
}

/**
 * ==================================
 * Build blueprint object (UI-compatible)
 * ==================================
 * IMPORTANT: Your UI requires `timeline` to exist or it falls back.
 * We return:
 * {
 *   ok: true,
 *   blueprint: {
 *     summary, timeline, supplies, tips, risks, meta
 *   }
 * }
 */
function buildBlueprintFromCatalog(form) {
  const guestCount = safeInt(form.guestCount, 20);
  const budgetCLP = safeInt(form.budget || form.budgetCLP, 0);
  const vibe = form.vibe || "";
  const setting = form.setting || "";
  const dietary = form.dietary || "";
  const notes = form.notes || "";
  const location = form.location || "Santiago";

  const eventType = detectEventType(form);
  const diet = dietarySet(form);

  // Category guesses — tuned to your v5 categories but safe for older catalogs
  const starters = pickTop(
    (it) => {
      const c = norm(it.category);
      return (
        c.includes("finger") ||
        c.includes("charcut") ||
        c.includes("cheese") ||
        c.includes("brunch") ||
        hasTag(it, "finger_food")
      );
    },
    eventType,
    diet,
    7
  );

  const mains = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("meat") || c.includes("main") || hasTag(it, "bbq") || hasTag(it, "parrilla");
    },
    eventType,
    diet,
    4
  );

  const desserts = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("dessert") || c.includes("sweet") || hasTag(it, "postre");
    },
    eventType,
    diet,
    3
  );

  const drinks = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("wine") || c.includes("beer") || c.includes("spirits") || c.includes("soft") || c.includes("coffee");
    },
    eventType,
    diet,
    7
  );

  const toSupplyLine = (it, bucket) => {
    const qty = qtyFor(it, guestCount, bucket);
    const unit = inferUnit(it);
    const storeName = STORE_NAME_BY_ID.get(it.storeId) || it.storeId || it.vendorName || "";
    const platform = mapStoreToPlatform(it.storeId, storeName);

    const price = it.unitPriceCLP;
    const priceStr = price != null ? `~$${formatCLP(price)} CLP` : "price n/a";

    // This is the key change: the visible label includes the real product name/brand/size + price
    return {
      // Keep these keys aligned with your UI list renderer (it displays item/quantity)
      item: `${it.name} — ${priceStr}`,
      quantity: qty,
      unit,
      note: `${storeName ? `Store: ${storeName}. ` : ""}Catalog ID: ${it.id}. ${it.description ? it.description.slice(0, 120) : ""}`.trim(),
      preferred_store: platform,

      // extra metadata (safe even if UI ignores it)
      catalogId: it.id,
      storeId: it.storeId || null,
      vendorName: it.vendorName || null,
      unitPriceCLP: price ?? null,
      category: it.category || null,
      tags: it.tags || [],
    };
  };

  const supplies = {
    // Your UI shows Food + Drinks blocks; we keep structure simple.
    food: [
      ...starters.map((it) => toSupplyLine(it, "starters")),
      ...mains.map((it) => toSupplyLine(it, "mains")),
      ...desserts.map((it) => toSupplyLine(it, "desserts")),
    ],
    drinks: drinks.map((it) => toSupplyLine(it, "drinks")),
    equipment: [
      {
        item: "Ice (bags)",
        quantity: Math.max(4, Math.ceil(guestCount / 6)),
        unit: "bags",
        note: "Rule: ~1 bag per 6 guests (+extra if hot day / cocktails). If not in catalog, buy Lider/Rappi.",
        preferred_store: "rappi",
      },
      {
        item: "Disposable cups/plates/napkins",
        quantity: guestCount,
        unit: "sets",
        note: "If not in catalog, buy Lider/Jumbo or Mercado Libre.",
        preferred_store: "mercadolibre",
      },
      {
        item: "Trash bags",
        quantity: Math.max(6, Math.ceil(guestCount / 6)),
        unit: "bags",
        note: "Separate wet/dry if possible.",
        preferred_store: "lider",
      },
    ],
  };

  const timeline = [
    { time: "T-24h", title: "Confirm plan", detail: `Confirm guest count (${guestCount}) + dietary: ${dietary || "none"}.` },
    { time: "T-6h", title: "Receive orders", detail: "Receive supermarket/vendor deliveries. Refrigerate immediately." },
    { time: "T-3h", title: "Prep + staging", detail: "Prep boards, chill drinks, label zones (food/drinks/dessert)." },
    { time: "T-2h", title: "Set vibe", detail: `Lighting + music aligned to: ${vibe || "your vibe"}. Setting: ${setting || "default"}.` },
    { time: "T-1h", title: "Cook/heat", detail: "Start heating/cooking mains so they land hot at peak time." },
    { time: "T-0", title: "Arrivals", detail: "Welcome drink + first starter wave." },
    { time: "T+1.5h", title: "Main moment", detail: "Serve mains in waves; keep drinks station restocked." },
    { time: "T+3h", title: "Dessert", detail: "Dessert + coffee / digestifs." },
    { time: "T+4h", title: "Close", detail: "Quick clean reset; pack leftovers safely." },
  ];

  const tips = [
    `If you want “more specific meat”: choose 2 proteins + 1 sausage style (e.g. vacuno + pollo + longaniza) from the catalog lines above.`,
    "Group orders by store to reduce delivery fees.",
    "Buy ice late so it lasts; keep backup trash bags visible.",
    notes ? `Special notes applied: ${notes}` : null,
  ].filter(Boolean);

  const risks = [
    norm(setting).includes("outdoor")
      ? "Outdoor risk: temperature drops in Santiago evenings; plan warmth/blankets or covered backup."
      : "Indoor risk: bottleneck at drinks station — consider 2 stations for >25 guests.",
  ];

  const summary = `Blueprint for ${guestCount} guests in ${location}. Vibe: ${vibe || "custom"} · Setting: ${setting || "default"} · Budget: ${
    budgetCLP ? `$${formatCLP(budgetCLP)} CLP` : "not specified"
  }.`;

  return {
    summary,
    timeline,
    supplies,
    tips,
    risks,
    meta: {
      eventType,
      catalogVersion: RAW.version || RAW.meta?.version || "unknown",
      catalogItemsLoaded: ITEMS.length,
    },
  };
}

/**
 * ==================================
 * Optional: use model to rewrite summary/tips (not required)
 * Keeps your app cheap and deterministic but can add polish.
 * ==================================
 */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function polishWithModel(blueprint, form) {
  // If you don’t want any model calls, set PRENDY_USE_MODEL=false in Netlify env.
  const useModel = (process.env.PRENDY_USE_MODEL || "false").toLowerCase() === "true";
  if (!useModel) return blueprint;

  const model = process.env.PRENDY_MODEL || "gpt-4.1-mini";
  const temperature = Number(process.env.PRENDY_TEMP || 0.6);
  const max_tokens = safeInt(process.env.PRENDY_MAX_TOKENS, 500);

  const system = `You are an event producer. Rewrite ONLY "summary" and "tips" to be more personal and vivid.
Do not change any supplies items, IDs, quantities, or prices. Return JSON with {summary, tips}.`;

  const user = JSON.stringify({ form, summary: blueprint.summary, tips: blueprint.tips }, null, 2);

  try {
    const resp = await client.chat.completions.create({
      model,
      temperature,
      max_tokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const txt = resp.choices?.[0]?.message?.content || "{}";
    const patched = JSON.parse(txt);

    return {
      ...blueprint,
      summary: typeof patched.summary === "string" ? patched.summary : blueprint.summary,
      tips: Array.isArray(patched.tips) ? patched.tips : blueprint.tips,
    };
  } catch (e) {
    // Fail silently; keep deterministic output
    return blueprint;
  }
}

/**
 * ==================================
 * Netlify handler
 * ==================================
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  let form;
  try {
    form = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
  }

  // If catalog is empty, return a hard error so you notice immediately (instead of silent generic)
  if (!ITEMS.length) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: "Catalog items not loaded. Check data/party_catalog_v4.json exists in repo and is valid JSON.",
      }),
    };
  }

  // Build blueprint grounded in catalog
  let blueprint = buildBlueprintFromCatalog(form);

  // Optional: polish copy only (summary/tips), leaving catalog lines intact
  blueprint = await polishWithModel(blueprint, form);

  // Final sanity: ensure timeline exists so UI does not fallback
  if (!Array.isArray(blueprint.timeline) || blueprint.timeline.length === 0) {
    blueprint.timeline = [{ time: "T-0", title: "Start", detail: "Timeline missing; fallback inserted." }];
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      blueprint, // IMPORTANT: structured object with timeline + supplies
    }),
  };
  }; 
