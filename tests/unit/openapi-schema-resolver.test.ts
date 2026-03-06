import { describe, it, expect } from "vitest";
import {
  resolveSchema,
  getRequestBodySchema,
  getResponseSchema,
} from "../../src/lib/openapi-schema-resolver.js";

describe("resolveSchema", () => {
  it("resolves a direct schema with properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    const result = resolveSchema(schema, {});
    expect(result).toEqual({
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    });
  });

  it("follows $ref to components/schemas", () => {
    const schema = { $ref: "#/components/schemas/User" };
    const spec = {
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "string" }, email: { type: "string" } },
            required: ["id", "email"],
          },
        },
      },
    };
    const result = resolveSchema(schema, spec);
    expect(result).toEqual({
      properties: { id: { type: "string" }, email: { type: "string" } },
      required: ["id", "email"],
    });
  });

  it("handles nested $ref (schema references another schema)", () => {
    const schema = { $ref: "#/components/schemas/Alias" };
    const spec = {
      components: {
        schemas: {
          Alias: { $ref: "#/components/schemas/Real" },
          Real: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    };
    const result = resolveSchema(schema, spec);
    expect(result).toEqual({
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });

  it("handles allOf by merging properties", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      ],
    };
    const result = resolveSchema(schema, {});
    expect(result?.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(result?.required).toEqual(["a", "b"]);
  });

  it("handles oneOf by merging all variants' properties", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { x: { type: "string" } } },
        { type: "object", properties: { y: { type: "number" } } },
      ],
    };
    const result = resolveSchema(schema, {});
    expect(result?.properties).toEqual({ x: { type: "string" }, y: { type: "number" } });
  });

  it("returns null for schemas without properties", () => {
    expect(resolveSchema({ type: "string" }, {})).toBeNull();
    expect(resolveSchema({ type: "array", items: { type: "string" } }, {})).toBeNull();
  });

  it("handles circular $ref gracefully (depth limit)", () => {
    const schema = { $ref: "#/components/schemas/Loop" };
    const spec = {
      components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } },
    };
    expect(resolveSchema(schema, spec)).toBeNull();
  });

  it("returns empty required array when required is not defined", () => {
    const schema = { type: "object", properties: { foo: { type: "string" } } };
    const result = resolveSchema(schema, {});
    expect(result?.required).toEqual([]);
  });
});

describe("getRequestBodySchema", () => {
  const spec = {
    paths: {
      "/gate-check": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    campaignId: { type: "string" },
                    orgId: { type: "string" },
                  },
                  required: ["campaignId", "orgId"],
                },
              },
            },
          },
        },
      },
      "/health": {
        get: { summary: "Health check" },
      },
    },
  };

  it("returns schema for POST endpoint with requestBody", () => {
    const result = getRequestBodySchema(spec, "/gate-check", "POST");
    expect(result?.properties).toHaveProperty("campaignId");
    expect(result?.properties).toHaveProperty("orgId");
    expect(result?.required).toEqual(["campaignId", "orgId"]);
  });

  it("returns null for GET endpoint (no requestBody)", () => {
    expect(getRequestBodySchema(spec, "/health", "GET")).toBeNull();
  });

  it("returns null when path does not exist", () => {
    expect(getRequestBodySchema(spec, "/nonexistent", "POST")).toBeNull();
  });

  it("handles simplified format (schema directly on requestBody)", () => {
    const simplified = {
      paths: {
        "/send": {
          post: {
            requestBody: {
              schema: {
                type: "object",
                properties: { to: { type: "string" } },
                required: ["to"],
              },
            },
          },
        },
      },
    };
    const result = getRequestBodySchema(simplified, "/send", "POST");
    expect(result?.properties).toHaveProperty("to");
    expect(result?.required).toEqual(["to"]);
  });

  it("resolves $ref in requestBody schema", () => {
    const specWithRef = {
      paths: {
        "/create": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateReq" },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          CreateReq: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    };
    const result = getRequestBodySchema(specWithRef, "/create", "POST");
    expect(result?.properties).toHaveProperty("name");
  });
});

describe("getResponseSchema", () => {
  it("returns schema for 200 response", () => {
    const spec = {
      paths: {
        "/check": {
          post: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { allowed: { type: "boolean" } },
                      required: ["allowed"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/check", "POST");
    expect(result?.properties).toHaveProperty("allowed");
  });

  it("falls back to 201 response", () => {
    const spec = {
      paths: {
        "/create": {
          post: {
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/create", "POST");
    expect(result?.properties).toHaveProperty("id");
  });

  it("handles simplified format (schema directly on response)", () => {
    const spec = {
      paths: {
        "/run": {
          post: {
            responses: {
              "200": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/run", "POST");
    expect(result?.properties).toHaveProperty("status");
  });

  it("returns null when no response schema exists", () => {
    const spec = {
      paths: { "/noop": { post: { responses: { "204": {} } } } },
    };
    expect(getResponseSchema(spec, "/noop", "POST")).toBeNull();
  });
});
