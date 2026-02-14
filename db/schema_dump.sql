--
-- PostgreSQL database dump
--

\restrict e8UXcX89hLYDTgDBvozHqCRlHKxUYZpTOMb5UzFZt1JKDzcjXsyew0GmSR7Jb4p

-- Dumped from database version 17.7 (Debian 17.7-3.pgdg13+1)
-- Dumped by pg_dump version 18.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: attributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attributions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_type text NOT NULL,
    source_name text NOT NULL,
    source_record_id text,
    source_url text,
    license text,
    confidence text,
    retrieved_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attributions_source_type_check CHECK ((source_type = ANY (ARRAY['NIKL_BASIC_DICT'::text, 'NIKL_STANDARD_DICT'::text, 'UNIHAN'::text, 'TEACHER'::text, 'AI'::text, 'USER'::text, 'OTHER'::text])))
);


--
-- Name: auth_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_identities (
    provider text NOT NULL,
    subject text NOT NULL,
    audience text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: content_item_audio_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_item_audio_variants (
    content_item_audio_variant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_item_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    voice_gender text NOT NULL,
    speed text NOT NULL,
    label text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reading_item_audio_variants_speed_check CHECK ((speed = ANY (ARRAY['slow'::text, 'moderate'::text, 'native'::text]))),
    CONSTRAINT reading_item_audio_variants_voice_gender_check CHECK ((voice_gender = ANY (ARRAY['female'::text, 'male'::text])))
);


--
-- Name: content_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_items (
    content_item_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    content_type text NOT NULL,
    text text NOT NULL,
    language text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_items_content_type_check CHECK ((content_type = ANY (ARRAY['sentence'::text, 'pattern'::text])))
);


--
-- Name: content_items_coverage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.content_items_coverage AS
 SELECT ci.content_item_id,
    ci.owner_user_id,
    ci.content_type,
    ci.text,
    ci.language,
    ci.notes,
    ci.created_at,
    ci.updated_at,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'female'::text) AND (v.speed = 'slow'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS female_slow_asset_id,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'female'::text) AND (v.speed = 'moderate'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS female_moderate_asset_id,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'female'::text) AND (v.speed = 'native'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS female_native_asset_id,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'male'::text) AND (v.speed = 'slow'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS male_slow_asset_id,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'male'::text) AND (v.speed = 'moderate'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS male_moderate_asset_id,
    (NULLIF(string_agg(
        CASE
            WHEN ((v.voice_gender = 'male'::text) AND (v.speed = 'native'::text)) THEN (v.asset_id)::text
            ELSE NULL::text
        END, ''::text), ''::text))::uuid AS male_native_asset_id,
    count(v.content_item_audio_variant_id) AS variants_count
   FROM (public.content_items ci
     LEFT JOIN public.content_item_audio_variants v ON ((v.content_item_id = ci.content_item_id)))
  GROUP BY ci.content_item_id, ci.owner_user_id, ci.content_type, ci.text, ci.language, ci.notes, ci.created_at, ci.updated_at;


--
-- Name: docparse_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docparse_jobs (
    job_id uuid NOT NULL,
    parse_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT docparse_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: document_content_item_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_content_item_links (
    document_id uuid NOT NULL,
    content_item_id uuid NOT NULL,
    link_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    session_date date,
    CONSTRAINT document_content_item_links_link_kind_check CHECK ((link_kind = ANY (ARRAY['sentence'::text, 'pattern'::text])))
);


--
-- Name: document_parse_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_parse_runs (
    parse_run_id uuid NOT NULL,
    document_id uuid NOT NULL,
    parser_version text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    error_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_parse_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'succeeded_partial'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: document_registry_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_registry_links (
    document_id uuid NOT NULL,
    parse_run_id uuid NOT NULL,
    registry_item_id uuid NOT NULL,
    link_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_registry_links_link_kind_check CHECK ((link_kind = ANY (ARRAY['sentence'::text, 'pattern'::text, 'vocab'::text])))
);


--
-- Name: document_vocab_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_vocab_items (
    document_id uuid NOT NULL,
    parse_run_id uuid NOT NULL,
    lemma text NOT NULL,
    surface text,
    count integer DEFAULT 1 NOT NULL,
    vocab_id uuid
);


--
-- Name: document_vocab_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_vocab_links (
    document_id uuid NOT NULL,
    user_id uuid NOT NULL,
    lemma text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    session_date date
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    document_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    source_kind text DEFAULT 'upload'::text NOT NULL,
    source_uri text,
    title text,
    ingest_status text DEFAULT 'pending'::text NOT NULL,
    reject_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT documents_ingest_status_check CHECK ((ingest_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text]))),
    CONSTRAINT documents_source_kind_check CHECK ((source_kind = ANY (ARRAY['upload'::text, 'google_doc'::text, 'other'::text])))
);


--
-- Name: google_oauth_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_oauth_connections (
    user_id uuid NOT NULL,
    scopes text DEFAULT ''::text NOT NULL,
    refresh_token text NOT NULL,
    access_token text,
    access_token_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grammar_pattern_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_pattern_aliases (
    alias_id uuid DEFAULT gen_random_uuid() NOT NULL,
    grammar_pattern_id uuid NOT NULL,
    alias_raw text NOT NULL,
    alias_norm text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grammar_pattern_aliases_seed_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_pattern_aliases_seed_stage (
    code text NOT NULL,
    alias_raw text NOT NULL,
    alias_norm text NOT NULL
);


--
-- Name: grammar_pattern_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_pattern_translations (
    translation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    grammar_pattern_id uuid NOT NULL,
    lang text NOT NULL,
    field text NOT NULL,
    text text NOT NULL,
    attribution_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grammar_pattern_translations_field_chk CHECK ((field = ANY (ARRAY['display_name'::text, 'meaning_short'::text, 'explanation'::text, 'notes'::text])))
);


--
-- Name: grammar_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    display_name text NOT NULL,
    explanation text NOT NULL,
    explanation_attribution_id uuid NOT NULL,
    level text,
    tags text[],
    status text DEFAULT 'provisional'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    canonical_form_ko text,
    pattern_group text,
    slot_type text,
    cefr_min text,
    cefr_max text,
    meaning_ko_short text,
    meaning_en_short text,
    rule_family text,
    constraints_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT grammar_patterns_cefr_chk CHECK ((((cefr_min IS NULL) AND (cefr_max IS NULL)) OR ((cefr_min = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text])) AND (cefr_max = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text]))))),
    CONSTRAINT grammar_patterns_slot_type_chk CHECK (((slot_type IS NULL) OR (slot_type = ANY (ARRAY['V'::text, 'A'::text, 'N'::text, 'CLAUSE'::text, 'QUOTE'::text])))),
    CONSTRAINT grammar_patterns_status_check CHECK ((status = ANY (ARRAY['provisional'::text, 'active'::text, 'deprecated'::text])))
);


