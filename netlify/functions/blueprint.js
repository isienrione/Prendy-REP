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
function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function scoreForEvent(item, eventType, vibe, setting, tier, dietaryText) {
  const tags = (item.tags || []).map(norm);
  const cat = norm(item.category);
  const sub = norm(item.subcategory);
  const name = norm(item.name);

  let score = 0;

  // Category priors
  if (["finger_food", "brunch_box", "cheese", "charcuterie", "frozen"].includes(cat)) score += 4;
  if (["main_delivery", "main_prepared", "catering_pack"].includes(cat)) score += 5;
  if (["dessert"].includes(cat)) score += 4;
  if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) score += 3;

  // Event tag boosts
  if (eventType) {
    if (tags.includes(norm(eventType))) score += 6;
  }
  if (tags.includes("party")) score += 2;
  if (tags.includes("big_home_party")) score += 2;
  if (tags.includes("adult_birthday_home")) score += 3;
  if (tags.includes("ready_to_heat")) score += 2;
  if (tags.includes("finger_food")) score += 1;
  if (tags.includes("premium")) score += 1;

  // Dietary alignment (soft preference)
  const dietary = norm(dietaryText);
  if (dietary.includes("vegetarian") || dietary.includes("veggie")) {
    if (tags.includes("vegetarian")) score += 5;
    if (name.includes("verdura") || name.includes("vegetal")) score += 1;
  }
  if (dietary.includes("vegan")) {
    if (tags.includes("vegan")) score += 6;
    if (tags.includes("vegetarian")) score += 2;
  }
  if (dietary.includes("gluten")) {
    if (tags.includes("gluten_free") || tags.includes("sin_gluten")) score += 6;
  }
  if (dietary.includes("no shellfish") || dietary.includes("sin mariscos")) {
    if (tags.includes("seafood") || name.includes("camar")) score -= 8;
  }

  // Vibe / tier / setting hints
  const v = norm(vibe);
  if (v.includes("elegant") || v.includes("refined") || v.includes("premium")) {
    if (tags.includes("premium") || name.includes("bouchon") || name.includes("serrano")) score += 2;
  }
  if (v.includes("party") || v.includes("high-energy") || v.includes("dance")) {
    if (cat === "beer" || cat === "spirits" || name.includes("ron") || name.includes("pisco")) score += 2;
  }

  const t = norm(tier);
  if (t === "value") {
    if ((item.price ?? 999999999) < 9000) score += 1;
  }
  if (t === "premium") {
    if ((item.price ?? 0) > 18000) score += 1;
  }

  const s = norm(setting);
  if (s === "outdoor") {
    // Outdoor = more “easy serve” / grill-ish
    if (tags.includes("skewers") || name.includes("anticucho") || tags.includes("ready_to_heat")) score += 2;
  }

  // Subcategory sanity
  if (sub.includes("cocktail") || sub.includes("mesa_catering")) score += 1;

  return score;
}

function bucketize(items, eventType, vibe, setting, tier, dietary) {
  const buckets = { fingerFoods: [], mains: [], desserts: [], drinks: [], other: [] };

  for (const it of items) {
    const cat = norm(it.category);
    const scored = { ...it, score: scoreForEvent(it, eventType, vibe, setting, tier, dietary) };

    if (["finger_food", "cheese", "charcuterie", "brunch_box", "frozen"].includes(cat)) {
      buckets.fingerFoods.push(scored);
    } else if (["main_delivery", "main_prepared", "catering_pack"].includes(cat)) {
      buckets.mains.push(scored);
    } else if (["dessert"].includes(cat)) {
      buckets.desserts.push(scored);
    } else if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) {
      buckets.drinks.push(scored);
    } else {
      buckets.other.push(scored);
    }
  }

  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (b.score - a.score) || (a.name || "").localeCompare(b.name || ""));
  }
  return buckets;
}

function topCompact(items, n) {
  return items.slice(0, n).map((it) => ({
    id: it.id,
    name: it.name,
    description: it.description || "",
    category: it.category,
    subcategory: it.subcategory,
    price: it.price ?? null,
    vendorName: it.vendorName || "",
    serviceType: it.serviceType || "",
    tags: it.tags || [],
    score: it.score,
  }));
}

