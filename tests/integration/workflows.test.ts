import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_UNKNOWN_TYPE,
  DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
} from "../helpers/fixtures.js";

// Mock DB
const mockDbRows: Record<string, unknown>[] = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: "wf-" + Math.random().toString(36).slice(2, 10),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockDbRows.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: (condition?: unknown) => {
          // Return matching rows or all
          return Promise.resolve(
            mockDbRows.filter((r) => r.status !== "deleted")
          );
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const row = mockDbRows[mockDbRows.length - 1];
          if (row) Object.assign(row, values);
          return {
            returning: () => Promise.resolve([{ ...row, ...values }]),
          };
        },
      }),
    }),
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// Mock Windmill client
vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: vi.fn().mockResolvedValue(undefined),
    getFlow: vi.fn().mockResolvedValue({ path: "f/workflows/test/flow" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const AUTH = { "x-api-key": "test-api-key" };

describe("POST /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("creates a workflow with valid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        orgId: "org-1",
        name: "Test Flow",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Test Flow");
    expect(res.body.orgId).toBe("org-1");
    expect(res.body.status).toBe("active");
    expect(res.body.windmillFlowPath).toContain("f/workflows/org-1/");
  });

  it("rejects an invalid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        orgId: "org-1",
        name: "Bad Flow",
        dag: DAG_WITH_UNKNOWN_TYPE,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid DAG");
    expect(res.body.details).toBeDefined();
  });

  it("requires authentication", async () => {
    const res = await request.post("/workflows").send({
      orgId: "org-1",
      name: "No Auth",
      dag: VALID_LINEAR_DAG,
    });

    expect(res.status).toBe(401);
  });

  it("validates request body with Zod", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      // Missing required fields
      name: "Incomplete",
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("requires orgId parameter", async () => {
    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("orgId");
  });

  it("returns workflows for orgId", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Flow 1",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("returns displayName and category in response", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      appId: "my-app",
      name: "sales-flow",
      displayName: "Sales Flow",
      category: "sales",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].displayName).toBe("Sales Flow");
    expect(res.body.workflows[0].category).toBe("sales");
  });
});

describe("PUT /workflows/deploy", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("creates new workflows scoped by appId", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "newsletter-subscribe",
            description: "Newsletter signup",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].name).toBe("newsletter-subscribe");
    expect(res.body.workflows[0].action).toBe("created");
    expect(res.body.workflows[0].id).toBeDefined();
  });

  it("updates existing workflows (idempotent)", async () => {
    mockDbRows.push({
      id: "wf-existing",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "newsletter-subscribe",
      description: "Old description",
      status: "active",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      windmillFlowPath: "f/workflows/kevinlourd-com/newsletter_subscribe",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "newsletter-subscribe",
            description: "Updated description",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].action).toBe("updated");
  });

  it("accepts displayName and category on deploy", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "sales-cold-email-v1",
            displayName: "Sales Cold Email Outreach",
            category: "sales",
            description: "3-email sequence",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].action).toBe("created");
    expect(res.body.workflows[0].displayName).toBe("Sales Cold Email Outreach");
    expect(res.body.workflows[0].category).toBe("sales");
  });

  it("accepts all three dimension enums on deploy", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "full-metadata-flow",
            displayName: "Full Metadata",
            category: "sales",
            channel: "email",
            audienceType: "cold-outreach",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].category).toBe("sales");
    expect(res.body.workflows[0].channel).toBe("email");
    expect(res.body.workflows[0].audienceType).toBe("cold-outreach");
  });

  it("returns null for all dimension fields when not provided", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "basic-flow",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].displayName).toBeNull();
    expect(res.body.workflows[0].category).toBeNull();
    expect(res.body.workflows[0].channel).toBeNull();
    expect(res.body.workflows[0].audienceType).toBeNull();
  });

  it("rejects invalid channel value", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "bad-channel-flow",
            channel: "smoke-signal",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid audienceType value", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "bad-audience-flow",
            audienceType: "lukewarm",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid category values", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "bad-category-flow",
            category: "invalid-category",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects non-slug name format", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "My Flow With Spaces",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("rejects name starting with hyphen", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "-leading-hyphen",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("preserves displayName/category on update", async () => {
    mockDbRows.push({
      id: "wf-existing",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "newsletter-subscribe",
      displayName: "Newsletter Signup",
      category: "sales",
      description: "Old description",
      status: "active",
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      windmillFlowPath: "f/workflows/kevinlourd-com/newsletter_subscribe",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          {
            name: "newsletter-subscribe",
            description: "Updated description",
            dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].action).toBe("updated");
    expect(res.body.workflows[0].displayName).toBe("Newsletter Signup");
    expect(res.body.workflows[0].category).toBe("sales");
  });

  it("rejects if any DAG is invalid (no partial writes)", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        workflows: [
          { name: "good-flow", dag: VALID_LINEAR_DAG },
          { name: "bad-flow", dag: DAG_WITH_UNKNOWN_TYPE },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid DAGs");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].name).toBe("bad-flow");
  });

  it("requires authentication", async () => {
    const res = await request.put("/workflows/deploy").send({
      appId: "kevinlourd-com",
      workflows: [{ name: "test", dag: VALID_LINEAR_DAG }],
    });

    expect(res.status).toBe(401);
  });

  it("validates request body", async () => {
    const res = await request
      .put("/workflows/deploy")
      .set(AUTH)
      .send({ appId: "kevinlourd-com" }); // missing workflows

    expect(res.status).toBe(400);
  });
});

describe("POST /workflows/:id/validate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("validates the DAG of an existing workflow", async () => {
    mockDbRows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Flow 1",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post("/workflows/wf-1/validate")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});
