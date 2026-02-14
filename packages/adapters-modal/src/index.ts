import {
  isModalJobStatus,
  type ModalExecutionHandle,
  type ModalExecutionTransport,
  type ModalJobResult,
  type ModalJobStatus,
  type ModalJobStatusResult,
  type ModalSubmitJobInput
} from "@bob/core";

const DEFAULT_MODAL_API_BASE_URL = "https://api.modal.com/v1";
const DEFAULT_TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

export interface ModalAuthConfig {
  tokenId: string;
  tokenSecret: string;
  apiBaseUrl: string;
  timeoutMs: number;
}

export interface CreateModalExecutionTransportInput {
  auth: ModalAuthConfig;
  fetchFn?: FetchLike;
}

export class ModalClientError extends Error {
  public readonly retryable: boolean;
  public readonly statusCode: number | null;
  public readonly code: "config" | "auth" | "transport_retryable" | "provider";

  public constructor(input: {
    message: string;
    retryable: boolean;
    statusCode?: number | null;
    code: ModalClientError["code"];
  }) {
    super(input.message);
    this.name = "ModalClientError";
    this.retryable = input.retryable;
    this.statusCode = input.statusCode ?? null;
    this.code = input.code;
  }
}

export class ModalConfigError extends ModalClientError {
  public constructor(message: string) {
    super({
      message,
      retryable: false,
      code: "config"
    });
    this.name = "ModalConfigError";
  }
}

export class ModalAuthError extends ModalClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: false,
      statusCode: statusCode ?? null,
      code: "auth"
    });
    this.name = "ModalAuthError";
  }
}

export class ModalRetryableTransportError extends ModalClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: true,
      statusCode: statusCode ?? null,
      code: "transport_retryable"
    });
    this.name = "ModalRetryableTransportError";
  }
}

export class ModalProviderError extends ModalClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: false,
      statusCode: statusCode ?? null,
      code: "provider"
    });
    this.name = "ModalProviderError";
  }
}

export function isRetryableModalError(error: unknown): boolean {
  return error instanceof ModalClientError && error.retryable;
}

export function loadModalAuthConfigFromEnv(
  env: Record<string, string | undefined>
): ModalAuthConfig {
  const tokenId = env.MODAL_TOKEN_ID?.trim();
  if (!tokenId) {
    throw new ModalConfigError("MODAL_TOKEN_ID is required");
  }

  const tokenSecret = env.MODAL_TOKEN_SECRET?.trim();
  if (!tokenSecret) {
    throw new ModalConfigError("MODAL_TOKEN_SECRET is required");
  }

  const rawBaseUrl = env.MODAL_API_BASE_URL?.trim();
  const apiBaseUrl = rawBaseUrl?.replace(/\/+$/, "") || DEFAULT_MODAL_API_BASE_URL;

  const rawTimeoutMs = env.MODAL_TIMEOUT_MS?.trim();
  const timeoutMs =
    rawTimeoutMs && rawTimeoutMs.length > 0
      ? Number.parseInt(rawTimeoutMs, 10)
      : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ModalConfigError("MODAL_TIMEOUT_MS must be a positive integer");
  }

  return {
    tokenId,
    tokenSecret,
    apiBaseUrl,
    timeoutMs
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function extractErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return "Unexpected Modal error response";
  }

  const direct = asNonEmptyString(payload.error) ?? asNonEmptyString(payload.message);
  if (direct) {
    return direct;
  }

  if (isRecord(payload.error)) {
    const nested =
      asNonEmptyString(payload.error.message) ?? asNonEmptyString(payload.error.description);
    if (nested) {
      return nested;
    }
  }

  return "Unexpected Modal error response";
}

function mapHttpError(status: number, payload: unknown): ModalClientError {
  const message = extractErrorMessage(payload);
  if (status === 401 || status === 403) {
    return new ModalAuthError(message, status);
  }

  if (status === 408 || status === 429 || status >= 500) {
    return new ModalRetryableTransportError(message, status);
  }

  return new ModalProviderError(message, status);
}

function parseModalStatus(
  value: unknown,
  fallback: ModalJobStatus,
  statusCode: number | undefined
): ModalJobStatus {
  const raw = asNonEmptyString(value) ?? fallback;
  if (!isModalJobStatus(raw)) {
    throw new ModalProviderError(`Invalid Modal status: ${raw}`, statusCode);
  }

  return raw;
}

function parseSubmitResponse(
  payload: unknown,
  statusCode: number | undefined
): ModalExecutionHandle {
  if (!isRecord(payload)) {
    throw new ModalProviderError("Modal submit response must be a JSON object", statusCode);
  }

  const externalRef =
    asNonEmptyString(payload.id) ??
    asNonEmptyString(payload.job_id) ??
    asNonEmptyString(payload.jobId);
  if (!externalRef) {
    throw new ModalProviderError("Modal submit response missing job id", statusCode);
  }

  return {
    externalRef,
    status: parseModalStatus(payload.status, "queued", statusCode),
    metadata: asMetadata(payload.metadata)
  };
}