function safeInt(x, d = 0) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * ============
 * QUANTITY HEURISTICS
 * ============
 * Keeps the model creative, but we compute quantities consistently.
 */
function inferPackSize(name) {
  // "Pack 20 ..." or "Caja 12 un ..."
  const s = (name || "").toString().toLowerCase();
  let m = s.match(/pack\s*(\d+)/i);
  if (m) return safeInt(m[1], 0);
  m = s.match(/caja\s*(\d+)\s*un/i);
  if (m) return safeInt(m[1], 0);
  m = s.match(/\((?:para|x)\s*(\d+)\)/i); // "(para 15)"
  if (m) return safeInt(m[1], 0);
  m = s.match(/para\s*(\d+)/i); // "para 15"
  if (m) return safeInt(m[1], 0);
  return 0;
}

function qtyForItem(item, guestCount, section) {
  const g = clamp(guestCount, 2, 500);
  const pack = inferPackSize(item.name);
  const cat = norm(item.category);

  // Drinks: generally per bottle/can/units — we target ~1.5 drinks per guest baseline
  if (section === "drinks") {
    // If priced like a single bottle (very low price), let model pick variety; here estimate units.
    // Baseline: 1 unit per 3 guests per SKU, but ensure at least 2.
    return Math.max(2, Math.ceil(g / 3));
  }

  // Finger foods: target 4–6 bites per guest across multiple SKUs
  if (section === "starters") {
    if (pack > 0) {
      // Need ~1 pack per 10–14 guests for a given SKU
      return Math.max(1, Math.ceil(g / 12));
    }
    // Individual price items: assume 1 unit feeds ~1 guest (mini tartaleta etc.)
    return Math.max(6, Math.ceil(g * 0.35));
  }

  // Mains: aim ~0.8 portions per guest across 2–3 mains
  if (section === "mains") {
    if (pack > 0) {
      // e.g., Pack 20 lomitos for 20 people → scale
      return Math.max(1, Math.ceil((g * 0.8) / pack));
    }
    // Individual meals (e.g. milanesa): 0.35–0.5 of guests per SKU
    return Math.max(6, Math.ceil(g * 0.35));
  }

  // Desserts: ~0.7 portions per guest across 2+ SKUs
  if (section === "desserts") {
    if (pack > 0) return Math.max(1, Math.ceil((g * 0.7) / pack));
    return Math.max(6, Math.ceil(g * 0.35));
  }

  // fallback
  if (cat === "catering_pack" && pack > 0) return Math.max(1, Math.ceil(g / pack));
  return Math.max(1, Math.ceil(g / 10));
}

function money(n) {
  const x = Math.round(Number(n || 0));
  return Number.isFinite(x) ? x : 0;
}

function budgetAllocation(totalBudget, hostingMode, tier) {
  const b = money(totalBudget) || 2000000;

  // If venue hosting → more to venue. If home → more to food/drinks/decor.
  const venuePct = hostingMode === "venue" ? 0.35 : 0.18;

  let foodPct = 0.32;
  let drinksPct = 0.16;

  if (tier === "value") {
    foodPct = 0.30;
    drinksPct = 0.14;
  } else if (tier === "premium") {
    foodPct = 0.34;
    drinksPct = 0.18;
  }

  const entertainmentPct = 0.10;
  const staffPct = hostingMode === "venue" ? 0.08 : 0.10;
  const miscPct = 1 - (venuePct + foodPct + drinksPct + entertainmentPct + staffPct);

  const alloc = {
    venue: { amount: money(b * venuePct), pct: Math.round(venuePct * 100) },
    food: { amount: money(b * foodPct), pct: Math.round(foodPct * 100) },
    drinks: { amount: money(b * drinksPct), pct: Math.round(drinksPct * 100) },
    entertainment: { amount: money(b * entertainmentPct), pct: Math.round(entertainmentPct * 100) },
    staff: { amount: money(b * staffPct), pct: Math.round(staffPct * 100) },
    misc: { amount: money(b * miscPct), pct: Math.round(miscPct * 100) },
  };

  // normalize rounding drift
  const pctSum =
    alloc.venue.pct + alloc.food.pct + alloc.drinks.pct + alloc.entertainment.pct + alloc.staff.pct + alloc.misc.pct;
  if (pctSum !== 100) alloc.misc.pct += (100 - pctSum);

  return alloc;
}

