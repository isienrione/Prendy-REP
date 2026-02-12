exports.handler = async (event) => {
export async function handler(event) {
const cors = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "content-type",
@@ -17,12 +17,12 @@ exports.handler = async (event) => {
};
}

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
return {
statusCode: 500,
headers: cors,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured" }),
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured" }),
};
}

@@ -33,20 +33,41 @@ exports.handler = async (event) => {

Event: ${formData.type}, ${formData.guestCount} guests, ${formData.budget} CLP budget, Setting: ${formData.setting}, Vibe: ${formData.vibe}, Dietary: ${formData.dietary || "None"}, Notes: ${formData.notes || "None"}

Respond ONLY with JSON (no markdown):
{"summary":"one sentence","timeline":[{"time":"HH:MM","task":"desc","owner":"who"}],"supplies":{"food":[{"item":"name","quantity":0,"unit":"u","note":"tip"}],"drinks":[{"item":"name","quantity":0,"unit":"u","note":"tip"}],"equipment":[{"item":"name","quantity":0,"unit":"u","note":"tip"}]},"budget":{"venue":{"amount":0,"pct":0},"food":{"amount":0,"pct":0},"drinks":{"amount":0,"pct":0},"entertainment":{"amount":0,"pct":0},"staff":{"amount":0,"pct":0},"misc":{"amount":0,"pct":0}},"staffing":{"servers":0,"bartenders":0,"setup_crew":0},"tips":["tip1","tip2","tip3"],"risks":["risk1","risk2"]}`;
Respond ONLY with valid JSON (no markdown, no commentary) exactly matching this schema:
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
}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${apiKey}`,
},
body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: "You output ONLY valid JSON. No markdown." },
          { role: "user", content: prompt },
        ],
}),
});

@@ -56,26 +77,35 @@ Respond ONLY with JSON (no markdown):
return {
statusCode: resp.status,
headers: cors,
        body: JSON.stringify({ error: "Anthropic error", details: data }),
        body: JSON.stringify({ error: "OpenAI error", details: data }),
};
}

    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";

    // Hardening: strip accidental code fences
const cleaned = text.replace(/```json|```/g, "").trim();

    // Extract JSON object if there is extra text
const start = cleaned.indexOf("{");
const end = cleaned.lastIndexOf("}");

if (start === -1 || end === -1) throw new Error("No JSON found in model output");

const parsed = JSON.parse(cleaned.slice(start, end + 1));

    return { statusCode: 200, headers: cors, body: JSON.stringify(parsed) };
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(parsed),
    };
} catch (err) {
return {
statusCode: 500,
headers: cors,
      body: JSON.stringify({ error: "Server error", message: String(err?.message || err) }),
      body: JSON.stringify({
        error: "Server error",
        message: String(err?.message || err),
      }),
};
}
};

}
