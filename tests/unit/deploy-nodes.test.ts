import { describe, it, expect, vi, beforeEach } from "vitest";
import { deployNodes } from "../../scripts/deploy-nodes.js";
import type { WindmillClient } from "../../src/lib/windmill-client.js";

function mockClient(scripts: Map<string, { hash: string; content: string }>) {
  return {
    getScript: vi.fn(async (path: string) => {
      const s = scripts.get(path);
      if (!s) return null;
      return { hash: s.hash, content: s.content, path, language: "bun", summary: "" };
    }),
    createScript: vi.fn(async () => {}),
  } as unknown as WindmillClient;
}

describe("deployNodes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates scripts that don't exist in Windmill", async () => {
    const client = mockClient(new Map());
    const results = await deployNodes(client);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.action === "created")).toBe(true);
    expect((client.createScript as ReturnType<typeof vi.fn>).mock.calls.length).toBe(results.length);

    // Verify no parent_hash on create calls
    for (const call of (client.createScript as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].parent_hash).toBeUndefined();
      expect(call[0].language).toBe("bun");
      expect(call[0].path).toMatch(/^f\/nodes\//);
    }
  });

  it("updates scripts with changed content", async () => {
    const scripts = new Map([
      ["f/nodes/client_create_user", { hash: "abc123", content: "old content" }],
    ]);
    const client = mockClient(scripts);
    const results = await deployNodes(client);

    const updated = results.filter((r) => r.path === "f/nodes/client_create_user");
    expect(updated).toHaveLength(1);
    expect(updated[0].action).toBe("updated");

    const updateCall = (client.createScript as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { path: string }).path === "f/nodes/client_create_user"
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].parent_hash).toBe("abc123");
  });

  it("skips scripts with unchanged content", async () => {
    // Read actual content of one script to simulate "unchanged"
    const fs = await import("node:fs");
    const path = await import("node:path");
    const actualContent = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../scripts/nodes/client-create-user.ts"),
      "utf-8"
    );

    const scripts = new Map([
      ["f/nodes/client_create_user", { hash: "abc123", content: actualContent }],
    ]);
    const client = mockClient(scripts);
    const results = await deployNodes(client);

    // client_create_user should NOT be in results (skipped)
    const skipped = results.find((r) => r.path === "f/nodes/client_create_user");
    expect(skipped).toBeUndefined();
  });

  it("maps filenames to correct Windmill paths", async () => {
    const client = mockClient(new Map());
    const results = await deployNodes(client);

    const paths = results.map((r) => r.path);
    expect(paths).toContain("f/nodes/client_create_user");
    expect(paths).toContain("f/nodes/lead_service");
    expect(paths).toContain("f/nodes/transactional_email_send");
    expect(paths).toContain("f/nodes/stripe_create_product");
    // No dashes in paths
    expect(paths.every((p) => !p.includes("-"))).toBe(true);
  });
});
