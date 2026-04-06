// Set required env vars before any module loads.
// These are dummy values — real DB/auth are mocked at the module level.
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.SESSION_JWT_SECRET = "test-secret-for-jest";
process.env.APPLE_CLIENT_IDS = "com.test.app";
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "sk-test-dummy-key";
