import type { DAG, DAGNode, DAGEdge } from "./dag-validator.js";
import { getScriptPath, isNativeNode } from "./node-type-registry.js";
import { buildInputTransforms } from "./input-mapping.js";

/** Global timeout applied to every script module (in seconds). 1 hour. */
const NODE_TIMEOUT_SECONDS = 3600;

/**
 * Reserved key under which the per-run `audienceId` is attached to each element
 * of a for-each iterator so it survives into the loop body.
 *
 * Windmill runs a `forloopflow` body as an isolated subflow: `flow_input.*`
 * (top-level) and `flow_input.iter.value` (current element) resolve inside it,
 * but `results.<outerStep>` does NOT (the start-run result reference used for
 * top-level/branch nodes returns undefined inside the loop). So a value chosen
 * mid-flow (the audienceId returned by campaign `/start-run`) cannot reach a
 * loop-body node via `results.start_run` — it must be folded onto the iterated
 * elements by the iterator expression (which IS evaluated in the parent scope
 * where `results.start_run` resolves) and read back as
 * `flow_input.iter.value?.<AUDIENCE_ITER_KEY>` inside the body.
 */
const AUDIENCE_ITER_KEY = "__wf_audience_id";

/** The reference every loop-body node uses to read the threaded audienceId. */
const LOOP_BODY_AUDIENCE_REF = `flow_input.iter.value?.${AUDIENCE_ITER_KEY}`;

export interface FlowModule {
  id: string;
  summary?: string;
  value:
    | ScriptModule
    | RawScriptModule
    | BranchOneModule
    | ForloopFlowModule;
  sleep?: { type: "javascript"; expr: string } | { type: "static"; value: number };
  timeout?: { type: "static"; value: number };
  retry?: { constant?: { attempts: number; seconds: number } };
  stop_after_if?: { expr: string; skip_if_stopped?: boolean };
  skip_if?: { expr: string };
}

interface ScriptModule {
  type: "script";
  path: string;
  input_transforms: Record<string, unknown>;
}

interface RawScriptModule {
  type: "rawscript";
  content: string;
  language: string;
  input_transforms?: Record<string, unknown>;
}

interface BranchOneModule {
  type: "branchone";
  branches: Array<{
    summary?: string;
    expr: string;
    modules: FlowModule[];
  }>;
  default: FlowModule[];
}

interface ForloopFlowModule {
  type: "forloopflow";
  iterator: { type: "javascript"; expr: string } | { type: "static"; value: unknown };
  modules: FlowModule[];
  skip_failures: boolean;
  parallel: boolean;
}

export interface OpenFlow {
  summary: string;
  description?: string;
  value: {
    modules: FlowModule[];
    same_worker: boolean;
    failure_module?: FlowModule;
  };
  schema?: Record<string, unknown>;
}

