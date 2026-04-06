/**
 * Tests for Global Content Approval & Editing (Work Queue #13)
 *
 * Phase 1 (8 test cases):
 *   1. State transition — approve
 *   2. State transition — reject
 *   3. Edit resets to preliminary
 *   4. No-op edit doesn't reset
 *   5. Different-approver enforcement
 *   6. Non-approver cannot edit global items
 *   7. Student filter (non-approver sees approved only)
 *   8. Approver filter (all items / filtered)
 *
 * Phase 2 (tests 9-14):
 *   9.  PATCH accepts metadata fields (cefr_level, topic, politeness, tense)
 *   10. PATCH accepts module_tags
 *   11. PATCH accepts operational_status
 *   12. Metadata-only edits don't reset global_state
 *   13. module_tags validation (rejects invalid)
 *   14. GET with module_tag filter
 */

// ── Mock db/pool before anything else ──────────────────────────
const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  pool: { query: mockQuery },
}));

// ── Mock auth/session ──────────────────────────────────────────
// Provide controllable requireSession + requireEntitlement stubs.
// Tests set mockUser before each request to control identity.
let mockUser = null;

jest.mock("../auth/session", () => {
  const original = jest.requireActual("../auth/session");
  return {
    ...original,
    requireSession: (req, _res, next) => {
      if (!mockUser) {
        return _res.status(401).json({ error: "missing session token" });
      }
      req.user = mockUser;
      next();
    },
    requireEntitlement: (entitlement) => (req, res, next) => {
      const ents = req.user?.entitlements || [];
      if (!Array.isArray(ents) || !ents.includes(entitlement)) {
        return res.status(403).json({ error: "insufficient entitlement" });
      }
      next();
    },
    // Stubs for functions called at boot time
    getUserState: jest.fn(),
    issueSessionTokens: jest.fn(),
    verifySessionJWT: jest.fn(),
    computeEntitlementsFromUser: jest.fn(),
  };
});

// ── Mock s3 util (signImageUrls) ───────────────────────────────
jest.mock("../util/s3", () => ({
  signImageUrls: jest.fn(async (rows) => rows),
}));

// ── Now load app + supertest ───────────────────────────────────
const request = require("supertest");
const { app } = require("../app");

// ── Helpers ────────────────────────────────────────────────────
const APPROVER_A_ID = "aaaa0000-0000-4000-a000-000000000001";
const APPROVER_B_ID = "bbbb0000-0000-4000-b000-000000000002";
const STUDENT_ID = "cccc0000-0000-4000-c000-000000000003";
const ITEM_ID = "dddd0000-0000-4000-d000-000000000004";
const REGISTRY_ID = "eeee0000-0000-4000-e000-000000000005";

function approverUser(userId) {
  return {
    userID: userId,
    role: "teacher",
    isApprover: true,
    isAdmin: false,
    isRootAdmin: false,
    isActive: true,
    entitlements: [
      "app:use",
      "teacher:tools",
      "approver:content",
      "flag:is_approver",
    ],
  };
}

function studentUser(userId) {
  return {
    userID: userId,
    role: "student",
    isApprover: false,
    isAdmin: false,
    isRootAdmin: false,
    isActive: true,
    entitlements: ["app:use"],
  };
}

/** Build a standard content item + registry row for the full DTO query. */
function fullDtoRow(overrides = {}) {
  return {
    content_item_id: ITEM_ID,
    content_type: "sentence",
    text: "테스트 문장입니다.",
    language: "ko",
    notes: null,
    cefr_level: "A1",
    topic: null,
    naturalness_score: null,
    politeness: null,
    politeness_en: null,
    tense: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    registry_item_id: REGISTRY_ID,
    audience: "global",
    global_state: "preliminary",
    operational_status: "active",
    registry_owner_user_id: null,
    last_reviewed_by: null,
    last_reviewed_at: null,
    last_edited_by: null,
    last_edited_at: null,
    module_tags: [],
    has_audio: false,
    ...overrides,
  };
}

// ── Setup / Teardown ───────────────────────────────────────────
beforeEach(() => {
  mockUser = null;
  mockQuery.mockReset();
});