function staffingPlan(guestCount, hostingMode, tier) {
  const g = clamp(guestCount, 2, 500);

  // Similar to your UI’s default heuristic  [oai_citation:2‡index (7).html](sediment://file_00000000f90c71f5ae5514ad21b66b25) but slightly smarter for tier.
  let servers = Math.ceil(g / 12);
  let bartenders = Math.ceil(g / 30);
  let setup_crew = Math.ceil(g / 25) + 1;

  if (hostingMode === "home") {
    // home parties often need less formal staff
    bartenders = Math.max(0, bartenders - 1);
  }
  if (tier === "premium") {
    servers += 1;
    bartenders += 1;
  }
  if (tier === "value") {
    servers = Math.max(1, servers - 1);
  }

  return { servers, bartenders, setup_crew };
}

function baseSupplies(guestCount, setting) {
  const g = clamp(guestCount, 2, 500);
  const outdoor = norm(setting) === "outdoor";

  return {
    disposables: [
      { item: "Plates", quantity: Math.ceil(g * 1.2), unit: "pcs", note: "20% buffer" },
      { item: "Napkins", quantity: Math.ceil(g * 2), unit: "pcs", note: "Dinner + spills" },
      { item: "Cups", quantity: Math.ceil(g * 1.5), unit: "pcs", note: "Soft drinks + water" },
      { item: "Cutlery sets", quantity: Math.ceil(g * 1.1), unit: "sets", note: "10% buffer" },
      { item: "Trash bags", quantity: Math.max(6, Math.ceil(g / 6)), unit: "bags", note: "Separate wet/dry if possible" },
      { item: "Paper towels", quantity: Math.max(2, Math.ceil(g / 15)), unit: "rolls", note: "" },
    ],
    serving: [
      { item: "Serving tongs/spoons", quantity: Math.max(3, Math.ceil(g / 12)), unit: "pcs", note: "" },
      { item: "Ice", quantity: Math.ceil(g * (outdoor ? 0.6 : 0.4)), unit: "kg", note: "More if cocktails/beer" },
    ],
    equipment: [
      { item: "Extra chairs", quantity: Math.ceil(g * 0.15), unit: "pcs", note: "If seating is limited" },
      { item: "Coolers / ice buckets", quantity: Math.max(1, Math.ceil(g / 25)), unit: "pcs", note: "" },
    ],
    decor: [
      { item: "Candles / warm lighting", quantity: Math.max(6, Math.ceil(g / 6)), unit: "pcs", note: "Mood upgrade" },
      ...(outdoor ? [{ item: "Bug spray / citronella", quantity: Math.max(2, Math.ceil(g / 20)), unit: "pcs", note: "" }] : []),
    ],
  };
}

