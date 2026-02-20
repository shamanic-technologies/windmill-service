# workflow-service

Workflow orchestration service wrapping Windmill. Translates internal DAG format to Windmill OpenFlow, manages workflow lifecycle, and tracks executions.

## Setup

```bash
npm install
cp .env.example .env  # fill in values
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WINDMILL_SERVER_URL` | Windmill instance URL |
| `WINDMILL_SERVER_API_KEY` | Windmill Bearer token |
| `WINDMILL_SERVER_WORKSPACE` | Windmill workspace (default: `prod`) |
| `WORKFLOW_SERVICE_DATABASE_URL` | Neon Postgres connection string |
| `WORKFLOW_SERVICE_API_KEY` | API key for incoming service-to-service auth |
| `WORKFLOW_SERVICE_URL` | Public URL of this service |
| `PORT` | HTTP port (default: `3000`) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB + Windmill) |
| POST | `/workflows` | Create a workflow |
| GET | `/workflows?orgId=X` | List workflows |
| GET | `/workflows/:id` | Get a workflow |
| PUT | `/workflows/:id` | Update a workflow |
| DELETE | `/workflows/:id` | Soft delete a workflow |
| POST | `/workflows/:id/validate` | Validate DAG |
| POST | `/workflows/:id/execute` | Execute a workflow |
| GET | `/workflow-runs/:id` | Get run status |
| GET | `/workflow-runs` | List runs |
| POST | `/workflow-runs/:id/cancel` | Cancel a run |
| GET | `/openapi.json` | OpenAPI spec |