export function dagToOpenFlow(dag: DAG, name: string): OpenFlow {
  const orderedNodes = topologicalSort(dag.nodes, dag.edges);
  // Exclude the onError node from the main module list — it becomes the failure_module
  const mainNodes = dag.onError
    ? orderedNodes.filter((n) => n.id !== dag.onError)
    : orderedNodes;
  const modules = buildModules(mainNodes, dag);

  // Collect all flow_input fields referenced by any node so Windmill accepts them
  const schemaProperties: Record<string, { type: string; description?: string }> = {
    orgId: { type: "string", description: "Organization identifier" },
    userId: { type: "string", description: "User identifier" },
    runId: { type: "string", description: "Runs-service run ID for this execution" },
    serviceEnvs: { type: "object", description: "Service URLs and API keys injected by workflow-service" },
    campaignId: { type: "string", description: "Campaign identifier (auto-injected)" },
    brandId: { type: "string", description: "Brand identifier (auto-injected)" },
    workflowSlug: { type: "string", description: "Workflow slug (auto-injected)" },
    featureSlug: { type: "string", description: "Feature slug from features-service (auto-injected)" },
    attributionContext: { type: "object", description: "Optional campaign attribution context supplied at execution time" },
    goal: { type: "string", description: "Optional active goal from attribution context" },
    brandProfileId: { type: "string", description: "Optional brand profile identifier from attribution context" },
    profileId: { type: "string", description: "Optional profile identifier from attribution context" },
    personaId: { type: "string", description: "Optional persona identifier from attribution context" },
    goalId: { type: "string", description: "Optional goal identifier from attribution context" },
    goalSlug: { type: "string", description: "Optional goal slug from attribution context" },
    optimizationGoal: { type: "string", description: "Optional active optimization goal from attribution context" },
  };
  for (const node of dag.nodes) {
    if (!node.inputMapping) continue;
    for (const ref of Object.values(node.inputMapping)) {
      if (typeof ref !== "string" || !ref.startsWith("$ref:flow_input.")) continue;
      const field = ref.replace("$ref:flow_input.", "").split(".")[0];
      if (field && !schemaProperties[field]) {
        schemaProperties[field] = { type: "string" };
      }
    }
  }

  const flow: OpenFlow = {
    summary: name,
    value: {
      modules,
      same_worker: false,
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: schemaProperties,
      required: [],
    },
  };

  if (dag.onError) {
    const errorNode = dag.nodes.find((n) => n.id === dag.onError);
    if (errorNode) {
      const failureModule = buildFailureModule(errorNode);
      if (failureModule) {
        flow.value.failure_module = failureModule;
      }
    }
  }

  return flow;
}

function buildModules(orderedNodes: DAGNode[], dag: DAG): FlowModule[] {
  // Pre-compute: determine which nodes are consumed by condition/for-each containers
  const consumed = new Set<string>();
  const conditionInfo = new Map<
    string,
    { branchNodeSets: Map<string, Set<string>>; afterNodes: Set<string> }
  >();
  const loopBodyInfo = new Map<string, Set<string>>();

  // Build incoming-edges map once (shared by all helpers)
  const incomingEdges = new Map<string, DAGEdge[]>();
  for (const node of dag.nodes) {
    incomingEdges.set(node.id, []);
  }
  for (const edge of dag.edges) {
    incomingEdges.get(edge.to)?.push(edge);
  }

  for (const node of orderedNodes) {
    if (node.type === "condition") {
      const info = collectBranchNodes(node.id, dag, orderedNodes, incomingEdges);
      conditionInfo.set(node.id, info);
      for (const nodeSet of info.branchNodeSets.values()) {
        for (const id of nodeSet) consumed.add(id);
      }
    } else if (node.type === "for-each") {
      const bodyNodes = collectLoopBodyNodes(node.id, dag, orderedNodes, incomingEdges);
      loopBodyInfo.set(node.id, bodyNodes);
      for (const id of bodyNodes) consumed.add(id);
    }
  }

  // The JS expression a start-run DESCENDANT uses to read the per-run audienceId.
  // Inline contexts (top-level, branchone body) resolve `results.start_run`;
  // for-each bodies override this to the iter-threaded reference (see
  // buildForEachModule). Null when the DAG has no campaign /start-run node.
  const { startRunModuleId } = getAudiencePropagationScope(dag);
  const audienceRef = startRunModuleId
    ? `results.${startRunModuleId}?.audienceId`
    : null;

  // Build pass: iterate ordered nodes, skip consumed, build containers with nested modules
  const modules: FlowModule[] = [];

  for (const node of orderedNodes) {
    if (consumed.has(node.id)) continue;

    if (node.type === "condition") {
      const mod = buildConditionModule(node, dag, orderedNodes, conditionInfo.get(node.id)!, audienceRef);
      modules.push(mod);
    } else if (node.type === "for-each") {
      const mod = buildForEachModule(node, orderedNodes, loopBodyInfo.get(node.id)!, dag, audienceRef);
      modules.push(mod);
    } else {
      const mod = nodeToModule(node, dag, audienceRef);
      if (mod) modules.push(mod);
    }
  }

  return modules;
}

