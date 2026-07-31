import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_SRC = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");

/**
 * Regression guard for the cold-compute deploy failure.
 *
 * A Neon compute suspended by scale-to-zero takes seconds to resume. Any work
 * awaited before `app.listen()` spends the deploy's healthcheck budget on that
 * first connection, the port never opens inside Railway's ~30s window, and the
 * deploy is marked FAILED for reasons that have nothing to do with the code
 * being shipped.
 */
describe("boot order", () => {
  const startupBlock = INDEX_SRC.slice(
    INDEX_SRC.indexOf('if (process.env.NODE_ENV !== "test")'),
  );

  it("has a startup block to inspect", () => {
    expect(startupBlock.length).toBeGreaterThan(0);
  });

  it("binds the port before running any boot work", () => {
    const listenAt = startupBlock.indexOf("app.listen(");
    const bootAt = startupBlock.indexOf("boot()");

    expect(listenAt).toBeGreaterThan(-1);
    expect(bootAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(bootAt);
  });

  it("awaits nothing before app.listen()", () => {
    const preListen = startupBlock.slice(0, startupBlock.indexOf("app.listen("));
    expect(preListen).not.toMatch(/\bawait\b/);
  });

  it("runs migrations through the cold-compute retry wrapper", () => {
    expect(INDEX_SRC).toContain("migrateWithRetry(");
    // A bare `await migrate(...)` on the boot path is the shape that fails on a
    // resuming compute.
    expect(INDEX_SRC).not.toMatch(/await\s+migrate\(/);
  });

  it("gates DB-touching routes on migrations, but not /health", () => {
    const healthAt = INDEX_SRC.indexOf("app.use(healthRoutes)");
    const gateAt = INDEX_SRC.indexOf("app.use(requireSchemaReady)");
    const publicAt = INDEX_SRC.indexOf("app.use(publicWorkflowsRoutes)");
    const internalAt = INDEX_SRC.indexOf("app.use(internalRoutes)");
    const identityAt = INDEX_SRC.indexOf("app.use(requireIdentity)");

    expect(gateAt).toBeGreaterThan(-1);
    expect(healthAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(publicAt);
    expect(gateAt).toBeLessThan(internalAt);
    expect(gateAt).toBeLessThan(identityAt);
  });

  it("exits loudly when migrations genuinely fail", () => {
    expect(INDEX_SRC).toContain("markSchemaFailed(");
    expect(INDEX_SRC).toMatch(/FATAL: database migrations failed/);
  });
});
