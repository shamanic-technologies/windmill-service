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
  DAG_WITH_RETRIES_ZERO,
  DAG_WITH_CUSTOM_RETRIES,
  DAG_WITH_ON_ERROR,
  DAG_WITH_FLOW_INPUT_REFS,
  DAG_WITH_CONFIG_RETRIES,
  DAG_WITH_DOT_NOTATION_AND_STATIC_BASE,
  DAG_WITH_STOP_AFTER_IF,
  DAG_WITH_SKIP_IF,
  DAG_WITH_CONDITION_CHAIN,
  DAG_WITH_TWO_BRANCHES,
} from "../helpers/fixtures.js";

describe("dagToOpenFlow", () => {
  it("translates a linear DAG to sequential modules", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Cold Email Flow");

    expect(result.summary).toBe("Cold Email Flow");
    expect(result.value.modules).toHaveLength(3);

    // Modules should be in topological order
    expect(result.value.modules[0].id).toBe("lead_search");
    expect(result.value.modules[1].id).toBe("email_gen");
    expect(result.value.modules[2].id).toBe("email_send");

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

  it("translates a condition node to a branchone module with nested branch targets", () => {
    const result = dagToOpenFlow(DAG_WITH_CONDITION, "Branch Flow");

    // Only the branchone should be top-level (branch-a/branch-b are nested inside)
    expect(result.value.modules).toHaveLength(1);

    const condModule = result.value.modules[0];
    expect(condModule.id).toBe("check");
    expect(condModule.value.type).toBe("branchone");

    if (condModule.value.type === "branchone") {
      expect(condModule.value.branches).toHaveLength(2);

      expect(condModule.value.branches[0].expr).toBe("results.check.score > 50");
      expect(condModule.value.branches[0].modules).toHaveLength(1);
      expect(condModule.value.branches[0].modules[0].id).toBe("branch_a");

      expect(condModule.value.branches[1].expr).toBe("results.check.score <= 50");
      expect(condModule.value.branches[1].modules).toHaveLength(1);
      expect(condModule.value.branches[1].modules[0].id).toBe("branch_b");
    }
  });

  it("translates a for-each node to a forloopflow module with nested body", () => {
    const result = dagToOpenFlow(DAG_WITH_FOREACH, "Loop Flow");

    // Only the forloopflow should be top-level (send is nested inside)
    expect(result.value.modules).toHaveLength(1);

    const loopModule = result.value.modules[0];
    expect(loopModule.id).toBe("loop");
    expect(loopModule.value.type).toBe("forloopflow");

    if (loopModule.value.type === "forloopflow") {
      expect(loopModule.value.iterator).toEqual({
        type: "javascript",
        expr: "flow_input.contacts",
      });
      expect(loopModule.value.parallel).toBe(false);
      expect(loopModule.value.modules).toHaveLength(1);
      expect(loopModule.value.modules[0].id).toBe("send");
    }
  });

  it("translates $ref input mapping to javascript transforms", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Ref Test");

    const emailGen = result.value.modules.find((m) => m.id === "email_gen");
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
    expect(mod.id).toBe("get_product");
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
    expect(result.value.modules[0].id).toBe("create_user");
    expect(result.value.modules[1].id).toBe("send_welcome");

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

  it("auto-injects appId and serviceEnvs input_transforms into script modules", () => {
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
        expect(transforms.serviceEnvs).toEqual({
          type: "javascript",
          expr: "flow_input.serviceEnvs",
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

  it("declares appId and serviceEnvs in OpenFlow schema properties", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Schema Test");

    expect(result.schema).toBeDefined();
    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.appId).toEqual({ type: "string", description: "Application identifier" });
    expect(props.serviceEnvs).toEqual({ type: "object", description: "Service URLs and API keys injected by workflow-service" });
  });

  it("generates valid OpenFlow schema structure", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Schema Test");

    expect(result.schema).toBeDefined();
    expect(result.value.same_worker).toBe(false);
  });

  it("sets explicit retry attempts: 0 when node has retries: 0", () => {
    const result = dagToOpenFlow(DAG_WITH_RETRIES_ZERO, "No Retry");

    expect(result.value.modules).toHaveLength(1);
    const mod = result.value.modules[0];
    expect(mod.retry).toEqual({ constant: { attempts: 0, seconds: 0 } });
  });

  it("uses custom retry count from node retries field", () => {
    const result = dagToOpenFlow(DAG_WITH_CUSTOM_RETRIES, "Custom Retry");

    const searchMod = result.value.modules.find((m) => m.id === "search");
    expect(searchMod!.retry).toEqual({ constant: { attempts: 5, seconds: 5 } });

    const sendMod = result.value.modules.find((m) => m.id === "send_email");
    expect(sendMod!.retry).toEqual({ constant: { attempts: 0, seconds: 0 } });
  });

  it("defaults to 3 retries when retries field is omitted", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Default Retry");

    for (const mod of result.value.modules) {
      if (mod.value.type === "script") {
        expect(mod.retry).toEqual({ constant: { attempts: 3, seconds: 5 } });
      }
    }
  });

  it("translates onError to failure_module", () => {
    const result = dagToOpenFlow(DAG_WITH_ON_ERROR, "Error Handler");

    // end-run should NOT be in the main modules list
    expect(result.value.modules.find((m) => m.id === "end_run")).toBeUndefined();

    // failure_module should exist
    expect(result.value.failure_module).toBeDefined();
    expect(result.value.failure_module!.id).toBe("end_run");
    expect(result.value.failure_module!.summary).toBe("onError: end-run");

    if (result.value.failure_module!.value.type === "script") {
      const transforms = result.value.failure_module!.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      // Should preserve $ref input mappings
      expect(transforms.runId).toEqual({
        type: "javascript",
        expr: "results.start_run.runId",
      });
      // Should inject error context
      expect(transforms.failedNodeId).toEqual({
        type: "javascript",
        expr: "error.failed_step",
      });
      expect(transforms.errorMessage).toEqual({
        type: "javascript",
        expr: "error.message",
      });
      // Should auto-inject appId and serviceEnvs
      expect(transforms.appId).toEqual({
        type: "javascript",
        expr: "flow_input.appId",
      });
      expect(transforms.serviceEnvs).toEqual({
        type: "javascript",
        expr: "flow_input.serviceEnvs",
      });
    }
  });

  it("does not set failure_module when onError is not specified", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "No Error Handler");
    expect(result.value.failure_module).toBeUndefined();
  });

  it("declares $ref:flow_input fields in OpenFlow schema so Windmill passes them through", () => {
    const result = dagToOpenFlow(DAG_WITH_FLOW_INPUT_REFS, "Flow Input Schema");

    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.appId).toEqual({ type: "string", description: "Application identifier" });
    expect(props.campaignId).toEqual({ type: "string" });
    expect(props.clerkOrgId).toEqual({ type: "string" });
  });

  it("declares flow_input fields from all nodes including onError handler", () => {
    const result = dagToOpenFlow(DAG_WITH_ON_ERROR, "Error Handler Schema");

    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    // success is referenced via $ref:flow_input.success in end-run node
    expect(props.success).toEqual({ type: "string" });
  });

  it("declares nested flow_input refs using only the top-level field name", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Nested Ref Schema");

    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    // brandIntel is referenced via $ref:flow_input.brandIntel in email-gen node
    expect(props.brandIntel).toEqual({ type: "string" });
  });

  it("reads retries from config.retries when top-level retries is absent", () => {
    const result = dagToOpenFlow(DAG_WITH_CONFIG_RETRIES, "Config Retries");

    const mod = result.value.modules[0];
    // config.retries: 0 → should produce explicit retry attempts: 0
    expect(mod.retry).toEqual({ constant: { attempts: 0, seconds: 0 } });
  });

  it("strips retries from config so it is not passed as a script parameter", () => {
    const result = dagToOpenFlow(DAG_WITH_CONFIG_RETRIES, "Config Retries Strip");

    const mod = result.value.modules[0];
    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      // retries should NOT appear as an input transform
      expect(transforms.retries).toBeUndefined();
      // Other config fields should still be present
      expect(transforms.service).toEqual({ type: "static", value: "campaign" });
    }
  });

  it("collapses dot-notation inputMapping keys into nested body object", () => {
    const result = dagToOpenFlow(DAG_WITH_CONFIG_RETRIES, "Dot Notation");

    const mod = result.value.modules[0];
    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      // Should NOT have flat dot-notation keys
      expect(transforms["body.campaignId"]).toBeUndefined();
      expect(transforms["body.clerkOrgId"]).toBeUndefined();
      // Should have a collapsed body transform
      expect(transforms.body).toBeDefined();
      expect(transforms.body.type).toBe("javascript");
      expect(transforms.body.expr).toContain("flow_input.campaignId");
      expect(transforms.body.expr).toContain("flow_input.clerkOrgId");
    }
  });

  it("normalizes hyphenated node ids to underscores in module ids", () => {
    // Regression: Windmill stores results under the literal module id.
    // If module id is "start-run" but expressions use "results.start_run",
    // the lookup fails and results.start_run is null.
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Module ID Test");

    for (const mod of result.value.modules) {
      expect(mod.id).not.toContain("-");
    }

    // Specifically verify hyphenated node ids become underscored module ids
    expect(result.value.modules[0].id).toBe("lead_search");
    expect(result.value.modules[1].id).toBe("email_gen");
    expect(result.value.modules[2].id).toBe("email_send");

    // Summary should keep the original node id for readability
    expect(result.value.modules[0].summary).toContain("lead-search");
  });

  it("normalizes hyphenated failure module id to underscores", () => {
    const result = dagToOpenFlow(DAG_WITH_ON_ERROR, "Failure Module ID");

    expect(result.value.failure_module).toBeDefined();
    expect(result.value.failure_module!.id).toBe("end_run");
    expect(result.value.failure_module!.id).not.toContain("-");
  });

  it("adds stop_after_if to module when config.stopAfterIf is set", () => {
    const result = dagToOpenFlow(DAG_WITH_STOP_AFTER_IF, "Graceful Stop");

    const fetchMod = result.value.modules.find((m) => m.id === "fetch_lead");
    expect(fetchMod).toBeDefined();
    expect(fetchMod!.stop_after_if).toEqual({
      expr: "result.found == false",
      skip_if_stopped: true,
    });
  });

  it("strips stopAfterIf from input_transforms so it is not passed to the script", () => {
    const result = dagToOpenFlow(DAG_WITH_STOP_AFTER_IF, "Strip StopAfterIf");

    const fetchMod = result.value.modules.find((m) => m.id === "fetch_lead");
    if (fetchMod!.value.type === "script") {
      const transforms = fetchMod!.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.stopAfterIf).toBeUndefined();
      // Other config fields should still be present
      expect(transforms.service).toEqual({ type: "static", value: "lead" });
    }
  });

  it("does not add stop_after_if when config.stopAfterIf is absent", () => {
    const result = dagToOpenFlow(DAG_WITH_HTTP_CALL, "No Stop");

    const mod = result.value.modules[0];
    expect(mod.stop_after_if).toBeUndefined();
  });

  it("adds skip_if to module when config.skipIf is set", () => {
    const result = dagToOpenFlow(DAG_WITH_SKIP_IF, "Skip If");

    const emailMod = result.value.modules.find((m) => m.id === "email_gen");
    expect(emailMod).toBeDefined();
    expect(emailMod!.skip_if).toEqual({
      expr: "results.fetch_lead.found == false",
    });
  });

  it("strips skipIf from input_transforms", () => {
    const result = dagToOpenFlow(DAG_WITH_SKIP_IF, "Strip SkipIf");

    const emailMod = result.value.modules.find((m) => m.id === "email_gen");
    if (emailMod!.value.type === "script") {
      const transforms = emailMod!.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.skipIf).toBeUndefined();
      expect(transforms.service).toEqual({ type: "static", value: "ai" });
    }
  });

  it("does not add skip_if to modules without config.skipIf", () => {
    const result = dagToOpenFlow(DAG_WITH_SKIP_IF, "No Skip");

    const fetchMod = result.value.modules.find((m) => m.id === "fetch_lead");
    expect(fetchMod!.skip_if).toBeUndefined();

    const endMod = result.value.modules.find((m) => m.id === "end_run");
    expect(endMod!.skip_if).toBeUndefined();
  });

  it("nests chained nodes inside condition branch and keeps after-branch nodes top-level", () => {
    const result = dagToOpenFlow(DAG_WITH_CONDITION_CHAIN, "Campaign Flow");

    // Top-level: fetch-lead, check-lead (branchone), end-run
    expect(result.value.modules).toHaveLength(3);
    expect(result.value.modules[0].id).toBe("fetch_lead");
    expect(result.value.modules[1].id).toBe("check_lead");
    expect(result.value.modules[2].id).toBe("end_run");

    const condModule = result.value.modules[1];
    expect(condModule.value.type).toBe("branchone");

    if (condModule.value.type === "branchone") {
      expect(condModule.value.branches).toHaveLength(1);
      expect(condModule.value.branches[0].expr).toBe("results.fetch_lead.found == true");
      // email-gen and email-send are chained inside the branch
      expect(condModule.value.branches[0].modules).toHaveLength(2);
      expect(condModule.value.branches[0].modules[0].id).toBe("email_gen");
      expect(condModule.value.branches[0].modules[1].id).toBe("email_send");

      // Default branch is empty (when found=false, skip to end-run)
      expect(condModule.value.default).toHaveLength(0);
    }
  });

  it("places nodes in correct branches and keeps unconditional targets after branch", () => {
    const result = dagToOpenFlow(DAG_WITH_TWO_BRANCHES, "Two Branch Flow");

    // Top-level: branchone (check-score), log-result
    expect(result.value.modules).toHaveLength(2);
    expect(result.value.modules[0].id).toBe("check_score");
    expect(result.value.modules[1].id).toBe("log_result");

    const condModule = result.value.modules[0];
    if (condModule.value.type === "branchone") {
      expect(condModule.value.branches).toHaveLength(2);

      const highBranch = condModule.value.branches.find(
        (b) => b.expr === "results.check_score.score > 50",
      );
      expect(highBranch!.modules).toHaveLength(1);
      expect(highBranch!.modules[0].id).toBe("send_email");

      const lowBranch = condModule.value.branches.find(
        (b) => b.expr === "results.check_score.score <= 50",
      );
      expect(lowBranch!.modules).toHaveLength(1);
      expect(lowBranch!.modules[0].id).toBe("send_sms");
    }
  });

  it("merges dot-notation keys with static config body and handles nested metadata", () => {
    const result = dagToOpenFlow(DAG_WITH_DOT_NOTATION_AND_STATIC_BASE, "Merge Body");

    const mod = result.value.modules[0];
    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      expect(transforms.body).toBeDefined();
      expect(transforms.body.type).toBe("javascript");
      const expr = transforms.body.expr!;
      // Static base should be spread
      expect(expr).toContain('"cold-email"');
      expect(expr).toContain('"broadcast"');
      // Dynamic fields should be present
      expect(expr).toContain("results.start_run.lead.data.email");
      expect(expr).toContain("results.start_run.appId");
      // Nested metadata should merge static source with dynamic emailGenerationId
      expect(expr).toContain('"source"');
      expect(expr).toContain("results.email_generate.id");
    }
  });
});
