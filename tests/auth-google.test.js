/**
 * Tests for Google Sign-In (POST /v1/auth/google)
 * and Apple Sign-In regression (POST /v1/auth/apple) after identity refactor.
 *
 * Tests:
 *   1. Google: rejects missing code
 *   2. Google: rejects missing redirectUri
 *   3. Google: returns provisional token for new identity (no auto-create)
 *   4. Google: successful sign-in (existing user)
 *   5. Google: returns 401 on invalid code
 *   6. Google: returns 403 on disabled account
 *   7. Apple: still works after ensureCanonicalUser refactor
 */

// ── Mock db/pool ──────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  pool: { query: mockQuery },
}));

// ── Mock auth/session ─────────────────────────────────────────
const mockIssueSessionTokens = jest.fn();
const mockIssueProvisionalToken = jest.fn();
const mockVerifyProvisionalToken = jest.fn();
const mockGetUserState = jest.fn();
const mockTouchLastSeen = jest.fn();

jest.mock("../auth/session", () => ({
  issueSessionTokens: (...args) => mockIssueSessionTokens(...args),
  issueProvisionalToken: (...args) => mockIssueProvisionalToken(...args),
  verifyProvisionalToken: (...args) => mockVerifyProvisionalToken(...args),
  getUserState: (...args) => mockGetUserState(...args),
  touchLastSeen: (...args) => mockTouchLastSeen(...args),
  requireSession: (req, res, next) => next(),
  requireRootAdmin: (req, res, next) => next(),
  requireEntitlement: () => (req, res, next) => next(),
  verifySessionJWT: jest.fn(),
  computeEntitlementsFromUser: jest.fn(),
  ensureAtLeastOneRootAdminNonFatal: jest.fn(),
}));

// ── Mock auth/google ──────────────────────────────────────────
const mockVerifyGoogleCode = jest.fn();
jest.mock("../auth/google", () => ({
  verifyGoogleCode: (...args) => mockVerifyGoogleCode(...args),
}));

// ── Mock auth/apple ───────────────────────────────────────────
const mockVerifyAppleToken = jest.fn();
const mockVerifyAppleCode = jest.fn();
jest.mock("../auth/apple", () => ({
  verifyAppleToken: (...args) => mockVerifyAppleToken(...args),
  verifyAppleCode: (...args) => mockVerifyAppleCode(...args),
  APPLE_CLIENT_IDS: ["com.vgibbs.hakmun"],
}));

// ── Mock auth/identity ────────────────────────────────────────
const mockEnsureCanonicalUser = jest.fn();
const mockFindUserByIdentity = jest.fn();
jest.mock("../auth/identity", () => ({
  ensureCanonicalUser: (...args) => mockEnsureCanonicalUser(...args),
  findUserByIdentity: (...args) => mockFindUserByIdentity(...args),
}));

// ── Mock util/audit ───────────────────────────────────────────
jest.mock("../util/audit", () => ({
  audit: jest.fn().mockResolvedValue(undefined),
}));

// ── Mock util/env (must be before app require) ────────────────
process.env.APPLE_CLIENT_IDS = "com.vgibbs.hakmun";
process.env.GOOGLE_SIGNIN_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_SIGNIN_CLIENT_SECRET = "test-google-client-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";

jest.mock("../util/env", () => ({
  initEnv: jest.fn(),
  env: {
    APPLE_CLIENT_IDS: ["com.vgibbs.hakmun"],
    JWT_SECRET: "test-jwt-secret",
    JWT_REFRESH_SECRET: "test-jwt-refresh-secret",
  },
}));

// ── Load app ──────────────────────────────────────────────────
const request = require("supertest");
const { app } = require("../app");

// ── Helpers ───────────────────────────────────────────────────
const TEST_USER_ID = "aaaaaaaa-bbbb-1111-8888-cccccccccccc";
const TEST_TOKENS = {
  accessToken: "access-token-123",
  refreshToken: "refresh-token-456",
  expiresIn: 3600,
  refreshExpiresIn: 86400,
};
const TEST_USER_STATE = {
  role: "student",
  is_active: true,
  is_admin: false,
  is_root_admin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueSessionTokens.mockResolvedValue(TEST_TOKENS);
  mockIssueProvisionalToken.mockResolvedValue("provisional-token-xyz");
  mockGetUserState.mockResolvedValue(TEST_USER_STATE);
  mockEnsureCanonicalUser.mockResolvedValue(TEST_USER_ID);
  mockFindUserByIdentity.mockResolvedValue(null); // default: unknown identity
  mockTouchLastSeen.mockResolvedValue(undefined);
});

