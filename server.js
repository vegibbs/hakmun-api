const express = require("express");
const app = express();

// Parse JSON bodies
app.use(express.json());

// Health check
app.get("/", (req, res) => res.send("hakmun-api up"));


// Sentence naturalness validation (stub)
// POST /v1/validate/sentence
// Body: { sentenceID: string, text: string, language: "ko" }
app.post("/v1/validate/sentence", (req, res) => {
  const { sentenceID, text, language } = req.body || {};

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


// Sentence generation (stub)
// POST /v1/generate/sentences
// Body: { profileKey: string, tier: string, count: number }
app.post("/v1/generate/sentences", (req, res) => {
  const { profileKey, tier, count } = req.body || {};

  // Basic input sanity check (non-blocking for stub)
  if (!count || typeof count !== "number") {
    return res.status(400).json({
      error: "missing or invalid count"
    });
  }

  // STUB sentences — static, deterministic
  const sentences = [
    {
      id: "GEN_0001",
      ko: "오늘은 날씨가 좋아서 산책을 하고 싶어요.",
      literal: "Today the weather is good so I want to take a walk.",
      natural: "The weather is nice today, so I want to go for a walk.",
      naturalnessScore: 0.95
    },
    {
      id: "GEN_0002",
      ko: "어제는 일이 많아서 집에 늦게 들어왔어요.",
      literal: "Yesterday there was a lot of work so I came home late.",
      natural: "I had a lot of work yesterday, so I got home late.",
      naturalnessScore: 0.94
    },
    {
      id: "GEN_0003",
      ko: "주말에는 친구를 만나서 커피를 마실 거예요.",
      literal: "On the weekend I will meet a friend and drink coffee.",
      natural: "I’m going to meet a friend and have coffee this weekend.",
      naturalnessScore: 0.96
    }
  ];

  // Return only up to `count`
  return res.json({
    sentences: sentences.slice(0, count),
    generatorVersion: "stub-v0"
  });
});


// IMPORTANT: listen on Railway-provided PORT
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on ${port}`));