/**
 * For a condition node, determine which downstream nodes belong to each branch
 * and which nodes come after the branchone (unconditional edge targets).
 */
function collectBranchNodes(
  conditionNodeId: string,
  dag: DAG,
  orderedNodes: DAGNode[],
  incomingEdges: Map<string, DAGEdge[]>,
): { branchNodeSets: Map<string, Set<string>>; afterNodes: Set<string> } {
  const outEdges = dag.edges.filter((e) => e.from === conditionNodeId);
  const afterNodes = new Set(
    outEdges.filter((e) => !e.condition).map((e) => e.to),
  );

  // Group conditional edges by expression.
  // A conditional edge target that ALSO has incoming edges from other nodes
  // is a convergence point — it must run after the branchone, not inside a branch.
  const branchRoots = new Map<string, Set<string>>();
  for (const edge of outEdges) {
    if (!edge.condition) continue;
    const targetIncoming = incomingEdges.get(edge.to) ?? [];
    const hasOtherIncoming = targetIncoming.some((inc) => inc.from !== conditionNodeId);
    if (hasOtherIncoming) {
      afterNodes.add(edge.to);
    } else {
      if (!branchRoots.has(edge.condition)) {
        branchRoots.set(edge.condition, new Set());
      }
      branchRoots.get(edge.condition)!.add(edge.to);
    }
  }

  const branchNodeSets = new Map<string, Set<string>>();

  for (const [expr, roots] of branchRoots) {
    const branchSet = new Set<string>();

    // Walk orderedNodes (topological order guarantees predecessors come first)
    for (const node of orderedNodes) {
      if (afterNodes.has(node.id)) continue;
      if (node.id === conditionNodeId) continue;

      if (roots.has(node.id)) {
        branchSet.add(node.id);
        continue;
      }

      if (branchSet.has(node.id)) continue;

      // Check if ALL incoming edges come from within this branch
      const incoming = incomingEdges.get(node.id) ?? [];
      if (incoming.length === 0) continue;
      if (incoming.every((inc) => branchSet.has(inc.from))) {
        branchSet.add(node.id);
      }
    }

    branchNodeSets.set(expr, branchSet);
  }

  return { branchNodeSets, afterNodes };
}

/**
 * For a for-each node, determine which downstream nodes belong inside the loop body.
 */
function collectLoopBodyNodes(
  forEachNodeId: string,
  dag: DAG,
  orderedNodes: DAGNode[],
  incomingEdges: Map<string, DAGEdge[]>,
): Set<string> {
  const directTargets = new Set(
    dag.edges.filter((e) => e.from === forEachNodeId).map((e) => e.to),
  );

  const bodySet = new Set<string>();

  for (const node of orderedNodes) {
    if (node.id === forEachNodeId) continue;

    if (directTargets.has(node.id)) {
      bodySet.add(node.id);
      continue;
    }

    if (bodySet.has(node.id)) continue;

    const incoming = incomingEdges.get(node.id) ?? [];
    if (incoming.length === 0) continue;
    if (incoming.every((inc) => inc.from === forEachNodeId || bodySet.has(inc.from))) {
      bodySet.add(node.id);
    }
  }

  return bodySet;
}

