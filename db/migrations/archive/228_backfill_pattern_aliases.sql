-- 228_backfill_pattern_aliases.sql
-- Add missing alias variants that the AI commonly produces during doc import,
-- plus three genuinely missing patterns: subject marker, object marker, and
-- past copula — high-frequency A1 grammar that appears in every lesson doc.

-- ═══════════════════════════════════════════════════════════════
-- 1) New grammar_patterns for missing core patterns
-- ═══════════════════════════════════════════════════════════════
INSERT INTO grammar_patterns (code, display_name, explanation, explanation_attribution_id, level, tags, status, canonical_form_ko, pattern_group, slot_type, cefr_min, cefr_max, meaning_ko_short, meaning_en_short, rule_family, active)
VALUES
  ('GP_PARTICLE_IGA', 'N-이/가', 'Subject-marking particle.', '44851b82-7c46-49fa-94e9-382fa263c87d', 'A1', '{particle,subject}', 'active', 'N-이/가', 'PARTICLE_SUBJECT', 'N', 'A1', 'A1', '주어', 'subject marker', 'PARTICLE_IGA', true),
  ('GP_PARTICLE_EULREUL', 'N-을/를', 'Object-marking particle.', '44851b82-7c46-49fa-94e9-382fa263c87d', 'A1', '{particle,object}', 'active', 'N-을/를', 'PARTICLE_OBJECT', 'N', 'A1', 'A1', '목적어', 'object marker', 'PARTICLE_EULREUL', true),
  ('GP_COPULA_PAST', 'N-이었어요/였어요', 'Past tense copula ending (was/were).', '44851b82-7c46-49fa-94e9-382fa263c87d', 'A1', '{copula,past,ending}', 'active', 'N-이었어요/였어요', 'COPULA_PAST', 'N', 'A1', 'A1', '과거 서술', 'was / were', 'COPULA_PAST', true)
ON CONFLICT (code) DO NOTHING;

