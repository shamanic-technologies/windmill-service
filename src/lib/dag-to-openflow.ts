import type { DAG, DAGNode, DAGEdge } from "./dag-validator.js";
import { getScriptPath, isNativeNode } from "./node-type-registry.js";
import { buildInputTransforms } from "./input-mapping.js";

export interface FlowModule {
  id: string;
  summary?: string;
  value:
    | ScriptModule
    | RawScriptModule
    | BranchOneModule
    | ForloopFlowModule;
  sleep?: { type: "javascript"; expr: string } | { type: "static"; value: number };
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
    appId: { type: "string", description: "Application identifier" },
    serviceEnvs: { type: "object", description: "Service URLs and API keys injected by windmill-service" },
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
  const modules: FlowModule[] = [];

  for (const node of orderedNodes) {
    const mod = nodeToModule(node, dag);
    if (mod) modules.push(mod);
  }

  return modules;
}

function nodeToModule(node: DAGNode, dag: DAG): FlowModule | null {
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

  if (node.type === "condition") {
    const outEdges = dag.edges.filter((e) => e.from === node.id);
    const branches = outEdges
      .filter((e) => e.condition)
      .map((e) => ({
        summary: e.condition,
        expr: e.condition!,
        modules: [] as FlowModule[],
      }));

    return {
      id: moduleId,
      summary: "Branch",
      value: {
        type: "branchone",
        branches,
        default: [],
      },
    };
  }

  if (node.type === "for-each") {
    const iteratorExpr =
      (node.config?.iterator as string) ?? "flow_input.items";
    return {
      id: moduleId,
      summary: "For each",
      value: {
        type: "forloopflow",
        iterator: { type: "javascript", expr: iteratorExpr },
        modules: [],
        skip_failures: (node.config?.skipFailures as boolean) ?? false,
        parallel: (node.config?.parallel as boolean) ?? false,
      },
    };
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

  const inputTransforms = buildInputTransforms(
    Object.keys(scriptConfig).length > 0 ? scriptConfig : undefined,
    node.inputMapping,
  );

  // Auto-inject appId and serviceEnvs from flow_input unless explicitly mapped
  if (!inputTransforms.appId) {
    inputTransforms.appId = { type: "javascript", expr: "flow_input.appId" };
  }
  if (!inputTransforms.serviceEnvs) {
    inputTransforms.serviceEnvs = { type: "javascript", expr: "flow_input.serviceEnvs" };
  }
  const mod: FlowModule = {
    id: moduleId,
    summary: `${node.type}: ${node.id}`,
    value: {
      type: "script",
      path: scriptPath,
      input_transforms: inputTransforms,
    },
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

  // Auto-inject appId and serviceEnvs from flow_input unless explicitly mapped
  if (!inputTransforms.appId) {
    inputTransforms.appId = { type: "javascript", expr: "flow_input.appId" };
  }
  if (!inputTransforms.serviceEnvs) {
    inputTransforms.serviceEnvs = { type: "javascript", expr: "flow_input.serviceEnvs" };
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
