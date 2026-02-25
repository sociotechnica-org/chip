import type {
  ArtifactDetailResponse,
  PrMode,
  RunDetailResponse,
  RunListResponse,
  RunSummary
} from "./types";

export interface ApiConfig {
  baseUrl: string;
  password: string;
}

interface CreateRunInput {
  issueNumber: number;
  requestor: string;
  goal: string;
  prMode: PrMode;
  idempotencyKey: string;
}

interface RetryRunResponse {
  run: RunSummary;
  retriedFromRunId: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "/api";
  }

  return trimmed.replace(/\/+$/u, "");
}

function buildHeaders(config: ApiConfig, extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${config.password}`);
  return headers;
}

async function requestJson<T>(
  config: ApiConfig,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}${path}`, init);
  const text = await response.text();
  const parsedBody = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const message = extractErrorMessage(parsedBody) ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return parsedBody as T;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const errorValue = (value as { error?: unknown }).error;
  return typeof errorValue === "string" && errorValue.length > 0 ? errorValue : null;
}

export async function ensureDefaultRepo(config: ApiConfig): Promise<void> {
  await requestJson<{ repo: unknown }>(config, "/v1/repos", {
    method: "POST",
    headers: buildHeaders(config, {
      "content-type": "application/json"
    }),
    body: JSON.stringify({
      owner: "sociotechnica-org",
      name: "lifebuild"
    })
  });
}

export async function listRuns(config: ApiConfig): Promise<RunListResponse> {
  return requestJson<RunListResponse>(config, "/v1/runs?limit=100", {
    headers: buildHeaders(config)
  });
}

export async function getRunDetail(config: ApiConfig, runId: string): Promise<RunDetailResponse> {
  return requestJson<RunDetailResponse>(config, `/v1/runs/${encodeURIComponent(runId)}`, {
    headers: buildHeaders(config)
  });
}

export async function getRunArtifact(
  config: ApiConfig,
  runId: string,
  artifactId: string
): Promise<ArtifactDetailResponse> {
  return requestJson<ArtifactDetailResponse>(
    config,
    `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    {
      headers: buildHeaders(config)
    }
  );
}

export async function createRun(config: ApiConfig, input: CreateRunInput): Promise<RunSummary> {
  const response = await requestJson<{ run: RunSummary }>(config, "/v1/runs", {
    method: "POST",
    headers: buildHeaders(config, {
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey
    }),
    body: JSON.stringify({
      repo: {
        owner: "sociotechnica-org",
        name: "lifebuild"
      },
      issue: {
        number: input.issueNumber
      },
      requestor: input.requestor,
      goal: input.goal.length > 0 ? input.goal : undefined,
      prMode: input.prMode
    })
  });

  return response.run;
}

export async function cancelRun(config: ApiConfig, runId: string): Promise<RunSummary> {
  const response = await requestJson<{ run: RunSummary }>(
    config,
    `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: buildHeaders(config)
    }
  );
  return response.run;
}

export async function retryRun(config: ApiConfig, runId: string): Promise<RetryRunResponse> {
  return requestJson<RetryRunResponse>(config, `/v1/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    headers: buildHeaders(config)
  });
}

export function createIdempotencyKey(prefix = "web"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
