# Workflow Service

Workflow orchestration service powered by Windmill. Translates internal DAG format to Windmill OpenFlow, manages workflow lifecycle, and tracks executions.

## Commands
- `npm test` — run all tests (Vitest)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server (tsx watch)
- `npm start` — start production server
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas

## Architecture
- `src/routes/workflows.ts` — CRUD workflow endpoints
- `src/routes/workflow-runs.ts` — Execution + status endpoints
- `src/lib/windmill-client.ts` — HTTP client for Windmill REST API
- `src/lib/dag-to-openflow.ts` — Core: translates our DAG → Windmill OpenFlow
- `src/lib/dag-validator.ts` — Validates DAG structure before translation
- `src/lib/node-type-registry.ts` — Maps node types to Windmill script paths
- `src/lib/input-mapping.ts` — Translates $ref syntax to Windmill input transforms
- `src/lib/job-poller.ts` — Background polling of running Windmill jobs
- `scripts/nodes/` — TypeScript scripts deployed to Windmill (one per node type)

## Key concepts
- Our DAG format: `{ nodes: [{id, type, config, inputMapping}], edges: [{from, to, condition?}] }`
- Windmill OpenFlow: `{ value: { modules: [...] }, schema: {...} }`
- Input mapping: `$ref:node-id.output.field` → `results.node_id.field` in Windmill
- Node scripts in Windmill call our existing services via HTTP
- Stubs throw errors with clear messages until the real service is built

## Rules
- Never edit `openapi.json` manually — regenerate with `npm run generate:openapi`
- Commit `openapi.json` alongside schema changes in `src/schemas.ts`
- When adding a node type: update `node-type-registry.ts` + create script in `scripts/nodes/`
- Every bug fix must include a regression test