-- Aliases for the new patterns
INSERT INTO grammar_pattern_aliases (grammar_pattern_id, alias_raw, alias_norm)
SELECT gp.id, v.alias_raw, v.alias_norm
FROM grammar_patterns gp
JOIN (VALUES
  ('GP_PARTICLE_IGA', '-이/가', '-이/가'),
  ('GP_PARTICLE_IGA', '-이', '-이'),
  ('GP_PARTICLE_IGA', '-가', '-가'),
  ('GP_PARTICLE_EULREUL', '-을/를', '-을/를'),
  ('GP_PARTICLE_EULREUL', '-을', '-을'),
  ('GP_PARTICLE_EULREUL', '-를', '-를'),
  ('GP_COPULA_PAST', '-이었어요/였어요', '-이었어요/였어요'),
  ('GP_COPULA_PAST', '-이었어요', '-이었어요'),
  ('GP_COPULA_PAST', '-였어요', '-였어요'),
  ('GP_COPULA_PAST', '-었어요/였어요', '-었어요/였어요')
) AS v(code, alias_raw, alias_norm) ON gp.code = v.code
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 2) Aliases for existing patterns that lacked common AI output variants
-- ═══════════════════════════════════════════════════════════════
INSERT INTO grammar_pattern_aliases (grammar_pattern_id, alias_raw, alias_norm)
SELECT gp.id, v.alias_raw, v.alias_norm
FROM grammar_patterns gp
JOIN (VALUES
  -- ═══════════════════════════════════════════════════════════════
  -- PRESENT POLITE ENDINGS  (GP_AEO_ENDING_PRESENT_POLITE_V / _A)
  -- Orphaned: -어요, -아요, -아요/어요, -아요/-어요
  -- ═══════════════════════════════════════════════════════════════
  ('GP_AEO_ENDING_PRESENT_POLITE_V', '-어요',       '-어요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_V', '-아/어요',    '-아/어요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_V', '-아요/어요',  '-아요/어요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_V', '-아요/-어요', '-아요/-어요'),

  ('GP_AEO_ENDING_PRESENT_POLITE_A', '-아요',       '-아요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_A', '-아/어요',    '-아/어요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_A', '-아요/어요',  '-아요/어요'),
  ('GP_AEO_ENDING_PRESENT_POLITE_A', '-아요/-어요', '-아요/-어요'),

  -- ═══════════════════════════════════════════════════════════════
  -- PAST ENDINGS  (GP_PAST_ENDING_V / _A)
  -- Orphaned: -었어요 (x10+), -았/었어요 (x7+)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_PAST_ENDING_V', '-었어요',    '-었어요'),
  ('GP_PAST_ENDING_V', '-았어요',    '-았어요'),
  ('GP_PAST_ENDING_V', '-았/었어요', '-았/었어요'),
  ('GP_PAST_ENDING_V', '-했어요',    '-했어요'),

  ('GP_PAST_ENDING_A', '-었어요',    '-었어요'),
  ('GP_PAST_ENDING_A', '-았어요',    '-았어요'),
  ('GP_PAST_ENDING_A', '-았/었어요', '-았/었어요'),
  ('GP_PAST_ENDING_A', '-했어요',    '-했어요'),

  -- ═══════════════════════════════════════════════════════════════
  -- FUTURE  (GP_FUTURE_GEOLGAYO_V / _A)
  -- Orphaned: -거예요, 거예요, -할 거예요, -ㄹ 거예요 (already has alias)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_FUTURE_GEOLGAYO_V', '-거예요',    '-거예요'),
  ('GP_FUTURE_GEOLGAYO_V', '거예요',     '거예요'),
  ('GP_FUTURE_GEOLGAYO_V', '-할 거예요', '-할거예요'),

  ('GP_FUTURE_GEOLGAYO_A', '-거예요',    '-거예요'),
  ('GP_FUTURE_GEOLGAYO_A', '거예요',     '거예요'),

  -- ═══════════════════════════════════════════════════════════════
  -- PROGRESSIVE  (GP_ASPECT_PROGRESSIVE)
  -- Orphaned: -고 있다 (x2)  (dictionary form; -고있어요 already exists)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_ASPECT_PROGRESSIVE', '-고 있다', '-고있다'),

  -- ═══════════════════════════════════════════════════════════════
  -- CONNECTOR: AND  (GP_CONNECTOR_AND_GO)
  -- Orphaned: -고 (x4)  (had NO aliases)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_CONNECTOR_AND_GO', '-고', '-고'),

  -- ═══════════════════════════════════════════════════════════════
  -- CONNECTOR: REASON -아/어서  (GP_CONNECTOR_REASON_AEO)
  -- Orphaned: -서, -해서  (shortened/하다-fused forms)
  -- Existing aliases: -아서/어서, -아서, -어서
  -- ═══════════════════════════════════════════════════════════════
  ('GP_CONNECTOR_REASON_AEO', '-서',   '-서'),
  ('GP_CONNECTOR_REASON_AEO', '-해서', '-해서'),

  -- ═══════════════════════════════════════════════════════════════
  -- CONNECTOR: REASON -(이)라서  (GP_CONNECTOR_REASON_IRASEO)
  -- Orphaned: -이라서
  -- Existing aliases: -(이)라서
  -- ═══════════════════════════════════════════════════════════════
  ('GP_CONNECTOR_REASON_IRASEO', '-이라서', '-이라서'),
  ('GP_CONNECTOR_REASON_IRASEO', '-라서',   '-라서'),

  -- ═══════════════════════════════════════════════════════════════
  -- DISCOURSE: 그래서  (GP_CONNECTOR_SO_GEURAESO)
  -- Orphaned: 그래서  (had NO aliases at all)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_CONNECTOR_SO_GEURAESO', '그래서', '그래서'),

  -- ═══════════════════════════════════════════════════════════════
  -- NOUN REASON: 때문에  (GP_N_REASON_TTAEMUNE)
  -- Orphaned: 때문에  (had NO aliases)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_N_REASON_TTAEMUNE', '때문에',  '때문에'),
  ('GP_N_REASON_TTAEMUNE', '-때문에', '-때문에'),

  -- ═══════════════════════════════════════════════════════════════
  -- NOUN WITH/AND: 하고  (GP_N_WITH_HAGO)
  -- Orphaned: 하고  (had NO aliases)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_N_WITH_HAGO', '하고',  '하고'),
  ('GP_N_WITH_HAGO', '-하고', '-하고'),

  -- ═══════════════════════════════════════════════════════════════
  -- CONDITION/TIME: -(으)ㄹ 때
  -- Orphaned: -을 때
  -- GP_CONNECTOR_WHEN_TTAE already has -(으)ㄹ때; add -을때 / -ㄹ때
  -- GP_CONDITION_EUL_TTAE  already has -(으)ㄹ때; add -을때 / -ㄹ때
  -- ═══════════════════════════════════════════════════════════════
  ('GP_CONNECTOR_WHEN_TTAE', '-을 때', '-을때'),
  ('GP_CONNECTOR_WHEN_TTAE', '-ㄹ 때', '-ㄹ때'),

  ('GP_CONDITION_EUL_TTAE', '-을 때', '-을때'),
  ('GP_CONDITION_EUL_TTAE', '-ㄹ 때', '-ㄹ때'),

  -- ═══════════════════════════════════════════════════════════════
  -- PARTICLES: 에게/한테 (GP_PARTICLE_TO) — dashless variants
  -- Orphaned: 에게, 한테  (existing aliases have dashes: -에게, -한테)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_PARTICLE_TO', '에게', '에게'),
  ('GP_PARTICLE_TO', '한테', '한테'),

  -- ═══════════════════════════════════════════════════════════════
  -- PARTICLES: 에게서 (GP_PARTICLE_EGESEO) — dashless variant
  -- Orphaned: 에게서  (existing alias: -에게서)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_PARTICLE_EGESEO', '에게서', '에게서'),

  -- ═══════════════════════════════════════════════════════════════
  -- PARTICLES: 한테서 (GP_PARTICLE_HANTAESEO) — dashless variant
  -- Orphaned: 한테서  (existing alias: -한테서)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_PARTICLE_HANTAESEO', '한테서', '한테서'),

  -- ═══════════════════════════════════════════════════════════════
  -- REQUEST: 좀  (GP_REQUEST_JOM) — dashed variant
  -- Orphaned: -좀  (existing alias: 좀 without dash)
  -- ═══════════════════════════════════════════════════════════════
  ('GP_REQUEST_JOM', '-좀', '-좀'),

  -- ═══════════════════════════════════════════════════════════════
  -- WHETHER: -는지  (GP_MODAL_WHETHER_EUNJI)
  -- Orphaned: -는지 (x2)
  -- Present-tense verb form of the -(으)ㄴ지 embedded question.
  -- Canonical: V-(으)ㄴ지; existing alias: -(으)ㄴ지
  -- ═══════════════════════════════════════════════════════════════
  ('GP_MODAL_WHETHER_EUNJI', '-는지', '-는지'),

  -- ═══════════════════════════════════════════════════════════════
  -- DESIRE: -고 싶다  (GP_MODAL_DESIRE_GOSIP)
  -- Forward-looking: AI may produce dictionary form instead of -고 싶어요
  -- ═══════════════════════════════════════════════════════════════
  ('GP_MODAL_DESIRE_GOSIP', '-고 싶다', '-고싶다')

) AS v(code, alias_raw, alias_norm)
ON gp.code = v.code
ON CONFLICT DO NOTHING;
