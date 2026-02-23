// netlify/functions/blueprint.js
import fs from "fs";
import path from "path";

/**
 * ==========================
 * Catalog loader (v5 + v4)
 * ==========================
 */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function normalizeItems(rawCatalog) {
  // v5 schema: { items: [...] }
  if (rawCatalog && Array.isArray(rawCatalog.items)) return rawCatalog.items;

  // v4-ish schema: { stores: [{ items: [...] }] }
  if (rawCatalog && Array.isArray(rawCatalog.stores) && rawCatalog.stores[0] && Array.isArray(rawCatalog.stores[0].items)) {
    return rawCatalog.stores[0].items;
  }

  // raw array fallback
  if (Array.isArray(rawCatalog)) return rawCatalog;

  return [];
}

function normalizeStores(rawCatalog) {
  if (rawCatalog && Array.isArray(rawCatalog.stores)) return rawCatalog.stores;
  return [];
}

function priceToCLPNumber(price) {
  if (price == null) return null;
  if (typeof price === "number" && Number.isFinite(price)) return price;
  if (typeof price === "object" && typeof price.amount === "number" && Number.isFinite(price.amount)) return price.amount;
  return null;
}

const CATALOG_PATH = path.join(process.cwd(), "data", "party_catalog_v4.json");

const RAW = readJsonSafe(CATALOG_PATH) || { version: "unknown", currency: "CLP", items: [], stores: [] };
const STORES = normalizeStores(RAW);
const STORE_NAME_BY_ID = new Map(STORES.map((s) => [s.id, s.name]));
const ITEMS = normalizeItems(RAW)
  .filter(Boolean)
  .map((it) => ({
    id: it.id,
    name: it.name || "",
    description: it.description || "",
    category: it.category || "",
    subcategory: it.subcategory || "",
    tags: Array.isArray(it.tags) ? it.tags : [],
    useCases: Array.isArray(it.useCases) ? it.useCases : [],
    storeId: it.storeId || "",
    vendorName: it.vendorName || "",
    format: it.format || null,
    unitPriceCLP: priceToCLPNumber(it.price),
  }));

/**
 * ==========================
 * Helpers
 * ==========================
 */
const norm = (s) => (s || "").toString().trim().toLowerCase();
const has = (arr, v) => (Array.isArray(arr) ? arr.map(norm).includes(norm(v)) : false);

function mapStoreToPlatform(storeId, storeNameFallback = "") {
  const s = norm(storeId || storeNameFallback);
  if (s.includes("lider")) return "lider";
  if (s.includes("jumbo")) return "jumbo";
  if (s.includes("rappi")) return "rappi";
  if (s.includes("uber")) return "ubereats";
  if (s.includes("pedido")) return "pedidosya";
  return "mercadolibre";
}

function fmtCLP(n) {
  if (n == null) return "";
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString("es-CL");
}

function detectEventType(form) {
  const type = norm(form.type);
  const vibe = norm(form.vibe);
  const g = parseInt(form.guestCount || "0", 10) || 20;

  if (type.includes("adult") && type.includes("birthday")) return "adult_birthday_home";
  if (type.includes("kid") || type.includes("kids")) return "kids_birthday_home";
  if (vibe.includes("bbq") || vibe.includes("asado")) return "family_lunch_bbq_home";
  if (g >= 45) return "big_home_party";
  return "adult_birthday_home";
}

function dietSet(form) {
  const d = norm(form.dietary || form.diet || "");
  const s = new Set();
  if (d.includes("vegan")) s.add("vegan");
  if (d.includes("vegetarian") || d.includes("veggie")) s.add("vegetarian");
  if (d.includes("gluten") || d.includes("sin gluten")) s.add("gluten_free");
  return s;
}