/**
 * ============
 * OPENAI CLIENT
 * ============
 */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  // Form fields from your index.html onboarding  [oai_citation:3‡index (7).html](sediment://file_00000000f90c71f5ae5514ad21b66b25)
  const scenarioKey = body.scenarioKey || "";
  const type = body.type || ""; // e.g. “Adult Birthday”
  const hostingMode = body.hostingMode || "home"; // "home" | "venue"
  const venueStyle = body.venueStyle || "";
  const tier = body.tier || "standard"; // "value" | "standard" | "premium"
  const guestCount = safeInt(body.guestCount, 20);
  const budgetCLP = safeInt(body.budget || body.budgetCLP, 2000000);
  const date = body.date || "";
  const setting = body.setting || "indoor"; // indoor | outdoor | mixed
  const vibe = body.vibe || ""; // from VIBE_OPTIONS
  const dietary = body.dietary || "";
  const notes = body.notes || "";

  // Event type mapping (keep your current default behavior but smarter)
  // Your Netlify function previously used eventType default "adult_birthday_home"  [oai_citation:4‡blueprint (2).js](sediment://file_00000000e9ac720e918341f5882255c7)
  let eventType = "adult_birthday_home";
  if (scenarioKey) {
    // Align scenario keys to tags you already have in catalog descriptions/tags (e.g., adult_birthday_home)
    if (scenarioKey.includes("adult")) eventType = "adult_birthday_home";
  }

  // Build scored buckets
  const buckets = bucketize(PARTY_ITEMS, eventType, vibe, setting, tier, dietary);

  // Compact catalog payload for model (top-N per bucket)
  const catalogPayload = {
    meta: { version: RAW_CATALOG.version, currency: RAW_CATALOG.currency, totalItems: PARTY_ITEMS.length },
    candidates: {
      starters: topCompact(buckets.fingerFoods, 25),
      mains: topCompact(buckets.mains, 18),
      desserts: topCompact(buckets.desserts, 18),
      drinks: topCompact(buckets.drinks, 22),
      other: topCompact(buckets.other, 12),
    },
  };

  // Request summary for “personal” grounding
  const requestSummary = {
    scenarioKey,
    type,
    eventType,
    hostingMode,
    venueStyle,
    tier,
    guestCount,
    budgetCLP,
    date,
    setting,
    vibe,
    dietary,
    notes,
  };

  // Output schema the UI expects (bp.summary, bp.staffing, bp.budget, bp.timeline, bp.supplies, tips, risks)
  const systemPrompt = `
You are Prendy, a senior event producer in Santiago, Chile.

Goal:
Return a SINGLE JSON object (no markdown) that is a complete event blueprint for the UI.

Hard constraints:
- You MUST ONLY use catalog items provided in "catalogPayload.candidates" when you refer to specific purchasable items.
- Every catalog-based item MUST include its exact "id".
- DO NOT invent vendors, products, or IDs.
- If something is missing from the catalog, include it as a generic supply line WITHOUT an id (id=null) and mark note="not in catalog".

You MUST return valid JSON with this shape:

{
  "summary": string,
  "menu": {
    "starters": [ { "id": string, "name": string, "vendorName": string, "unitPrice": number|null, "quantity": number, "unit": string, "why": string } ],
    "mains":    [ ... ],
    "desserts": [ ... ],
    "drinks":   [ ... ]
  },
  "budget": {
    "venue": {"amount": number, "pct": number},
    "food": {"amount": number, "pct": number},
    "drinks": {"amount": number, "pct": number},
    "entertainment": {"amount": number, "pct": number},
    "staff": {"amount": number, "pct": number},
    "misc": {"amount": number, "pct": number}
  },
  "staffing": { "servers": number, "bartenders": number, "setup_crew": number },
  "timeline": [ { "time": "HH:MM", "title": string, "detail": string } ],
  "supplies": {
    "food_prep": [ { "item": string, "quantity": number, "unit": string, "note": string } ],
    "drinks_service": [ ... ],
    "disposables": [ ... ],
    "serving": [ ... ],
    "equipment": [ ... ],
    "decor": [ ... ]
  },
  "tips": string[],
  "risks": string[]
}

Quality requirements:
- Make it feel personal: reference the user's "vibe", "setting", and any special notes (e.g., surprise cake at 18:00, reggaeton DJ) in timeline + tips.
- Be operational: quantities should be plausible for the guest count.
- Keep the menu balanced:
  - starters: 4–7 SKUs
  - mains: 2–4 SKUs
  - desserts: 2–4 SKUs
  - drinks: 4–8 SKUs
- Provide punchy, helpful "why" per item tied to vibe/dietary/setting.
`;

  const userPrompt = `
requestSummary:
${JSON.stringify(requestSummary, null, 2)}

catalogPayload:
${JSON.stringify(catalogPayload, null, 2)}

Return ONLY the JSON object.
`;

  // Allocate budget + staffing outside model (deterministic)
  const alloc = budgetAllocation(budgetCLP, hostingMode, tier);
  const staffing = staffingPlan(guestCount, hostingMode, tier);

  // Provide deterministic base supplies; model will augment/adjust
  const base = baseSupplies(guestCount, setting);

  // Call model — keep creativity but force JSON
  // NOTE: Your current model is gpt-4.1-mini  [oai_citation:5‡blueprint (2).js](sediment://file_00000000e9ac720e918341f5882255c7)
  // We bump tokens to allow richer, more detailed output.
  const MODEL = process.env.PRENDY_MODEL || "gpt-4.1-mini";

  let rawText = "";
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.85, // slightly more creative without going off rails (IDs still constrained)
      max_tokens: 2200,  // richer blueprint (timeline + menu + supplies) without exploding cost
      // If your SDK/model supports it, this strongly improves JSON reliability:
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    rawText = completion.choices?.[0]?.message?.content || "";
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

  // Parse JSON robustly (some models still wrap text)
  let modelBp = null;
  try {
    modelBp = JSON.parse(rawText);
  } catch {
    // try extracting first {...} block
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        modelBp = JSON.parse(rawText.slice(start, end + 1));
      } catch {
        modelBp = null;
      }
    }
  }

  // Hard fallback if parsing failed
  if (!modelBp) {
    modelBp = {
      summary: `Blueprint ready for ${guestCount} guests — ${type || "Gathering"} (${vibe || "your vibe"}).`,
      menu: { starters: [], mains: [], desserts: [], drinks: [] },
      budget: alloc,
      staffing,
      timeline: [
        { time: "17:00", title: "Setup", detail: "Chill setup: music, lighting, drinks station." },
        { time: "18:00", title: "Guests arrive", detail: "First round of drinks + starter bites." },
        { time: "20:00", title: "Main moment", detail: "Serve mains; keep drinks flowing." },
        { time: "22:30", title: "Dessert", detail: "Dessert + coffee; switch playlist energy." },
      ],
      supplies: { ...base, food_prep: [], drinks_service: [] },
      tips: ["Confirm deliveries the day before via WhatsApp.", "Buy ice late on the day so it lasts."],
      risks: ["Weather: if outdoor, have a backup plan for wind/cold."],
    };
  }

  // Enforce deterministic budget + staffing (prevents model mistakes)
  modelBp.budget = alloc;
  modelBp.staffing = staffing;

  // Ensure supplies object exists and merge base supplies so you always have depth
  modelBp.supplies = modelBp.supplies || {};
  for (const k of Object.keys(base)) {
    if (!Array.isArray(modelBp.supplies[k])) modelBp.supplies[k] = [];
    // merge: base first, then model adds extras
    modelBp.supplies[k] = [...base[k], ...modelBp.supplies[k]];
  }
  if (!Array.isArray(modelBp.supplies.food_prep)) modelBp.supplies.food_prep = [];
  if (!Array.isArray(modelBp.supplies.drinks_service)) modelBp.supplies.drinks_service = [];

  // Validate menu IDs exist in catalog candidates; drop invalid (prevents hallucinated IDs)
  const validIds = new Set(PARTY_ITEMS.map((x) => x.id));
  function cleanMenu(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === "object" && typeof x.id === "string" && validIds.has(x.id))
      .map((x) => ({
        id: x.id,
        name: x.name || "",
        vendorName: x.vendorName || "",
        unitPrice: (x.unitPrice === null || Number.isFinite(Number(x.unitPrice))) ? x.unitPrice : null,
        quantity: clamp(safeInt(x.quantity, 1), 1, 9999),
        unit: x.unit || "unit",
        why: x.why || "",
      }));
  }

  modelBp.menu = modelBp.menu || {};
  modelBp.menu.starters = cleanMenu(modelBp.menu.starters);
  modelBp.menu.mains = cleanMenu(modelBp.menu.mains);
  modelBp.menu.desserts = cleanMenu(modelBp.menu.desserts);
  modelBp.menu.drinks = cleanMenu(modelBp.menu.drinks);

  // If model under-filled, auto-top-up from scored buckets deterministically
  function fillTo(section, arr, bucket, targetMin, targetMax) {
    const out = [...arr];
    const used = new Set(out.map((x) => x.id));
    for (const it of bucket) {
      if (out.length >= targetMax) break;
      if (used.has(it.id)) continue;
      out.push({
        id: it.id,
        name: it.name,
        vendorName: it.vendorName || "",
        unitPrice: it.price ?? null,
        quantity: qtyForItem(it, guestCount, section),
        unit: "unit",
        why: `Fits ${vibe || "your vibe"} and works well for ${setting}.`,
      });
      used.add(it.id);
      if (out.length >= targetMin) break;
    }
    return out;
  }

  modelBp.menu.starters = fillTo("starters", modelBp.menu.starters, buckets.fingerFoods, 4, 7);
  modelBp.menu.mains = fillTo("mains", modelBp.menu.mains, buckets.mains, 2, 4);
  modelBp.menu.desserts = fillTo("desserts", modelBp.menu.desserts, buckets.desserts, 2, 4);
  modelBp.menu.drinks = fillTo("drinks", modelBp.menu.drinks, buckets.drinks, 4, 8);

  // Improve quantities deterministically (model can be vague)
  function refreshQty(section, arr) {
    return arr.map((x) => {
      const it = PARTY_ITEMS.find((p) => p.id === x.id);
      if (!it) return x;
      const q = qtyForItem(it, guestCount, section);
      return { ...x, unitPrice: it.price ?? x.unitPrice ?? null, quantity: q };
    });
  }
  modelBp.menu.starters = refreshQty("starters", modelBp.menu.starters);
  modelBp.menu.mains = refreshQty("mains", modelBp.menu.mains);
  modelBp.menu.desserts = refreshQty("desserts", modelBp.menu.desserts);
  modelBp.menu.drinks = refreshQty("drinks", modelBp.menu.drinks);

  // Summary (ensure it exists and feels “personal”)
  if (!modelBp.summary || typeof modelBp.summary !== "string") {
    modelBp.summary = `A ${tier} ${type || "event"} blueprint for ${guestCount} guests in ${setting} mode — tuned to "${vibe}".`;
  } else {
    // gently ensure it includes vibe/setting
    const s = modelBp.summary;
    if (!s.toLowerCase().includes(norm(vibe)) && vibe) modelBp.summary = `${s} (Vibe: ${vibe} · Setting: ${setting})`;
  }

  // Timeline: ensure structure
  if (!Array.isArray(modelBp.timeline)) modelBp.timeline = [];
  modelBp.timeline = modelBp.timeline
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      time: x.time || "18:00",
      title: x.title || "Moment",
      detail: x.detail || "",
    }))
    .slice(0, 12);

  if (modelBp.timeline.length < 5) {
    modelBp.timeline = [
      { time: "16:30", title: "Cold storage + staging", detail: "Make fridge space; label zones: drinks / starters / dessert." },
      { time: "17:30", title: "Set the vibe", detail: `Lighting + playlist aligned to ${vibe || "your vibe"}.` },
      { time: "18:00", title: "Arrival + first pour", detail: "Welcome drinks + first round of starters." },
      { time: "19:30", title: "Main flow", detail: "Bring mains out in waves so food stays hot." },
      { time: "21:30", title: "Dessert + coffee", detail: "Dessert moment; shift to mellow playlist or keep it high-energy." },
      { time: "23:30", title: "Late-night reset", detail: "Refresh ice; quick tidy; water station stays stocked." },
    ];
  }

  // Tips & risks: ensure arrays
  if (!Array.isArray(modelBp.tips)) modelBp.tips = [];
  if (!Array.isArray(modelBp.risks)) modelBp.risks = [];

  // Add a couple of high-signal operational tips
  modelBp.tips = [
    ...modelBp.tips,
    "Do a 10-minute ‘flow check’: guests should naturally move between drinks, food, and seating.",
    "Order for ~90% of RSVPs (Santiago no-shows are real) and keep extra snacks in reserve.",
  ].slice(0, 10);

  // Outdoor risk boost
  if (norm(setting) === "outdoor") {
    modelBp.risks = [
      ...modelBp.risks,
      "Weather swing: Santiago evenings can drop fast — plan heat/blankets or a covered backup.",
    ].slice(0, 10);
  } else {
    modelBp.risks = [...modelBp.risks, "Bottleneck risk: keep a second drinks station if space is tight."].slice(0, 10);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      blueprint: modelBp,
      catalogVersion: RAW_CATALOG.version,
      catalogItemCount: PARTY_ITEMS.length,
      model: MODEL,
    }),
  };
