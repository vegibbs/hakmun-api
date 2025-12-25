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

// IMPORTANT: listen on Railway-provided PORT
const port = process.env.PORT;
app.listen(port, () => console.log(`listening on ${port}`));