function buildConditionModule(
  node: DAGNode,
  dag: DAG,
  orderedNodes: DAGNode[],
  info: { branchNodeSets: Map<string, Set<string>>; afterNodes: Set<string> },
  audienceRef: string | null,
): FlowModule {
  const moduleId = node.id.replace(/-/g, "_");
  const outEdges = dag.edges.filter((e) => e.from === node.id && e.condition);

  // Deduplicate by expression (multiple edges can share the same condition)
  const seenExprs = new Set<string>();
  const branches: Array<{ summary?: string; expr: string; modules: FlowModule[] }> = [];

  // Collect all DAG node IDs that contain hyphens so we can replace them in expressions
  const hyphenatedIds = dag.nodes
    .map((n) => n.id)
    .filter((id) => id.includes("-"))
    .sort((a, b) => b.length - a.length); // longest first to avoid partial replacements

  for (const edge of outEdges) {
    const rawExpr = edge.condition!;
    if (seenExprs.has(rawExpr)) continue;
    seenExprs.add(rawExpr);

    // Transform condition expression: replace hyphenated node IDs with underscored
    // versions so they match Windmill's module IDs.
    // Handles both bracket notation (results['fetch-lead']) and dot notation.
    let expr = rawExpr;
    for (const id of hyphenatedIds) {
      const underscored = id.replace(/-/g, "_");
      // Replace bracket-notation references: results['node-id'] or results["node-id"]
      expr = expr.replaceAll(`['${id}']`, `.${underscored}`);
      expr = expr.replaceAll(`["${id}"]`, `.${underscored}`);
      // Replace dot-notation references: results.node-id (invalid JS but could appear)
      // Only replace when preceded by 'results.' to avoid false positives
      expr = expr.replaceAll(`results.${id}`, `results.${underscored}`);
    }

    const branchNodeIds = info.branchNodeSets.get(rawExpr) ?? new Set();
    const branchNodes = orderedNodes.filter((n) => branchNodeIds.has(n.id));
    const branchModules: FlowModule[] = [];
    for (const bn of branchNodes) {
      // branchone runs inline in the parent flow scope, so `results.start_run`
      // still resolves inside a branch body — forward the inline audienceRef.
      const mod = nodeToModule(bn, dag, audienceRef);
      if (mod) branchModules.push(mod);
    }

    branches.push({ summary: rawExpr, expr, modules: branchModules });
  }

  return {
    id: moduleId,
    summary: "Branch",
    value: { type: "branchone", branches, default: [] },
  };
}

function buildForEachModule(
  node: DAGNode,
  orderedNodes: DAGNode[],
  bodyNodeIds: Set<string>,
  dag: DAG,
  audienceRef: string | null,
): FlowModule {
  const moduleId = node.id.replace(/-/g, "_");
  let iteratorExpr = (node.config?.iterator as string) ?? "flow_input.items";

  // A for-each body is an isolated subflow — `results.start_run` (the inline
  // audienceRef) does NOT resolve inside it. When this loop runs downstream of
  // start-run, fold the per-run audienceId onto every iterated element via the
  // iterator expression (evaluated in the PARENT scope, where the inbound
  // audienceRef resolves), then have body nodes read it from the iteration
  // context. This is what carries per-(audience × workflow) attribution to the
  // per-lead send/generation calls nested in the loop.
  const carriesAudience =
    audienceRef !== null && isStartRunDescendant(dag, moduleId);

  if (carriesAudience) {
    // (origIter ?? []).map(el => el && typeof el === "object"
    //   ? { ...el, __wf_audience_id: <audienceRef> } : el)
    iteratorExpr =
      `(${iteratorExpr} ?? []).map((__wf_el) => ` +
      `(__wf_el && typeof __wf_el === "object") ? ` +
      `{ ...__wf_el, ${AUDIENCE_ITER_KEY}: ${audienceRef} } : __wf_el)`;
  }

  // Inside the loop body, audienceId is read from the (possibly wrapped)
  // iteration element, not from the out-of-scope start-run result.
  const bodyAudienceRef = carriesAudience ? LOOP_BODY_AUDIENCE_REF : null;

  const bodyNodes = orderedNodes.filter((n) => bodyNodeIds.has(n.id));
  const bodyModules: FlowModule[] = [];
  for (const bn of bodyNodes) {
    const mod = nodeToModule(bn, dag, bodyAudienceRef);
    if (mod) bodyModules.push(mod);
  }

  return {
    id: moduleId,
    summary: "For each",
    value: {
      type: "forloopflow",
      iterator: { type: "javascript", expr: iteratorExpr },
      modules: bodyModules,
      skip_failures: (node.config?.skipFailures as boolean) ?? false,
      parallel: (node.config?.parallel as boolean) ?? false,
    },
  };
}

