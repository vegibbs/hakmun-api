// FILE: hakmun-api/util/openai.js
// PURPOSE: Centralized server-side OpenAI service for HakMun
// SCOPE:
// - Synchronous text analysis for document highlight import
// - Future reuse by writing module and other extraction features
//
// RESPONSIBILITIES:
// - Own OpenAI API access (server-side only)
// - Enforce JSON-only structured output
// - Apply timeouts and basic retry
// - Expose a single stable interface to callers

const fetch = global.fetch || require("node-fetch");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("Missing env var: OPENAI_API_KEY");
}

// Model is centralized here so it can be changed in one place later.
const OPENAI_MODEL = "gpt-4.1-mini";

// Hard limits to protect the server
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    promise(controller.signal).finally(() => clearTimeout(id)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("openai_timeout")), ms))
  ]);
}

function buildDocImportPrompt({ text, importAs, glossLang }) {
  const lang = (glossLang || "en").trim() || "en";

  return `You are a Korean teaching assistant. You are analyzing highlighted classroom notes.

Goal:
- Extract three groups: vocabulary, sentences, grammar patterns.
- This text may include inline English, arrows, stars, placeholders like OOO, and non-sentence fragments.

CRITICAL OUTPUT RULES:
- Return ONLY valid JSON. No markdown. No comments. No explanations outside JSON.
- Be conservative: omit uncertain items. Missing is acceptable; junk is forbidden.

VOCABULARY RULES:
- Return dictionary-form headwords suitable for linking to a global dictionary.
- If you see a conjugated/adnominal form, return lemma_ko as the base form.
  Example: "좋은" -> lemma_ko "좋다" and surface_ko "좋은".
- Strip inline English glue words (e.g., "so") from Korean lemma derivation.
- pos_ko must be one of: 명사|동사|형용사|부사|기타

SENTENCE RULES:
- Return only well-formed natural Korean sentences.
- Remove inline English glue words if they are not part of Korean.

PATTERN RULES (surface-form only):
- Do NOT invent grammar labels or explanations.
- Output patterns as matchable surface forms found in the text.
- For endings, return the attachable ending pattern (not the full conjugated word).
  Example: "먹었어요" -> "-았/었어요".
- For pragmatic endings/contractions, output exactly as written: 죠, 잖아요, 거든요, 군요, 더라고요, etc.
- Strip punctuation from surface_form (keep punctuation in context_span only).

Input text:
"""
${text}
"""

Extraction mode: ${importAs}
Gloss language for translations/explanations: ${lang}

Return JSON using this schema exactly:
{
  "gloss_lang": "${lang}",
  "vocabulary": [
    { "lemma_ko": "...", "pos_ko": "명사|동사|형용사|부사|기타", "surface_ko": null, "gloss": null }
  ],
  "sentences": [
    { "ko": "...", "gloss": null }
  ],
  "patterns": [
    { "surface_form": "...", "context_span": "...", "confidence": 0.0, "kind": "ENDING|CONNECTOR|PARTICLE|DISCOURSE|AUX|OTHER" }
  ]
}

For any section with no valid items, return an empty array.
If importAs excludes a section, still return the key with an empty array.`;
}

function buildLegacyPrompt({ text, importAs }) {
  return `You are a language-teaching assistant for Korean learners.

Your task is to analyze the provided text and extract clean, high-confidence learning items.

Rules:
- Return ONLY valid JSON.
- Do NOT include explanations outside JSON.
- Discard junk, fragments, UI text, and non-language artifacts.
- Normalize spacing and punctuation.

Input text:
"""
${text}
"""

Extraction mode: ${importAs}

Output JSON schema:
{
  "sentences": [
    { "ko": "...", "en": "..." }
  ],
  "vocab": [
    { "lemma": "...", "pos": "명사|동사|형용사|부사|기타", "gloss": "..." }
  ],
  "patterns": [
    { "pattern": "...", "explanation": "..." }
  ]
}

Include only sections relevant to the extraction mode.
If no valid items exist for a section, return an empty array for that section.`;
}

function buildPrompt({ text, importAs, profile, glossLang }) {
  const p = (profile || "legacy").trim() || "legacy";
  if (p === "doc_import") {
    return buildDocImportPrompt({ text, importAs, glossLang });
  }
  return buildLegacyPrompt({ text, importAs });
}

