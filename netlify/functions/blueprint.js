// netlify/functions/blueprint.js
export default async (req) => {
  // --- CORS ---
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ---- Validate guest count ----
    const guestCount = Number(body.guestCount);
    if (!Number.isFinite(guestCount) || guestCount < 1 || guestCount > 200) {
      return new Response(
        JSON.stringify({
          error: "Missing or invalid guestCount",
          hint: "Send guestCount as a number between 1 and 200.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const event = {
      city: body.city ?? "Santiago, Chile",
      vibe: body.vibe ?? "",
      budgetCLP: body.budgetCLP ?? null,
      dietary: body.dietary ?? [],
      occasion: body.occasion ?? "",
      guestCount,
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- JSON Schema the model MUST follow ----
    const schema = {
      name: "blueprint_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "timeline", "supplies"],
        properties: {
          summary: { type: "string" },
          timeline: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["time", "task", "owner"],
              properties: {
                time: { type: "string" },
                task: { type: "string" },
                owner: { type: "string" },
              },
            },
          },
          supplies: {
            type: "object",
            additionalProperties: false,
            required: ["food", "drinks", "equipment"],
            properties: {
              food: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["item", "quantity", "unit"],
                  properties: {
                    item: { type: "string" },
                    quantity: { type: "number" },
                    unit: { type: "string" },
                    note: { type: "string" },
                    // Optional: model may include a preferred store but MUST ALSO include suggestedStores
                    preferred_store: { type: "string" },
                    suggestedStores: {
                      type: "array",
                      items: { type: "string" },
                    },
                    category: { type: "string" },
                  },
                },
              },
              drinks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["item", "quantity", "unit"],
                  properties: {
                    item: { type: "string" },
                    quantity: { type: "number" },
                    unit: { type: "string" },
                    note: { type: "string" },
                    preferred_store: { type: "string" },
                    suggestedStores: { type: "array", items: { type: "string" } },
                    category: { type: "string" },
                  },
                },
              },
              equipment: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["item", "quantity", "unit"],
                  properties: {
                    item: { type: "string" },
                    quantity: { type: "number" },
                    unit: { type: "string" },
                    note: { type: "string" },
                    preferred_store: { type: "string" },
                    suggestedStores: { type: "array", items: { type: "string" } },
                    category: { type: "string" },
                  },
                },
              },
            },
          },
          tips: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          staffing: {
            type: "object",
            additionalProperties: true,
          },
          budget: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      strict: true,
    };

    // ---- Prompt: explicitly forbid single-store defaults ----
    const system = `You generate event blueprints and shopping lists for Chile.
IMPORTANT RULES:
- Never assume all items come from a single store.
- For EACH supply item, include suggestedStores: an array of 2–4 stores chosen from:
  ["lider","jumbo","santaisabel","unimarc","tottus","mercadolibre","rappi"].
- If you include preferred_store, it must be one of those and must ALSO include suggestedStores.
- Quantities must scale with guestCount (healthy portions).
Return ONLY valid JSON matching the provided schema.`;

    const user = `Event details:
${JSON.stringify(event, null, 2)}

Create:
- summary
- timeline
- supplies (food/drinks/equipment) with suggestedStores per item
- optional tips/risks/budget/staffing`;

    // ---- Call OpenAI (Responses API if available; fallback style via chat/completions) ----
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: schema },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: "OpenAI error", details: data }),
        {
          status: resp.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Responses API returns structured text in output; extract JSON safely
    const jsonText =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ??
      null;

    if (!jsonText) {
      return new Response(
        JSON.stringify({ error: "No JSON returned", details: data }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const blueprint = JSON.parse(jsonText);

    // Final safety: ensure every supply item has suggestedStores (never empty)
    const ensureStores = (arr) =>
      (arr ?? []).map((x) => ({
        ...x,
        suggestedStores:
          Array.isArray(x.suggestedStores) && x.suggestedStores.length
            ? x.suggestedStores
            : ["jumbo", "lider"],
      }));

    blueprint.supplies.food = ensureStores(blueprint.supplies.food);
    blueprint.supplies.drinks = ensureStores(blueprint.supplies.drinks);
    blueprint.supplies.equipment = ensureStores(blueprint.supplies.equipment);

    return new Response(JSON.stringify(blueprint), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Server error", details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
};