/**
 * Whether `moduleId` is reachable forward from the campaign /start-run node —
 * i.e. it runs strictly after start-run, so the run's audienceId is available
 * to thread into it. False for non-campaign DAGs (no start-run node).
 */
function isStartRunDescendant(dag: DAG, moduleId: string): boolean {
  const { startRunModuleId, descendants } = getAudiencePropagationScope(dag);
  return startRunModuleId !== null && descendants.has(moduleId);
}

/**
 * Find the campaign-service `/start-run` node.
 *
 * campaign-service re-selects the priority audience for each run inside
 * `/start-run` and returns it as `audienceId`. That value is only known AFTER
 * start-run executes (the root execute-workflow run is already created), so it
 * cannot be a dispatch-time flow_input — it is threaded forward from this
 * node's result into every DOWNSTREAM node as the x-audience-id header.
 *
 * Returns null for non-campaign flows (no start-run node → no audience to
 * propagate).
 */
function findCampaignStartRunNode(dag: DAG): DAGNode | null {
  for (const node of dag.nodes) {
    if (node.type !== "http.call") continue;
    const service = node.config?.service;
    const path = node.config?.path;
    if (
      (service === "campaign" || service === "campaign-service") &&
      typeof path === "string" &&
      /start[-_]?run/i.test(path)
    ) {
      return node;
    }
  }
  return null;
}

/**
 * Module ids (hyphens→underscores) of every node reachable FORWARD from
 * `startNodeId` via edges — the nodes that execute strictly AFTER it.
 *
 * Only these may reference `results.<start_run>`: Windmill resolves a
 * `results.X` reference by fetching the flow result by id BEFORE the JS `?.`
 * guard runs, so a node that runs at-or-before start-run (e.g. the gate-check
 * that precedes it in the chassis) would 404 the result lookup at dispatch
 * ("Flow result by id not found ... id: start_run"). Scoping the audienceId
 * injection to descendants removes that spurious 404 warning on every run.
 *
 * The start node itself is excluded (BFS starts from its successors), so no
 * self-reference is emitted.
 */