// ── Google Sign-In Tests ──────────────────────────────────────
describe("POST /v1/auth/google", () => {
  test("1. rejects missing code", async () => {
    const res = await request(app)
      .post("/v1/auth/google")
      .send({ redirectUri: "http://localhost:5173/auth/google/callback" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  test("2. rejects missing redirectUri", async () => {
    const res = await request(app)
      .post("/v1/auth/google")
      .send({ code: "auth-code-123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redirectUri/i);
  });

  test("3. returns provisional token for new identity (no auto-create)", async () => {
    mockVerifyGoogleCode.mockResolvedValue({
      googleSubject: "google-sub-123",
      audience: "test-google-client-id",
      email: "test@gmail.com",
      name: "Test User",
    });
    mockFindUserByIdentity.mockResolvedValue(null); // unknown identity

    const res = await request(app)
      .post("/v1/auth/google")
      .send({
        code: "valid-auth-code",
        redirectUri: "http://localhost:5173/auth/google/callback",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("new_identity");
    expect(res.body.provisionalToken).toBe("provisional-token-xyz");
    expect(res.body.provider).toBe("google");
    expect(res.body.email).toBe("test@gmail.com");
    expect(res.body.name).toBe("Test User");

    // Should NOT have created a user
    expect(mockEnsureCanonicalUser).not.toHaveBeenCalled();
    expect(mockIssueSessionTokens).not.toHaveBeenCalled();
  });

  test("4. successful sign-in (existing user)", async () => {
    mockVerifyGoogleCode.mockResolvedValue({
      googleSubject: "google-sub-existing",
      audience: "test-google-client-id",
      email: "existing@gmail.com",
      name: "Existing User",
    });

    const existingUserID = "dddddddd-eeee-1111-8888-ffffffffffff";
    mockFindUserByIdentity.mockResolvedValue(existingUserID);
    mockGetUserState.mockResolvedValue({
      ...TEST_USER_STATE,
      role: "teacher",
    });

    const res = await request(app)
      .post("/v1/auth/google")
      .send({
        code: "valid-auth-code",
        redirectUri: "http://localhost:5173/auth/google/callback",
      });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("access-token-123");
    expect(res.body.user.userID).toBe(existingUserID);
    expect(res.body.user.role).toBe("teacher");
    expect(res.body.user.isTeacher).toBe(true);

    // Should NOT have auto-created
    expect(res.body.status).toBeUndefined();
  });

  test("5. returns 401 on invalid code", async () => {
    mockVerifyGoogleCode.mockRejectedValue(new Error("Google token exchange failed: 400"));

    const res = await request(app)
      .post("/v1/auth/google")
      .send({
        code: "bad-code",
        redirectUri: "http://localhost:5173/auth/google/callback",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication failed");
  });

  test("6. returns 403 on disabled account", async () => {
    mockVerifyGoogleCode.mockResolvedValue({
      googleSubject: "google-sub-disabled",
      audience: "test-google-client-id",
      email: "disabled@gmail.com",
      name: "Disabled User",
    });
    mockFindUserByIdentity.mockResolvedValue(TEST_USER_ID);
    mockGetUserState.mockResolvedValue({ ...TEST_USER_STATE, is_active: false });

    const res = await request(app)
      .post("/v1/auth/google")
      .send({
        code: "valid-auth-code",
        redirectUri: "http://localhost:5173/auth/google/callback",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account disabled");
  });
});

// ── Apple Sign-In Regression ──────────────────────────────────
describe("POST /v1/auth/apple", () => {
  test("7. native flow still works after web flow addition", async () => {
    mockVerifyAppleToken.mockResolvedValue({
      appleSubject: "apple-sub-123",
      audience: "com.vgibbs.hakmun",
      email: "test@icloud.com",
    });

    const res = await request(app)
      .post("/v1/auth/apple")
      .send({ identityToken: "valid-apple-identity-token" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("access-token-123");
    expect(res.body.user.userID).toBe(TEST_USER_ID);

    // Verify ensureCanonicalUser was called with provider: "apple"
    expect(mockEnsureCanonicalUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apple",
        subject: "apple-sub-123",
        audience: "com.vgibbs.hakmun",
      }),
      expect.any(String)
    );
  });

  test("8. web flow: successful sign-in with code + redirectUri", async () => {
    mockVerifyAppleCode.mockResolvedValue({
      appleSubject: "apple-sub-web-456",
      audience: "com.hakmun.web",
      email: "webuser@icloud.com",
    });

    const res = await request(app)
      .post("/v1/auth/apple")
      .send({
        code: "valid-apple-auth-code",
        redirectUri: "https://app.hakmunapp.com/auth/apple/callback",
      });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("access-token-123");
    expect(res.body.user.userID).toBe(TEST_USER_ID);

    expect(mockVerifyAppleCode).toHaveBeenCalledWith(
      "valid-apple-auth-code",
      "https://app.hakmunapp.com/auth/apple/callback"
    );
    expect(mockEnsureCanonicalUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apple",
        subject: "apple-sub-web-456",
        audience: "com.hakmun.web",
      }),
      expect.any(String)
    );
  });

  test("9. web flow: rejects missing redirectUri", async () => {
    const res = await request(app)
      .post("/v1/auth/apple")
      .send({ code: "valid-apple-auth-code" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redirectUri/i);
  });

  test("10. rejects empty body (neither identityToken nor code)", async () => {
    const res = await request(app)
      .post("/v1/auth/apple")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/identityToken|code/i);
  });
});