async function callOpenAIOnce(prompt) {
  const url = "https://api.openai.com/v1/chat/completions";

  return withTimeout(async (signal) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You output strict JSON only." },
          { role: "user", content: prompt }
        ]
      }),
      signal
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = JSON.stringify(json).slice(0, 500);
      throw new Error(`openai_http_${resp.status}:${msg}`);
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("openai_no_content");
    }

    return content;
  }, REQUEST_TIMEOUT_MS);
}

function parseAndValidate(jsonText, profile) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("openai_invalid_json");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("openai_invalid_shape");
  }

  const p = (profile || "legacy").trim() || "legacy";

  if (p === "doc_import") {
    // Ensure required arrays exist
    if (!Array.isArray(parsed.vocabulary)) parsed.vocabulary = [];
    if (!Array.isArray(parsed.sentences)) parsed.sentences = [];
    if (!Array.isArray(parsed.patterns)) parsed.patterns = [];

    if (typeof parsed.gloss_lang !== "string") parsed.gloss_lang = null;

    // Light normalization of row shapes (do not over-validate; UI will allow edits)
    parsed.vocabulary = parsed.vocabulary
      .filter(x => x && typeof x === "object")
      .map(x => ({
        lemma_ko: typeof x.lemma_ko === "string" ? x.lemma_ko.trim() : "",
        pos_ko: typeof x.pos_ko === "string" ? x.pos_ko.trim() : "기타",
        surface_ko: (x.surface_ko === null || x.surface_ko === undefined) ? null : String(x.surface_ko).trim(),
        gloss: (x.gloss === null || x.gloss === undefined) ? null : String(x.gloss).trim()
      }))
      .filter(x => x.lemma_ko);

    parsed.sentences = parsed.sentences
      .filter(x => x && typeof x === "object")
      .map(x => ({
        ko: typeof x.ko === "string" ? x.ko.trim() : "",
        gloss: (x.gloss === null || x.gloss === undefined) ? null : String(x.gloss).trim()
      }))
      .filter(x => x.ko);

    parsed.patterns = parsed.patterns
      .filter(x => x && typeof x === "object")
      .map(x => ({
        surface_form: typeof x.surface_form === "string" ? x.surface_form.trim() : "",
        context_span: typeof x.context_span === "string" ? x.context_span.trim() : "",
        confidence: (typeof x.confidence === "number" && Number.isFinite(x.confidence)) ? x.confidence : null,
        kind: (x.kind === null || x.kind === undefined) ? null : String(x.kind).trim()
      }))
      .filter(x => x.surface_form);

    return parsed;
  }

  // legacy shape
  for (const key of ["sentences", "vocab", "patterns"]) {
    if (!Array.isArray(parsed[key])) {
      parsed[key] = [];
    }
  }

  return parsed;
}

async function analyzeTextForImport(arg1, arg2 = "all", arg3 = null) {
  // Backward compatible forms:
  // - analyzeTextForImport(text, importAs)
  // New form:
  // - analyzeTextForImport({ text, importAs, profile, glossLang })
  let text;
  let importAs;
  let profile;
  let glossLang;

  if (arg1 && typeof arg1 === "object" && typeof arg1.text === "string") {
    text = arg1.text;
    importAs = (arg1.importAs || "all");
    profile = (arg1.profile || "legacy");
    glossLang = (arg1.glossLang || null);
  } else {
    text = arg1;
    importAs = arg2 || "all";
    profile = (arg3 && typeof arg3 === "object" && arg3.profile) ? arg3.profile : "legacy";
    glossLang = (arg3 && typeof arg3 === "object" && arg3.glossLang) ? arg3.glossLang : null;
  }

  if (typeof text !== "string" || !text.trim()) {
    if ((profile || "legacy").trim() === "doc_import") {
      return { gloss_lang: glossLang || null, vocabulary: [], sentences: [], patterns: [] };
    }
    return { sentences: [], vocab: [], patterns: [] };
  }

  const prompt = buildPrompt({ text: text.trim(), importAs, profile, glossLang });

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callOpenAIOnce(prompt);
      return parseAndValidate(raw, profile);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(500);
        continue;
      }
    }
  }

  throw lastError || new Error("openai_failed");
}

module.exports = {
  analyzeTextForImport
};