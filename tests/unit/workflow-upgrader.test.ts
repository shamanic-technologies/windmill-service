import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";

// Mock the API registry client
vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchLlmContext: vi.fn().mockResolvedValue({
    services: [
      {
        service: "campaign",
        description: "Campaign service",
        endpoints: [
          { method: "POST", path: "/gate-check", summary: "Gate check" },
          { method: "POST", path: "/start-run", summary: "Start run" },
          { method: "POST", path: "/end-run", summary: "End run" },
        ],
      },
    ],
  }),
  fetchServiceSpec: vi.fn().mockResolvedValue({
    paths: {
      "/gate-check": { post: {} },
      "/start-run": { post: {} },
      "/end-run": { post: {} },
    },
  }),
}));

import {
  upgradeWorkflow,
  setUpgradeAnthropicClient,
  UpgradeValidationError,
} from "../../src/lib/workflow-upgrader.js";

describe("upgradeWorkflow", () => {
  const BROKEN_DAG: DAG = {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/internal/gate-check", stopAfterIf: "result.allowed == false" },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
      {
        id: "end-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
    ],
    edges: [{ from: "gate-check", to: "end-run" }],
  };

  const FIXED_DAG: DAG = {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
      {
        id: "end-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/end-run", body: { success: true } },
        inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
      },
    ],
    edges: [{ from: "gate-check", to: "end-run" }],
  };

  const IDENTITY = { orgId: "test-org", userId: "test-user", runId: "test-run" };
  const METADATA = {
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    description: "Test workflow",
  };

  afterEach(() => {
    setUpgradeAnthropicClient(null);
  });

  it("calls the LLM with upgrade prompt and returns corrected DAG", async () => {
    // Mock Anthropic client that immediately returns a fixed DAG via create_workflow
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "create_workflow",
              input: {
                category: "sales",
                channel: "email",
                audienceType: "cold-outreach",
                description: "Test workflow (fixed)",
                dag: FIXED_DAG,
              },
            },
          ],
        }),
      },
    };

    setUpgradeAnthropicClient(mockClient as any);

    const result = await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      "fake-key",
      IDENTITY,
      METADATA,
    );

    expect(result.dag.nodes[0].config?.path).toBe("/gate-check");
    expect(result.category).toBe("sales");
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);

    // Verify the system prompt mentions the broken endpoint
    const systemArg = mockClient.messages.create.mock.calls[0][0].system;
    expect(systemArg).toContain("/internal/gate-check");
    expect(systemArg).toContain("FIX a broken workflow");
  });

  it("handles discovery tool calls before generating the fixed DAG", async () => {
    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: model wants to call list_services
            return Promise.resolve({
              content: [
                { type: "tool_use", id: "t1", name: "list_services", input: {} },
              ],
            });
          }
          // Second call: model returns the fixed DAG
          return Promise.resolve({
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "create_workflow",
                input: {
                  category: "sales",
                  channel: "email",
                  audienceType: "cold-outreach",
                  description: "Fixed",
                  dag: FIXED_DAG,
                },
              },
            ],
          });
        }),
      },
    };

    setUpgradeAnthropicClient(mockClient as any);

    const result = await upgradeWorkflow(
      BROKEN_DAG,
      [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
      "fake-key",
      IDENTITY,
      METADATA,
    );

    expect(result.dag.nodes[0].config?.path).toBe("/gate-check");
    expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
  });

  it("throws when LLM produces invalid DAG after retries", async () => {
    const invalidDag: DAG = {
      nodes: [
        { id: "a", type: "nonexistent-type" },
      ],
      edges: [{ from: "a", to: "b" }], // 'b' doesn't exist
    };

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "create_workflow",
              input: {
                category: "sales",
                channel: "email",
                audienceType: "cold-outreach",
                description: "Bad",
                dag: invalidDag,
              },
            },
          ],
        }),
      },
    };

    setUpgradeAnthropicClient(mockClient as any);

    await expect(
      upgradeWorkflow(
        BROKEN_DAG,
        [{ service: "campaign", method: "POST", path: "/internal/gate-check", reason: "not found" }],
        "fake-key",
        IDENTITY,
        METADATA,
      ),
    ).rejects.toThrow(UpgradeValidationError);
  });
});