--
-- Name: grammar_patterns_seed_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_patterns_seed_stage (
    code text NOT NULL,
    display_name text NOT NULL,
    explanation text NOT NULL,
    level text,
    tags text[],
    status text DEFAULT 'active'::text NOT NULL,
    canonical_form_ko text,
    pattern_group text,
    slot_type text,
    cefr_min text,
    cefr_max text,
    meaning_ko_short text,
    meaning_en_short text,
    rule_family text,
    constraints_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: grammar_rule_families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grammar_rule_families (
    rule_family text NOT NULL,
    description text,
    rule_spec_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_character_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_character_levels (
    hanja_character_id uuid NOT NULL,
    level_code text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_characters (
    id uuid NOT NULL,
    hanja text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_hanja_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_hanja_link (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    hanja_character_id uuid NOT NULL,
    "position" integer,
    source_snapshot_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_character_ranking_mv; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.hanja_character_ranking_mv AS
 WITH freq AS (
         SELECT l.hanja_character_id,
            count(*) AS freq_words
           FROM public.nikl_entry_hanja_link l
          GROUP BY l.hanja_character_id
        ), ranked AS (
         SELECT freq.hanja_character_id,
            freq.freq_words,
            rank() OVER (ORDER BY freq.freq_words DESC) AS rank_global,
            percent_rank() OVER (ORDER BY freq.freq_words DESC) AS pct_rank
           FROM freq
        )
 SELECT r.hanja_character_id,
    hc.hanja,
    r.freq_words,
    r.rank_global,
    round(((r.pct_rank * (100)::double precision))::numeric, 2) AS percentile
   FROM (ranked r
     JOIN public.hanja_characters hc ON ((hc.id = r.hanja_character_id)))
  ORDER BY r.rank_global
  WITH NO DATA;


--
-- Name: hanja_level_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_level_labels (
    level_code text NOT NULL,
    lang text NOT NULL,
    label text NOT NULL,
    display text NOT NULL,
    notes text
);


--
-- Name: hanja_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_levels (
    level_code text NOT NULL,
    sort_order integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_readings (
    id uuid NOT NULL,
    hanja_character_id uuid NOT NULL,
    reading_hangul text NOT NULL,
    reading_type text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_texts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_texts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hanja_character_id uuid NOT NULL,
    text_type text NOT NULL,
    lang text NOT NULL,
    text_value text NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hanja_vocab; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hanja_vocab (
    hanja_character_id uuid NOT NULL,
    vocab_id uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: krdict_hanja_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.krdict_hanja_link (
    krdict_entry_id uuid NOT NULL,
    hanja_character_id uuid NOT NULL,
    "position" integer NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    confidence text DEFAULT 'suggested'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_khl_confidence CHECK ((confidence = ANY (ARRAY['suggested'::text, 'verified'::text, 'rejected'::text]))),
    CONSTRAINT chk_khl_source CHECK ((source = ANY (ARRAY['manual'::text, 'teacher'::text, 'import'::text, 'suggested'::text])))
);


--
-- Name: krdict_lexical_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.krdict_lexical_entry (
    id uuid NOT NULL,
    snapshot_version text NOT NULL,
    source_entry_id text NOT NULL,
    headword text,
    pos text,
    raw_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: krdict_lexical_entry_fast; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.krdict_lexical_entry_fast (
    snapshot_version text NOT NULL,
    source_entry_id text NOT NULL,
    headword text,
    pos text,
    definition_ko text,
    en_lemma text,
    en_definition text,
    origin text,
    hanja text
);


--
-- Name: krdict_term_bank; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.krdict_term_bank (
    term text NOT NULL,
    reading text,
    pos text NOT NULL,
    level text NOT NULL,
    glosses_en text[],
    source_code integer,
    raw_pos_level text,
    raw_level text
);


--
-- Name: library_moderation_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_moderation_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_type text NOT NULL,
    content_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    reason text,
    before_snapshot jsonb NOT NULL,
    after_snapshot jsonb NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT library_moderation_actions_action_check CHECK ((action = ANY (ARRAY['needs_review'::text, 'restore'::text, 'approve'::text, 'reject'::text, 'keep_under_review'::text, 'set_preliminary'::text, 'set_global'::text, 'set_personal'::text])))
);


--
-- Name: library_registry_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_registry_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_type text NOT NULL,
    content_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    audience text NOT NULL,
    global_state text,
    operational_status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT library_registry_items_audience_check CHECK ((audience = ANY (ARRAY['personal'::text, 'global'::text]))),
    CONSTRAINT library_registry_items_global_state_check CHECK ((global_state = ANY (ARRAY['preliminary'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT library_registry_items_global_state_guard CHECK ((((audience = 'global'::text) AND (global_state IS NOT NULL)) OR ((audience = 'personal'::text) AND (global_state IS NULL)))),
    CONSTRAINT library_registry_items_operational_status_check CHECK ((operational_status = ANY (ARRAY['active'::text, 'under_review'::text])))
);


--
-- Name: library_review_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_review_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registry_item_id uuid NOT NULL,
    flagged_by_user_id uuid NOT NULL,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    prior_snapshot jsonb NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_user_id uuid,
    resolution text,
    CONSTRAINT library_review_queue_resolution_check CHECK (((resolution IS NULL) OR (resolution = ANY (ARRAY['restored'::text, 'kept_under_review'::text, 'rejected'::text]))))
);


--
-- Name: library_share_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_share_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_type text NOT NULL,
    content_id uuid NOT NULL,
    grant_type text NOT NULL,
    grantee_id uuid NOT NULL,
    granted_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT library_share_grants_grant_type_check CHECK ((grant_type = ANY (ARRAY['user'::text, 'class'::text])))
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    asset_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    object_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    title text,
    language text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_assets_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT media_assets_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: nikl_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entries (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    headword text NOT NULL,
    sup_no integer DEFAULT 0 NOT NULL,
    word_unit text,
    pos_ko text,
    word_type_ko text,
    word_grade_ko text,
    entry_link text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_categories (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    category_type text NOT NULL,
    idx integer NOT NULL,
    written_form text NOT NULL,
    reference text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_conjugations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_conjugations (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    idx integer NOT NULL,
    conjugation text NOT NULL,
    pronunciation text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_hanja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_hanja (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    hanja_text text NOT NULL,
    raw_label text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_loanword_origin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_loanword_origin (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    idx integer NOT NULL,
    origin_text text NOT NULL,
    origin_language_type_ko text,
    raw_label text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_entry_pronunciations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_entry_pronunciations (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    idx integer NOT NULL,
    pronunciation text NOT NULL,
    audio_link text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_label_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_label_map (
    domain text NOT NULL,
    label_ko text NOT NULL,
    lang text NOT NULL,
    label text NOT NULL,
    display text NOT NULL,
    notes text
);


--
-- Name: nikl_sense_examples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_sense_examples (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    idx integer NOT NULL,
    example_type_ko text NOT NULL,
    example_text_ko text NOT NULL,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_sense_multimedia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_sense_multimedia (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    idx integer NOT NULL,
    media_label text NOT NULL,
    media_type_ko text NOT NULL,
    media_link text NOT NULL,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_sense_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_sense_patterns (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    idx integer NOT NULL,
    pattern_text_ko text NOT NULL,
    pattern_reference_ko text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_sense_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_sense_relations (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    idx integer NOT NULL,
    rel_word text NOT NULL,
    rel_type_ko text NOT NULL,
    link_type text,
    link_target_code text,
    link text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_sense_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_sense_translations (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    idx integer NOT NULL,
    lang text,
    trans_lang_raw text,
    trans_word text,
    trans_definition text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_senses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_senses (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    sense_no integer NOT NULL,
    definition_ko text NOT NULL,
    reference_ko text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_snapshots (
    snapshot_id uuid NOT NULL,
    endpoint text NOT NULL,
    target_code integer,
    lemma text,
    object_key text NOT NULL,
    sha256 text NOT NULL,
    bytes integer NOT NULL,
    http_status integer NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    query text,
    parsed_at timestamp with time zone,
    parse_error text,
    CONSTRAINT nikl_snapshots_endpoint_check CHECK ((endpoint = ANY (ARRAY['search'::text, 'view'::text])))
);


--
-- Name: nikl_subword_examples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_subword_examples (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    subword_no integer NOT NULL,
    subsense_no integer NOT NULL,
    idx integer NOT NULL,
    example_type_ko text NOT NULL,
    example_text_ko text NOT NULL,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_subword_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_subword_patterns (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    subword_no integer NOT NULL,
    subsense_no integer NOT NULL,
    idx integer NOT NULL,
    pattern_text_ko text NOT NULL,
    pattern_reference_ko text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_subword_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_subword_relations (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    subword_no integer NOT NULL,
    subsense_no integer NOT NULL,
    idx integer NOT NULL,
    rel_word text NOT NULL,
    rel_type_ko text NOT NULL,
    link_type text,
    link_target_code text,
    link text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_subword_senses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_subword_senses (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    subword_no integer NOT NULL,
    subsense_no integer NOT NULL,
    definition_ko text NOT NULL,
    reference_ko text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_subwords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_subwords (
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text NOT NULL,
    subword_no integer NOT NULL,
    subword_text text NOT NULL,
    subword_unit_ko text NOT NULL,
    reference_ko text,
    raw_snapshot_id uuid NOT NULL,
    parsed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_target_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_target_codes (
    target_code integer NOT NULL,
    first_seen_snapshot_id uuid NOT NULL,
    first_seen_endpoint text DEFAULT 'search'::text NOT NULL,
    first_seen_lemma text NOT NULL,
    first_seen_object_key text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_nikl_target_codes_first_seen_endpoint CHECK (((first_seen_endpoint IS NULL) OR (first_seen_endpoint = 'search'::text))),
    CONSTRAINT nikl_target_codes_first_seen_endpoint_check CHECK ((first_seen_endpoint = 'search'::text))
);


--
-- Name: nikl_target_codes_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_target_codes_stage (
    target_code integer NOT NULL,
    first_seen_snapshot_id uuid NOT NULL,
    first_seen_lemma text NOT NULL,
    first_seen_object_key text NOT NULL
);


--
-- Name: nikl_unmapped_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nikl_unmapped_fields (
    unmapped_id bigint NOT NULL,
    snapshot_id uuid NOT NULL,
    provider text DEFAULT 'krdict'::text NOT NULL,
    provider_target_code text,
    xml_path text NOT NULL,
    raw_value text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    count_seen integer DEFAULT 1 NOT NULL,
    notes text
);


--
-- Name: nikl_unmapped_fields_unmapped_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nikl_unmapped_fields_unmapped_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nikl_unmapped_fields_unmapped_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nikl_unmapped_fields_unmapped_id_seq OWNED BY public.nikl_unmapped_fields.unmapped_id;


--
-- Name: nikl_view_entry_wide_beginner; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.nikl_view_entry_wide_beginner AS
 WITH e AS (
         SELECT nikl_entries.provider,
            nikl_entries.provider_target_code,
            nikl_entries.headword,
            nikl_entries.sup_no,
            nikl_entries.word_unit,
            nikl_entries.pos_ko,
            nikl_entries.word_type_ko,
            nikl_entries.word_grade_ko,
            nikl_entries.entry_link,
            nikl_entries.raw_snapshot_id,
            nikl_entries.parsed_at
           FROM public.nikl_entries
        ), lm_pos AS (
         SELECT nikl_label_map.label_ko,
            nikl_label_map.label AS pos_label_en,
            nikl_label_map.display AS pos_display_en
           FROM public.nikl_label_map
          WHERE ((nikl_label_map.domain = 'pos'::text) AND (nikl_label_map.lang = 'en'::text))
        ), lm_type AS (
         SELECT nikl_label_map.label_ko,
            nikl_label_map.label AS word_type_label_en,
            nikl_label_map.display AS word_type_display_en
           FROM public.nikl_label_map
          WHERE ((nikl_label_map.domain = 'word_type'::text) AND (nikl_label_map.lang = 'en'::text))
        ), lm_grade AS (
         SELECT nikl_label_map.label_ko,
            nikl_label_map.label AS word_grade_label_en,
            nikl_label_map.display AS word_grade_display_en
           FROM public.nikl_label_map
          WHERE ((nikl_label_map.domain = 'word_grade'::text) AND (nikl_label_map.lang = 'en'::text))
        ), s AS (
         SELECT nikl_senses.provider,
            nikl_senses.provider_target_code,
            nikl_senses.sense_no,
            nikl_senses.definition_ko,
            nikl_senses.reference_ko
           FROM public.nikl_senses
          WHERE (nikl_senses.sense_no = 1)
        ), snap AS (
         SELECT nikl_snapshots.snapshot_id,
            nikl_snapshots.target_code,
            nikl_snapshots.object_key,
            nikl_snapshots.sha256,
            nikl_snapshots.bytes,
            nikl_snapshots.http_status,
            nikl_snapshots.fetched_at,
            nikl_snapshots.parsed_at AS snapshot_parsed_at,
            nikl_snapshots.parse_error
           FROM public.nikl_snapshots
        ), p1 AS (
         SELECT nikl_entry_pronunciations.provider,
            nikl_entry_pronunciations.provider_target_code,
            nikl_entry_pronunciations.pronunciation,
            nikl_entry_pronunciations.audio_link
           FROM public.nikl_entry_pronunciations
          WHERE (nikl_entry_pronunciations.idx = 1)
        ), c1 AS (
         SELECT nikl_entry_conjugations.provider,
            nikl_entry_conjugations.provider_target_code,
            nikl_entry_conjugations.conjugation,
            nikl_entry_conjugations.pronunciation AS conjugation_pron
           FROM public.nikl_entry_conjugations
          WHERE (nikl_entry_conjugations.idx = 1)
        ), lw1 AS (
         SELECT nikl_entry_loanword_origin.provider,
            nikl_entry_loanword_origin.provider_target_code,
            nikl_entry_loanword_origin.origin_text,
            nikl_entry_loanword_origin.origin_language_type_ko,
            nikl_entry_loanword_origin.raw_label
           FROM public.nikl_entry_loanword_origin
          WHERE (nikl_entry_loanword_origin.idx = 1)
        ), h1 AS (
         SELECT nikl_entry_hanja.provider,
            nikl_entry_hanja.provider_target_code,
            min(nikl_entry_hanja.hanja_text) AS hanja_text
           FROM public.nikl_entry_hanja
          GROUP BY nikl_entry_hanja.provider, nikl_entry_hanja.provider_target_code
        ), cat1 AS (
         SELECT DISTINCT ON (nikl_entry_categories.provider, nikl_entry_categories.provider_target_code) nikl_entry_categories.provider,
            nikl_entry_categories.provider_target_code,
            nikl_entry_categories.category_type,
            nikl_entry_categories.written_form,
            nikl_entry_categories.reference
           FROM public.nikl_entry_categories
          ORDER BY nikl_entry_categories.provider, nikl_entry_categories.provider_target_code, nikl_entry_categories.category_type, nikl_entry_categories.idx
        ), t_en AS (
         SELECT DISTINCT ON (nikl_sense_translations.provider, nikl_sense_translations.provider_target_code) nikl_sense_translations.provider,
            nikl_sense_translations.provider_target_code,
            nikl_sense_translations.trans_word,
            nikl_sense_translations.trans_definition
           FROM public.nikl_sense_translations
          WHERE ((nikl_sense_translations.sense_no = 1) AND ((nikl_sense_translations.lang = 'en'::text) OR (nikl_sense_translations.trans_lang_raw ~~* '%en%'::text)))
          ORDER BY nikl_sense_translations.provider, nikl_sense_translations.provider_target_code, nikl_sense_translations.idx
        ), t_any AS (
         SELECT DISTINCT ON (nikl_sense_translations.provider, nikl_sense_translations.provider_target_code) nikl_sense_translations.provider,
            nikl_sense_translations.provider_target_code,
            nikl_sense_translations.trans_word,
            nikl_sense_translations.trans_definition
           FROM public.nikl_sense_translations
          WHERE (nikl_sense_translations.sense_no = 1)
          ORDER BY nikl_sense_translations.provider, nikl_sense_translations.provider_target_code, nikl_sense_translations.idx
        ), t_all AS (
         SELECT nikl_sense_translations.provider,
            nikl_sense_translations.provider_target_code,
            jsonb_agg(jsonb_build_object('idx', nikl_sense_translations.idx, 'lang', COALESCE(nikl_sense_translations.lang, nikl_sense_translations.trans_lang_raw), 'word', nikl_sense_translations.trans_word, 'definition', nikl_sense_translations.trans_definition) ORDER BY nikl_sense_translations.idx) AS translations_json
           FROM public.nikl_sense_translations
          WHERE (nikl_sense_translations.sense_no = 1)
          GROUP BY nikl_sense_translations.provider, nikl_sense_translations.provider_target_code
        ), ex1 AS (
         SELECT nikl_sense_examples.provider,
            nikl_sense_examples.provider_target_code,
            nikl_sense_examples.example_type_ko,
            nikl_sense_examples.example_text_ko
           FROM public.nikl_sense_examples
          WHERE ((nikl_sense_examples.sense_no = 1) AND (nikl_sense_examples.idx = 1))
        ), pat1 AS (
         SELECT nikl_sense_patterns.provider,
            nikl_sense_patterns.provider_target_code,
            nikl_sense_patterns.pattern_text_ko,
            nikl_sense_patterns.pattern_reference_ko
           FROM public.nikl_sense_patterns
          WHERE ((nikl_sense_patterns.sense_no = 1) AND (nikl_sense_patterns.idx = 1))
        ), rel1 AS (
         SELECT nikl_sense_relations.provider,
            nikl_sense_relations.provider_target_code,
            nikl_sense_relations.rel_word,
            nikl_sense_relations.rel_type_ko,
            nikl_sense_relations.link_type,
            nikl_sense_relations.link_target_code,
            nikl_sense_relations.link
           FROM public.nikl_sense_relations
          WHERE ((nikl_sense_relations.sense_no = 1) AND (nikl_sense_relations.idx = 1))
        ), m1 AS (
         SELECT nikl_sense_multimedia.provider,
            nikl_sense_multimedia.provider_target_code,
            nikl_sense_multimedia.media_label,
            nikl_sense_multimedia.media_type_ko,
            nikl_sense_multimedia.media_link
           FROM public.nikl_sense_multimedia
          WHERE ((nikl_sense_multimedia.sense_no = 1) AND (nikl_sense_multimedia.idx = 1))
        )
 SELECT e.provider,
    e.provider_target_code AS target_code,
    e.headword,
    e.sup_no,
    e.word_unit,
    e.pos_ko,
    e.word_type_ko,
    e.word_grade_ko,
    e.entry_link,
    COALESCE(lm_pos.pos_label_en, e.pos_ko) AS pos_label_en,
    COALESCE(lm_pos.pos_display_en, e.pos_ko) AS pos_display_en,
    COALESCE(lm_type.word_type_label_en, e.word_type_ko) AS word_type_label_en,
    COALESCE(lm_type.word_type_display_en, e.word_type_ko) AS word_type_display_en,
    COALESCE(lm_grade.word_grade_label_en, e.word_grade_ko) AS word_grade_label_en,
    COALESCE(lm_grade.word_grade_display_en, e.word_grade_ko) AS word_grade_display_en,
    snap.object_key,
    snap.sha256,
    snap.bytes,
    snap.http_status,
    snap.parse_error,
    p1.pronunciation AS pron_1,
    p1.audio_link AS pron_audio_1,
    c1.conjugation AS conj_1,
    c1.conjugation_pron AS conj_pron_1,
    h1.hanja_text AS hanja_1,
    lw1.origin_text AS loanword_origin_1,
    lw1.origin_language_type_ko AS loanword_lang_ko_1,
    lw1.raw_label AS loanword_raw_label_1,
    cat1.category_type AS category_type_1,
    cat1.written_form AS category_written_1,
    cat1.reference AS category_ref_1,
    s.definition_ko AS sense1_def_ko,
    s.reference_ko AS sense1_ref_ko,
    COALESCE(t_en.trans_word, t_any.trans_word) AS sense1_primary_word,
    COALESCE(t_en.trans_definition, t_any.trans_definition) AS sense1_primary_def,
    t_en.trans_word AS sense1_en_word,
    t_en.trans_definition AS sense1_en_def,
    t_all.translations_json AS sense1_translations_json,
    ex1.example_type_ko AS sense1_ex_type_1,
    ex1.example_text_ko AS sense1_ex_text_1,
    pat1.pattern_text_ko AS sense1_pattern_1,
    pat1.pattern_reference_ko AS sense1_pattern_ref_1,
    rel1.rel_type_ko AS sense1_rel_type_1,
    rel1.rel_word AS sense1_rel_word_1,
    rel1.link_type AS sense1_rel_link_type_1,
    rel1.link_target_code AS sense1_rel_link_target_1,
    rel1.link AS sense1_rel_link_1,
    m1.media_type_ko AS sense1_media_type_1,
    m1.media_label AS sense1_media_label_1,
    m1.media_link AS sense1_media_link_1
   FROM (((((((((((((((((e
     LEFT JOIN snap ON ((snap.snapshot_id = e.raw_snapshot_id)))
     LEFT JOIN lm_pos ON ((lm_pos.label_ko = e.pos_ko)))
     LEFT JOIN lm_type ON ((lm_type.label_ko = e.word_type_ko)))
     LEFT JOIN lm_grade ON ((lm_grade.label_ko = e.word_grade_ko)))
     LEFT JOIN s ON (((s.provider = e.provider) AND (s.provider_target_code = e.provider_target_code))))
     LEFT JOIN p1 ON (((p1.provider = e.provider) AND (p1.provider_target_code = e.provider_target_code))))
     LEFT JOIN c1 ON (((c1.provider = e.provider) AND (c1.provider_target_code = e.provider_target_code))))
     LEFT JOIN h1 ON (((h1.provider = e.provider) AND (h1.provider_target_code = e.provider_target_code))))
     LEFT JOIN lw1 ON (((lw1.provider = e.provider) AND (lw1.provider_target_code = e.provider_target_code))))
     LEFT JOIN cat1 ON (((cat1.provider = e.provider) AND (cat1.provider_target_code = e.provider_target_code))))
     LEFT JOIN t_en ON (((t_en.provider = e.provider) AND (t_en.provider_target_code = e.provider_target_code))))
     LEFT JOIN t_any ON (((t_any.provider = e.provider) AND (t_any.provider_target_code = e.provider_target_code))))
     LEFT JOIN t_all ON (((t_all.provider = e.provider) AND (t_all.provider_target_code = e.provider_target_code))))
     LEFT JOIN ex1 ON (((ex1.provider = e.provider) AND (ex1.provider_target_code = e.provider_target_code))))
     LEFT JOIN pat1 ON (((pat1.provider = e.provider) AND (pat1.provider_target_code = e.provider_target_code))))
     LEFT JOIN rel1 ON (((rel1.provider = e.provider) AND (rel1.provider_target_code = e.provider_target_code))))
     LEFT JOIN m1 ON (((m1.provider = e.provider) AND (m1.provider_target_code = e.provider_target_code))))
  WHERE (COALESCE(lm_grade.word_grade_label_en, e.word_grade_ko) = 'beginner'::text);


--
-- Name: nikl_view_hanja_flashline; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.nikl_view_hanja_flashline AS
 SELECT provider,
    target_code,
    headword,
    sup_no,
    hanja_1 AS hanja,
    sense1_def_ko AS meaning_ko,
    sense1_en_def AS meaning_en,
    concat(headword,
        CASE
            WHEN ((hanja_1 IS NOT NULL) AND (hanja_1 <> ''::text)) THEN (' '::text || hanja_1)
            ELSE ''::text
        END, ' — ', COALESCE(sense1_def_ko, ''::text),
        CASE
            WHEN ((sense1_en_def IS NOT NULL) AND (sense1_en_def <> ''::text)) THEN ('; '::text || sense1_en_def)
            ELSE ''::text
        END) AS display_line
   FROM public.nikl_view_entry_wide_beginner
  WHERE ((headword IS NOT NULL) AND (sense1_def_ko IS NOT NULL));


--
-- Name: nikl_view_hanja_rank_top100; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.nikl_view_hanja_rank_top100 AS
 WITH top_hanja AS (
         SELECT hanja_character_ranking_mv.hanja_character_id,
            hanja_character_ranking_mv.hanja,
            hanja_character_ranking_mv.rank_global
           FROM public.hanja_character_ranking_mv
          WHERE (hanja_character_ranking_mv.rank_global <= 100)
        )
 SELECT h.rank_global,
    n.target_code,
    n.headword,
    n.sup_no,
    h.hanja,
    n.meaning_ko,
    n.meaning_en,
    concat(n.headword, ' ', h.hanja, ' — ', COALESCE(n.meaning_ko, ''::text),
        CASE
            WHEN ((n.meaning_en IS NOT NULL) AND (n.meaning_en <> ''::text)) THEN ('; '::text || n.meaning_en)
            ELSE ''::text
        END) AS display_line
   FROM (top_hanja h
     LEFT JOIN LATERAL ( SELECT e.provider_target_code AS target_code,
            e.headword,
            e.sup_no,
            COALESCE(NULLIF(v.sense1_rel_word_1, ''::text), s.definition_ko) AS meaning_ko,
            en.meaning_en
           FROM ((((public.nikl_entry_hanja_link l
             JOIN public.nikl_entries e ON (((e.provider = l.provider) AND (e.provider_target_code = l.provider_target_code))))
             LEFT JOIN public.nikl_view_entry_wide_beginner v ON (((v.provider = e.provider) AND (v.target_code = e.provider_target_code))))
             LEFT JOIN public.nikl_senses s ON (((s.provider = e.provider) AND (s.provider_target_code = e.provider_target_code) AND (s.sense_no = 1))))
             LEFT JOIN LATERAL ( SELECT COALESCE(NULLIF(t.trans_word, ''::text), NULLIF(t.trans_definition, ''::text)) AS meaning_en
                   FROM public.nikl_sense_translations t
                  WHERE ((t.provider = e.provider) AND (t.provider_target_code = e.provider_target_code) AND (t.sense_no = 1) AND (lower(COALESCE(t.lang, ''::text)) = ANY (ARRAY['en'::text, 'eng'::text, 'english'::text])))
                  ORDER BY t.idx
                 LIMIT 1) en ON (true))
          WHERE (l.hanja_character_id = h.hanja_character_id)
          ORDER BY (char_length(e.headword)), e.sup_no, e.provider_target_code
         LIMIT 1) n ON (true))
  WHERE (n.target_code IS NOT NULL)
  ORDER BY h.rank_global;


--
-- Name: nikl_view_hanja_wordline; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.nikl_view_hanja_wordline AS
 SELECT provider,
    target_code,
    headword,
    sup_no,
    hanja_1 AS hanja,
    COALESCE(NULLIF(sense1_primary_word, ''::text), NULLIF(sense1_def_ko, ''::text)) AS meaning_ko,
    COALESCE(NULLIF(sense1_en_word, ''::text), NULLIF(sense1_en_def, ''::text)) AS meaning_en,
    concat(headword,
        CASE
            WHEN ((hanja_1 IS NOT NULL) AND (hanja_1 <> ''::text)) THEN (' '::text || hanja_1)
            ELSE ''::text
        END, ' — ', COALESCE(NULLIF(sense1_primary_word, ''::text), NULLIF(sense1_def_ko, ''::text), ''::text),
        CASE
            WHEN (COALESCE(NULLIF(sense1_en_word, ''::text), NULLIF(sense1_en_def, ''::text)) IS NOT NULL) THEN ('; '::text || COALESCE(NULLIF(sense1_en_word, ''::text), NULLIF(sense1_en_def, ''::text)))
            ELSE ''::text
        END) AS display_line
   FROM public.nikl_view_entry_wide_beginner
  WHERE ((headword IS NOT NULL) AND (hanja_1 IS NOT NULL) AND (hanja_1 <> ''::text) AND ((NULLIF(sense1_primary_word, ''::text) IS NOT NULL) OR (NULLIF(sense1_en_word, ''::text) IS NOT NULL)));


--
-- Name: nikl_view_parse_audit; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.nikl_view_parse_audit AS
 SELECT e.provider,
    e.provider_target_code,
    e.headword,
    e.pos_ko,
    e.word_type_ko,
    e.word_grade_ko,
    e.raw_snapshot_id,
    s.fetched_at,
    s.parsed_at,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_pronunciations p
          WHERE ((p.provider = e.provider) AND (p.provider_target_code = e.provider_target_code))) AS pronunciations_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_conjugations c
          WHERE ((c.provider = e.provider) AND (c.provider_target_code = e.provider_target_code))) AS conjugations_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_categories k
          WHERE ((k.provider = e.provider) AND (k.provider_target_code = e.provider_target_code))) AS categories_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_loanword_origin o
          WHERE ((o.provider = e.provider) AND (o.provider_target_code = e.provider_target_code))) AS loanword_origin_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_hanja h
          WHERE ((h.provider = e.provider) AND (h.provider_target_code = e.provider_target_code))) AS entry_hanja_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_entry_hanja_link hl
          WHERE ((hl.provider = e.provider) AND (hl.provider_target_code = e.provider_target_code))) AS entry_hanja_link_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_senses se
          WHERE ((se.provider = e.provider) AND (se.provider_target_code = e.provider_target_code))) AS senses_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_sense_translations t
          WHERE ((t.provider = e.provider) AND (t.provider_target_code = e.provider_target_code))) AS sense_translations_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_sense_examples ex
          WHERE ((ex.provider = e.provider) AND (ex.provider_target_code = e.provider_target_code))) AS sense_examples_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_sense_patterns sp
          WHERE ((sp.provider = e.provider) AND (sp.provider_target_code = e.provider_target_code))) AS sense_patterns_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_sense_relations r
          WHERE ((r.provider = e.provider) AND (r.provider_target_code = e.provider_target_code))) AS sense_relations_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_sense_multimedia m
          WHERE ((m.provider = e.provider) AND (m.provider_target_code = e.provider_target_code))) AS sense_multimedia_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_subwords sw
          WHERE ((sw.provider = e.provider) AND (sw.provider_target_code = e.provider_target_code))) AS subwords_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_subword_senses ss
          WHERE ((ss.provider = e.provider) AND (ss.provider_target_code = e.provider_target_code))) AS subword_senses_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_subword_examples sx
          WHERE ((sx.provider = e.provider) AND (sx.provider_target_code = e.provider_target_code))) AS subword_examples_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_subword_patterns sp2
          WHERE ((sp2.provider = e.provider) AND (sp2.provider_target_code = e.provider_target_code))) AS subword_patterns_ct,
    ( SELECT count(*) AS count
           FROM public.nikl_subword_relations sr
          WHERE ((sr.provider = e.provider) AND (sr.provider_target_code = e.provider_target_code))) AS subword_relations_ct
   FROM (public.nikl_entries e
     JOIN public.nikl_snapshots s ON ((s.snapshot_id = e.raw_snapshot_id)))
  WHERE (s.endpoint = 'view'::text);


--
-- Name: pos_labels_lookup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_labels_lookup (
    lang text NOT NULL,
    pos_ko text NOT NULL,
    label text NOT NULL
);


--
-- Name: saved_document_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_document_sources (
    saved_source_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_key text NOT NULL,
    source_uri text NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_change_log (
    script_no integer NOT NULL,
    script_name text NOT NULL,
    script_sha256 text,
    git_commit text,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sentence_grammar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentence_grammar (
    sentence_id uuid NOT NULL,
    grammar_pattern_id uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sentence_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentence_translations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sentence_id uuid NOT NULL,
    attribution_id uuid NOT NULL,
    language text NOT NULL,
    text text NOT NULL,
    style text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sentence_vocab; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentence_vocab (
    sentence_id uuid NOT NULL,
    vocab_id uuid NOT NULL,
    is_core boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sentences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ko text NOT NULL,
    level text,
    tags text[],
    status text DEFAULT 'provisional'::text NOT NULL,
    source_attribution_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sentences_status_check CHECK ((status = ANY (ARRAY['provisional'::text, 'active'::text, 'deprecated'::text])))
);


--
-- Name: teaching_vocab; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lemma text NOT NULL,
    part_of_speech text NOT NULL,
    level text,
    tags text[],
    status text DEFAULT 'provisional'::text NOT NULL,
    canonical_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pos_code text DEFAULT 'unknown'::text NOT NULL,
    pos_label text,
    CONSTRAINT teaching_vocab_pos_code_check CHECK ((pos_code = ANY (ARRAY['noun'::text, 'pronoun'::text, 'numeral'::text, 'verb'::text, 'adjective'::text, 'adverb'::text, 'determiner'::text, 'particle'::text, 'interjection'::text, 'dependent_noun'::text, 'auxiliary'::text, 'unknown'::text]))),
    CONSTRAINT teaching_vocab_status_check CHECK ((status = ANY (ARRAY['provisional'::text, 'active'::text, 'deprecated'::text])))
);


--
-- Name: teaching_vocab_localized_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_localized_overrides (
    vocab_id uuid NOT NULL,
    sense_index integer NOT NULL,
    lang text NOT NULL,
    word_override text,
    pos_override text,
    definition_override text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teaching_vocab_split_apply_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_split_apply_plan (
    vocab_id uuid NOT NULL,
    sense_index integer NOT NULL,
    gloss_en text NOT NULL,
    vocab_type text NOT NULL,
    part_of_speech text,
    pos_code text,
    pos_label text,
    nikl_target_code text,
    nikl_sense_no integer,
    english_label_override text
);


--
-- Name: teaching_vocab_nikl_suggestions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.teaching_vocab_nikl_suggestions AS
 WITH rem AS (
         SELECT t.vocab_id,
            t.sense_index,
            tv.lemma,
            COALESCE(t.part_of_speech, tv.part_of_speech) AS pos_ko,
            lower(btrim(t.gloss_en)) AS gloss_raw
           FROM (public.teaching_vocab_split_apply_plan t
             JOIN public.teaching_vocab tv ON ((tv.id = t.vocab_id)))
          WHERE ((t.nikl_target_code IS NULL) AND (t.gloss_en IS NOT NULL) AND (btrim(t.gloss_en) <> ''::text))
        ), g_tokens AS (
         SELECT r.vocab_id,
            r.sense_index,
            r.lemma,
            r.pos_ko,
            r.gloss_raw,
            lower(btrim(tok.tok)) AS gtok
           FROM (rem r
             JOIN LATERAL regexp_split_to_table(r.gloss_raw, '[,;]'::text) tok(tok) ON (true))
          WHERE (btrim(tok.tok) <> ''::text)
        ), cand AS (
         SELECT r.vocab_id,
            r.sense_index,
            r.lemma,
            r.pos_ko,
            r.gloss_raw,
            e.provider_target_code AS nikl_target_code,
            s.sense_no AS nikl_sense_no,
            st.trans_word,
            st.trans_definition,
            ( SELECT count(*) AS count
                   FROM (g_tokens gt
                     JOIN LATERAL regexp_split_to_table(COALESCE(st.trans_word, ''::text), '[,;]'::text) tw(tok) ON (true))
                  WHERE ((gt.vocab_id = r.vocab_id) AND (gt.sense_index = r.sense_index) AND (lower(btrim(tw.tok)) = gt.gtok))) AS w_overlap,
            ( SELECT count(*) AS count
                   FROM g_tokens gt
                  WHERE ((gt.vocab_id = r.vocab_id) AND (gt.sense_index = r.sense_index) AND (lower(COALESCE(st.trans_definition, ''::text)) ~~ (('%'::text || gt.gtok) || '%'::text)))) AS d_overlap,
            (((
                CASE
                    WHEN (lower(COALESCE(st.trans_word, ''::text)) ~ '\\b(gwa|gil|dae|ne|nae|si|ti)\\b'::text) THEN 3
                    ELSE 0
                END +
                CASE
                    WHEN (lower(COALESCE(st.trans_definition, ''::text)) ~~ '%the name of the vowel%'::text) THEN 5
                    ELSE 0
                END) +
                CASE
                    WHEN (lower(COALESCE(st.trans_definition, ''::text)) ~~ '%postpositional%'::text) THEN 3
                    ELSE 0
                END) +
                CASE
                    WHEN (lower(COALESCE(st.trans_definition, ''::text)) ~~ '%abbreviated word%'::text) THEN 3
                    ELSE 0
                END) AS penalty
           FROM (((rem r
             JOIN public.nikl_entries e ON ((e.headword = r.lemma)))
             JOIN public.nikl_senses s ON ((s.provider_target_code = e.provider_target_code)))
             LEFT JOIN public.nikl_sense_translations st ON (((st.provider_target_code = e.provider_target_code) AND (st.sense_no = s.sense_no) AND (st.lang = 'en'::text))))
        ), ranked AS (
         SELECT cand.vocab_id,
            cand.sense_index,
            cand.lemma,
            cand.pos_ko,
            cand.gloss_raw,
            cand.nikl_target_code,
            cand.nikl_sense_no,
            cand.trans_word,
            cand.trans_definition,
            cand.w_overlap,
            cand.d_overlap,
            cand.penalty,
            (((cand.w_overlap * 10) + (cand.d_overlap * 2)) - cand.penalty) AS score,
            row_number() OVER (PARTITION BY cand.vocab_id, cand.sense_index ORDER BY (((cand.w_overlap * 10) + (cand.d_overlap * 2)) - cand.penalty) DESC) AS rn
           FROM cand
        )
 SELECT vocab_id,
    sense_index,
    lemma,
    pos_ko,
    gloss_raw,
    max(
        CASE
            WHEN (rn = 1) THEN nikl_target_code
            ELSE NULL::text
        END) AS best_target_code,
    max(
        CASE
            WHEN (rn = 1) THEN nikl_sense_no
            ELSE NULL::integer
        END) AS best_sense_no,
    max(
        CASE
            WHEN (rn = 1) THEN score
            ELSE NULL::bigint
        END) AS best_score,
    max(
        CASE
            WHEN (rn = 1) THEN trans_word
            ELSE NULL::text
        END) AS best_trans_word,
    max(
        CASE
            WHEN (rn = 2) THEN nikl_target_code
            ELSE NULL::text
        END) AS second_target_code,
    max(
        CASE
            WHEN (rn = 2) THEN nikl_sense_no
            ELSE NULL::integer
        END) AS second_sense_no,
    max(
        CASE
            WHEN (rn = 2) THEN score
            ELSE NULL::bigint
        END) AS second_score
   FROM ranked
  WHERE (rn <= 2)
  GROUP BY vocab_id, sense_index, lemma, pos_ko, gloss_raw;


--
-- Name: teaching_vocab_pos_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_pos_staging (
    vocab_id uuid NOT NULL,
    lemma text NOT NULL,
    english_gloss text,
    part_of_speech text NOT NULL,
    pos_code text NOT NULL,
    pos_label text NOT NULL,
    confidence numeric NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teaching_vocab_sense_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_sense_analysis (
    analysis_id uuid DEFAULT gen_random_uuid() NOT NULL,
    vocab_id uuid NOT NULL,
    lemma text NOT NULL,
    english_gloss_raw text,
    sense_index integer NOT NULL,
    sense_key text NOT NULL,
    gloss_en text NOT NULL,
    part_of_speech text NOT NULL,
    pos_code text NOT NULL,
    confidence numeric NOT NULL,
    model text NOT NULL,
    run_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teaching_vocab_set_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_set_items (
    set_code text NOT NULL,
    snapshot_version text NOT NULL,
    vocab_id uuid NOT NULL,
    ordinal integer NOT NULL
);


--
-- Name: teaching_vocab_split; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.teaching_vocab_split AS
 SELECT t.id AS vocab_id,
    ap.sense_index,
    (((t.id)::text || ':'::text) || (ap.sense_index)::text) AS vocab_sense_key,
    t.lemma,
    COALESCE(ap.part_of_speech, t.part_of_speech) AS part_of_speech,
    COALESCE(ap.pos_code, t.pos_code) AS pos_code,
    COALESCE(ap.pos_label, t.pos_label) AS pos_label,
    ap.gloss_en,
    t.level,
    t.tags,
    t.status,
    t.canonical_ref,
    t.created_at,
    t.updated_at
   FROM (public.teaching_vocab_split_apply_plan ap
     JOIN public.teaching_vocab t ON ((t.id = ap.vocab_id)));


--
-- Name: teaching_vocab_split_csv_import; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_vocab_split_csv_import (
    lemma_ko text NOT NULL,
    split boolean NOT NULL,
    gloss_en text NOT NULL,
    part_of_speech text
);


--
-- Name: teaching_vocab_split_nikl; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.teaching_vocab_split_nikl AS
 SELECT tv.lemma,
    ne.pos_ko AS nikl_pos_ko,
    ns.definition_ko AS nikl_definition_ko,
    st.trans_word AS nikl_trans_word_en,
    st.trans_definition AS nikl_trans_definition_en,
    ov_en.word_override AS tv_override_nikl_trans_word_en,
    ov_en.definition_override AS tv_override_nikl_trans_definition_en,
    ov_en.pos_override AS tv_override_en_lookup_from_nikl_pos_ko
   FROM (((((public.teaching_vocab_split_apply_plan ap
     JOIN public.teaching_vocab tv ON ((tv.id = ap.vocab_id)))
     LEFT JOIN public.nikl_entries ne ON (((ne.provider = 'krdict'::text) AND (ne.provider_target_code = ap.nikl_target_code))))
     LEFT JOIN public.nikl_senses ns ON (((ns.provider = 'krdict'::text) AND (ns.provider_target_code = ap.nikl_target_code) AND (ns.sense_no = ap.nikl_sense_no))))
     LEFT JOIN public.nikl_sense_translations st ON (((st.provider = 'krdict'::text) AND (st.provider_target_code = ap.nikl_target_code) AND (st.sense_no = ap.nikl_sense_no) AND (st.lang = 'en'::text) AND (st.idx = 1))))
     LEFT JOIN public.teaching_vocab_localized_overrides ov_en ON (((ov_en.vocab_id = ap.vocab_id) AND (ov_en.sense_index = ap.sense_index) AND (ov_en.lang = 'en'::text))));


--
-- Name: teaching_vocab_split_nikl_debug; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.teaching_vocab_split_nikl_debug AS
 SELECT tvs.vocab_id,
    tvs.sense_index,
    tvs.vocab_sense_key,
    tvs.lemma,
    tvs.part_of_speech,
    tvs.pos_code,
    tvs.pos_label,
    tvs.gloss_en,
    tvs.level,
    tvs.tags,
    tvs.status,
    tvs.canonical_ref,
    tvs.created_at,
    tvs.updated_at,
        CASE
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'pear'::text)) THEN '31454'::text
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'ship'::text)) THEN '29729'::text
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'stomach'::text)) THEN '20211'::text
            ELSE NULL::text
        END AS nikl_target_code,
        CASE
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'pear'::text)) THEN 1
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'ship'::text)) THEN 1
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'stomach'::text)) THEN 2
            ELSE NULL::integer
        END AS nikl_sense_no,
    s.definition_ko AS nikl_definition_ko
   FROM (public.teaching_vocab_split tvs
     LEFT JOIN public.nikl_senses s ON (((s.provider_target_code =
        CASE
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'pear'::text)) THEN '31454'::text
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'ship'::text)) THEN '29729'::text
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'stomach'::text)) THEN '20211'::text
            ELSE NULL::text
        END) AND (s.sense_no =
        CASE
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'pear'::text)) THEN 1
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'ship'::text)) THEN 1
            WHEN ((tvs.lemma = '배'::text) AND (tvs.part_of_speech = '명사'::text) AND (lower(tvs.gloss_en) = 'stomach'::text)) THEN 2
            ELSE NULL::integer
        END))));


