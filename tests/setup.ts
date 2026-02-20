process.env.WORKFLOW_SERVICE_DATABASE_URL =
  process.env.WORKFLOW_SERVICE_DATABASE_URL ??
  "postgresql://test:test@localhost/windmill_test";
process.env.WORKFLOW_SERVICE_API_KEY = "test-api-key";
process.env.WINDMILL_SERVER_URL = "http://localhost:8000";
process.env.WINDMILL_SERVER_API_KEY = "test-windmill-token";
process.env.WINDMILL_SERVER_WORKSPACE = "test";
process.env.NODE_ENV = "test";