function descendantModuleIds(dag: DAG, startNodeId: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const edge of dag.edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const seen = new Set<string>();
  const queue = [...(adj.get(startNodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adj.get(current) ?? []) queue.push(next);
  }

  return new Set([...seen].map((id) => id.replace(/-/g, "_")));
}

interface AudiencePropagationScope {
  startRunModuleId: string | null;
  descendants: Set<string>;
}

const audienceScopeCache = new WeakMap<DAG, AudiencePropagationScope>();

/**
 * Resolve (and memoize per DAG) the start-run module id + the set of module ids
 * downstream of it that should receive the threaded `audienceId` transform.
 */
function getAudiencePropagationScope(dag: DAG): AudiencePropagationScope {
  const cached = audienceScopeCache.get(dag);
  if (cached) return cached;

  const startNode = findCampaignStartRunNode(dag);
  const scope: AudiencePropagationScope = startNode
    ? {
        startRunModuleId: startNode.id.replace(/-/g, "_"),
        descendants: descendantModuleIds(dag, startNode.id),
      }
    : { startRunModuleId: null, descendants: new Set<string>() };

  audienceScopeCache.set(dag, scope);
  return scope;
}

function nodeToModule(
  node: DAGNode,
  dag: DAG,
  audienceRef: string | null,
): FlowModule | null {
  const moduleId = node.id.replace(/-/g, "_");

  if (node.type === "wait") {
    const seconds = (node.config?.seconds as number) ?? 0;
    return {
      id: moduleId,
      summary: `Wait ${seconds}s`,
      value: {
        type: "rawscript",
        content: "",
        language: "bun",
      },
      sleep: { type: "static", value: seconds },
    };
  }

  if (node.type === "script") {
    const code = node.config?.code as string;
    const language = (node.config?.language as string) ?? "bun";
    const retries = node.retries
      ?? (typeof node.config?.retries === "number" ? node.config.retries : 3);
    const stopAfterIf = typeof node.config?.stopAfterIf === "string"
      ? node.config.stopAfterIf : undefined;
    const skipIf = typeof node.config?.skipIf === "string"
      ? node.config.skipIf : undefined;
    const inputTransforms = buildInputTransforms(undefined, node.inputMapping);

    const mod: FlowModule = {
      id: moduleId,
      summary: `script: ${node.id}`,
      value: {
        type: "rawscript",
        content: code,
        language,
        input_transforms: inputTransforms,
      },
      timeout: { type: "static", value: NODE_TIMEOUT_SECONDS },
      retry: retries > 0
        ? { constant: { attempts: retries, seconds: 5 } }
        : { constant: { attempts: 0, seconds: 0 } },
    };
    if (stopAfterIf) {
      mod.stop_after_if = { expr: stopAfterIf, skip_if_stopped: true };
    }
    if (skipIf) {
      mod.skip_if = { expr: skipIf };
    }
    return mod;
  }

  // Normal node: script reference
  const scriptPath = getScriptPath(node.type);
  if (scriptPath === undefined || scriptPath === null) {
    if (isNativeNode(node.type)) return null;
    throw new Error(`No script path for node type: ${node.type}`);
  }

  // Extract retries and stopAfterIf from top-level or config, strip non-script fields
  const retries = node.retries
    ?? (typeof node.config?.retries === "number" ? node.config.retries : 3);
  const stopAfterIf = typeof node.config?.stopAfterIf === "string"
    ? node.config.stopAfterIf : undefined;
  const skipIf = typeof node.config?.skipIf === "string"
    ? node.config.skipIf : undefined;
  const { retries: _r, stopAfterIf: _s, skipIf: _sk, ...scriptConfig } = node.config ?? {};

  // For http.call nodes, rewrite "path.*" inputMapping keys to "params.*"
  // so collapseDotNotation doesn't replace the scalar path string with an object.
  let resolvedInputMapping = node.inputMapping;
  if (node.type === "http.call" && resolvedInputMapping) {
    const rewritten: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolvedInputMapping)) {
      if (key.startsWith("path.")) {
        rewritten[`params.${key.slice(5)}`] = value;
      } else {
        rewritten[key] = value;
      }
    }
    resolvedInputMapping = rewritten;
  }

  const inputTransforms = buildInputTransforms(
    Object.keys(scriptConfig).length > 0 ? scriptConfig : undefined,
    resolvedInputMapping,
  );

  // Auto-inject identity + tracking context from flow_input unless explicitly mapped
  const autoInjects: Record<string, string> = {
    orgId: "flow_input.orgId",
    userId: "flow_input.userId",
    runId: "flow_input.runId",
    serviceEnvs: "flow_input.serviceEnvs",
    campaignId: "flow_input.campaignId",
    brandId: "flow_input.brandId",
    workflowSlug: "flow_input.workflowSlug",
    featureSlug: "flow_input.featureSlug",
    attributionContext: "flow_input.attributionContext",
    goal: "flow_input.goal",
    brandProfileId: "flow_input.brandProfileId",
    profileId: "flow_input.profileId",
    personaId: "flow_input.personaId",
    goalId: "flow_input.goalId",
    goalSlug: "flow_input.goalSlug",
    optimizationGoal: "flow_input.optimizationGoal",
  };
  for (const [key, expr] of Object.entries(autoInjects)) {
    if (!inputTransforms[key]) {
      inputTransforms[key] = { type: "javascript", expr };
    }
  }

  // Propagate the per-run audience chosen by campaign-service inside /start-run.
  // Unlike the identity fields above, audienceId is not a flow_input — it is
  // only known once start-run has executed, so it is threaded downstream as the
  // x-audience-id header. `audienceRef` is the caller-scoped expression that
  // resolves to it: `results.start_run?.audienceId` for inline (top-level /
  // branchone) nodes, or the iter-threaded `flow_input.iter.value?...` for
  // nodes inside a for-each body (where the start-run result is out of scope).
  // Scope to start-run descendants only: Windmill resolves `results.<start_run>`
  // via a result-by-id fetch BEFORE the JS `?.` runs, so injecting the inline
  // ref into a node that runs at-or-before start-run (e.g. gate-check) 404s the
  // lookup at dispatch.
  const { startRunModuleId, descendants } = getAudiencePropagationScope(dag);
  if (
    audienceRef &&
    startRunModuleId &&
    descendants.has(moduleId) &&
    !inputTransforms.audienceId
  ) {
    inputTransforms.audienceId = {
      type: "javascript",
      expr: audienceRef,
    };
  }

  const mod: FlowModule = {
    id: moduleId,
    summary: `${node.type}: ${node.id}`,
    value: {
      type: "script",
      path: scriptPath,
      input_transforms: inputTransforms,
    },
    timeout: { type: "static", value: NODE_TIMEOUT_SECONDS },
    retry: retries > 0
      ? { constant: { attempts: retries, seconds: 5 } }
      : { constant: { attempts: 0, seconds: 0 } },
  };

  if (stopAfterIf) {
    mod.stop_after_if = { expr: stopAfterIf, skip_if_stopped: true };
  }
  if (skipIf) {
    mod.skip_if = { expr: skipIf };
  }

  return mod;
}