--
-- Name: topik_i_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topik_i_staging (
    ordinal integer,
    lemma_ko text,
    gloss_en text
);


--
-- Name: user_dictionary_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_dictionary_pins (
    user_id uuid NOT NULL,
    headword text NOT NULL,
    vocab_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_handles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_handles (
    handle public.citext NOT NULL,
    apple_user_id text,
    kind text NOT NULL,
    primary_handle public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    CONSTRAINT user_handles_kind_check CHECK ((kind = ANY (ARRAY['primary'::text, 'alias'::text])))
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    apple_user_id text,
    schema_version integer NOT NULL,
    settings_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: user_vocab_exposures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_vocab_exposures (
    exposure_id uuid NOT NULL,
    user_id uuid NOT NULL,
    lemma text NOT NULL,
    surface text,
    vocab_id uuid,
    source_kind text NOT NULL,
    source_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_vocab_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_vocab_items (
    user_id uuid NOT NULL,
    lemma text NOT NULL,
    vocab_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_count integer DEFAULT 0 NOT NULL,
    rotation_level_computed smallint DEFAULT 3 NOT NULL,
    rotation_level_override smallint,
    status text DEFAULT 'learning'::text NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_vocab_items_rotation_computed_check CHECK (((rotation_level_computed >= 1) AND (rotation_level_computed <= 5))),
    CONSTRAINT user_vocab_items_rotation_override_check CHECK (((rotation_level_override IS NULL) OR ((rotation_level_override >= 1) AND (rotation_level_override <= 5))))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    apple_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    user_id uuid NOT NULL,
    role text DEFAULT 'student'::text NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    is_root_admin boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    profile_photo_object_key text,
    profile_photo_updated_at timestamp with time zone
);


--
-- Name: v_hanja_character_primary_texts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_hanja_character_primary_texts AS
 SELECT hc.id AS hanja_character_id,
    hc.hanja,
    ko.text_value AS gloss_ko,
    en.text_value AS meaning_en
   FROM ((public.hanja_characters hc
     LEFT JOIN LATERAL ( SELECT ht.text_value
           FROM public.hanja_texts ht
          WHERE ((ht.hanja_character_id = hc.id) AND (ht.text_type = 'gloss'::text) AND (ht.lang = 'ko'::text) AND (ht.is_primary = true))
          ORDER BY ht.created_at DESC
         LIMIT 1) ko ON (true))
     LEFT JOIN LATERAL ( SELECT ht.text_value
           FROM public.hanja_texts ht
          WHERE ((ht.hanja_character_id = hc.id) AND (ht.text_type = 'meaning'::text) AND (ht.lang = 'en'::text) AND (ht.is_primary = true))
          ORDER BY ht.created_at DESC
         LIMIT 1) en ON (true));


--
-- Name: v_hanja_character_primary_texts_top100; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_hanja_character_primary_texts_top100 AS
 SELECT r.rank_global,
    v.hanja_character_id,
    v.hanja,
    v.gloss_ko,
    v.meaning_en,
    concat(v.hanja, ' — ', COALESCE(v.gloss_ko, ''::text),
        CASE
            WHEN ((v.meaning_en IS NOT NULL) AND (v.meaning_en <> ''::text)) THEN ('; '::text || v.meaning_en)
            ELSE ''::text
        END) AS display_line
   FROM (public.v_hanja_character_primary_texts v
     JOIN public.hanja_character_ranking_mv r ON ((r.hanja_character_id = v.hanja_character_id)))
  WHERE (r.rank_global <= 100)
  ORDER BY r.rank_global;


--
-- Name: vocab_glosses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vocab_glosses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vocab_id uuid NOT NULL,
    attribution_id uuid NOT NULL,
    language text NOT NULL,
    text text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nikl_unmapped_fields unmapped_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_unmapped_fields ALTER COLUMN unmapped_id SET DEFAULT nextval('public.nikl_unmapped_fields_unmapped_id_seq'::regclass);


--
-- Name: attributions attributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attributions
    ADD CONSTRAINT attributions_pkey PRIMARY KEY (id);


--
-- Name: auth_identities auth_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (provider, subject, audience);


--
-- Name: docparse_jobs docparse_jobs_one_job_per_run; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docparse_jobs
    ADD CONSTRAINT docparse_jobs_one_job_per_run UNIQUE (parse_run_id);


--
-- Name: docparse_jobs docparse_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docparse_jobs
    ADD CONSTRAINT docparse_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: document_content_item_links document_content_item_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_content_item_links
    ADD CONSTRAINT document_content_item_links_pkey PRIMARY KEY (document_id, content_item_id, link_kind);


--
-- Name: document_parse_runs document_parse_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_parse_runs
    ADD CONSTRAINT document_parse_runs_pkey PRIMARY KEY (parse_run_id);


--
-- Name: document_registry_links document_registry_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_registry_links
    ADD CONSTRAINT document_registry_links_pkey PRIMARY KEY (document_id, parse_run_id, registry_item_id);


--
-- Name: document_vocab_items document_vocab_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_items
    ADD CONSTRAINT document_vocab_items_pkey PRIMARY KEY (document_id, parse_run_id, lemma);


--
-- Name: document_vocab_links document_vocab_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_links
    ADD CONSTRAINT document_vocab_links_pkey PRIMARY KEY (document_id, user_id, lemma);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (document_id);


--
-- Name: google_oauth_connections google_oauth_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_connections
    ADD CONSTRAINT google_oauth_connections_pkey PRIMARY KEY (user_id);


--
-- Name: grammar_pattern_aliases grammar_pattern_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_aliases
    ADD CONSTRAINT grammar_pattern_aliases_pkey PRIMARY KEY (alias_id);


--
-- Name: grammar_pattern_aliases_seed_stage grammar_pattern_aliases_seed_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_aliases_seed_stage
    ADD CONSTRAINT grammar_pattern_aliases_seed_stage_pkey PRIMARY KEY (code, alias_norm);


--
-- Name: grammar_pattern_translations grammar_pattern_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_translations
    ADD CONSTRAINT grammar_pattern_translations_pkey PRIMARY KEY (translation_id);


--
-- Name: grammar_patterns grammar_patterns_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_patterns
    ADD CONSTRAINT grammar_patterns_code_key UNIQUE (code);


--
-- Name: grammar_patterns grammar_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_patterns
    ADD CONSTRAINT grammar_patterns_pkey PRIMARY KEY (id);


--
-- Name: grammar_patterns_seed_stage grammar_patterns_seed_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_patterns_seed_stage
    ADD CONSTRAINT grammar_patterns_seed_stage_pkey PRIMARY KEY (code);


--
-- Name: grammar_rule_families grammar_rule_families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_rule_families
    ADD CONSTRAINT grammar_rule_families_pkey PRIMARY KEY (rule_family);


--
-- Name: hanja_character_levels hanja_character_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_character_levels
    ADD CONSTRAINT hanja_character_levels_pkey PRIMARY KEY (hanja_character_id, level_code);


--
-- Name: hanja_characters hanja_characters_hanja_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_characters
    ADD CONSTRAINT hanja_characters_hanja_key UNIQUE (hanja);


--
-- Name: hanja_characters hanja_characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_characters
    ADD CONSTRAINT hanja_characters_pkey PRIMARY KEY (id);


--
-- Name: hanja_level_labels hanja_level_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_level_labels
    ADD CONSTRAINT hanja_level_labels_pkey PRIMARY KEY (level_code, lang);


--
-- Name: hanja_levels hanja_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_levels
    ADD CONSTRAINT hanja_levels_pkey PRIMARY KEY (level_code);


--
-- Name: hanja_readings hanja_readings_hanja_character_id_reading_hangul_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_readings
    ADD CONSTRAINT hanja_readings_hanja_character_id_reading_hangul_key UNIQUE (hanja_character_id, reading_hangul);


--
-- Name: hanja_readings hanja_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_readings
    ADD CONSTRAINT hanja_readings_pkey PRIMARY KEY (id);


--
-- Name: hanja_texts hanja_texts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_texts
    ADD CONSTRAINT hanja_texts_pkey PRIMARY KEY (id);


--
-- Name: hanja_vocab hanja_vocab_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_vocab
    ADD CONSTRAINT hanja_vocab_pkey PRIMARY KEY (hanja_character_id, vocab_id);


--
-- Name: krdict_hanja_link krdict_hanja_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_hanja_link
    ADD CONSTRAINT krdict_hanja_link_pkey PRIMARY KEY (krdict_entry_id, "position");


--
-- Name: krdict_lexical_entry_fast krdict_lexical_entry_fast_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_lexical_entry_fast
    ADD CONSTRAINT krdict_lexical_entry_fast_pkey PRIMARY KEY (snapshot_version, source_entry_id);


--
-- Name: krdict_lexical_entry krdict_lexical_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_lexical_entry
    ADD CONSTRAINT krdict_lexical_entry_pkey PRIMARY KEY (id);


--
-- Name: krdict_lexical_entry krdict_lexical_entry_snapshot_version_source_entry_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_lexical_entry
    ADD CONSTRAINT krdict_lexical_entry_snapshot_version_source_entry_id_key UNIQUE (snapshot_version, source_entry_id);


--
-- Name: krdict_term_bank krdict_term_bank_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_term_bank
    ADD CONSTRAINT krdict_term_bank_pkey PRIMARY KEY (term, pos, level);


--
-- Name: library_moderation_actions library_moderation_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_moderation_actions
    ADD CONSTRAINT library_moderation_actions_pkey PRIMARY KEY (id);


--
-- Name: library_registry_items library_registry_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_registry_items
    ADD CONSTRAINT library_registry_items_pkey PRIMARY KEY (id);


--
-- Name: library_registry_items library_registry_items_unique_content; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_registry_items
    ADD CONSTRAINT library_registry_items_unique_content UNIQUE (content_type, content_id);


--
-- Name: library_review_queue library_review_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_review_queue
    ADD CONSTRAINT library_review_queue_pkey PRIMARY KEY (id);


--
-- Name: library_share_grants library_share_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_share_grants
    ADD CONSTRAINT library_share_grants_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (asset_id);


--
-- Name: nikl_entries nikl_entries_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entries
    ADD CONSTRAINT nikl_entries_pk PRIMARY KEY (provider, provider_target_code);


--
-- Name: nikl_entry_categories nikl_entry_categories_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_categories
    ADD CONSTRAINT nikl_entry_categories_pk PRIMARY KEY (provider, provider_target_code, category_type, idx);


--
-- Name: nikl_entry_conjugations nikl_entry_conjugations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_conjugations
    ADD CONSTRAINT nikl_entry_conjugations_pk PRIMARY KEY (provider, provider_target_code, idx);


--
-- Name: nikl_entry_hanja_link nikl_entry_hanja_link_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja_link
    ADD CONSTRAINT nikl_entry_hanja_link_pk PRIMARY KEY (provider, provider_target_code, hanja_character_id);


--
-- Name: nikl_entry_hanja nikl_entry_hanja_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja
    ADD CONSTRAINT nikl_entry_hanja_pk PRIMARY KEY (provider, provider_target_code, hanja_text);


--
-- Name: nikl_entry_loanword_origin nikl_entry_loanword_origin_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_loanword_origin
    ADD CONSTRAINT nikl_entry_loanword_origin_pk PRIMARY KEY (provider, provider_target_code, idx);


--
-- Name: nikl_entry_pronunciations nikl_entry_pronunciations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_pronunciations
    ADD CONSTRAINT nikl_entry_pronunciations_pk PRIMARY KEY (provider, provider_target_code, idx);


--
-- Name: nikl_label_map nikl_label_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_label_map
    ADD CONSTRAINT nikl_label_map_pkey PRIMARY KEY (domain, label_ko, lang);


--
-- Name: nikl_sense_examples nikl_sense_examples_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_examples
    ADD CONSTRAINT nikl_sense_examples_pk PRIMARY KEY (provider, provider_target_code, sense_no, idx);


--
-- Name: nikl_sense_multimedia nikl_sense_multimedia_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_multimedia
    ADD CONSTRAINT nikl_sense_multimedia_pk PRIMARY KEY (provider, provider_target_code, sense_no, idx);


--
-- Name: nikl_sense_patterns nikl_sense_patterns_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_patterns
    ADD CONSTRAINT nikl_sense_patterns_pk PRIMARY KEY (provider, provider_target_code, sense_no, idx);


--
-- Name: nikl_sense_relations nikl_sense_relations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_relations
    ADD CONSTRAINT nikl_sense_relations_pk PRIMARY KEY (provider, provider_target_code, sense_no, idx);


--
-- Name: nikl_sense_translations nikl_sense_translations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_translations
    ADD CONSTRAINT nikl_sense_translations_pk PRIMARY KEY (provider, provider_target_code, sense_no, idx);


--
-- Name: nikl_senses nikl_senses_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_senses
    ADD CONSTRAINT nikl_senses_pk PRIMARY KEY (provider, provider_target_code, sense_no);


--
-- Name: nikl_snapshots nikl_snapshots_endpoint_target_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_snapshots
    ADD CONSTRAINT nikl_snapshots_endpoint_target_code_key UNIQUE (endpoint, target_code);


--
-- Name: nikl_snapshots nikl_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_snapshots
    ADD CONSTRAINT nikl_snapshots_pkey PRIMARY KEY (snapshot_id);


--
-- Name: nikl_subword_examples nikl_subword_examples_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_examples
    ADD CONSTRAINT nikl_subword_examples_pk PRIMARY KEY (provider, provider_target_code, subword_no, subsense_no, idx);


--
-- Name: nikl_subword_patterns nikl_subword_patterns_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_patterns
    ADD CONSTRAINT nikl_subword_patterns_pk PRIMARY KEY (provider, provider_target_code, subword_no, subsense_no, idx);


--
-- Name: nikl_subword_relations nikl_subword_relations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_relations
    ADD CONSTRAINT nikl_subword_relations_pk PRIMARY KEY (provider, provider_target_code, subword_no, subsense_no, idx);


--
-- Name: nikl_subword_senses nikl_subword_senses_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_senses
    ADD CONSTRAINT nikl_subword_senses_pk PRIMARY KEY (provider, provider_target_code, subword_no, subsense_no);


--
-- Name: nikl_subwords nikl_subwords_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subwords
    ADD CONSTRAINT nikl_subwords_pk PRIMARY KEY (provider, provider_target_code, subword_no);


--
-- Name: nikl_target_codes nikl_target_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_target_codes
    ADD CONSTRAINT nikl_target_codes_pkey PRIMARY KEY (target_code);


--
-- Name: nikl_target_codes_stage nikl_target_codes_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_target_codes_stage
    ADD CONSTRAINT nikl_target_codes_stage_pkey PRIMARY KEY (target_code);


--
-- Name: nikl_unmapped_fields nikl_unmapped_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_unmapped_fields
    ADD CONSTRAINT nikl_unmapped_fields_pkey PRIMARY KEY (unmapped_id);


--
-- Name: pos_labels_lookup pos_labels_lookup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_labels_lookup
    ADD CONSTRAINT pos_labels_lookup_pkey PRIMARY KEY (lang, pos_ko);


--
-- Name: content_item_audio_variants reading_item_audio_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_item_audio_variants
    ADD CONSTRAINT reading_item_audio_variants_pkey PRIMARY KEY (content_item_audio_variant_id);


--
-- Name: content_items reading_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT reading_items_pkey PRIMARY KEY (content_item_id);


--
-- Name: saved_document_sources saved_document_sources_owner_user_id_source_kind_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_document_sources
    ADD CONSTRAINT saved_document_sources_owner_user_id_source_kind_source_key_key UNIQUE (owner_user_id, source_kind, source_key);


--
-- Name: saved_document_sources saved_document_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_document_sources
    ADD CONSTRAINT saved_document_sources_pkey PRIMARY KEY (saved_source_id);


--
-- Name: schema_change_log schema_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_change_log
    ADD CONSTRAINT schema_change_log_pkey PRIMARY KEY (script_no);


--
-- Name: sentence_grammar sentence_grammar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_grammar
    ADD CONSTRAINT sentence_grammar_pkey PRIMARY KEY (sentence_id, grammar_pattern_id);


--
-- Name: sentence_translations sentence_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_translations
    ADD CONSTRAINT sentence_translations_pkey PRIMARY KEY (id);


--
-- Name: sentence_translations sentence_translations_sentence_id_language_text_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_translations
    ADD CONSTRAINT sentence_translations_sentence_id_language_text_key UNIQUE (sentence_id, language, text);


--
-- Name: sentence_vocab sentence_vocab_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_vocab
    ADD CONSTRAINT sentence_vocab_pkey PRIMARY KEY (sentence_id, vocab_id);


--
-- Name: sentences sentences_ko_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentences
    ADD CONSTRAINT sentences_ko_key UNIQUE (ko);


--
-- Name: sentences sentences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentences
    ADD CONSTRAINT sentences_pkey PRIMARY KEY (id);


--
-- Name: teaching_vocab teaching_vocab_lemma_part_of_speech_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab
    ADD CONSTRAINT teaching_vocab_lemma_part_of_speech_key UNIQUE (lemma, part_of_speech);


--
-- Name: teaching_vocab_localized_overrides teaching_vocab_localized_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_localized_overrides
    ADD CONSTRAINT teaching_vocab_localized_overrides_pkey PRIMARY KEY (vocab_id, sense_index, lang);


--
-- Name: teaching_vocab teaching_vocab_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab
    ADD CONSTRAINT teaching_vocab_pkey PRIMARY KEY (id);


--
-- Name: teaching_vocab_pos_staging teaching_vocab_pos_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_pos_staging
    ADD CONSTRAINT teaching_vocab_pos_staging_pkey PRIMARY KEY (vocab_id);


--
-- Name: teaching_vocab_sense_analysis teaching_vocab_sense_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_sense_analysis
    ADD CONSTRAINT teaching_vocab_sense_analysis_pkey PRIMARY KEY (analysis_id);


--
-- Name: teaching_vocab_sense_analysis teaching_vocab_sense_analysis_run_id_vocab_id_sense_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_sense_analysis
    ADD CONSTRAINT teaching_vocab_sense_analysis_run_id_vocab_id_sense_index_key UNIQUE (run_id, vocab_id, sense_index);


--
-- Name: teaching_vocab_set_items teaching_vocab_set_items_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_set_items
    ADD CONSTRAINT teaching_vocab_set_items_ordinal_unique UNIQUE (set_code, snapshot_version, ordinal);


--
-- Name: teaching_vocab_set_items teaching_vocab_set_items_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_set_items
    ADD CONSTRAINT teaching_vocab_set_items_pk PRIMARY KEY (set_code, snapshot_version, vocab_id);


--
-- Name: teaching_vocab_split_apply_plan teaching_vocab_split_apply_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_split_apply_plan
    ADD CONSTRAINT teaching_vocab_split_apply_plan_pkey PRIMARY KEY (vocab_id, sense_index);


--
-- Name: library_share_grants uq_active_library_share_grant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_share_grants
    ADD CONSTRAINT uq_active_library_share_grant UNIQUE (content_type, content_id, grant_type, grantee_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: content_item_audio_variants uq_content_item_variant_cell; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_item_audio_variants
    ADD CONSTRAINT uq_content_item_variant_cell UNIQUE (content_item_id, voice_gender, speed);


--
-- Name: grammar_pattern_aliases uq_grammar_pattern_alias_norm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_aliases
    ADD CONSTRAINT uq_grammar_pattern_alias_norm UNIQUE (grammar_pattern_id, alias_norm);


--
-- Name: grammar_pattern_translations uq_grammar_pattern_translations_one_per_field; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_translations
    ADD CONSTRAINT uq_grammar_pattern_translations_one_per_field UNIQUE (grammar_pattern_id, lang, field);


--
-- Name: media_assets uq_media_assets_owner_object_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT uq_media_assets_owner_object_key UNIQUE (owner_user_id, object_key);


--
-- Name: user_dictionary_pins user_dictionary_pins_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_dictionary_pins
    ADD CONSTRAINT user_dictionary_pins_pk PRIMARY KEY (user_id, headword);


--
-- Name: user_handles user_handles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_handles
    ADD CONSTRAINT user_handles_pkey PRIMARY KEY (handle);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: user_vocab_exposures user_vocab_exposures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_exposures
    ADD CONSTRAINT user_vocab_exposures_pkey PRIMARY KEY (exposure_id);


--
-- Name: user_vocab_items user_vocab_items_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_items
    ADD CONSTRAINT user_vocab_items_pk PRIMARY KEY (user_id, lemma);


--
-- Name: users users_apple_user_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_apple_user_id_uk UNIQUE (apple_user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: vocab_glosses vocab_glosses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocab_glosses
    ADD CONSTRAINT vocab_glosses_pkey PRIMARY KEY (id);


--
-- Name: vocab_glosses vocab_glosses_vocab_id_language_text_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocab_glosses
    ADD CONSTRAINT vocab_glosses_vocab_id_language_text_key UNIQUE (vocab_id, language, text);


--
-- Name: idx_auth_identities_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_identities_user_id ON public.auth_identities USING btree (user_id);


--
-- Name: idx_content_item_audio_variants_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_item_audio_variants_asset ON public.content_item_audio_variants USING btree (asset_id);


--
-- Name: idx_content_item_audio_variants_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_item_audio_variants_item ON public.content_item_audio_variants USING btree (content_item_id);


--
-- Name: idx_content_items_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_items_owner ON public.content_items USING btree (owner_user_id);


--
-- Name: idx_dcil_session_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dcil_session_date ON public.document_content_item_links USING btree (session_date) WHERE (session_date IS NOT NULL);


--
-- Name: idx_doc_content_links_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_content_links_doc ON public.document_content_item_links USING btree (document_id);


--
-- Name: idx_doc_content_links_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_content_links_item ON public.document_content_item_links USING btree (content_item_id);


--
-- Name: idx_doc_vocab_links_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_vocab_links_doc ON public.document_vocab_links USING btree (document_id);


--
-- Name: idx_doc_vocab_links_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_vocab_links_user ON public.document_vocab_links USING btree (user_id);


--
-- Name: idx_docparse_jobs_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docparse_jobs_document ON public.docparse_jobs USING btree (document_id);


--
-- Name: idx_docparse_jobs_locked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docparse_jobs_locked_at ON public.docparse_jobs USING btree (locked_at);


--
-- Name: idx_docparse_jobs_status_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docparse_jobs_status_available ON public.docparse_jobs USING btree (status, available_at);


--
-- Name: idx_document_parse_runs_doc_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_parse_runs_doc_time ON public.document_parse_runs USING btree (document_id, started_at DESC);


--
-- Name: idx_document_parse_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_parse_runs_status ON public.document_parse_runs USING btree (status);


--
-- Name: idx_document_registry_links_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_registry_links_doc ON public.document_registry_links USING btree (document_id);


--
-- Name: idx_document_registry_links_registry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_registry_links_registry ON public.document_registry_links USING btree (registry_item_id);


--
-- Name: idx_document_registry_links_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_registry_links_run ON public.document_registry_links USING btree (parse_run_id);


--
-- Name: idx_document_vocab_items_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_vocab_items_doc ON public.document_vocab_items USING btree (document_id);


--
-- Name: idx_document_vocab_items_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_vocab_items_run ON public.document_vocab_items USING btree (parse_run_id);


--
-- Name: idx_document_vocab_items_vocab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_vocab_items_vocab_id ON public.document_vocab_items USING btree (vocab_id);


--
-- Name: idx_documents_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_asset ON public.documents USING btree (asset_id);


--
-- Name: idx_documents_ingest_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_ingest_status ON public.documents USING btree (ingest_status);


--
-- Name: idx_documents_owner_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_owner_created ON public.documents USING btree (owner_user_id, created_at DESC);


--
-- Name: idx_dvl_session_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dvl_session_date ON public.document_vocab_links USING btree (session_date) WHERE (session_date IS NOT NULL);


--
-- Name: idx_google_oauth_connections_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_oauth_connections_updated ON public.google_oauth_connections USING btree (updated_at DESC);


--
-- Name: idx_gpa_alias_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpa_alias_norm ON public.grammar_pattern_aliases USING btree (alias_norm);


--
-- Name: idx_gpa_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpa_pattern ON public.grammar_pattern_aliases USING btree (grammar_pattern_id);


--
-- Name: idx_gpass_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpass_norm ON public.grammar_pattern_aliases_seed_stage USING btree (alias_norm);


--
-- Name: idx_gpss_cefr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpss_cefr ON public.grammar_patterns_seed_stage USING btree (cefr_min, cefr_max);


--
-- Name: idx_gpss_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpss_group ON public.grammar_patterns_seed_stage USING btree (pattern_group);


--
-- Name: idx_gpt_lang_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpt_lang_field ON public.grammar_pattern_translations USING btree (lang, field);


--
-- Name: idx_gpt_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpt_pattern ON public.grammar_pattern_translations USING btree (grammar_pattern_id);


--
-- Name: idx_grammar_patterns_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grammar_patterns_active ON public.grammar_patterns USING btree (active) WHERE (active = true);


--
-- Name: idx_grammar_patterns_cefr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grammar_patterns_cefr ON public.grammar_patterns USING btree (cefr_min, cefr_max);


--
-- Name: idx_grammar_patterns_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grammar_patterns_group ON public.grammar_patterns USING btree (pattern_group);


--
-- Name: idx_khl_hanja_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_khl_hanja_character ON public.krdict_hanja_link USING btree (hanja_character_id);


--
-- Name: idx_khl_krdict_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_khl_krdict_entry ON public.krdict_hanja_link USING btree (krdict_entry_id);


--
-- Name: idx_krdict_fast_hanja; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_krdict_fast_hanja ON public.krdict_lexical_entry_fast USING btree (hanja) WHERE (hanja IS NOT NULL);


--
-- Name: idx_krdict_fast_headword; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_krdict_fast_headword ON public.krdict_lexical_entry_fast USING btree (headword);


--
-- Name: idx_krdict_fast_pos; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_krdict_fast_pos ON public.krdict_lexical_entry_fast USING btree (pos);


--
-- Name: idx_krdict_headword; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_krdict_headword ON public.krdict_lexical_entry USING btree (headword);


--
-- Name: idx_krdict_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_krdict_snapshot ON public.krdict_lexical_entry USING btree (snapshot_version);


--
-- Name: idx_library_registry_global_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_registry_global_active ON public.library_registry_items USING btree (global_state, created_at DESC) WHERE ((audience = 'global'::text) AND (operational_status = 'active'::text) AND (global_state = ANY (ARRAY['preliminary'::text, 'approved'::text])));


--
-- Name: idx_library_registry_under_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_registry_under_review ON public.library_registry_items USING btree (created_at DESC) WHERE (operational_status = 'under_review'::text);


--
-- Name: idx_library_review_queue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_review_queue_open ON public.library_review_queue USING btree (flagged_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: idx_library_share_grants_active_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_share_grants_active_content ON public.library_share_grants USING btree (content_type, content_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_library_share_grants_active_grantee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_share_grants_active_grantee ON public.library_share_grants USING btree (grant_type, grantee_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_lma_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lma_actor_created ON public.library_moderation_actions USING btree (actor_user_id, created_at DESC);


--
-- Name: idx_lma_content_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lma_content_created ON public.library_moderation_actions USING btree (content_type, content_id, created_at DESC);


--
-- Name: idx_lma_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lma_created_at ON public.library_moderation_actions USING btree (created_at DESC);


--
-- Name: idx_media_assets_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_created_at ON public.media_assets USING btree (created_at);


--
-- Name: idx_media_assets_owner_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_owner_user_id ON public.media_assets USING btree (owner_user_id);


--
-- Name: idx_nikl_entries_grade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entries_grade ON public.nikl_entries USING btree (word_grade_ko);


--
-- Name: idx_nikl_entries_headword; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entries_headword ON public.nikl_entries USING btree (headword);


--
-- Name: idx_nikl_entries_pos; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entries_pos ON public.nikl_entries USING btree (pos_ko);


--
-- Name: idx_nikl_entries_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entries_snapshot ON public.nikl_entries USING btree (raw_snapshot_id);


--
-- Name: idx_nikl_entry_categories_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_categories_target ON public.nikl_entry_categories USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_entry_categories_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_categories_type ON public.nikl_entry_categories USING btree (category_type);


--
-- Name: idx_nikl_entry_conjugations_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_conjugations_target ON public.nikl_entry_conjugations USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_entry_hanja_link_hanja; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_hanja_link_hanja ON public.nikl_entry_hanja_link USING btree (hanja_character_id);


--
-- Name: idx_nikl_entry_hanja_link_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_hanja_link_target ON public.nikl_entry_hanja_link USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_entry_hanja_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_hanja_target ON public.nikl_entry_hanja USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_entry_loanword_origin_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_loanword_origin_target ON public.nikl_entry_loanword_origin USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_entry_pronunciations_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_entry_pronunciations_target ON public.nikl_entry_pronunciations USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_sense_examples_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_examples_target_sense ON public.nikl_sense_examples USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_sense_examples_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_examples_type ON public.nikl_sense_examples USING btree (example_type_ko);


--
-- Name: idx_nikl_sense_multimedia_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_multimedia_target_sense ON public.nikl_sense_multimedia USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_sense_multimedia_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_multimedia_type ON public.nikl_sense_multimedia USING btree (media_type_ko);


--
-- Name: idx_nikl_sense_patterns_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_patterns_target_sense ON public.nikl_sense_patterns USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_sense_relations_link_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_relations_link_target ON public.nikl_sense_relations USING btree (link_target_code);


--
-- Name: idx_nikl_sense_relations_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_relations_target_sense ON public.nikl_sense_relations USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_sense_translations_lang; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_translations_lang ON public.nikl_sense_translations USING btree (lang);


--
-- Name: idx_nikl_sense_translations_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_sense_translations_target_sense ON public.nikl_sense_translations USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_senses_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_senses_target ON public.nikl_senses USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_senses_target_sense; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_senses_target_sense ON public.nikl_senses USING btree (provider, provider_target_code, sense_no);


--
-- Name: idx_nikl_snapshots_view_unparsed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_snapshots_view_unparsed ON public.nikl_snapshots USING btree (endpoint, parsed_at) WHERE (endpoint = 'view'::text);


--
-- Name: idx_nikl_subword_examples_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subword_examples_target ON public.nikl_subword_examples USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_subword_patterns_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subword_patterns_target ON public.nikl_subword_patterns USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_subword_relations_link_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subword_relations_link_target ON public.nikl_subword_relations USING btree (link_target_code);


--
-- Name: idx_nikl_subword_relations_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subword_relations_target ON public.nikl_subword_relations USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_subword_senses_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subword_senses_target ON public.nikl_subword_senses USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_subwords_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_subwords_target ON public.nikl_subwords USING btree (provider, provider_target_code);


--
-- Name: idx_nikl_target_codes_first_seen_lemma; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_target_codes_first_seen_lemma ON public.nikl_target_codes USING btree (first_seen_lemma);


--
-- Name: idx_nikl_unmapped_fields_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nikl_unmapped_fields_target ON public.nikl_unmapped_fields USING btree (provider, provider_target_code);


--
-- Name: idx_saved_document_sources_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_document_sources_owner_updated ON public.saved_document_sources USING btree (owner_user_id, updated_at DESC);


--
-- Name: idx_teaching_vocab_localized_overrides_lang; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teaching_vocab_localized_overrides_lang ON public.teaching_vocab_localized_overrides USING btree (lang);


--
-- Name: idx_teaching_vocab_set_items_set; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teaching_vocab_set_items_set ON public.teaching_vocab_set_items USING btree (set_code, snapshot_version);


--
-- Name: idx_teaching_vocab_set_items_vocab; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teaching_vocab_set_items_vocab ON public.teaching_vocab_set_items USING btree (vocab_id);


--
-- Name: idx_user_dictionary_pins_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_dictionary_pins_user_created ON public.user_dictionary_pins USING btree (user_id, created_at DESC);


--
-- Name: idx_user_dictionary_pins_vocab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_dictionary_pins_vocab_id ON public.user_dictionary_pins USING btree (vocab_id);


--
-- Name: idx_user_handles_primary_handle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_handles_primary_handle ON public.user_handles USING btree (primary_handle);


--
-- Name: idx_user_handles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_handles_user_id ON public.user_handles USING btree (user_id);


--
-- Name: idx_user_profiles_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_updated_at ON public.user_profiles USING btree (updated_at);


--
-- Name: idx_user_vocab_exposures_user_lemma; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_exposures_user_lemma ON public.user_vocab_exposures USING btree (user_id, lemma);


--
-- Name: idx_user_vocab_exposures_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_exposures_user_time ON public.user_vocab_exposures USING btree (user_id, occurred_at DESC);


--
-- Name: idx_user_vocab_exposures_vocab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_exposures_vocab_id ON public.user_vocab_exposures USING btree (vocab_id);


--
-- Name: idx_user_vocab_items_user_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_items_user_last_seen ON public.user_vocab_items USING btree (user_id, last_seen_at DESC);


--
-- Name: idx_user_vocab_items_user_rotation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_items_user_rotation ON public.user_vocab_items USING btree (user_id, rotation_level_computed);


--
-- Name: idx_user_vocab_items_vocab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_vocab_items_vocab_id ON public.user_vocab_items USING btree (vocab_id);


--
-- Name: ix_hanja_texts_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_hanja_texts_lookup ON public.hanja_texts USING btree (text_type, lang, hanja_character_id);


--
-- Name: uq_content_item_audio_variants_one_default_per_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_content_item_audio_variants_one_default_per_item ON public.content_item_audio_variants USING btree (content_item_id) WHERE (is_default = true);


--
-- Name: uq_hanja_character_ranking_mv_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_hanja_character_ranking_mv_id ON public.hanja_character_ranking_mv USING btree (hanja_character_id);


--
-- Name: uq_library_review_queue_one_open_per_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_library_review_queue_one_open_per_item ON public.library_review_queue USING btree (registry_item_id) WHERE (resolved_at IS NULL);


--
-- Name: uq_nikl_unmapped_fields_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_nikl_unmapped_fields_dedupe ON public.nikl_unmapped_fields USING btree (snapshot_id, xml_path, COALESCE(provider_target_code, ''::text), COALESCE(raw_value, ''::text));


--
-- Name: uq_user_handles_one_primary_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_handles_one_primary_per_user ON public.user_handles USING btree (user_id) WHERE (kind = 'primary'::text);


--
-- Name: uq_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_user_id ON public.users USING btree (user_id);


--
-- Name: users_is_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_is_admin_idx ON public.users USING btree (is_admin) WHERE (is_admin = true);


--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role);


--
-- Name: users_user_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_user_id_uidx ON public.users USING btree (user_id);


--
-- Name: ux_hanja_texts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_hanja_texts_unique ON public.hanja_texts USING btree (hanja_character_id, text_type, lang, text_value);


--
-- Name: media_assets trg_media_assets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_media_assets_set_updated_at BEFORE UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: auth_identities auth_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: docparse_jobs docparse_jobs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docparse_jobs
    ADD CONSTRAINT docparse_jobs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: docparse_jobs docparse_jobs_parse_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docparse_jobs
    ADD CONSTRAINT docparse_jobs_parse_run_id_fkey FOREIGN KEY (parse_run_id) REFERENCES public.document_parse_runs(parse_run_id) ON DELETE CASCADE;


--
-- Name: document_content_item_links document_content_item_links_content_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_content_item_links
    ADD CONSTRAINT document_content_item_links_content_item_id_fkey FOREIGN KEY (content_item_id) REFERENCES public.content_items(content_item_id) ON DELETE CASCADE;


--
-- Name: document_content_item_links document_content_item_links_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_content_item_links
    ADD CONSTRAINT document_content_item_links_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: document_parse_runs document_parse_runs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_parse_runs
    ADD CONSTRAINT document_parse_runs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: document_registry_links document_registry_links_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_registry_links
    ADD CONSTRAINT document_registry_links_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: document_registry_links document_registry_links_parse_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_registry_links
    ADD CONSTRAINT document_registry_links_parse_run_id_fkey FOREIGN KEY (parse_run_id) REFERENCES public.document_parse_runs(parse_run_id) ON DELETE CASCADE;


--
-- Name: document_registry_links document_registry_links_registry_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_registry_links
    ADD CONSTRAINT document_registry_links_registry_item_id_fkey FOREIGN KEY (registry_item_id) REFERENCES public.library_registry_items(id) ON DELETE RESTRICT;


--
-- Name: document_vocab_items document_vocab_items_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_items
    ADD CONSTRAINT document_vocab_items_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: document_vocab_items document_vocab_items_parse_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_items
    ADD CONSTRAINT document_vocab_items_parse_run_id_fkey FOREIGN KEY (parse_run_id) REFERENCES public.document_parse_runs(parse_run_id) ON DELETE CASCADE;


--
-- Name: document_vocab_items document_vocab_items_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_items
    ADD CONSTRAINT document_vocab_items_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE SET NULL;


--
-- Name: document_vocab_links document_vocab_links_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_links
    ADD CONSTRAINT document_vocab_links_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id) ON DELETE CASCADE;


--
-- Name: document_vocab_links document_vocab_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_vocab_links
    ADD CONSTRAINT document_vocab_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: documents documents_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(asset_id) ON DELETE RESTRICT;


--
-- Name: documents documents_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: teaching_vocab_localized_overrides fk_teaching_vocab_override_vocab; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_localized_overrides
    ADD CONSTRAINT fk_teaching_vocab_override_vocab FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: user_handles fk_user_handles_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_handles
    ADD CONSTRAINT fk_user_handles_user_id FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_profiles fk_user_profiles_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT fk_user_profiles_user_id FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: google_oauth_connections google_oauth_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_connections
    ADD CONSTRAINT google_oauth_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: grammar_pattern_aliases grammar_pattern_aliases_grammar_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_aliases
    ADD CONSTRAINT grammar_pattern_aliases_grammar_pattern_id_fkey FOREIGN KEY (grammar_pattern_id) REFERENCES public.grammar_patterns(id) ON DELETE CASCADE;


--
-- Name: grammar_pattern_translations grammar_pattern_translations_attribution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_translations
    ADD CONSTRAINT grammar_pattern_translations_attribution_id_fkey FOREIGN KEY (attribution_id) REFERENCES public.attributions(id);


--
-- Name: grammar_pattern_translations grammar_pattern_translations_grammar_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_pattern_translations
    ADD CONSTRAINT grammar_pattern_translations_grammar_pattern_id_fkey FOREIGN KEY (grammar_pattern_id) REFERENCES public.grammar_patterns(id) ON DELETE CASCADE;


--
-- Name: grammar_patterns grammar_patterns_explanation_attribution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grammar_patterns
    ADD CONSTRAINT grammar_patterns_explanation_attribution_id_fkey FOREIGN KEY (explanation_attribution_id) REFERENCES public.attributions(id);


--
-- Name: hanja_character_levels hanja_character_levels_hanja_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_character_levels
    ADD CONSTRAINT hanja_character_levels_hanja_character_id_fkey FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id) ON DELETE CASCADE;


--
-- Name: hanja_character_levels hanja_character_levels_level_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_character_levels
    ADD CONSTRAINT hanja_character_levels_level_code_fkey FOREIGN KEY (level_code) REFERENCES public.hanja_levels(level_code) ON DELETE RESTRICT;


--
-- Name: hanja_level_labels hanja_level_labels_level_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_level_labels
    ADD CONSTRAINT hanja_level_labels_level_code_fkey FOREIGN KEY (level_code) REFERENCES public.hanja_levels(level_code) ON DELETE CASCADE;


--
-- Name: hanja_readings hanja_readings_hanja_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_readings
    ADD CONSTRAINT hanja_readings_hanja_character_id_fkey FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id) ON DELETE CASCADE;


--
-- Name: hanja_texts hanja_texts_hanja_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_texts
    ADD CONSTRAINT hanja_texts_hanja_character_id_fkey FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id) ON DELETE CASCADE;


--
-- Name: hanja_vocab hanja_vocab_hanja_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_vocab
    ADD CONSTRAINT hanja_vocab_hanja_character_id_fkey FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id) ON DELETE CASCADE;


--
-- Name: hanja_vocab hanja_vocab_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hanja_vocab
    ADD CONSTRAINT hanja_vocab_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: krdict_hanja_link krdict_hanja_link_hanja_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_hanja_link
    ADD CONSTRAINT krdict_hanja_link_hanja_character_id_fkey FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id);


--
-- Name: krdict_hanja_link krdict_hanja_link_krdict_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.krdict_hanja_link
    ADD CONSTRAINT krdict_hanja_link_krdict_entry_id_fkey FOREIGN KEY (krdict_entry_id) REFERENCES public.krdict_lexical_entry(id);


--
-- Name: library_review_queue library_review_queue_registry_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_review_queue
    ADD CONSTRAINT library_review_queue_registry_item_id_fkey FOREIGN KEY (registry_item_id) REFERENCES public.library_registry_items(id) ON DELETE RESTRICT;


--
-- Name: media_assets media_assets_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: nikl_entries nikl_entries_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entries
    ADD CONSTRAINT nikl_entries_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_categories nikl_entry_categories_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_categories
    ADD CONSTRAINT nikl_entry_categories_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_categories nikl_entry_categories_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_categories
    ADD CONSTRAINT nikl_entry_categories_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_conjugations nikl_entry_conjugations_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_conjugations
    ADD CONSTRAINT nikl_entry_conjugations_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_conjugations nikl_entry_conjugations_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_conjugations
    ADD CONSTRAINT nikl_entry_conjugations_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_hanja nikl_entry_hanja_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja
    ADD CONSTRAINT nikl_entry_hanja_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_hanja_link nikl_entry_hanja_link_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja_link
    ADD CONSTRAINT nikl_entry_hanja_link_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_hanja_link nikl_entry_hanja_link_hanja_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja_link
    ADD CONSTRAINT nikl_entry_hanja_link_hanja_fk FOREIGN KEY (hanja_character_id) REFERENCES public.hanja_characters(id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_hanja_link nikl_entry_hanja_link_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja_link
    ADD CONSTRAINT nikl_entry_hanja_link_snapshot_fk FOREIGN KEY (source_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_hanja nikl_entry_hanja_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_hanja
    ADD CONSTRAINT nikl_entry_hanja_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_loanword_origin nikl_entry_loanword_origin_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_loanword_origin
    ADD CONSTRAINT nikl_entry_loanword_origin_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_loanword_origin nikl_entry_loanword_origin_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_loanword_origin
    ADD CONSTRAINT nikl_entry_loanword_origin_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_entry_pronunciations nikl_entry_pronunciations_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_pronunciations
    ADD CONSTRAINT nikl_entry_pronunciations_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_entry_pronunciations nikl_entry_pronunciations_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_entry_pronunciations
    ADD CONSTRAINT nikl_entry_pronunciations_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_sense_examples nikl_sense_examples_sense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_examples
    ADD CONSTRAINT nikl_sense_examples_sense_fk FOREIGN KEY (provider, provider_target_code, sense_no) REFERENCES public.nikl_senses(provider, provider_target_code, sense_no) ON DELETE CASCADE;


--
-- Name: nikl_sense_examples nikl_sense_examples_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_examples
    ADD CONSTRAINT nikl_sense_examples_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_sense_multimedia nikl_sense_multimedia_sense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_multimedia
    ADD CONSTRAINT nikl_sense_multimedia_sense_fk FOREIGN KEY (provider, provider_target_code, sense_no) REFERENCES public.nikl_senses(provider, provider_target_code, sense_no) ON DELETE CASCADE;


--
-- Name: nikl_sense_multimedia nikl_sense_multimedia_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_multimedia
    ADD CONSTRAINT nikl_sense_multimedia_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_sense_patterns nikl_sense_patterns_sense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_patterns
    ADD CONSTRAINT nikl_sense_patterns_sense_fk FOREIGN KEY (provider, provider_target_code, sense_no) REFERENCES public.nikl_senses(provider, provider_target_code, sense_no) ON DELETE CASCADE;


--
-- Name: nikl_sense_patterns nikl_sense_patterns_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_patterns
    ADD CONSTRAINT nikl_sense_patterns_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_sense_relations nikl_sense_relations_sense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_relations
    ADD CONSTRAINT nikl_sense_relations_sense_fk FOREIGN KEY (provider, provider_target_code, sense_no) REFERENCES public.nikl_senses(provider, provider_target_code, sense_no) ON DELETE CASCADE;


--
-- Name: nikl_sense_relations nikl_sense_relations_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_relations
    ADD CONSTRAINT nikl_sense_relations_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_sense_translations nikl_sense_translations_sense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_translations
    ADD CONSTRAINT nikl_sense_translations_sense_fk FOREIGN KEY (provider, provider_target_code, sense_no) REFERENCES public.nikl_senses(provider, provider_target_code, sense_no) ON DELETE CASCADE;


--
-- Name: nikl_sense_translations nikl_sense_translations_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_sense_translations
    ADD CONSTRAINT nikl_sense_translations_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_senses nikl_senses_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_senses
    ADD CONSTRAINT nikl_senses_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_senses nikl_senses_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_senses
    ADD CONSTRAINT nikl_senses_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_subword_examples nikl_subword_examples_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_examples
    ADD CONSTRAINT nikl_subword_examples_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_subword_examples nikl_subword_examples_subsense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_examples
    ADD CONSTRAINT nikl_subword_examples_subsense_fk FOREIGN KEY (provider, provider_target_code, subword_no, subsense_no) REFERENCES public.nikl_subword_senses(provider, provider_target_code, subword_no, subsense_no) ON DELETE CASCADE;


--
-- Name: nikl_subword_patterns nikl_subword_patterns_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_patterns
    ADD CONSTRAINT nikl_subword_patterns_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_subword_patterns nikl_subword_patterns_subsense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_patterns
    ADD CONSTRAINT nikl_subword_patterns_subsense_fk FOREIGN KEY (provider, provider_target_code, subword_no, subsense_no) REFERENCES public.nikl_subword_senses(provider, provider_target_code, subword_no, subsense_no) ON DELETE CASCADE;


--
-- Name: nikl_subword_relations nikl_subword_relations_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_relations
    ADD CONSTRAINT nikl_subword_relations_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_subword_relations nikl_subword_relations_subsense_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_relations
    ADD CONSTRAINT nikl_subword_relations_subsense_fk FOREIGN KEY (provider, provider_target_code, subword_no, subsense_no) REFERENCES public.nikl_subword_senses(provider, provider_target_code, subword_no, subsense_no) ON DELETE CASCADE;


--
-- Name: nikl_subword_senses nikl_subword_senses_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_senses
    ADD CONSTRAINT nikl_subword_senses_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_subword_senses nikl_subword_senses_subword_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subword_senses
    ADD CONSTRAINT nikl_subword_senses_subword_fk FOREIGN KEY (provider, provider_target_code, subword_no) REFERENCES public.nikl_subwords(provider, provider_target_code, subword_no) ON DELETE CASCADE;


--
-- Name: nikl_subwords nikl_subwords_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subwords
    ADD CONSTRAINT nikl_subwords_entry_fk FOREIGN KEY (provider, provider_target_code) REFERENCES public.nikl_entries(provider, provider_target_code) ON DELETE CASCADE;


--
-- Name: nikl_subwords nikl_subwords_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_subwords
    ADD CONSTRAINT nikl_subwords_snapshot_fk FOREIGN KEY (raw_snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: nikl_unmapped_fields nikl_unmapped_fields_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nikl_unmapped_fields
    ADD CONSTRAINT nikl_unmapped_fields_snapshot_fk FOREIGN KEY (snapshot_id) REFERENCES public.nikl_snapshots(snapshot_id) ON DELETE RESTRICT;


--
-- Name: content_item_audio_variants reading_item_audio_variants_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_item_audio_variants
    ADD CONSTRAINT reading_item_audio_variants_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(asset_id) ON DELETE CASCADE;


--
-- Name: content_item_audio_variants reading_item_audio_variants_reading_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_item_audio_variants
    ADD CONSTRAINT reading_item_audio_variants_reading_item_id_fkey FOREIGN KEY (content_item_id) REFERENCES public.content_items(content_item_id) ON DELETE CASCADE;


--
-- Name: content_items reading_items_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT reading_items_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: saved_document_sources saved_document_sources_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_document_sources
    ADD CONSTRAINT saved_document_sources_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: sentence_grammar sentence_grammar_grammar_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_grammar
    ADD CONSTRAINT sentence_grammar_grammar_pattern_id_fkey FOREIGN KEY (grammar_pattern_id) REFERENCES public.grammar_patterns(id) ON DELETE CASCADE;


--
-- Name: sentence_grammar sentence_grammar_sentence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_grammar
    ADD CONSTRAINT sentence_grammar_sentence_id_fkey FOREIGN KEY (sentence_id) REFERENCES public.sentences(id) ON DELETE CASCADE;


--
-- Name: sentence_translations sentence_translations_attribution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_translations
    ADD CONSTRAINT sentence_translations_attribution_id_fkey FOREIGN KEY (attribution_id) REFERENCES public.attributions(id);


--
-- Name: sentence_translations sentence_translations_sentence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_translations
    ADD CONSTRAINT sentence_translations_sentence_id_fkey FOREIGN KEY (sentence_id) REFERENCES public.sentences(id) ON DELETE CASCADE;


--
-- Name: sentence_vocab sentence_vocab_sentence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_vocab
    ADD CONSTRAINT sentence_vocab_sentence_id_fkey FOREIGN KEY (sentence_id) REFERENCES public.sentences(id) ON DELETE CASCADE;


--
-- Name: sentence_vocab sentence_vocab_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_vocab
    ADD CONSTRAINT sentence_vocab_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: sentences sentences_source_attribution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentences
    ADD CONSTRAINT sentences_source_attribution_id_fkey FOREIGN KEY (source_attribution_id) REFERENCES public.attributions(id);


--
-- Name: teaching_vocab_pos_staging teaching_vocab_pos_staging_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_pos_staging
    ADD CONSTRAINT teaching_vocab_pos_staging_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: teaching_vocab_sense_analysis teaching_vocab_sense_analysis_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_sense_analysis
    ADD CONSTRAINT teaching_vocab_sense_analysis_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: teaching_vocab_set_items teaching_vocab_set_items_vocab_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_set_items
    ADD CONSTRAINT teaching_vocab_set_items_vocab_fk FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: teaching_vocab_split_apply_plan teaching_vocab_split_apply_plan_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_vocab_split_apply_plan
    ADD CONSTRAINT teaching_vocab_split_apply_plan_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- Name: user_dictionary_pins user_dictionary_pins_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_dictionary_pins
    ADD CONSTRAINT user_dictionary_pins_user_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_dictionary_pins user_dictionary_pins_vocab_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_dictionary_pins
    ADD CONSTRAINT user_dictionary_pins_vocab_fk FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE SET NULL;


--
-- Name: user_vocab_exposures user_vocab_exposures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_exposures
    ADD CONSTRAINT user_vocab_exposures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_vocab_exposures user_vocab_exposures_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_exposures
    ADD CONSTRAINT user_vocab_exposures_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE SET NULL;


--
-- Name: user_vocab_items user_vocab_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_items
    ADD CONSTRAINT user_vocab_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_vocab_items user_vocab_items_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vocab_items
    ADD CONSTRAINT user_vocab_items_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE SET NULL;


--
-- Name: vocab_glosses vocab_glosses_attribution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocab_glosses
    ADD CONSTRAINT vocab_glosses_attribution_id_fkey FOREIGN KEY (attribution_id) REFERENCES public.attributions(id);


--
-- Name: vocab_glosses vocab_glosses_vocab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocab_glosses
    ADD CONSTRAINT vocab_glosses_vocab_id_fkey FOREIGN KEY (vocab_id) REFERENCES public.teaching_vocab(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict e8UXcX89hLYDTgDBvozHqCRlHKxUYZpTOMb5UzFZt1JKDzcjXsyew0GmSR7Jb4p

