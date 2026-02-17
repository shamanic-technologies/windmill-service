import { isKnownNodeType } from "./node-type-registry.js";

export interface DAGNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputMapping?: Record<string, string>;
  retries?: number;
}

export interface DAGEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface DAG {
  nodes: DAGNode[];
  edges: DAGEdge[];
  onError?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateDAG(dag: DAG): ValidationResult {
  const errors: ValidationError[] = [];
  const nodeIds = dag.nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);

  // 1. Duplicate node IDs
  if (nodeIdSet.size !== nodeIds.length) {
    const seen = new Set<string>();
    for (const id of nodeIds) {
      if (seen.has(id)) {
        errors.push({ field: "nodes", message: `Duplicate node ID: "${id}"` });
      }
      seen.add(id);
    }
  }

  // 2. Unknown node types
  for (const node of dag.nodes) {
    if (!isKnownNodeType(node.type)) {
      errors.push({
        field: `nodes[${node.id}].type`,
        message: `Unknown node type: "${node.type}"`,
      });
    }
  }

  // 3. Edge references valid nodes
  for (const edge of dag.edges) {
    if (!nodeIdSet.has(edge.from)) {
      errors.push({
        field: "edges",
        message: `Edge references unknown source node: "${edge.from}"`,
      });
    }
    if (!nodeIdSet.has(edge.to)) {
      errors.push({
        field: "edges",
        message: `Edge references unknown target node: "${edge.to}"`,
      });
    }
  }

  // 4. Cycle detection (DFS)
  if (hasCycle(dag.nodes, dag.edges)) {
    errors.push({ field: "edges", message: "Workflow contains a cycle" });
  }

  // 5. Validate $ref in inputMapping
  for (const node of dag.nodes) {
    if (!node.inputMapping) continue;
    for (const [key, ref] of Object.entries(node.inputMapping)) {
      if (typeof ref !== "string") continue;
      if (!ref.startsWith("$ref:")) continue;
      if (ref.startsWith("$ref:flow_input")) continue;

      const refNodeId = ref.replace("$ref:", "").split(".")[0];
      if (!nodeIdSet.has(refNodeId)) {
        errors.push({
          field: `nodes[${node.id}].inputMapping.${key}`,
          message: `References unknown node: "${refNodeId}"`,
        });
      }
    }
  }

  // 6. At least one entry node (no incoming edges)
  const targets = new Set(dag.edges.map((e) => e.to));
  const entryNodes = dag.nodes.filter((n) => !targets.has(n.id));
  if (entryNodes.length === 0 && dag.nodes.length > 0) {
    errors.push({
      field: "nodes",
      message: "No entry node found (all nodes have incoming edges)",
    });
  }

  // 7. onError references an existing node
  if (dag.onError && !nodeIdSet.has(dag.onError)) {
    errors.push({
      field: "onError",
      message: `onError references unknown node: "${dag.onError}"`,
    });
  }

  return { valid: errors.length === 0, errors };
}

function hasCycle(nodes: DAGNode[], edges: DAGEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    adj.get(edge.from)?.push(edge.to);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    inStack.add(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (inStack.has(neighbor)) return true;
      if (!visited.has(neighbor) && dfs(neighbor)) return true;
    }

    inStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id) && dfs(node.id)) return true;
  }

  return false;
}
