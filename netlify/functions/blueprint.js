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

    const prompt = `You are Prendy, a logistics AI for social gatherings in Santiago, Chile. Generate a detailed event logistics blueprint.

Event: ${formData.type}, ${formData.guestCount} guests, ${formData.budget} CLP budget, Setting: ${formData.setting}, Vibe: ${formData.vibe}, Dietary: ${formData.dietary || "None"}, Notes: ${formData.notes || "None"}

Respond ONLY with valid JSON (no markdown, no commentary) exactly matching this schema:
{
  "summary":"one sentence",
  "timeline":[{"time":"HH:MM","task":"desc","owner":"who"}],
  "supplies":{
   "food":[{"item":"name","quantity":0,"unit":"u","note":"tip","preferred_store":"lider","suggestedStores":["lider","jumbo"]}],
"drinks":[{"item":"name","quantity":0,"unit":"u","note":"tip","preferred_store":"rappi","suggestedStores":["rappi","lider"]}],
"equipment":[{"item":"name","quantity":0,"unit":"u","note":"tip","preferred_store":"mercadolibre","suggestedStores":["mercadolibre","lider"]}]

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
}`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: "You output ONLY valid JSON. No markdown." },
          { role: "user", content: prompt },
        ],
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

    const text = data?.choices?.[0]?.message?.content?.trim() || "";

    // Hardening: strip accidental code fences
    const cleaned = text.replace(/```json|```/g, "").trim();

    // Extract JSON object if there is extra text
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found in model output");

    const parsed = JSON.parse(cleaned.slice(start, end + 1));

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
