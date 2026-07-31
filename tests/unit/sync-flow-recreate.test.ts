import { describe, it, expect, vi } from "vitest";
import { syncFlowToWindmill } from "../../src/lib/startup-validator.js";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";
import type { Workflow } from "../../src/db/schema.js";
import type { WindmillClient } from "../../src/lib/windmill-client.js";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    workflowSlug: "sales-cold-email-outreach-wisteria",
    description: "a workflow",
    dag: VALID_LINEAR_DAG,
    windmillFlowPath: "f/workflows/org-1/sales_cold_email_outreach_wisteria",
    ...overrides,
  } as unknown as Workflow;
}

function makeClient(updateImpl: () => Promise<void>) {
  const updateFlow = vi.fn(updateImpl);
  const createFlow = vi.fn(async () => "path");
  return {
    client: { updateFlow, createFlow } as unknown as WindmillClient,
    updateFlow,
    createFlow,
  };
}

describe("syncFlowToWindmill", () => {
  it("updates the flow when it already exists", async () => {
    const { client, updateFlow, createFlow } = makeClient(async () => {});

    await syncFlowToWindmill(makeWorkflow(), client);

    expect(updateFlow).toHaveBeenCalledTimes(1);
    expect(createFlow).not.toHaveBeenCalled();
  });

  it("recreates the flow at the recorded path when Windmill 404s", async () => {
    const { client, updateFlow, createFlow } = makeClient(async () => {
      throw new Error(
        "Windmill API error: POST /flows/update/f/workflows/org-1/x → 404 Not Found: Not found: Flow not found",
      );
    });

    await syncFlowToWindmill(makeWorkflow(), client);

    expect(updateFlow).toHaveBeenCalledTimes(1);
    expect(createFlow).toHaveBeenCalledTimes(1);
    const arg = createFlow.mock.calls[0][0] as unknown as { path: string; summary: string };
    expect(arg.path).toBe("f/workflows/org-1/sales_cold_email_outreach_wisteria");
    expect(arg.summary).toBe("sales-cold-email-outreach-wisteria");
  });

  it("does not swallow a non-404 failure", async () => {
    const { client, createFlow } = makeClient(async () => {
      throw new Error("Windmill API error: POST /flows/update/... → 500 Internal Server Error");
    });

    await expect(syncFlowToWindmill(makeWorkflow(), client)).rejects.toThrow("500");
    expect(createFlow).not.toHaveBeenCalled();
  });

  it("is a no-op for a workflow with no flow path", async () => {
    const { client, updateFlow, createFlow } = makeClient(async () => {});

    await syncFlowToWindmill(makeWorkflow({ windmillFlowPath: null }), client);

    expect(updateFlow).not.toHaveBeenCalled();
    expect(createFlow).not.toHaveBeenCalled();
  });
});