// ================================================================
// Test 1: State transition — approve
// ================================================================
describe("PATCH /v1/library/global/items/:id/state", () => {
  test("1. approve: preliminary → approved", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // 1st query: fetch registry row
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          global_state: "preliminary",
          last_edited_by: APPROVER_B_ID, // different editor
          content_id: ITEM_ID,
        },
      ],
    });
    // 2nd query: UPDATE registry
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          content_type: "sentence",
          content_id: ITEM_ID,
          audience: "global",
          global_state: "approved",
          operational_status: "active",
          owner_user_id: null,
          last_reviewed_by: APPROVER_A_ID,
          last_reviewed_at: "2026-04-06T00:00:00Z",
          last_edited_by: APPROVER_B_ID,
          last_edited_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-04-06T00:00:00Z",
        },
      ],
    });
    // 3rd query: fetch full DTO
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ global_state: "approved", last_reviewed_by: APPROVER_A_ID })],
    });

    const res = await request(app)
      .patch(`/v1/library/global/items/${ITEM_ID}/state`)
      .send({ global_state: "approved" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("approved");
    expect(res.body.item.last_reviewed_by).toBe(APPROVER_A_ID);
  });

  // ================================================================
  // Test 2: State transition — reject
  // ================================================================
  test("2. reject: preliminary → rejected", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          global_state: "preliminary",
          last_edited_by: null,
          content_id: ITEM_ID,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          global_state: "rejected",
          last_reviewed_by: APPROVER_A_ID,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ global_state: "rejected", last_reviewed_by: APPROVER_A_ID })],
    });

    const res = await request(app)
      .patch(`/v1/library/global/items/${ITEM_ID}/state`)
      .send({ global_state: "rejected" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("rejected");
  });

  // ================================================================
  // Test 5: Different-approver enforcement
  // ================================================================
  test("5a. same editor cannot approve own edit → 403", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // Registry row shows APPROVER_A edited it
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          global_state: "preliminary",
          last_edited_by: APPROVER_A_ID, // same as caller
          content_id: ITEM_ID,
        },
      ],
    });

    const res = await request(app)
      .patch(`/v1/library/global/items/${ITEM_ID}/state`)
      .send({ global_state: "approved" })
      .expect(403);

    expect(res.body.error).toBe("SAME_EDITOR_CANNOT_APPROVE");
  });

  test("5b. different editor can approve → 200", async () => {
    mockUser = approverUser(APPROVER_B_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: REGISTRY_ID,
          global_state: "preliminary",
          last_edited_by: APPROVER_A_ID, // different from caller (B)
          content_id: ITEM_ID,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REGISTRY_ID, global_state: "approved" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ global_state: "approved", last_reviewed_by: APPROVER_B_ID })],
    });

    const res = await request(app)
      .patch(`/v1/library/global/items/${ITEM_ID}/state`)
      .send({ global_state: "approved" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("approved");
  });
});

