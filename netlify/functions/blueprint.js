export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured" }),
    };
  }

  try {
    const formData = JSON.parse(event.body || "{}");

    // Hard validation
    const required = ["type", "guestCount", "budget", "setting", "vibe"];
    const missing = required.filter((k) => !formData?.[k]);
    if (missing.length) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({
          error: "Missing required fields",
          missing,
          received: formData,
        }),
      };
    }

    const prompt = `
You are Prendy, a logistics AI for social gatherings in Santiago, Chile.
Generate a detailed event logistics blueprint.

Event:
- Type: ${formData.type}
- Guests: ${formData.guestCount}
- Budget: ${formData.budget} CLP
- Setting: ${formData.setting}
- Vibe: ${formData.vibe}
- Dietary: ${formData.dietary || "None"}
- Notes: ${formData.notes || "None"}

IMPORTANT OUTPUT RULES:
1) Respond ONLY with valid JSON. No markdown. No commentary.
2) Use 24-hour times in HH:MM.
3) Supplies item names should prefer CANONICAL NAMES when possible:
   - Food: "Empanadas", "Main protein", "Side salads", "Bread", "Cheese", "Dessert"
   - Drinks: "Wine", "Beer", "Soft drinks", "Juice", "Water", "Ice", "Pisco", "Lemons"
   - Equipment: "Napkin", "Plates", "Glass sets", "Tables", "Chairs"
4) Quantities must be numbers (not ranges).

Return schema EXACTLY:
{
 "summary":"one sentence",
 "timeline":[{"time":"HH:MM","task":"desc","owner":"who"}],
 "supplies":{
   "food":[{"item":"name","quantity":0,"unit":"u","note":"tip"}],
   "drinks":[{"item":"name","quantity":0,"unit":"u","note":"tip"}],
   "equipment":[{"item":"name","quantity":0,"unit":"u","note":"tip"}]
 },
 "budget":{
   "venue":{"amount":0,"pct":0},
   "food":{"amount":0,"pct":0},
   "drinks":{"amount":0,"pct":0},
   "entertainment":{"amount":0,"pct":0},
   "staff":{"amount":0,"pct":0},
   "misc":{"amount":0,"pct":0}
 },
 "staffing":{"servers":0,"bartenders":0,"setup_crew":0},
 "tips":["tip1","tip2","tip3"],
 "risks":["risk1","risk2"]
}
`.trim();

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        // Pick a model you have access to; these are common:
        model: "gpt-4o-mini",
        input: prompt,
        // Encourage JSON-only
        text: { format: { type: "json_object" } },
        max_output_tokens: 1200,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: cors,
        body: JSON.stringify({ error: "OpenAI error", details: data }),
      };
    }

    // Responses API output extraction
    const outText =
      (data.output || [])
        .flatMap((o) => o.content || [])
        .map((c) => c.text || "")
        .join("")
        .trim() || "";

    // Parse JSON defensively
    const start = outText.indexOf("{");
    const end = outText.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found in model output");

    const parsed = JSON.parse(outText.slice(start, end + 1));

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: "Server error",
        message: String(err?.message || err),
      }),
    };
  }
}