function buildFailureModule(node: DAGNode): FlowModule | null {
  const scriptPath = getScriptPath(node.type);
  if (scriptPath === undefined || scriptPath === null) {
    return null;
  }

  const inputTransforms = buildInputTransforms(node.config, node.inputMapping);

  // Auto-inject identity + tracking context from flow_input unless explicitly mapped
  const failureAutoInjects: Record<string, string> = {
    orgId: "flow_input.orgId",
    userId: "flow_input.userId",
    runId: "flow_input.runId",
    serviceEnvs: "flow_input.serviceEnvs",
    campaignId: "flow_input.campaignId",
    brandId: "flow_input.brandId",
    workflowSlug: "flow_input.workflowSlug",
    featureSlug: "flow_input.featureSlug",
    attributionContext: "flow_input.attributionContext",
    goal: "flow_input.goal",
    brandProfileId: "flow_input.brandProfileId",
    profileId: "flow_input.profileId",
    personaId: "flow_input.personaId",
    goalId: "flow_input.goalId",
    goalSlug: "flow_input.goalSlug",
    optimizationGoal: "flow_input.optimizationGoal",
  };
  for (const [key, expr] of Object.entries(failureAutoInjects)) {
    if (!inputTransforms[key]) {
      inputTransforms[key] = { type: "javascript", expr };
    }
  }

  // Inject error context — available to the onError node
  if (!inputTransforms.failedNodeId) {
    inputTransforms.failedNodeId = {
      type: "javascript",
      expr: "error.failed_step",
    };
  }
  if (!inputTransforms.errorMessage) {
    inputTransforms.errorMessage = {
      type: "javascript",
      expr: "error.message",
    };
  }

  const moduleId = node.id.replace(/-/g, "_");
  return {
    id: moduleId,
    summary: `onError: ${node.id}`,
    value: {
      type: "script",
      path: scriptPath,
      input_transforms: inputTransforms,
    },
  };
}

function topologicalSort(nodes: DAGNode[], edges: DAGEdge[]): DAGNode[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adj.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of nodes) {
    if (inDegree.get(node.id) === 0) {
      queue.push(node.id);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adj.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) {
        queue.push(neighbor);
      }
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return sorted.map((id) => nodeMap.get(id)!).filter(Boolean);
}
