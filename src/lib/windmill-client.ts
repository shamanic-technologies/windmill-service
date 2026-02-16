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
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
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

  // === HEALTH ===

  async healthCheck(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/version`, {
      headers: { Authorization: `Bearer ${this.token}` },
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
