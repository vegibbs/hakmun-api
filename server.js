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
// Body: { sentenceID: string, text: string, language: "ko" }
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


// Sentence generation (OpenAI)
// POST /v1/generate/sentences
// Body: { profileKey: string, tier: "beginner"|"intermediate"|"advanced", count: number }
app.post("/v1/generate/sentences", async (req, res) => {
  try {
    const { profileKey, tier, count } = req.body || {};

    if (!count || typeof count !== "number" || count < 1 || count > 30) {
      return res.status(400).json({ error: "count must be a number between 1 and 30" });
    }

    const safeTier =
      tier === "intermediate" || tier === "advanced" ? tier : "beginner";

    const schema = {
      name: "HakMunGenerateSentencesResponse",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["sentences", "generatorVersion"],
        properties: {
          generatorVersion: { type: "string" },
          sentences: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "ko", "naturalnessScore"],
              properties: {
                id: { type: "string" },
                ko: { type: "string" },
                literal: { type: ["string", "null"] },
                natural: { type: ["string", "null"] },
                naturalnessScore: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          }
        }
      }
    };

    const prompt = [
      "You generate Korean typing practice sentences for a language-learning app.",
      "",
      "Return EXACT JSON matching the provided schema.",
      `Generate ${count} unique sentences.`,
      `Tier: ${safeTier}.`,
      "",
      "Constraints:",
      "- Sentences must be natural and realistic Korean.",
      "- Avoid profanity, hate, sexual content, or unsafe topics.",
      "- Each sentence must be a complete sentence with punctuation.",
      "- Provide naturalnessScore in [0,1] as your self-evaluation (higher = more natural).",
      "- Use stable unique IDs like GEN_A1B2C3D4 (8 chars after GEN_).",
      "",
      `Profile key (for logging only): ${profileKey || "unknown"}.`
    ].join("\n");

    const r = await openai.responses.create({
      model: "gpt-5.2",
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: schema.name,
          schema: schema.schema
        }
      }
    });

    const jsonText = r.output_text;
    const payload = JSON.parse(jsonText);

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