function scoreItem(it, eventType, diet) {
  let score = 0;

  if (eventType && has(it.useCases, eventType)) score += 10;
  if (has(it.tags, "party")) score += 2;
  if (has(it.tags, "finger_food")) score += 3;
  if (has(it.tags, "ready_to_heat")) score += 2;
  if (has(it.tags, "bbq") || has(it.tags, "parrilla")) score += 3;

  if (diet.has("vegan")) {
    if (has(it.tags, "vegan")) score += 6;
    if (has(it.tags, "vegetarian")) score += 2;
    if (has(it.tags, "beef") || has(it.tags, "pork") || has(it.tags, "chicken") || has(it.tags, "seafood") || has(it.tags, "cheese")) score -= 9;
  } else if (diet.has("vegetarian")) {
    if (has(it.tags, "vegetarian")) score += 5;
    if (has(it.tags, "vegan")) score += 3;
    if (has(it.tags, "beef") || has(it.tags, "pork") || has(it.tags, "chicken") || has(it.tags, "seafood")) score -= 8;
  }

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

function inferUnit(it) {
  const u = it?.format?.unitType;
  if (u) return u;
  const name = norm(it.name);
  if (name.includes("kg")) return "kg";
  if (name.includes("lt") || name.includes("litro")) return "L";
  return "units";
}

function qtyFor(it, guestCount, bucket) {
  const g = Math.max(2, parseInt(guestCount || "20", 10) || 20);
  const cat = norm(it.category);

  if (bucket === "mains") {
    // ~250g/person total across 2-3 proteins; approximate per SKU
    if (inferUnit(it) === "kg" || norm(it.name).includes("kg")) return Math.max(2, Math.ceil(g / 6));
    return Math.max(4, Math.ceil(g / 8));
  }

  if (bucket === "starters") return Math.max(1, Math.ceil(g / 12));
  if (bucket === "desserts") return Math.max(1, Math.ceil(g / 12));

  if (bucket === "drinks") {
    if (cat.includes("wine")) return Math.max(2, Math.ceil(g / 5));
    if (cat.includes("beer")) return Math.max(6, Math.ceil(g * 1.2));
    if (cat.includes("spirits")) return Math.max(1, Math.ceil(g / 18));
    return Math.max(4, Math.ceil(g / 6));
  }

  return 1;
}

function supplyLine(it, bucket, guestCount) {
  const storeName = STORE_NAME_BY_ID.get(it.storeId) || it.storeId || it.vendorName || "";
  const platform = mapStoreToPlatform(it.storeId, storeName);
  const priceStr = it.unitPriceCLP != null ? `~$${fmtCLP(it.unitPriceCLP)} CLP` : "price n/a";

  // IMPORTANT: item label becomes *specific* (brand/size) because it uses it.name
  return {
    item: `${it.name} — ${priceStr}`,
    quantity: qtyFor(it, guestCount, bucket),
    unit: inferUnit(it),
    note: `${storeName ? `Store: ${storeName}. ` : ""}Catalog ID: ${it.id}. ${it.description ? it.description.slice(0, 120) : ""}`.trim(),
    preferred_store: platform,

    // optional metadata for later UI upgrades
    catalogId: it.id,
    storeId: it.storeId || null,
    unitPriceCLP: it.unitPriceCLP ?? null,
    category: it.category || null,
    tags: it.tags || [],
  };
}

function buildBlueprint(form) {
  const guestCount = parseInt(form.guestCount || "20", 10) || 20;
  const budget = parseInt(form.budget || form.budgetCLP || "0", 10) || 0;
  const vibe = form.vibe || "";
  const setting = form.setting || "";
  const location = form.location || "Santiago";
  const dietary = form.dietary || "";
  const notes = form.notes || "";

  const eventType = detectEventType(form);
  const diet = dietSet(form);

  // broad category matching (works for v5 categories like wine_red too)
  const starters = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("charcut") || c.includes("cheese") || c.includes("finger") || c.includes("brunch") || has(it.tags, "finger_food");
    },
    eventType,
    diet,
    6
  );

  const mains = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("meat") || c.includes("main") || has(it.tags, "bbq") || has(it.tags, "parrilla");
    },
    eventType,
    diet,
    4
  );

  const desserts = pickTop(
    (it) => {
      const c = norm(it.category);
      return c.includes("dessert") || c.includes("sweet") || has(it.tags, "postre");
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
    6
  );

  const supplies = {
    food: [
      ...starters.map((it) => supplyLine(it, "starters", guestCount)),
      ...mains.map((it) => supplyLine(it, "mains", guestCount)),
      ...desserts.map((it) => supplyLine(it, "desserts", guestCount)),
    ],
    drinks: drinks.map((it) => supplyLine(it, "drinks", guestCount)),
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
    ],
  };

  // CRITICAL: timeline exists at top-level, so UI won't fallback
  const timeline = [
    { time: "T-24h", task: "Confirm RSVPs + dietary", owner: "Host" },
    { time: "T-6h", task: "Receive orders + refrigerate", owner: "Host" },
    { time: "T-3h", task: "Prep boards + chill drinks", owner: "Host + helper" },
    { time: "T-2h", task: `Set vibe: ${vibe || "custom"} · setting: ${setting || "default"}`, owner: "Host" },
    { time: "T-0", task: "Guests arrive — welcome drinks + starters", owner: "Host" },
    { time: "T+1.5h", task: "Serve mains", owner: "Host + helper" },
    { time: "T+3h", task: "Dessert + coffee", owner: "Host" },
  ];

  const summary = `Blueprint for ${guestCount} guests in ${location}. Vibe: ${vibe || "custom"} · Setting: ${setting || "default"} · Budget: ${
    budget ? `$${fmtCLP(budget)} CLP` : "not specified"
  }.`;

  const tips = [
    "You should now see specific catalog products in Supplies (not 'Main protein'). If you still see 'Main protein', the frontend is still using fallback.",
    notes ? `Notes applied: ${notes}` : null,
    dietary ? `Dietary: ${dietary}` : null,
  ].filter(Boolean);

  return {
    summary,
    timeline,
    supplies,
    tips,
    meta: {
      eventType,
      catalogVersion: RAW.version || "unknown",
      itemsLoaded: ITEMS.length,
      debug: "UNWRAPPED_BLUEPRINT_RESPONSE_v1",
    },
  };
}

/**
 * ==========================
 * Netlify handler
 * ==========================
 */
export const handler = async (event) => {
  console.log(`[Prendy] blueprint called. method=${event.httpMethod}`);

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let form = {};
  try {
    form = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  console.log(`[Prendy] catalog path=${CATALOG_PATH}`);
  console.log(`[Prendy] itemsLoaded=${ITEMS.length} version=${RAW.version || "unknown"}`);

  if (!ITEMS.length) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Catalog not loaded. Ensure data/party_catalog_v4.json exists in the deployed repo and is valid JSON.",
      }),
    };
  }

  const blueprint = buildBlueprint(form);

  // IMPORTANT: return blueprint directly (not wrapped), so bp.timeline exists
  return {
    statusCode: 200,
    body: JSON.stringify(blueprint),
    headers: { "Content-Type": "application/json" },
  };
};
