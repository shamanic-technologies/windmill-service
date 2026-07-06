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
  DAG_WITH_CAMPAIGN_START_RUN,
  DAG_WITH_CAMPAIGN_FOREACH,
  DAG_WITH_DOT_NOTATION_AND_STATIC_BASE,
  DAG_WITH_STOP_AFTER_IF,
  DAG_WITH_SKIP_IF,
  DAG_WITH_CONDITION_CHAIN,
  DAG_WITH_TWO_BRANCHES,
  DAG_WITH_PATH_PARAMS,
  DAG_WITH_HYPHENATED_CONDITION,
  DAG_WITH_BRANCH_CONVERGENCE,
  DAG_WITH_SCRIPT_NODE,
  DAG_WITH_SCRIPT_NODE_INPUTS,
  DAG_WITH_SCRIPT_NODE_DENO,
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
      // body is collapsed from dot-notation keys into a single javascript expression
      expect(transforms.body).toBeDefined();
      expect(transforms.body.type).toBe("javascript");
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
      expect(transforms.orgId).toEqual({
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

  it("auto-injects orgId, userId, runId, serviceEnvs, and tracking context into script modules", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Auto Inject");

    for (const mod of result.value.modules) {
      if (mod.value.type === "script") {
        const transforms = mod.value.input_transforms as Record<
          string,
          { type: string; expr?: string; value?: unknown }
        >;
        expect(transforms.orgId).toEqual({
          type: "javascript",
          expr: "flow_input.orgId",
        });
        expect(transforms.userId).toEqual({
          type: "javascript",
          expr: "flow_input.userId",
        });
        expect(transforms.runId).toEqual({
          type: "javascript",
          expr: "flow_input.runId",
        });
        expect(transforms.serviceEnvs).toEqual({
          type: "javascript",
          expr: "flow_input.serviceEnvs",
        });
        expect(transforms.campaignId).toEqual({
          type: "javascript",
          expr: "flow_input.campaignId",
        });
        expect(transforms.brandId).toEqual({
          type: "javascript",
          expr: "flow_input.brandId",
        });
        expect(transforms.workflowSlug).toEqual({
          type: "javascript",
          expr: "flow_input.workflowSlug",
        });
        expect(transforms.featureSlug).toEqual({
          type: "javascript",
          expr: "flow_input.featureSlug",
        });
        expect(transforms.attributionContext).toEqual({
          type: "javascript",
          expr: "flow_input.attributionContext",
        });
        expect(transforms.goal).toEqual({
          type: "javascript",
          expr: "flow_input.goal",
        });
        expect(transforms.brandProfileId).toEqual({
          type: "javascript",
          expr: "flow_input.brandProfileId",
        });
        // Deprecated aliases must NOT be auto-injected.
        expect(transforms.customerProfileId).toBeUndefined();
        expect(transforms.customerPersonaId).toBeUndefined();
        expect(transforms.profileId).toEqual({
          type: "javascript",
          expr: "flow_input.profileId",
        });
        expect(transforms.personaId).toEqual({
          type: "javascript",
          expr: "flow_input.personaId",
        });
        expect(transforms.goalId).toEqual({
          type: "javascript",
          expr: "flow_input.goalId",
        });
        expect(transforms.goalSlug).toEqual({
          type: "javascript",
          expr: "flow_input.goalSlug",
        });
        expect(transforms.optimizationGoal).toEqual({
          type: "javascript",
          expr: "flow_input.optimizationGoal",
        });
      }
    }
  });

  it("threads audienceId from campaign /start-run result into every subsequent node", () => {
    const result = dagToOpenFlow(DAG_WITH_CAMPAIGN_START_RUN, "Audience Flow");
    const byId = new Map(result.value.modules.map((m) => [m.id, m]));

    for (const id of ["fetch_lead", "email_send"]) {
      const mod = byId.get(id);
      expect(mod).toBeDefined();
      if (mod!.value.type === "script") {
        const transforms = mod!.value.input_transforms as Record<
          string,
          { type: string; expr?: string }
        >;
        expect(transforms.audienceId).toEqual({
          type: "javascript",
          expr: "results.start_run?.audienceId",
        });
      }
    }
  });

  it("does not inject audienceId into nodes that run BEFORE start-run (no Windmill result-by-id 404)", () => {
    // gate-check precedes start-run in the chassis. Windmill resolves
    // `results.start_run` via a result-by-id fetch before the JS `?.` guard,
    // so injecting the transform here 404s the lookup at dispatch
    // ("Flow result by id not found ... id: start_run"). Regression for that
    // spurious warning: only start-run DESCENDANTS get the audienceId transform.
    const result = dagToOpenFlow(DAG_WITH_CAMPAIGN_START_RUN, "Audience Flow");
    const gateCheck = result.value.modules.find((m) => m.id === "gate_check");
    expect(gateCheck).toBeDefined();
    if (gateCheck!.value.type === "script") {
      const transforms = gateCheck!.value.input_transforms as Record<string, unknown>;
      expect(transforms.audienceId).toBeUndefined();
    }
  });

  it("does not inject audienceId into the start-run node itself (no self-reference)", () => {
    const result = dagToOpenFlow(DAG_WITH_CAMPAIGN_START_RUN, "Audience Flow");
    const startRun = result.value.modules.find((m) => m.id === "start_run");
    expect(startRun).toBeDefined();
    if (startRun!.value.type === "script") {
      const transforms = startRun!.value.input_transforms as Record<string, unknown>;
      expect(transforms.audienceId).toBeUndefined();
    }
  });

  it("injects no audienceId when the DAG has no campaign /start-run node", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "No Campaign Audience");
    for (const mod of result.value.modules) {
      if (mod.value.type === "script") {
        const transforms = mod.value.input_transforms as Record<string, unknown>;
        expect(transforms.audienceId).toBeUndefined();
      }
    }
  });

  describe("audienceId threading into for-each loop bodies", () => {
    // Regression for #321: per-lead gen/send nodes nested inside a for-each
    // loop body must carry the run's audienceId, but `results.start_run` does
    // NOT resolve inside a Windmill forloopflow subflow. audienceId is folded
    // onto each iterated element (via the iterator expr, evaluated in the parent
    // scope) and read back from `flow_input.iter.value` inside the body.
    const flow = dagToOpenFlow(DAG_WITH_CAMPAIGN_FOREACH, "Campaign ForEach");
    const topById = new Map(flow.value.modules.map((m) => [m.id, m]));
    const loop = topById.get("loop_leads");

    function loopBodyTransforms(id: string): Record<string, { type: string; expr?: string }> {
      if (loop?.value.type !== "forloopflow") throw new Error("loop not a forloopflow");
      const bodyMod = loop.value.modules.find((m) => m.id === id);
      if (!bodyMod || bodyMod.value.type !== "script") throw new Error(`no script body ${id}`);
      return bodyMod.value.input_transforms as Record<string, { type: string; expr?: string }>;
    }

    it("wraps the loop iterator to attach the per-run audienceId to each element", () => {
      expect(loop).toBeDefined();
      if (loop!.value.type === "forloopflow") {
        const expr = (loop!.value.iterator as { type: string; expr: string }).expr;
        // original iterator preserved, mapped, and audienceId attached from
        // start-run's result (resolvable in the parent/iterator scope)
        expect(expr).toContain("results.fetch_leads.leads");
        expect(expr).toContain(".map(");
        expect(expr).toContain("__wf_audience_id: results.start_run?.audienceId");
      }
    });

    it("references audienceId from the iteration context on every loop-body node", () => {
      for (const id of ["email_generate", "email_send"]) {
        expect(loopBodyTransforms(id).audienceId).toEqual({
          type: "javascript",
          expr: "flow_input.iter.value?.__wf_audience_id",
        });
      }
    });

    it("does NOT reference the out-of-scope start-run result inside the loop body", () => {
      for (const id of ["email_generate", "email_send"]) {
        expect(loopBodyTransforms(id).audienceId.expr).not.toContain("results.start_run");
      }
    });

    it("keeps the inline start-run result ref for descendants OUTSIDE the loop", () => {
      const fetchLeads = topById.get("fetch_leads");
      expect(fetchLeads).toBeDefined();
      if (fetchLeads!.value.type === "script") {
        const transforms = fetchLeads!.value.input_transforms as Record<
          string,
          { type: string; expr?: string }
        >;
        expect(transforms.audienceId).toEqual({
          type: "javascript",
          expr: "results.start_run?.audienceId",
        });
      }
    });

    it("does not wrap a for-each iterator when the DAG has no start-run node", () => {
      const noCampaign = dagToOpenFlow(DAG_WITH_FOREACH, "No Campaign Loop");
      const loopMod = noCampaign.value.modules.find((m) => m.id === "loop");
      expect(loopMod).toBeDefined();
      if (loopMod!.value.type === "forloopflow") {
        // iterator untouched, no audienceId attach
        expect((loopMod!.value.iterator as { expr: string }).expr).toBe("flow_input.contacts");
        for (const body of loopMod!.value.modules) {
          if (body.value.type === "script") {
            const t = body.value.input_transforms as Record<string, unknown>;
            expect(t.audienceId).toBeUndefined();
          }
        }
      }
    });
  });

  it("does not override explicit orgId in node config but auto-injects userId", () => {
    const result = dagToOpenFlow(POLARITY_WELCOME_DAG, "Explicit OrgId");

    const mod = result.value.modules[0];
    expect(mod.value.type).toBe("script");

    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      // Should keep the static config value, not override with flow_input
      expect(transforms.orgId).toEqual({
        type: "static",
        value: "polaritycourse",
      });
      // Should still auto-inject userId
      expect(transforms.userId).toEqual({
        type: "javascript",
        expr: "flow_input.userId",
      });
    }
  });

  it("declares orgId, userId, runId, and serviceEnvs in OpenFlow schema properties", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Schema Test");

    expect(result.schema).toBeDefined();
    const props = (result.schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.orgId).toEqual({ type: "string", description: "Organization identifier" });
    expect(props.userId).toEqual({ type: "string", description: "User identifier" });
    expect(props.runId).toEqual({ type: "string", description: "Runs-service run ID for this execution" });
    expect(props.serviceEnvs).toEqual({ type: "object", description: "Service URLs and API keys injected by workflow-service" });
    expect(props.attributionContext).toEqual({ type: "object", description: "Optional campaign attribution context supplied at execution time" });
    expect(props.goal).toEqual({ type: "string", description: "Optional active goal from attribution context" });
    expect(props.brandProfileId).toEqual({ type: "string", description: "Optional brand profile identifier from attribution context" });
    // Deprecated aliases must NOT appear in the flow_input schema.
    expect(props.customerProfileId).toBeUndefined();
    expect(props.customerPersonaId).toBeUndefined();
    expect(props.personaId).toEqual({ type: "string", description: "Optional persona identifier from attribution context" });
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
        expr: "results.start_run?.runId",
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
      // Should auto-inject orgId, userId and serviceEnvs
      expect(transforms.orgId).toEqual({
        type: "javascript",
        expr: "flow_input.orgId",
      });
      expect(transforms.userId).toEqual({
        type: "javascript",
        expr: "flow_input.userId",
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
    expect(props.orgId).toEqual({ type: "string", description: "Organization identifier" });
    expect(props.userId).toEqual({ type: "string", description: "User identifier" });
    expect(props.campaignId).toEqual({ type: "string", description: "Campaign identifier (auto-injected)" });
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
      expect(transforms["body.orgId"]).toBeUndefined();
      // Should have a collapsed body transform
      expect(transforms.body).toBeDefined();
      expect(transforms.body.type).toBe("javascript");
      expect(transforms.body.expr).toContain("flow_input.campaignId");
      expect(transforms.body.expr).toContain("flow_input.orgId");
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
      // Dynamic fields should be present (deep paths use optional chaining)
      expect(expr).toContain("results.start_run?.lead?.email");
      expect(expr).toContain("results.start_run?.orgId");
      // Nested metadata should merge static source with dynamic emailGenerationId
      expect(expr).toContain('"source"');
      expect(expr).toContain("results.email_generate?.id");
    }
  });

  it("regression: transforms hyphenated node IDs in condition expressions to underscores", () => {
    const result = dagToOpenFlow(DAG_WITH_HYPHENATED_CONDITION, "Hyphen Condition");

    // Top-level: fetch-lead, check-lead (branchone), end-run
    expect(result.value.modules).toHaveLength(3);
    expect(result.value.modules[1].id).toBe("check_lead");

    const condModule = result.value.modules[1];
    expect(condModule.value.type).toBe("branchone");

    if (condModule.value.type === "branchone") {
      expect(condModule.value.branches).toHaveLength(1);
      // The expression must use underscored IDs for Windmill compatibility
      expect(condModule.value.branches[0].expr).toBe("results.fetch_lead.found == true");
      // The summary keeps the original expression for readability
      expect(condModule.value.branches[0].summary).toBe("results['fetch-lead'].found == true");
      // email-gen and email-send are inside the branch
      expect(condModule.value.branches[0].modules).toHaveLength(2);
      expect(condModule.value.branches[0].modules[0].id).toBe("email_gen");
      expect(condModule.value.branches[0].modules[1].id).toBe("email_send");
    }
  });

  it("regression: rewrites path.* inputMapping to params.* for http.call nodes", () => {
    const result = dagToOpenFlow(DAG_WITH_PATH_PARAMS, "Fetch Brand");

    const mod = result.value.modules[0];
    expect(mod.id).toBe("fetch_brand");
    if (mod.value.type === "script") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; value?: unknown; expr?: string }
      >;
      // path should remain the static string, NOT be replaced by an object
      expect(transforms.path).toEqual({ type: "static", value: "/internal/brands/:brandId" });
      // params should contain the dynamic path parameter
      expect(transforms.params).toBeDefined();
      expect(transforms.params.type).toBe("javascript");
      expect(transforms.params.expr).toContain("results.start_run?.brandId");
      // body should NOT exist since there's no static body config
      expect(transforms.body).toBeUndefined();
    }
  });

  it("sets a 1-hour timeout on every script module", () => {
    const result = dagToOpenFlow(VALID_LINEAR_DAG, "Timeout Flow");

    for (const mod of result.value.modules) {
      if (mod.value.type === "script") {
        expect(mod.timeout).toEqual({ type: "static", value: 3600 });
      }
    }
  });

  it("regression: convergence node after branch runs on both paths", () => {
    const result = dagToOpenFlow(DAG_WITH_BRANCH_CONVERGENCE, "Convergence");

    // Top-level: fetch-lead, check-lead (branchone), end-run
    expect(result.value.modules).toHaveLength(3);
    expect(result.value.modules[0].id).toBe("fetch_lead");
    expect(result.value.modules[1].id).toBe("check_lead");
    expect(result.value.modules[2].id).toBe("end_run");

    const condModule = result.value.modules[1];
    expect(condModule.value.type).toBe("branchone");

    if (condModule.value.type === "branchone") {
      expect(condModule.value.branches).toHaveLength(2);

      // True branch: email-gen → email-send
      const trueBranch = condModule.value.branches.find(
        (b) => b.expr === "results.fetch_lead.found == true",
      );
      expect(trueBranch).toBeDefined();
      expect(trueBranch!.modules).toHaveLength(2);
      expect(trueBranch!.modules[0].id).toBe("email_gen");
      expect(trueBranch!.modules[1].id).toBe("email_send");

      // False branch: empty — end-run was promoted to after-branch
      const falseBranch = condModule.value.branches.find(
        (b) => b.expr === "results.fetch_lead.found == false",
      );
      expect(falseBranch).toBeDefined();
      expect(falseBranch!.modules).toHaveLength(0);

      expect(condModule.value.default).toHaveLength(0);
    }
  });

  it("sets timeout on http.call modules", () => {
    const result = dagToOpenFlow(DAG_WITH_HTTP_CALL, "HTTP Timeout");
    const mod = result.value.modules[0];
    expect(mod.timeout).toEqual({ type: "static", value: 3600 });
  });

  it("does not set timeout on wait modules", () => {
    const result = dagToOpenFlow(DAG_WITH_WAIT, "Wait Timeout");
    const waitMod = result.value.modules.find((m) => m.id === "pause");
    expect(waitMod!.timeout).toBeUndefined();
  });

  it("translates a script node to a rawscript module with bun language by default", () => {
    const result = dagToOpenFlow(DAG_WITH_SCRIPT_NODE, "Script Flow");

    const scriptModule = result.value.modules.find((m) => m.id === "get_date");
    expect(scriptModule).toBeDefined();
    expect(scriptModule!.value.type).toBe("rawscript");

    if (scriptModule!.value.type === "rawscript") {
      expect(scriptModule!.value.content).toBe(
        "export async function main() { return { currentDate: new Date().toISOString().split('T')[0] }; }"
      );
      expect(scriptModule!.value.language).toBe("bun");
    }
  });

  it("downstream node can $ref a script node's output", () => {
    const result = dagToOpenFlow(DAG_WITH_SCRIPT_NODE, "Script Ref");

    const useDate = result.value.modules.find((m) => m.id === "use_date");
    expect(useDate).toBeDefined();
    expect(useDate!.value.type).toBe("script");

    if (useDate!.value.type === "script") {
      const transforms = useDate!.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      expect(transforms.body).toBeDefined();
      expect(transforms.body.type).toBe("javascript");
      expect(transforms.body.expr).toContain("results.get_date?.currentDate");
    }
  });

  it("populates rawscript input_transforms from inputMapping", () => {
    const result = dagToOpenFlow(DAG_WITH_SCRIPT_NODE_INPUTS, "Script Inputs");

    const mod = result.value.modules[0];
    expect(mod.value.type).toBe("rawscript");

    if (mod.value.type === "rawscript") {
      const transforms = mod.value.input_transforms as Record<
        string,
        { type: string; expr?: string; value?: unknown }
      >;
      expect(transforms.first).toEqual({
        type: "javascript",
        expr: "flow_input.firstName",
      });
      expect(transforms.last).toEqual({
        type: "javascript",
        expr: "flow_input.lastName",
      });
    }
  });

  it("honours an explicit config.language for script nodes", () => {
    const result = dagToOpenFlow(DAG_WITH_SCRIPT_NODE_DENO, "Script Deno");

    const mod = result.value.modules[0];
    expect(mod.value.type).toBe("rawscript");

    if (mod.value.type === "rawscript") {
      expect(mod.value.language).toBe("deno");
    }
  });

  it("sets timeout on script modules", () => {
    const result = dagToOpenFlow(DAG_WITH_SCRIPT_NODE, "Script Timeout");
    const scriptModule = result.value.modules.find((m) => m.id === "get_date");
    expect(scriptModule!.timeout).toEqual({ type: "static", value: 3600 });
  });
});
