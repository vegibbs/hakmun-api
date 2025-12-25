const express = require("express");
const OpenAI = require("openai");

const app = express();

// Parse JSON bodies
app.use(express.json());

// OpenAI client (server-side only)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check
app.get("/", (req, res) => res.send("hakmun-api up"));


// Sentence naturalness validation (stub)
// POST /v1/validate/sentence
app.post("/v1/validate/sentence", (req, res) => {
  const { sentenceID, text } = req.body || {};

  if (!sentenceID || !text) {
    return res.status(400).json({
      verdict: "NEEDS_REVIEW",
      reason: "missing sentenceID or text"
    });
  }

  // STUB: always return OK for now
  return res.json({
    verdict: "OK",
    reason: ""
  });
});


// Sentence generation (OpenAI, JSON mode)
// POST /v1/generate/sentences
app.post("/v1/generate/sentences", async (req, res) => {
  try {
    const { profileKey, tier, count } = req.body || {};

    if (!count || typeof count !== "number" || count < 1 || count > 30) {
      return res.status(400).json({
        error: "count must be a number between 1 and 30"
      });
    }

    const safeTier =
      tier === "intermediate" || tier === "advanced" ? tier : "beginner";

    const prompt = `
You generate Korean typing practice sentences for a language-learning app.

Return ONLY valid JSON. Do not include explanations or markdown.

The JSON MUST have this shape:

{
  "generatorVersion": "string",
  "sentences": [
    {
      "id": "string",
      "ko": "string",
      "literal": "string | null",
      "natural": "string | null",
      "naturalnessScore": number (0 to 1)
    }
  ]
}

Rules:
- Generate exactly ${count} unique sentences.
- Tier: ${safeTier}.
- Sentences must be natural, realistic Korean.
- Each sentence must be complete and properly punctuated.
- Avoid unsafe content.
- Use stable IDs like GEN_A1B2C3D4.
- naturalnessScore is your self-evaluation (higher = more natural).

Profile key (for logging only): ${profileKey || "unknown"}.
`.trim();

    const r = await openai.responses.create({
      model: "gpt-5.2",
      input: prompt,
      response_format: { type: "json" }
    });

    const text = r.output_text;
    const payload = JSON.parse(text);

    // Minimal validation before returning
    if (
      !payload ||
      typeof payload.generatorVersion !== "string" ||
      !Array.isArray(payload.sentences)
    ) {
      throw new Error("Invalid JSON structure from model");
    }

    for (const s of payload.sentences) {
      if (
        typeof s.id !== "string" ||
        typeof s.ko !== "string" ||
        typeof s.naturalnessScore !== "number"
      ) {
        throw new Error("Invalid sentence item in model output");
      }
    }

    return res.json(payload);
  } catch (err) {
    return res.status(500).json({
      error: String(err)
    });
  }
});


// IMPORTANT: listen on Railway-provided PORT (fallback for local runs)
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on ${port}`));