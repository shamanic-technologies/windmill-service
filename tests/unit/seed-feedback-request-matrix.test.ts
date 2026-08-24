import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import type { DAG } from "../../src/types.js";
// @ts-expect-error — plain .mjs ops script, no type declarations
import { buildDag, cellOf, ANGLES, MODELS, OFFER_FIELDS } from "../../scripts/seed-feedback-request-matrix.mjs";

const cells = ANGLES.flatMap((a: { type: string }) =>
  MODELS.map((m: string) => ({ type: a.type, model: m })),
);

describe("seed-feedback-request-matrix", () => {
  it("builds twelve cells, three angles by four models", () => {
    expect(ANGLES).toHaveLength(3);
    expect(MODELS).toHaveLength(4);
    expect(cells).toHaveLength(12);
  });

  it("produces a valid DAG for every cell", () => {
    for (const { type, model } of cells) {
      const result = validateDAG(buildDag(type, model) as DAG);
      expect(result.errors, `${type}::${model}`).toEqual([]);
      expect(result.valid, `${type}::${model}`).toBe(true);
    }
  });

  // Twelve rows sharing one signature would collide on the partial unique index
  // over (feature_slug, signature) WHERE status='active', which POST /workflows
  // surfaces as a raw 500 rather than a clean 409.
  it("gives every cell a distinct signature", () => {
    const signatures = cells.map(({ type, model }) => computeDAGSignature(buildDag(type, model)));
    expect(new Set(signatures).size).toBe(cells.length);
  });

  it("writes the model explicitly on every cell, including the Google default", () => {
    for (const { type, model } of cells) {
      const dag = buildDag(type, model) as DAG;
      const node = dag.nodes.find((n) => n.config?.service === "content-generation");
      expect(node?.config?.body).toMatchObject({ type, model });
    }
  });

  // cellOf reads what a STORED dag encodes, and the fleet's existing rows omit
  // the model. Absent has to read back as the chat-service default, or a re-run
  // treats an already-covered cell as missing and duplicates it.
  it("reads an absent model back as the pro default", () => {
    expect(cellOf(buildDag("feedback-request-blind-email-v1", "pro"))).toBe(
      "feedback-request-blind-email-v1::pro",
    );
    expect(
      cellOf({ nodes: [{ id: "x", config: { service: "content-generation", body: { type: "cold-email-v29" } } }] }),
    ).toBe("cold-email-v29::pro");
    expect(cellOf({ nodes: [{ id: "x", config: { service: "lead" } }] })).toBeNull();
  });

  // Each of the eight is a question the customer answers on the feature. A key
  // the DAG asks for that the feature never collects is silently answered from
  // the brand's website instead, so the customer's own words never ship.
  it("asks brand-service for all eight offer fields and maps each into the prompt", () => {
    const dag = buildDag("feedback-request-giving-email-v1", "pro") as DAG;
    const extract = dag.nodes.find((n) => n.id === "brand-extract-fields");
    const fields = (extract?.config?.body as { fields: { key: string }[] }).fields;
    const generate = dag.nodes.find((n) => n.id === "email-generate");

    for (const { key, variable } of OFFER_FIELDS as { key: string; variable: string }[]) {
      expect(fields.map((f) => f.key), key).toContain(key);
      expect(generate?.inputMapping?.[`body.variables.${variable}`]).toBe(
        `$ref:brand-extract-fields.output.fields.${key}.value`,
      );
    }

    // brand-service takes { key, description }; the script's own `variable`
    // bookkeeping must not ride along in the request body.
    for (const field of fields) {
      expect(Object.keys(field).sort()).toEqual(["description", "key"]);
    }
  });

  // features-service named the gift `gift` after the templates were already
  // registered against `giftOffer`. The DAG bridges the two, so a regression
  // here means the customer's description of their own gift stops reaching the
  // email and the extractor answers from the brand's website instead.
  it("bridges the gift key to the variable the templates declare", () => {
    const dag = buildDag("feedback-request-giving-email-v1", "pro") as DAG;
    expect(dag.nodes.find((n) => n.id === "email-generate")?.inputMapping?.["body.variables.giftOffer"]).toBe(
      "$ref:brand-extract-fields.output.fields.gift.value",
    );
  });

  it("supplies currentDate, which the templates declare and the fleet's DAGs omit", () => {
    const dag = buildDag("feedback-request-blind-email-v1", "kimi-pro") as DAG;
    expect(dag.nodes.find((n) => n.id === "get-date")?.type).toBe("script");
    expect(
      dag.nodes.find((n) => n.id === "email-generate")?.inputMapping?.["body.variables.currentDate"],
    ).toBe("$ref:get-date.output.currentDate");
  });

  it("carries the three end-run nodes and the error handler the campaign chassis needs", () => {
    const dag = buildDag("feedback-request-observation-email-v1", "glm-pro") as DAG;
    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["end-run", "end-run-no-lead", "end-run-error"]));
    expect(dag.onError).toBe("end-run-error");
  });

  it("never retries the non-idempotent steps", () => {
    const dag = buildDag("feedback-request-giving-email-v1", "deepseek-pro") as DAG;
    for (const id of ["fetch-lead", "email-generate", "email-send"]) {
      expect(dag.nodes.find((n) => n.id === id)?.retries, id).toBe(0);
    }
  });
});