// ================================================================
// Test 3 & 4: Edit resets / no-op edit
// ================================================================
describe("PATCH /v1/content/items/:id (global edit)", () => {
  test("3. text change resets global_state to preliminary", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // 1st query: regCheck — fetch item + registry
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          registry_id: REGISTRY_ID,
          audience: "global",
          global_state: "approved",
          current_text: "Original text",
          owner_user_id: null,
        },
      ],
    });
    // 2nd query: UPDATE content_items
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          content_item_id: ITEM_ID,
          content_type: "sentence",
          text: "Changed text",
          notes: null,
          cefr_level: "A1",
          topic: null,
          owner_user_id: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-04-06T00:00:00Z",
        },
      ],
    });
    // 3rd query: UPDATE registry (reset to preliminary)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4th query: fetch full DTO
    mockQuery.mockResolvedValueOnce({
      rows: [
        fullDtoRow({
          text: "Changed text",
          global_state: "preliminary",
          last_edited_by: APPROVER_A_ID,
        }),
      ],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ text: "Changed text" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("preliminary");
    expect(res.body.item.last_edited_by).toBe(APPROVER_A_ID);

    // Verify the 3rd query was the registry reset with 'preliminary'
    const resetCall = mockQuery.mock.calls[2];
    expect(resetCall[0]).toContain("preliminary");
    expect(resetCall[1]).toContain(APPROVER_A_ID);
  });

  test("4. no-op edit (same text) does NOT reset global_state", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    const sameText = "Same text";

    // 1st query: regCheck
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          registry_id: REGISTRY_ID,
          audience: "global",
          global_state: "approved",
          current_text: sameText,
          owner_user_id: null,
        },
      ],
    });
    // 2nd query: UPDATE content_items
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          content_item_id: ITEM_ID,
          content_type: "sentence",
          text: sameText,
          notes: null,
        },
      ],
    });
    // 3rd query: UPDATE registry (notes-only path — editor tracked, state preserved)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4th query: fetch full DTO
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ text: sameText, global_state: "approved" })],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ text: sameText })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("approved");

    // Verify the 3rd query did NOT include 'preliminary'
    const editorTrackCall = mockQuery.mock.calls[2];
    expect(editorTrackCall[0]).not.toContain("preliminary");
  });

  // ================================================================
  // Test 6: Non-approver cannot edit global items
  // ================================================================
  test("6. student cannot edit global content → 403", async () => {
    mockUser = studentUser(STUDENT_ID);

    // regCheck returns a global item
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          registry_id: REGISTRY_ID,
          audience: "global",
          global_state: "approved",
          current_text: "Original",
          owner_user_id: null,
        },
      ],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ text: "Hacked text" })
      .expect(403);

    expect(res.body.error).toBe("APPROVER_REQUIRED");
  });
});

// ================================================================
// Tests 7 & 8: GET filter behavior
// ================================================================
describe("GET /v1/library/global/items", () => {
  test("7. student (no approver:content) → only approved items", async () => {
    mockUser = studentUser(STUDENT_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ global_state: "approved" })],
    });

    const res = await request(app)
      .get("/v1/library/global/items?content_type=sentence")
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify the SQL included an explicit 'approved' filter
    const sql = mockQuery.mock.calls[0][0];
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain("approved");
  });

  test("8a. approver with no filter → all items (no explicit state filter)", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [
        fullDtoRow({ global_state: "preliminary" }),
        fullDtoRow({ global_state: "approved" }),
        fullDtoRow({ global_state: "rejected" }),
      ],
    });

    const res = await request(app)
      .get("/v1/library/global/items?content_type=sentence")
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.items).toHaveLength(3);

    // Params should be just ['sentence'] — no state filter added
    const params = mockQuery.mock.calls[0][1];
    expect(params).toEqual(["sentence"]);
  });

  test("8b. approver with explicit filter → only that state", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ global_state: "preliminary" })],
    });

    const res = await request(app)
      .get("/v1/library/global/items?content_type=sentence&global_state=preliminary")
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Params should include 'preliminary' as the state filter
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain("preliminary");
  });

  // ================================================================
  // Test 14: GET with module_tag filter
  // ================================================================
  test("14. module_tag filter narrows results", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ module_tags: ["numbers:time"] })],
    });

    const res = await request(app)
      .get("/v1/library/global/items?content_type=sentence&module_tag=numbers:time")
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify the SQL used the @> JSONB containment operator
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("module_tags");
    expect(sql).toContain("@>");

    // Verify the params include the JSONB array with the tag
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain(JSON.stringify(["numbers:time"]));
  });
});