function parseStatusResponse(
  payload: unknown,
  requestedExternalRef: string,
  statusCode: number | undefined
): ModalJobStatusResult {
  if (!isRecord(payload)) {
    throw new ModalProviderError("Modal status response must be a JSON object", statusCode);
  }

  const externalRef =
    asNonEmptyString(payload.id) ??
    asNonEmptyString(payload.job_id) ??
    asNonEmptyString(payload.jobId) ??
    requestedExternalRef;

  return {
    externalRef,
    status: parseModalStatus(payload.status, "running", statusCode),
    metadata: asMetadata(payload.metadata)
  };
}

function parseResultResponse(
  payload: unknown,
  requestedExternalRef: string,
  statusCode: number | undefined
): ModalJobResult {
  if (!isRecord(payload)) {
    throw new ModalProviderError("Modal result response must be a JSON object", statusCode);
  }

  const externalRef =
    asNonEmptyString(payload.id) ??
    asNonEmptyString(payload.job_id) ??
    asNonEmptyString(payload.jobId) ??
    requestedExternalRef;
  const status = parseModalStatus(payload.status, "failed", statusCode);
  const summary =
    asNonEmptyString(payload.summary) ?? asNonEmptyString(payload.message) ?? `Modal job ${status}`;
  const logsInline = asNonEmptyString(payload.logs) ?? asNonEmptyString(payload.logs_inline);

  return {
    externalRef,
    status,
    summary,
    logsInline: logsInline ?? undefined,
    metadata: asMetadata(payload.metadata)
  };
}

interface RequestResult {
  payload: unknown;
  statusCode?: number;
}

class HttpModalExecutionTransport implements ModalExecutionTransport {
  private readonly fetchFn: FetchLike;
  private readonly auth: ModalAuthConfig;

  public constructor(input: CreateModalExecutionTransportInput) {
    this.fetchFn = input.fetchFn ?? fetch;
    this.auth = input.auth;
  }

  public async submitJob(input: ModalSubmitJobInput): Promise<ModalExecutionHandle> {
    const response = await this.request("/jobs", {
      method: "POST",
      body: JSON.stringify({
        phase: input.phase,
        runId: input.runId,
        command: input.command,
        env: input.env ?? {},
        metadata: input.metadata ?? {}
      })
    });
    return parseSubmitResponse(response.payload, response.statusCode);
  }

  public async getJobStatus(externalRef: string): Promise<ModalJobStatusResult> {
    const response = await this.request(`/jobs/${encodeURIComponent(externalRef)}`, {
      method: "GET"
    });
    return parseStatusResponse(response.payload, externalRef, response.statusCode);
  }

  public async getJobResult(externalRef: string): Promise<ModalJobResult> {
    const response = await this.request(`/jobs/${encodeURIComponent(externalRef)}/result`, {
      method: "GET"
    });
    return parseResultResponse(response.payload, externalRef, response.statusCode);
  }

  private buildHeaders(extra: HeadersInit | undefined): Headers {
    const headers = new Headers(extra ?? undefined);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("Modal-Key", this.auth.tokenId);
    headers.set("Modal-Secret", this.auth.tokenSecret);
    return headers;
  }

  private async request(path: string, init: RequestInit): Promise<RequestResult> {
    const timeout = this.auth.timeoutMs;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeout);

    const url = `${this.auth.apiBaseUrl}${path}`;
    try {
      const response = await this.fetchFn(url, {
        ...init,
        headers: this.buildHeaders(init.headers),
        signal: controller.signal
      });

      const rawBody = await response.text();
      let payload: unknown = null;
      if (rawBody.trim().length > 0) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          throw new ModalProviderError("Modal returned non-JSON response body", response.status);
        }
      }

      if (!response.ok) {
        throw mapHttpError(response.status, payload);
      }

      return {
        payload,
        statusCode: response.status
      };
    } catch (error) {
      if (error instanceof ModalClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ModalRetryableTransportError("Modal request timed out");
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ModalRetryableTransportError(`Modal request failed: ${message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

export function createModalExecutionTransport(
  input: CreateModalExecutionTransportInput
): ModalExecutionTransport {
  return new HttpModalExecutionTransport(input);
}

export function createModalExecutionTransportFromEnv(
  env: Record<string, string | undefined>,
  options: Pick<CreateModalExecutionTransportInput, "fetchFn"> = {}
): ModalExecutionTransport {
  const auth = loadModalAuthConfigFromEnv(env);
  return createModalExecutionTransport({
    auth,
    fetchFn: options.fetchFn
  });
}
