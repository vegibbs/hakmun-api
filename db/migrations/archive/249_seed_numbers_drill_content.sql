-- 249: Seed numbers drill content into teaching_vocab and content_items.
-- Bare number words → teaching_vocab + vocab_glosses.
-- Full sentences/phrases → content_items + library_registry_items.
-- All items tagged with module:numbers, section:*, subsection:*.

-- ═══════════════════════════════════════════════════════════════
-- 1) Teaching vocab: bare number words (no spaces in Korean text)
-- ═══════════════════════════════════════════════════════════════

WITH sys AS (SELECT user_id FROM users WHERE is_root_admin = true LIMIT 1)
INSERT INTO teaching_vocab (lemma, part_of_speech, pos_code, status, tags, created_by)
SELECT v.lemma, v.pos, v.pos_code, 'active', v.tags, sys.user_id
FROM (VALUES
  -- Native 1-10
  ('하나', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('둘',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('셋',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('넷',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('다섯', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('여섯', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('일곱', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('여덟', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('아홉', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  ('열',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']::text[]),
  -- All Native
  ('열하나',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('열둘',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('열셋',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('열넷',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('열다섯',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('스물',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('스물하나', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('서른',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('마흔',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('쉰',       'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('예순',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('일흔',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('여든',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  ('아흔',     'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']::text[]),
  -- Sino-Korean
  ('일', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('이', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('삼', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('사', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('오', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('육', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('칠', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('팔', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('구', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('십', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('백', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('천', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('만', 'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('십이',             'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('이십삼',           'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('백오십육',         'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[]),
  ('삼천사백이십일',   'numeral', 'numeral', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']::text[])
) AS v(lemma, pos, pos_code, tags)
CROSS JOIN sys
ON CONFLICT (lemma, part_of_speech) DO UPDATE
SET tags = (
  SELECT ARRAY(SELECT DISTINCT unnest(array_cat(teaching_vocab.tags, EXCLUDED.tags)))
);


-- ═══════════════════════════════════════════════════════════════
-- 2) Vocab glosses for the bare number words
-- ═══════════════════════════════════════════════════════════════

INSERT INTO vocab_glosses (vocab_id, attribution_id, language, text, is_primary)
SELECT tv.id, '44851b82-7c46-49fa-94e9-382fa263c87d'::uuid, 'en', v.gloss, true
FROM (VALUES
  -- Native 1-10
  ('하나', 'numeral', '1 (native)'),
  ('둘',   'numeral', '2 (native)'),
  ('셋',   'numeral', '3 (native)'),
  ('넷',   'numeral', '4 (native)'),
  ('다섯', 'numeral', '5 (native)'),
  ('여섯', 'numeral', '6 (native)'),
  ('일곱', 'numeral', '7 (native)'),
  ('여덟', 'numeral', '8 (native)'),
  ('아홉', 'numeral', '9 (native)'),
  ('열',   'numeral', '10 (native)'),
  -- All Native
  ('열하나',   'numeral', '11 (native)'),
  ('열둘',     'numeral', '12 (native)'),
  ('열셋',     'numeral', '13 (native)'),
  ('열넷',     'numeral', '14 (native)'),
  ('열다섯',   'numeral', '15 (native)'),
  ('스물',     'numeral', '20 (native)'),
  ('스물하나', 'numeral', '21 (native)'),
  ('서른',     'numeral', '30 (native)'),
  ('마흔',     'numeral', '40 (native)'),
  ('쉰',       'numeral', '50 (native)'),
  ('예순',     'numeral', '60 (native)'),
  ('일흔',     'numeral', '70 (native)'),
  ('여든',     'numeral', '80 (native)'),
  ('아흔',     'numeral', '90 (native)'),
  -- Sino-Korean
  ('일', 'numeral', '1 (Sino-Korean)'),
  ('이', 'numeral', '2 (Sino-Korean)'),
  ('삼', 'numeral', '3 (Sino-Korean)'),
  ('사', 'numeral', '4 (Sino-Korean)'),
  ('오', 'numeral', '5 (Sino-Korean)'),
  ('육', 'numeral', '6 (Sino-Korean)'),
  ('칠', 'numeral', '7 (Sino-Korean)'),
  ('팔', 'numeral', '8 (Sino-Korean)'),
  ('구', 'numeral', '9 (Sino-Korean)'),
  ('십', 'numeral', '10 (Sino-Korean)'),
  ('백', 'numeral', '100 (Sino-Korean)'),
  ('천', 'numeral', '1,000 (Sino-Korean)'),
  ('만', 'numeral', '10,000 (Sino-Korean)'),
  ('십이',             'numeral', '12 (Sino-Korean)'),
  ('이십삼',           'numeral', '23 (Sino-Korean)'),
  ('백오십육',         'numeral', '156 (Sino-Korean)'),
  ('삼천사백이십일',   'numeral', '3,421 (Sino-Korean)')
) AS v(lemma, pos, gloss)
JOIN teaching_vocab tv ON tv.lemma = v.lemma AND tv.part_of_speech = v.pos
ON CONFLICT (vocab_id, language, text) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- 3) Content items: sentences and multi-word phrases
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  sys_user UUID;
  r RECORD;
  ci_id UUID;
BEGIN
  SELECT user_id INTO sys_user FROM users WHERE is_root_admin = true LIMIT 1;
  IF sys_user IS NULL THEN
    SELECT user_id INTO sys_user FROM users LIMIT 1;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _num_seed (
    ko TEXT NOT NULL,
    hint TEXT NOT NULL,
    tags TEXT[] NOT NULL
  ) ON COMMIT DROP;

  TRUNCATE _num_seed;

  INSERT INTO _num_seed (ko, hint, tags) VALUES
    -- Numbers > Native 1-10 (sentences)
    ('사과 하나 주세요.', 'Please give me one apple.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']),
    ('커피 두 잔 주세요.', 'Please give me two cups of coffee.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']),
    ('학생 세 명이 왔어요.', 'Three students came.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']),
    ('의자 네 개가 있어요.', 'There are four chairs.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']),
    ('다섯 시에 만나요.', 'Let''s meet at five o''clock.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_1_10']),
    -- Numbers > All Native (sentences)
    ('스물다섯 살이에요.', 'I am 25 years old.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']),
    ('서른두 명이 참석했어요.', '32 people attended.', ARRAY['module:numbers', 'section:numbers', 'subsection:native_all']),
    -- Numbers > Sino-Korean (sentences/phrases)
    ('전화번호는 공일공-이삼사오-육칠팔구예요.', 'The phone number is 010-2345-6789.', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']),
    ('이천이십육 년', 'The year 2026', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']),
    ('삼월 이일', 'March 2nd', ARRAY['module:numbers', 'section:numbers', 'subsection:sino']),
    -- Time
    ('지금 한 시예요.', 'It''s 1 o''clock now.', ARRAY['module:numbers', 'section:time']),
    ('두 시 삼십 분이에요.', 'It''s 2:30.', ARRAY['module:numbers', 'section:time']),
    ('세 시 십오 분이에요.', 'It''s 3:15.', ARRAY['module:numbers', 'section:time']),
    ('네 시 사십오 분이에요.', 'It''s 4:45.', ARRAY['module:numbers', 'section:time']),
    ('오전 여섯 시에 일어나요.', 'I wake up at 6 AM.', ARRAY['module:numbers', 'section:time']),
    ('오후 일곱 시에 저녁을 먹어요.', 'I eat dinner at 7 PM.', ARRAY['module:numbers', 'section:time']),
    ('아홉 시 반에 수업이 시작해요.', 'Class starts at 9:30.', ARRAY['module:numbers', 'section:time']),
    ('열두 시에 점심을 먹어요.', 'I eat lunch at 12 o''clock.', ARRAY['module:numbers', 'section:time']),
    ('열한 시 이십 분이에요.', 'It''s 11:20.', ARRAY['module:numbers', 'section:time']),
    ('오후 세 시 오십오 분이에요.', 'It''s 3:55 PM.', ARRAY['module:numbers', 'section:time']),
    ('회의는 두 시간 걸려요.', 'The meeting takes two hours.', ARRAY['module:numbers', 'section:time']),
    ('삼십 분 후에 출발해요.', 'We leave in 30 minutes.', ARRAY['module:numbers', 'section:time']),
    -- Counters > 개 (general things)
    ('사과 한 개 주세요.', 'Please give me one apple.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gae']),
    ('계란 세 개가 필요해요.', 'I need three eggs.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gae']),
    ('문제가 다섯 개 있어요.', 'There are five problems.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gae']),
    ('선물 열 개를 샀어요.', 'I bought ten gifts.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gae']),
    ('빵 두 개하고 우유 한 개 주세요.', 'Please give me two breads and one milk.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gae']),
    -- Counters > 명 (people)
    ('학생 세 명이 있어요.', 'There are three students.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_myeong']),
    ('두 명이서 갔어요.', 'Two people went.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_myeong']),
    ('다섯 명을 초대했어요.', 'I invited five people.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_myeong']),
    ('한 명만 남았어요.', 'Only one person is left.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_myeong']),
    ('열 명이 참석했어요.', 'Ten people attended.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_myeong']),
    -- Counters > 잔 (cups/glasses)
    ('커피 한 잔 주세요.', 'One cup of coffee, please.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_jan']),
    ('물 두 잔 마셨어요.', 'I drank two glasses of water.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_jan']),
    ('차 세 잔 드릴까요?', 'Shall I give you three cups of tea?', ARRAY['module:numbers', 'section:counters', 'subsection:counter_jan']),
    ('맥주 네 잔 시켰어요.', 'I ordered four glasses of beer.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_jan']),
    ('주스 다섯 잔이 있어요.', 'There are five glasses of juice.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_jan']),
    -- Counters > 권 (books/volumes)
    ('책 한 권을 읽었어요.', 'I read one book.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gwon']),
    ('소설 세 권을 샀어요.', 'I bought three novels.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gwon']),
    ('만화책 열 권이 있어요.', 'There are ten comic books.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gwon']),
    ('이번 달에 두 권 읽을 거예요.', 'I will read two books this month.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gwon']),
    ('도서관에서 다섯 권을 빌렸어요.', 'I borrowed five books from the library.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_gwon']),
    -- Counters > 대 (vehicles/machines)
    ('차 한 대가 있어요.', 'There is one car.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_dae']),
    ('버스 세 대가 지나갔어요.', 'Three buses passed by.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_dae']),
    ('컴퓨터 두 대를 샀어요.', 'I bought two computers.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_dae']),
    ('자전거 네 대가 주차되어 있어요.', 'Four bicycles are parked.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_dae']),
    ('택시 한 대를 불렀어요.', 'I called one taxi.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_dae']),
    -- Counters > 병 (bottles)
    ('물 한 병 주세요.', 'One bottle of water, please.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_byeong']),
    ('소주 두 병 시켰어요.', 'I ordered two bottles of soju.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_byeong']),
    ('우유 세 병을 샀어요.', 'I bought three bottles of milk.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_byeong']),
    ('맥주 네 병이 남았어요.', 'Four bottles of beer are left.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_byeong']),
    ('와인 한 병을 선물했어요.', 'I gifted one bottle of wine.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_byeong']),
    -- Counters > 번 (times/occurrences)
    ('한 번 더 해 주세요.', 'Please do it one more time.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_beon']),
    ('세 번 확인했어요.', 'I checked three times.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_beon']),
    ('두 번째 시도에 성공했어요.', 'I succeeded on the second try.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_beon']),
    ('다섯 번 연습했어요.', 'I practiced five times.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_beon']),
    ('첫 번째 문제가 제일 어려웠어요.', 'The first problem was the hardest.', ARRAY['module:numbers', 'section:counters', 'subsection:counter_beon']),
    -- Real Estate
    ('이 아파트는 삼십이 평이에요.', 'This apartment is 32 pyeong.', ARRAY['module:numbers', 'section:real_estate']),
    ('월세가 백만 원이에요.', 'The monthly rent is 1,000,000 won.', ARRAY['module:numbers', 'section:real_estate']),
    ('보증금이 이천만 원이에요.', 'The deposit is 20,000,000 won.', ARRAY['module:numbers', 'section:real_estate']),
    ('전세 삼억 원이에요.', 'The jeonse is 300,000,000 won.', ARRAY['module:numbers', 'section:real_estate']),
    ('매매가 오억 원이에요.', 'The sale price is 500,000,000 won.', ARRAY['module:numbers', 'section:real_estate']),
    ('이 원룸은 십 평이에요.', 'This studio is 10 pyeong.', ARRAY['module:numbers', 'section:real_estate']),
    ('관리비가 십오만 원이에요.', 'The maintenance fee is 150,000 won.', ARRAY['module:numbers', 'section:real_estate']),
    ('이십오 평 아파트를 찾고 있어요.', 'I''m looking for a 25-pyeong apartment.', ARRAY['module:numbers', 'section:real_estate']),
    ('보증금 오백만 원에 월세 오십만 원이에요.', 'It''s 5,000,000 won deposit with 500,000 won monthly rent.', ARRAY['module:numbers', 'section:real_estate']),
    ('이 건물은 지상 십오 층이에요.', 'This building is 15 floors above ground.', ARRAY['module:numbers', 'section:real_estate']);

  -- Insert each sentence if it doesn't already exist with module:numbers tag
  FOR r IN SELECT * FROM _num_seed LOOP
    IF NOT EXISTS (
      SELECT 1 FROM content_items
      WHERE text = r.ko AND 'module:numbers' = ANY(tags)
    ) THEN
      INSERT INTO content_items (owner_user_id, content_type, text, notes, tags)
      VALUES (sys_user, 'sentence', r.ko, r.hint, r.tags)
      RETURNING content_item_id INTO ci_id;

      INSERT INTO library_registry_items (content_type, content_id, owner_user_id, audience, global_state)
      VALUES ('sentence', ci_id, sys_user, 'global', 'approved');
    END IF;
  END LOOP;
END $$;
