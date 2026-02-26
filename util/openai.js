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
const OPENAI_MODEL = "gpt-4.1";

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

function ensureEndingPunctuation(s) {
  if (!s) return s;
  const last = s[s.length - 1];
  if (last === "." || last === "?" || last === "!" || last === "。" || last === "？" || last === "！") {
    return s;
  }
  return s + ".";
}

function buildDocImportPrompt({ text, importAs, glossLang, canonicalPatterns }) {
  const lang = (glossLang || "en").trim() || "en";

  // Build canonical pattern reference block if available
  let patternRefBlock = "";
  if (Array.isArray(canonicalPatterns) && canonicalPatterns.length > 0) {
    const lines = canonicalPatterns.map(p => {
      const aliases = (p.aliases || []).filter(a => a).join(", ");
      return aliases ? `${p.display_name} [${aliases}]` : p.display_name;
    });
    patternRefBlock = `
CANONICAL PATTERN REFERENCE:
The following is the complete list of known grammar patterns in our database.
When you identify a grammar pattern, you MUST match it to one of these canonical forms.
Use the display_name or any alias shown in brackets as the surface_form value.
If no exact or close match exists, return the surface form as-is and add "unmatched": true to that pattern object.

${lines.join("\n")}
`;
  }

  return `You are a Korean teaching assistant. You are analyzing notes from a Korean tutoring or teaching session.

Context:
- These notes were written by a Korean teacher during a lesson with a student.
- The student needs clean, natural Korean sentences to practice from these session notes.
- The text is messy: it contains inline English glosses, pronunciation guides, shorthand,
  arrows, stars, placeholders, and partial phrases mixed with real sentences.
- Your job is to extract maximum learning value from these notes.

Goal:
- Extract four groups: vocabulary, sentences, grammar patterns, and fragments.

CRITICAL OUTPUT RULES:
- Return ONLY valid JSON. No markdown. No comments. No explanations outside JSON.
- Be conservative with vocabulary and patterns.
- Be AGGRESSIVE with sentences: extract every line that contains or implies a usable Korean sentence.
  If a line is messy but you can infer the teacher's intended sentence, write the clean natural
  Korean sentence. You understand Korean well enough to reconstruct intent from teacher shorthand.
  It is better to produce a slightly adapted but natural sentence than to lose classroom content.

VOCABULARY RULES:
- Return dictionary-form headwords suitable for linking to a global dictionary.
- If you see a conjugated/adnominal form, return lemma_ko as the base form.
  Example: "좋은" -> lemma_ko "좋다" and surface_ko "좋은".
- Strip inline English glue words (e.g., "so") from Korean lemma derivation.
- pos_ko must be one of: 명사|동사|형용사|부사|기타

SENTENCE RULES:
- Extract every usable Korean sentence from the teacher's notes.
- If a line is not a perfect sentence but clearly implies one, reconstruct the natural Korean
  sentence the teacher intended. Keep the same context, grammar, and vocabulary — just make it
  a complete, natural sentence a student can practice.
  Example: "회이랑 점심도 먹고 예기도 하고 놀았어요" → "회의랑 점심도 먹고 얘기도 하고 놀았어요."
  Example: "항상 일찍, 화요일하고 목요일에 수업을 항상 해요" → "화요일하고 목요일에 항상 수업을 해요."
- MANDATORY: Every Korean sentence MUST end with punctuation (. or ? or !). No exceptions.
  If the source text lacks punctuation, add a period. Check each sentence before returning.
- Parenthetical annotations like (말), (딸한테), (몬) are common in teaching notes.
  Include the sentence WITH the parenthetical — do not skip it.
  Example: "딸한테 밥을 사 오라고 (말)했어요." is a valid sentence — extract it as-is.
  Example: "한번도 못(몬) 만났어요." is a valid sentence — extract it as-is.
- Inline English words (e.g., "자주often", "pass by") are teacher glosses.
  Strip the English and keep the Korean: "형이랑 자주 만나요?" not "형이랑 자주often 만나요?".
- Alternate forms with slashes (e.g., "해요./해씀요.") — pick the standard form for the sentence.
- Always provide a gloss (translation) in ${lang} for each sentence.
- REJECT pattern templates and scaffolds: if a line contains a dash-placeholder for a grammar slot
  (e.g., "어떻게 -는지 모르겠어요", "V-고 싶다"), it is a pattern example, NOT a sentence.
  Do not put these in sentences. They belong in patterns (if atomic) or fragments (if scaffolds).
- When in doubt, INCLUDE the sentence. It is better to capture a slightly rough sentence than
  to lose real classroom content. The user can always delete it later.
- PER-SENTENCE VOCABULARY: For each sentence, include a "vocabulary" array listing the content
  words that appear in that sentence. Use the same format as the top-level vocabulary
  (lemma_ko, pos_ko, surface_ko, gloss). This links vocabulary directly to the sentence so
  students get vocabulary exposure when they practice it.
  Exclude common function words/particles (이/가, 을/를, 에, 은/는, 의, 도, 와/과, 에서, 으로, etc.).
  Include nouns, verbs, adjectives, and adverbs that carry meaning.

PATTERN RULES (atomic surface-form only):
- Do NOT invent grammar labels or explanations.
- Output patterns as matchable surface forms found in the text.
- For endings, return the attachable ending pattern (not the full conjugated word).
  Example: "먹었어요" -> "-았/었어요".
- For pragmatic endings/contractions, output exactly as written: 죠, 잖아요, 거든요, 군요, 더라고요, etc.
- Strip punctuation from surface_form (keep punctuation in context_span only).
- If a pattern does not match any known canonical form, set "unmatched": true on that pattern.
- DECOMPOSITION (critical): Each pattern entry MUST be a single atomic grammar point.
  Decompose compound endings into their individual component patterns.
  Never return a compound ending as a single surface form.
  Example: "밝아질 거예요" contains TWO patterns — return them separately:
    1. surface_form: "-아/어지다" (passive/become), context_span: "밝아질 거예요"
    2. surface_form: "-(으)ㄹ 거예요" (future tense), context_span: "밝아질 거예요"
  Both entries share the same context_span (the sentence where they appear).
  If a surface form is a stack of multiple grammar points, split it into one entry per atomic pattern.
${patternRefBlock}
FRAGMENT RULES:
- Fragments capture teaching material that is NOT a complete sentence or a pluggable grammar pattern.
- Examples: grammar breakdowns, conjugation tables, example scaffolds, teacher annotations,
  partial phrases with arrows/markers, grouped quotation endings, drill sequences.
- Keep related lines together as a single fragment blob (do not split line-by-line).
  Example: four indirect quotation endings listed together should be ONE fragment, not four.
- Assign a short descriptive label to each fragment (e.g., "간접 인용 endings", "ㅂ 불규칙 conjugation chart").
- Do NOT duplicate material already captured as a sentence or pattern.
- Fragments preserve the original formatting (newlines, bullets, arrows) from the source text.
- If nothing qualifies as a fragment, return an empty array.
- IMPORTANT: Before finalizing a fragment, scan each line within it. If any line is a complete
  natural Korean sentence (subject+predicate, ends with a verb/adjective ending), extract that
  line as a sentence instead. Do not bury sentences inside fragment blobs.
  Example: a vocab list followed by "한번도 못(몬) 만났어요." — the vocab list is a fragment,
  but that last line is a sentence and must go into the sentences array.

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
    { "lemma_ko": "...", "pos_ko": "명사|동사|형용사|부사|기타", "surface_ko": "conjugated form or null", "gloss": "${lang} meaning" }
  ],
  "sentences": [
    { "ko": "Korean sentence with punctuation.", "gloss": "${lang} translation", "vocabulary": [{ "lemma_ko": "...", "pos_ko": "명사|동사|형용사|부사|기타", "surface_ko": "conjugated form or null", "gloss": "${lang} meaning" }] }
  ],
  "patterns": [
    { "surface_form": "...", "context_span": "...", "confidence": 0.0, "kind": "ENDING|CONNECTOR|PARTICLE|DISCOURSE|AUX|OTHER", "unmatched": false }
  ],
  "fragments": [
    { "text": "original text blob preserving newlines", "label": "short descriptive label" }
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

function buildPrompt({ text, importAs, profile, glossLang, canonicalPatterns }) {
  const p = (profile || "legacy").trim() || "legacy";
  if (p === "doc_import") {
    return buildDocImportPrompt({ text, importAs, glossLang, canonicalPatterns });
  }
  return buildLegacyPrompt({ text, importAs });
}

async function callOpenAIOnce(prompt, timeoutMs) {
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
  }, timeoutMs || REQUEST_TIMEOUT_MS);
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
        ko: ensureEndingPunctuation(typeof x.ko === "string" ? x.ko.trim() : ""),
        gloss: (x.gloss === null || x.gloss === undefined) ? null : String(x.gloss).trim()
      }))
      .filter(x => x.ko);

    parsed.patterns = parsed.patterns
      .filter(x => x && typeof x === "object")
      .map(x => ({
        surface_form: typeof x.surface_form === "string" ? x.surface_form.trim() : "",
        context_span: typeof x.context_span === "string" ? x.context_span.trim() : "",
        confidence: (typeof x.confidence === "number" && Number.isFinite(x.confidence)) ? x.confidence : null,
        kind: (x.kind === null || x.kind === undefined) ? null : String(x.kind).trim(),
        unmatched: x.unmatched === true
      }))
      .filter(x => x.surface_form);

    if (!Array.isArray(parsed.fragments)) parsed.fragments = [];
    parsed.fragments = parsed.fragments
      .filter(x => x && typeof x === "object")
      .map(x => ({
        text: typeof x.text === "string" ? x.text.trim() : "",
        label: (x.label === null || x.label === undefined) ? null : String(x.label).trim() || null
      }))
      .filter(x => x.text);

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

  let canonicalPatterns;

  if (arg1 && typeof arg1 === "object" && typeof arg1.text === "string") {
    text = arg1.text;
    importAs = (arg1.importAs || "all");
    profile = (arg1.profile || "legacy");
    glossLang = (arg1.glossLang || null);
    canonicalPatterns = arg1.canonicalPatterns || null;
  } else {
    text = arg1;
    importAs = arg2 || "all";
    profile = (arg3 && typeof arg3 === "object" && arg3.profile) ? arg3.profile : "legacy";
    glossLang = (arg3 && typeof arg3 === "object" && arg3.glossLang) ? arg3.glossLang : null;
  }

  if (typeof text !== "string" || !text.trim()) {
    if ((profile || "legacy").trim() === "doc_import") {
      return { gloss_lang: glossLang || null, vocabulary: [], sentences: [], patterns: [], fragments: [] };
    }
    return { sentences: [], vocab: [], patterns: [] };
  }

  const prompt = buildPrompt({ text: text.trim(), importAs, profile, glossLang, canonicalPatterns });

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

// ---------------------------------------------------------------------------
// Practice sentence generation & validation
// ---------------------------------------------------------------------------

function buildPracticeGenerationPrompt({ text, cefrLevel, glossLang, count, perspective, politeness }) {
  const lang = (glossLang || "en").trim() || "en";
  const cefr = (cefrLevel || "A1").trim();
  const n = count || 5;
  const pov = perspective || "first_person";
  const pol = politeness || "해요체";

  return `You are a Korean language teaching assistant creating practice sentences for a student.

CONTEXT:
The student's teacher wrote the following notes during a recent Korean lesson.
The student's current CEFR level is ${cefr}.
Your job is to generate practice sentences that reinforce the vocabulary, grammar patterns,
and topics found in these lesson notes — exactly the way the teacher intended them to be practiced.

TEACHER'S LESSON NOTES:
"""
${text}
"""

UNDERSTANDING THE NOTES:
- In Korean teaching materials, parentheses () mark OPTIONAL elements that can be dropped in
  natural speech. For example, "(말)했어요" means "말" is optional — both "말했어요" and "했어요"
  are valid. Generate sentences using both forms across your output.
- Parentheses are also sometimes used as pronunciation guides for the student.
  For example, "좋아요(조아요)" — the part in parentheses is how to pronounce it.
  Do NOT include pronunciation guides in your generated sentences.
- If the notes contain multiple grammar types, categories, or conjugation patterns,
  identify each type and generate ${n} sentences PER TYPE. Label each sentence with its type.
- Read the teacher's examples carefully. Match the sentence patterns, politeness level, and
  teaching style the teacher demonstrated.

GENERATION RULES:
1. Each sentence MUST be a complete, natural Korean sentence a native speaker would actually say.
2. Target ${cefr} CEFR level — use vocabulary and grammar appropriate for this level.
   - A1-A2: Simple present/past, 요-form (해요체), basic connectors (-고, -어서), everyday topics.
   - B1-B2: Compound sentences, indirect speech, conditional (-면), causative, varied tenses.
   - C1-C2: Nuanced connectors (-는 바람에, -더니), formal/informal register mixing, idiomatic expressions.
3. Draw vocabulary and grammar directly from the lesson notes. Each sentence should practice
   at least one word or pattern that appears in the notes.
4. Vary sentence structures — do not repeat the same pattern across sentences within a type.
5. Mix tenses: past (-았/었어요), present (-아/어요), future (-(으)ㄹ 거예요), and progressive (-고 있어요)
   unless the type specifically targets a single tense.
6. ${pol === "합니다체" ? "Use formal 합니다체 for all sentences." : pol === "반말" ? "Use 반말 (informal) for all sentences. Do not add 요 endings." : "Use 요-form (해요체) for all sentences."}
7. ${pov === "third_person" ? "Write all sentences about other people (third person). Use natural subjects like 친구, 동생, 선생님, 그 사람, etc. Vary the subjects across sentences." : "Write all sentences from the speaker's own perspective (first person). Use natural Korean — do NOT start sentences with 저는 or 나는 unless the speaker's identity would be genuinely ambiguous without it. In Korean, the subject is normally dropped when it's the speaker. A native speaker says \"오늘 바빠요\" not \"저는 오늘 바빠요\". Only include 저/나 when contrasting with someone else or when omitting it would cause confusion about who is speaking."}
8. Each sentence should be 8-25 syllables long (natural conversation length).
9. Do NOT include English words mixed into Korean.
10. Every sentence MUST end with punctuation (. ? !).
11. Generate exactly ${n} sentences per type — no more, no less.

FOR EACH SENTENCE, ALSO PROVIDE:
- group_label: the type/category this sentence belongs to (from the teacher's notes).
  If the notes have only one topic, use a descriptive label like "vocabulary practice" or the
  grammar point name. If there are multiple types (e.g., -다고, -냐고, -자고, -라고), use
  those as group labels.
- en: ${lang} translation
- cefr_level: your estimate of the actual CEFR level (e.g., "A2", "B1")
- topic: pick ONE from: daily_life, food, weather, travel, work, school, shopping, health,
  hobbies, relationships, directions, time, emotions, family, transportation, housing,
  clothing, nature, culture, technology
- naturalness_score: 0.0 to 1.0 — how likely a native Korean speaker would say this in
  everyday conversation. Be honest. Penalize textbook-sounding phrasing.
- source_words: array of Korean words/patterns from the lesson notes that this sentence practices
  (so the student can see the connection to their lesson)
- vocabulary: array of content words in this sentence
  { "lemma_ko": "dictionary form", "pos_ko": "명사|동사|형용사|부사|기타" }
  Exclude particles (이/가, 을/를, 에, 은/는, 의, 도, 와/과, 에서, 으로).
- grammar_patterns: array of grammar patterns used
  { "surface_form": "the attachable ending pattern, e.g. -았/었어요" }
  Return atomic patterns only.
- politeness: "해요체" or "합니다체" or "반말"
- tense: "past" or "present" or "future" or "progressive" or "imperative"

Return ONLY valid JSON. No markdown. No explanations.

Output schema:
{
  "sentences": [
    {
      "ko": "Korean sentence here.",
      "en": "English translation here.",
      "group_label": "type label",
      "cefr_level": "A2",
      "topic": "daily_life",
      "naturalness_score": 0.92,
      "source_words": ["만나다", "-았/었어요"],
      "vocabulary": [{ "lemma_ko": "만나다", "pos_ko": "동사" }],
      "grammar_patterns": [{ "surface_form": "-았/었어요" }],
      "politeness": "해요체",
      "tense": "past"
    }
  ]
}`;
}

function buildValidationPrompt(sentences, glossLang) {
  const lang = (glossLang || "en").trim() || "en";
  const sentenceList = sentences.map((s, i) => `${i + 1}. ${s.ko}`).join("\n");

  return `You are a native Korean language expert reviewing sentences for naturalness.

For each Korean sentence below, evaluate:
1. Is it grammatically correct Korean?
2. Would a native Korean speaker naturally say this in everyday conversation?
3. Does the sentence sound natural and idiomatic, or does it feel artificial/textbook-like?
4. Are there any unnatural word choices, awkward phrasing, or particle errors?
5. Are verb conjugations correct (correct 받침 handling, correct vowel contraction)?

SENTENCES TO REVIEW:
${sentenceList}

For each sentence, return:
- index: the 1-based sentence number
- natural: true if a native speaker would say this, false if it sounds unnatural
- naturalness_score: 0.0 to 1.0 (1.0 = perfectly natural)
- issues: array of strings describing any problems (empty array if none)
- suggested_fix: if natural is false, provide the corrected Korean sentence. null if natural is true.
- explanation: brief ${lang} explanation of any issues (empty string if none)

Return ONLY valid JSON. No markdown.

Output schema:
{
  "validations": [
    {
      "index": 1,
      "natural": true,
      "naturalness_score": 0.95,
      "issues": [],
      "suggested_fix": null,
      "explanation": ""
    }
  ]
}`;
}

function parseGenerationResult(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("openai_invalid_json");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("openai_invalid_shape");
  }

  if (!Array.isArray(parsed.sentences)) {
    throw new Error("openai_invalid_shape");
  }

  parsed.sentences = parsed.sentences
    .filter(x => x && typeof x === "object")
    .map(x => ({
      ko: ensureEndingPunctuation(typeof x.ko === "string" ? x.ko.trim() : ""),
      en: (x.en === null || x.en === undefined) ? null : String(x.en).trim(),
      group_label: (x.group_label === null || x.group_label === undefined) ? null : String(x.group_label).trim(),
      cefr_level: (x.cefr_level === null || x.cefr_level === undefined) ? null : String(x.cefr_level).trim(),
      topic: (x.topic === null || x.topic === undefined) ? null : String(x.topic).trim(),
      naturalness_score: (typeof x.naturalness_score === "number" && Number.isFinite(x.naturalness_score)) ? x.naturalness_score : null,
      source_words: Array.isArray(x.source_words) ? x.source_words.filter(w => typeof w === "string") : [],
      vocabulary: Array.isArray(x.vocabulary) ? x.vocabulary.filter(v => v && typeof v === "object" && v.lemma_ko) : [],
      grammar_patterns: Array.isArray(x.grammar_patterns) ? x.grammar_patterns.filter(g => g && typeof g === "object" && g.surface_form) : [],
      politeness: (x.politeness === null || x.politeness === undefined) ? null : String(x.politeness).trim(),
      tense: (x.tense === null || x.tense === undefined) ? null : String(x.tense).trim()
    }))
    .filter(x => x.ko);

  return parsed;
}

function parseValidationResult(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("openai_invalid_json");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("openai_invalid_shape");
  }

  if (!Array.isArray(parsed.validations)) {
    throw new Error("openai_invalid_shape");
  }

  parsed.validations = parsed.validations
    .filter(x => x && typeof x === "object")
    .map(x => ({
      index: typeof x.index === "number" ? x.index : 0,
      natural: x.natural === true,
      naturalness_score: (typeof x.naturalness_score === "number" && Number.isFinite(x.naturalness_score)) ? x.naturalness_score : 0,
      issues: Array.isArray(x.issues) ? x.issues.filter(i => typeof i === "string") : [],
      suggested_fix: (x.suggested_fix === null || x.suggested_fix === undefined) ? null : String(x.suggested_fix).trim() || null,
      explanation: (x.explanation === null || x.explanation === undefined) ? "" : String(x.explanation).trim()
    }));

  return parsed;
}

/**
 * Generate practice sentences from teacher lesson notes.
 *
 * @param {Object} opts
 * @param {string} opts.text - The teacher's lesson notes (highlighted text)
 * @param {string} opts.cefrLevel - Student's CEFR level (e.g., "A2")
 * @param {string} [opts.glossLang="en"] - Translation language
 * @param {number} [opts.count=5] - Sentences per type
 * @returns {Object} { sentences: [...] }
 */
async function generatePracticeSentences({ text, cefrLevel, glossLang, count, perspective, politeness, timeoutMs }) {
  if (typeof text !== "string" || !text.trim()) {
    return { sentences: [] };
  }

  const prompt = buildPracticeGenerationPrompt({ text: text.trim(), cefrLevel, glossLang, count, perspective, politeness });

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callOpenAIOnce(prompt, timeoutMs);
      return parseGenerationResult(raw);
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

/**
 * Validate generated sentences for Korean naturalness.
 * This is an independent check — it does NOT see the generation prompt.
 *
 * @param {Array<{ko: string}>} sentences - Generated sentences to validate
 * @param {string} [glossLang="en"] - Language for issue explanations
 * @returns {Object} { validations: [...] }
 */
async function validatePracticeSentences(sentences, glossLang, timeoutMs) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return { validations: [] };
  }

  const prompt = buildValidationPrompt(sentences, glossLang);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callOpenAIOnce(prompt, timeoutMs);
      return parseValidationResult(raw);
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
  analyzeTextForImport,
  callOpenAIOnce,
  generatePracticeSentences,
  validatePracticeSentences
};