// ================================================================
// Phase 2 Tests: Metadata & Module Tags
// ================================================================
describe("PATCH /v1/content/items/:id (Phase 2 fields)", () => {
  // ================================================================
  // Test 9: PATCH accepts metadata fields
  // ================================================================
  test("9. metadata fields (cefr_level, topic, politeness, tense) accepted", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // regCheck
    mockQuery.mockResolvedValueOnce({
      rows: [{
        registry_id: REGISTRY_ID,
        audience: "global",
        global_state: "approved",
        current_text: "테스트 문장입니다.",
        owner_user_id: null,
      }],
    });
    // UPDATE content_items
    mockQuery.mockResolvedValueOnce({
      rows: [{
        content_item_id: ITEM_ID,
        content_type: "sentence",
        text: "테스트 문장입니다.",
        notes: null,
        cefr_level: "B1",
        topic: "daily life",
        politeness: "formal",
        tense: "present",
      }],
    });
    // UPDATE registry (editor tracking, no text change so no state reset)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Full DTO fetch
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({
        cefr_level: "B1",
        topic: "daily life",
        politeness: "formal",
        tense: "present",
        global_state: "approved",
      })],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({
        cefr_level: "B1",
        topic: "daily life",
        politeness: "formal",
        tense: "present",
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.cefr_level).toBe("B1");
    expect(res.body.item.topic).toBe("daily life");

    // Verify content_items UPDATE included the metadata fields
    const updateSql = mockQuery.mock.calls[1][0];
    expect(updateSql).toContain("cefr_level");
    expect(updateSql).toContain("topic");
    expect(updateSql).toContain("politeness");
    expect(updateSql).toContain("tense");
  });

  // ================================================================
  // Test 10: PATCH accepts module_tags
  // ================================================================
  test("10. module_tags accepted and persisted on registry", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // regCheck
    mockQuery.mockResolvedValueOnce({
      rows: [{
        registry_id: REGISTRY_ID,
        audience: "global",
        global_state: "approved",
        current_text: "테스트 문장입니다.",
        owner_user_id: null,
      }],
    });
    // No content_items update (only registry fields)
    // UPDATE registry (module_tags + editor tracking)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Full DTO fetch
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({
        module_tags: ["numbers:time", "numbers:counters"],
        global_state: "approved",
      })],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ module_tags: ["numbers:time", "numbers:counters"] })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.module_tags).toEqual(["numbers:time", "numbers:counters"]);

    // Verify registry UPDATE included module_tags
    const regSql = mockQuery.mock.calls[1][0];
    expect(regSql).toContain("module_tags");
  });

  // ================================================================
  // Test 11: PATCH accepts operational_status
  // ================================================================
  test("11. operational_status update on registry", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // regCheck
    mockQuery.mockResolvedValueOnce({
      rows: [{
        registry_id: REGISTRY_ID,
        audience: "global",
        global_state: "approved",
        current_text: "테스트 문장입니다.",
        owner_user_id: null,
      }],
    });
    // UPDATE registry
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Full DTO fetch
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ operational_status: "inactive", global_state: "approved" })],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ operational_status: "inactive" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.operational_status).toBe("inactive");
  });

  // ================================================================
  // Test 12: Metadata-only edits don't reset global_state
  // ================================================================
  test("12. metadata-only edit preserves approved state", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    // regCheck
    mockQuery.mockResolvedValueOnce({
      rows: [{
        registry_id: REGISTRY_ID,
        audience: "global",
        global_state: "approved",
        current_text: "테스트 문장입니다.",
        owner_user_id: null,
      }],
    });
    // UPDATE content_items (cefr_level only)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        content_item_id: ITEM_ID,
        cefr_level: "B2",
      }],
    });
    // UPDATE registry (editor tracking, no text change)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Full DTO fetch
    mockQuery.mockResolvedValueOnce({
      rows: [fullDtoRow({ cefr_level: "B2", global_state: "approved" })],
    });

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ cefr_level: "B2" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.item.global_state).toBe("approved");

    // The registry update should NOT contain 'preliminary'
    const regCall = mockQuery.mock.calls[2];
    expect(regCall[0]).not.toContain("preliminary");
  });

  // ================================================================
  // Test 13: Invalid module_tags rejected
  // ================================================================
  test("13. invalid module_tags → 400", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ module_tags: "not-an-array" })
      .expect(400);

    expect(res.body.error).toBe("INVALID_MODULE_TAGS");
  });

  test("13b. invalid operational_status → 400", async () => {
    mockUser = approverUser(APPROVER_A_ID);

    const res = await request(app)
      .patch(`/v1/content/items/${ITEM_ID}`)
      .send({ operational_status: "deleted" })
      .expect(400);

    expect(res.body.error).toBe("INVALID_OPERATIONAL_STATUS");
  });
});
