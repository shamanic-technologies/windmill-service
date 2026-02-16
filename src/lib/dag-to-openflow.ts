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
  };
  schema?: Record<string, unknown>;
}

export function dagToOpenFlow(dag: DAG, name: string): OpenFlow {
  const orderedNodes = topologicalSort(dag.nodes, dag.edges);
  const modules = buildModules(orderedNodes, dag);

  return {
    summary: name,
    value: {
      modules,
      same_worker: false,
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        appId: { type: "string", description: "Application identifier" },
      },
      required: [],
    },
  };
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
  if (node.type === "wait") {
    const seconds = (node.config?.seconds as number) ?? 0;
    return {
      id: node.id,
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
      id: node.id,
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
      id: node.id,
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

  const inputTransforms = buildInputTransforms(node.config, node.inputMapping);

  // Auto-inject appId from flow_input unless the node already maps it explicitly
  if (!inputTransforms.appId) {
    inputTransforms.appId = { type: "javascript", expr: "flow_input.appId" };
  }

  return {
    id: node.id,
    summary: `${node.type}: ${node.id}`,
    value: {
      type: "script",
      path: scriptPath,
      input_transforms: inputTransforms,
    },
    retry: {
      constant: { attempts: 3, seconds: 5 },
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
