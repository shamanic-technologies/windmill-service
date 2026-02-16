import { describe, it, expect } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_WAIT,
  DAG_WITH_CONDITION,
  DAG_WITH_FOREACH,
  POLARITY_WELCOME_DAG,
  DAG_WITH_HTTP_CALL,
  DAG_WITH_HTTP_CALL_CHAIN,
} from "../helpers/fixtures.js";

describe("dagToOpenFlow", () => {
  it("translates a linear DAG to sequential modules", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Cold Email Flow");

    expect(result.summary).toBe("Cold Email Flow");
    expect(result.value.modules).toHaveLength(3);

    // Modules should be in topological order
    expect(result.value.modules[0].id).toBe("lead-search");
    expect(result.value.modules[1].id).toBe("email-gen");
    expect(result.value.modules[2].id).toBe("email-send");

    // First module is a script reference
    const first = result.value.modules[0].value;
    expect(first.type).toBe("script");
    if (first.type === "script") {
      expect(first.path).toBe("f/nodes/lead_service");
    }
  });

  it("translates a wait node to a sleep module", () => {
    const result = dagToOpenFlow(DAG_WITH_WAIT, "Wait Flow");

    const waitModule = result.value.modules.find((m) => m.id === "pause");
    expect(waitModule).toBeDefined();
    expect(waitModule!.sleep).toEqual({ type: "static", value: 30 });
  });

  it("translates a condition node to a branchone module", () => {
    const result = dagToOpenFlow(DAG_WITH_CONDITION, "Branch Flow");

    const condModule = result.value.modules.find((m) => m.id === "check");
    expect(condModule).toBeDefined();
    expect(condModule!.value.type).toBe("branchone");

    if (condModule!.value.type === "branchone") {
      expect(condModule!.value.branches).toHaveLength(2);
      expect(condModule!.value.branches[0].expr).toBe(
        "results.check.score > 50"
      );
    }
  });

  it("translates a for-each node to a forloopflow module", () => {
    const result = dagToOpenFlow(DAG_WITH_FOREACH, "Loop Flow");

    const loopModule = result.value.modules.find((m) => m.id === "loop");
    expect(loopModule).toBeDefined();
    expect(loopModule!.value.type).toBe("forloopflow");

    if (loopModule!.value.type === "forloopflow") {
      expect(loopModule!.value.iterator).toEqual({
        type: "javascript",
        expr: "flow_input.contacts",
      });
      expect(loopModule!.value.parallel).toBe(false);
    }
  });

  it("translates $ref input mapping to javascript transforms", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Ref Test");

    const emailGen = result.value.modules.find((m) => m.id === "email-gen");
    expect(emailGen).toBeDefined();
    expect(emailGen!.value.type).toBe("script");

    if (emailGen!.value.type === "script") {
      const transforms = emailGen!.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      expect(transforms.leadData).toEqual({
        type: "javascript",
        expr: "results.lead_search.lead",
      });
      expect(transforms.clientData).toEqual({
        type: "javascript",
        expr: "flow_input.brandIntel",
      });
    }
  });

  it("spreads static config as individual transforms", () => {
    const result = dagToOpenFlow(POLARITY_WELCOME_DAG, "Welcome");

    const sendModule = result.value.modules[0];
    expect(sendModule.value.type).toBe("script");

    if (sendModule.value.type === "script") {
      const transforms = sendModule.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.appId).toEqual({
        type: "static",
        value: "polaritycourse",
      });
      expect(transforms.eventType).toEqual({
        type: "static",
        value: "webinar-registration-welcome",
      });
      expect(transforms.recipientEmail).toEqual({
        type: "javascript",
        expr: "flow_input.email",
      });
      expect(transforms.config).toBeUndefined();
    }
  });

  it("translates http.call node to script module with config as individual transforms", () => {
    const result = dagToOpenFlow(DAG_WITH_HTTP_CALL, "HTTP Call Test");

    expect(result.value.modules).toHaveLength(1);
    const mod = result.value.modules[0];
    expect(mod.id).toBe("get-product");
    expect(mod.value.type).toBe("script");

    if (mod.value.type === "script") {
      expect(mod.value.path).toBe("f/nodes/http_call");
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.service).toEqual({ type: "static", value: "stripe" });
      expect(transforms.method).toEqual({ type: "static", value: "GET" });
      expect(transforms.path).toEqual({ type: "static", value: "/products/prod_123" });
    }
  });

  it("translates http.call chain with $ref input mapping", () => {
    const result = dagToOpenFlow(DAG_WITH_HTTP_CALL_CHAIN, "HTTP Chain");

    expect(result.value.modules).toHaveLength(2);
    expect(result.value.modules[0].id).toBe("create-user");
    expect(result.value.modules[1].id).toBe("send-welcome");

    const sendMod = result.value.modules[1];
    if (sendMod.value.type === "script") {
      const transforms = sendMod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.service).toEqual({ type: "static", value: "transactional-email" });
      expect(transforms.method).toEqual({ type: "static", value: "POST" });
      expect(transforms.path).toEqual({ type: "static", value: "/send" });
      expect(transforms.body).toEqual({ type: "javascript", expr: "results.create_user" });
    }
  });

  it("auto-injects appId input_transform into script modules", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "AppId Inject");

    for (const mod of result.value.modules) {
      if (mod.value.type === "script") {
        const transforms = mod.value.input_transforms as Record<
          string,
          { type: string; expr?: string; value?: unknown }
        >;
        expect(transforms.appId).toEqual({
          type: "javascript",
          expr: "flow_input.appId",
        });
      }
    }
  });

  it("does not override explicit appId in node config", () => {
    const result = dagToOpenFlow(POLARITY_WELCOME_DAG, "Explicit AppId");

    const mod = result.value.modules[0];
    expect(mod.value.type).toBe("script");

    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      // Should keep the static config value, not override with flow_input
      expect(transforms.appId).toEqual({
        type: "static",
        value: "polaritycourse",
      });
    }
  });

  it("declares appId in OpenFlow schema properties", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Schema Test");

    expect(result.schema).toBeDefined();
    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.appId).toEqual({ type: "string", description: "Application identifier" });
  });

  it("generates valid OpenFlow schema structure", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Schema Test");

    expect(result.schema).toBeDefined();
    expect(result.value.same_worker).toBe(false);
  });
});
