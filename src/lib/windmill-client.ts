export interface WindmillJob {
  id: string;
  workspace_id?: string;
  running: boolean;
  success?: boolean;
  result?: unknown;
  flow_status?: unknown;
  canceled?: boolean;
  canceled_reason?: string;
  started_at?: string;
  type?: string;
}

export interface WindmillClientConfig {
  baseUrl: string;
  token: string;
  workspace?: string;
}

export type WindmillTransportKind = "connect_timeout" | "socket_closed" | "network";

export class WindmillTransportError extends Error {
  constructor(
    message: string,
    public readonly kind: WindmillTransportKind,
    public readonly dispatchAmbiguous: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "WindmillTransportError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

function classifyTransportError(
  err: unknown,
  method: string,
): WindmillTransportError {
  const code = getErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);

  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return new WindmillTransportError(
      `Windmill transport connect_timeout: ${message}`,
      "connect_timeout",
      false,
      { cause: err },
    );
  }

  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") {
    return new WindmillTransportError(
      `Windmill transport socket_closed: ${message}`,
      "socket_closed",
      method !== "GET",
      { cause: err },
    );
  }

  return new WindmillTransportError(
    `Windmill transport network: ${message}`,
    "network",
    method !== "GET",
    { cause: err },
  );
}

export function isAmbiguousWindmillDispatchError(err: unknown): boolean {
  return err instanceof WindmillTransportError && err.dispatchAmbiguous;
}

/**
 * A non-2xx answer from the Windmill REST API. Subclasses `Error` and keeps the
 * exact same `message` shape the plain `Error` used to carry, so existing
 * `message.includes("404")` callers keep working — the added fields exist so a
 * caller can classify without parsing prose.
 */
export class WindmillApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "WindmillApiError";
  }
}

/**
 * True when Windmill can never resolve this job, no matter how long we wait.
 *
 * Two shapes, both permanent:
 *  - 404: the job id is unknown to Windmill (retention purge, wrong workspace).
 *  - 5xx whose body says something was "not found": a job whose flow definition
 *    was mutated underneath it. A workflow VERSION UPGRADE deletes the flow
 *    nodes an in-flight job still references, and Windmill then answers
 *    `500 Internal: windmill-common/src/cache.rs: Flow node not found` for that
 *    job forever. Retrying it is retrying a corpse.
 *
 * Everything else (connect timeouts, socket resets, a plain 502/503 while
 * Windmill restarts, a 5xx with no "not found" in it) is transient and must
 * keep being retried.
 */
export function isUnresolvableWindmillJobError(err: unknown): boolean {
  if (!(err instanceof WindmillApiError)) return false;
  if (err.status === 404) return true;
  if (err.status >= 500 && /not found/i.test(err.body)) return true;
  return false;
}

export class WindmillClient {
  private baseUrl: string;
  private token: string;
  private workspace: string;

  constructor(config: WindmillClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.workspace = config.workspace ?? "prod";
  }

  private get apiBase(): string {
    return `${this.baseUrl}/api/w/${this.workspace}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    const maxAttempts = method === "GET" ? 2 : 1;
    let lastTransportError: WindmillTransportError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err) {
        lastTransportError = classifyTransportError(err, method);
        if (attempt < maxAttempts) continue;
        throw lastTransportError;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new WindmillApiError(
          res.status,
          method,
          path,
          text,
          `Windmill API error: ${method} ${path} → ${res.status} ${res.statusText}: ${text}`
        );
      }

      const contentType = res.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return res.json() as Promise<T>;
      }

      const text = await res.text();
      return text as unknown as T;
    }

    throw lastTransportError ?? new Error(`Windmill request failed: ${method} ${path}`);
  }

  // === FLOWS ===

  async createFlow(flow: {
    path: string;
    summary: string;
    description?: string;
    value: unknown;
    schema?: unknown;
  }): Promise<string> {
    await this.request("POST", "/flows/create", flow);
    return flow.path;
  }

  async updateFlow(
    path: string,
    flow: {
      summary?: string;
      description?: string;
      value: unknown;
      schema?: unknown;
    }
  ): Promise<void> {
    await this.request("POST", `/flows/update/${path}`, { path, ...flow });
  }

  async getFlow(path: string): Promise<unknown> {
    return this.request("GET", `/flows/get/${path}`);
  }

  async deleteFlow(path: string): Promise<void> {
    await this.request("DELETE", `/flows/delete/${path}`);
  }

  // === SCRIPTS ===

  async getScript(path: string): Promise<{ hash: string; content: string; path: string; language: string; summary: string } | null> {
    try {
      return await this.request("GET", `/scripts/get/p/${path}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  async createScript(script: {
    path: string;
    summary: string;
    description?: string;
    content: string;
    language: string;
    parent_hash?: string;
  }): Promise<void> {
    await this.request("POST", "/scripts/create", script);
  }

  // === JOBS ===

  async runFlow(
    path: string,
    args: Record<string, unknown>
  ): Promise<string> {
    return this.request<string>("POST", `/jobs/run/f/${path}`, args);
  }

  async getJob(jobId: string): Promise<WindmillJob> {
    return this.request<WindmillJob>("GET", `/jobs_u/get/${jobId}`);
  }

  async cancelJob(jobId: string, reason?: string): Promise<void> {
    await this.request("POST", `/jobs/queue/cancel/${jobId}`, { reason });
  }

  // === GLOBAL INSTANCE SETTINGS ===

  /**
   * Set an instance-wide global setting (not workspace-scoped).
   * Requires the API token to belong to a superadmin user.
   * See Windmill `POST /api/settings/global/{key}` (operationId `setGlobal`).
   */
  async setGlobalSetting(key: string, value: unknown): Promise<void> {
    const url = `${this.baseUrl}/api/settings/global/${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(600_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Windmill setGlobalSetting "${key}" failed: ${res.status} ${res.statusText}: ${text}`,
      );
    }
  }

  // === HEALTH ===

  async healthCheck(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/version`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(600_000),
    });
    return res.ok;
  }
}

let _client: WindmillClient | null = null;

export function getWindmillClient(): WindmillClient | null {
  if (!_client) {
    const baseUrl = process.env.WINDMILL_SERVER_URL;
    const token = process.env.WINDMILL_SERVER_API_KEY;
    const workspace = process.env.WINDMILL_SERVER_WORKSPACE;

    if (!baseUrl || !token) {
      return null;
    }

    _client = new WindmillClient({ baseUrl, token, workspace });
  }
  return _client;
}

/** Reset singleton (for testing) */
export function resetWindmillClient(): void {
  _client = null;
}
