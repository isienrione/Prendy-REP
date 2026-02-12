export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "OPENAI_API_KEY missing" }) };
  }

  try {
    const formData = JSON.parse(event.body || "{}");

    // Hard guard: don't allow missing guest count
    if (!formData.guestCount && !formData.guestCountNumber) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "guestCount is required" }) };
    }

    const prompt = `
You are "Prendy", an operations planner for social gatherings in Santiago, Chile.

Goal:
Create a high-quality, realistic event blueprint: timeline, staffing, budget, supplies.

CRITICAL RULES:
1) Output ONLY valid JSON. No markdown. No extra text.
2) Do NOT assume a single retailer. Use generic items and optionally include "preferred_store" field with realistic distribution.
3) Make quantities scale with guestCountNumber if provided, else estimate from guestCount range.
4) Use Chile-appropriate grocery terms (agua mineral, hielo, limon, queso, marraqueta, pollo, verduras, vino, cerveza, bebidas, etc.).
5) Ensure budget percentages sum to 100 and amounts roughly match the budget.

Inputs:
- type: ${formData.type}
- guestCount: ${formData.guestCount}
- guestCountNumber: ${formData.guestCountNumber || ""}
- budgetCLP: ${formData.budget}
- setting: ${formData.setting}
- vibe: ${formData.vibe}
- dietary: ${formData.dietary || "None"}
- notes: ${formData.notes || "None"}

Return this exact JSON schema:
{
  "summary": "string",
  "assumptions": {
    "guest_count": 0,
    "budget_clp": 0,
    "style_notes": "string"
  },
  "timeline": [{"time":"HH:MM","task":"string","owner":"string"}],
  "supplies": {
    "food": [{"item":"string","quantity":0,"unit":"string","note":"string","preferred_store":"string"}],
    "drinks": [{"item":"string","quantity":0,"unit":"string","note":"string","preferred_store":"string"}],
    "equipment": [{"item":"string","quantity":0,"unit":"string","note":"string","preferred_store":"string"}]
  },
  "budget": {
    "venue":{"amount":0,"pct":0},
    "food":{"amount":0,"pct":0},
    "drinks":{"amount":0,"pct":0},
    "entertainment":{"amount":0,"pct":0},
    "staff":{"amount":0,"pct":0},
    "misc":{"amount":0,"pct":0}
  },
  "staffing":{"servers":0,"bartenders":0,"setup_crew":0},
  "tips":["string","string","string"],
  "risks":["string","string"]
}
`;

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        max_output_tokens: 1600
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: resp.status, headers: cors, body: JSON.stringify({ error: "OpenAI error", details: data }) };
    }

    const text =
      (data.output_text || "").trim()
      || (data.output?.map(o => o.content?.map(c => c.text).join("")).join("") || "").trim();

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found in model output");

    const parsed = JSON.parse(text.slice(start, end + 1));
    return { statusCode: 200, headers: cors, body: JSON.stringify(parsed) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server error", message: String(err?.message || err) }) };
  }
}
