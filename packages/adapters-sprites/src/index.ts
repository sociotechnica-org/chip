import {
  type SpritesExecutionHandle,
  type SpritesExecutionTransport,
  type SpritesJobResult,
  type SpritesJobStatus,
  type SpritesJobStatusResult,
  type SpritesSubmitJobInput
} from "@bob/core";

const DEFAULT_SPRITES_API_BASE_URL = "https://api.sprites.dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CACHED_RESULTS = 128;

type FetchLike = typeof fetch;

export interface SpritesAuthConfig {
  token: string;
  spriteName: string;
  apiBaseUrl: string;
  timeoutMs: number;
}

export interface CreateSpritesExecutionTransportInput {
  auth: SpritesAuthConfig;
  fetchFn?: FetchLike;
}

export class SpritesClientError extends Error {
  public readonly retryable: boolean;
  public readonly statusCode: number | null;
  public readonly code: "config" | "auth" | "transport_retryable" | "provider";

  public constructor(input: {
    message: string;
    retryable: boolean;
    statusCode?: number | null;
    code: SpritesClientError["code"];
  }) {
    super(input.message);
    this.name = "SpritesClientError";
    this.retryable = input.retryable;
    this.statusCode = input.statusCode ?? null;
    this.code = input.code;
  }
}

export class SpritesConfigError extends SpritesClientError {
  public constructor(message: string) {
    super({
      message,
      retryable: false,
      code: "config"
    });
    this.name = "SpritesConfigError";
  }
}

export class SpritesAuthError extends SpritesClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: false,
      statusCode: statusCode ?? null,
      code: "auth"
    });
    this.name = "SpritesAuthError";
  }
}

export class SpritesRetryableTransportError extends SpritesClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: true,
      statusCode: statusCode ?? null,
      code: "transport_retryable"
    });
    this.name = "SpritesRetryableTransportError";
  }
}

export class SpritesProviderError extends SpritesClientError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      retryable: false,
      statusCode: statusCode ?? null,
      code: "provider"
    });
    this.name = "SpritesProviderError";
  }
}

export function isRetryableSpritesError(error: unknown): boolean {
  return error instanceof SpritesClientError && error.retryable;
}

export function loadSpritesAuthConfigFromEnv(
  env: Record<string, string | undefined>
): SpritesAuthConfig {
  const token = env.SPRITE_TOKEN?.trim();
  if (!token) {
    throw new SpritesConfigError("SPRITE_TOKEN is required");
  }

  const spriteName = env.SPRITE_NAME?.trim();
  if (!spriteName) {
    throw new SpritesConfigError("SPRITE_NAME is required");
  }

  const rawBaseUrl = env.SPRITES_API_BASE_URL?.trim();
  const apiBaseUrl = rawBaseUrl?.replace(/\/+$/, "") || DEFAULT_SPRITES_API_BASE_URL;

  const rawTimeoutMs = env.SPRITES_TIMEOUT_MS?.trim();
  const timeoutMs =
    rawTimeoutMs && rawTimeoutMs.length > 0
      ? Number.parseInt(rawTimeoutMs, 10)
      : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SpritesConfigError("SPRITES_TIMEOUT_MS must be a positive integer");
  }

  return {
    token,
    spriteName,
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

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (!isRecord(payload)) {
    return "Unexpected Sprites error response";
  }

  const direct =
    asNonEmptyString(payload.error) ??
    asNonEmptyString(payload.message) ??
    asNonEmptyString(payload.detail);
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

  return "Unexpected Sprites error response";
}

function mapHttpError(status: number, payload: unknown): SpritesClientError {
  const message = extractErrorMessage(payload);
  if (status === 401 || status === 403) {
    return new SpritesAuthError(message, status);
  }

  if (status === 408 || status === 429 || status >= 500) {
    return new SpritesRetryableTransportError(message, status);
  }

  return new SpritesProviderError(message, status);
}

function parsePossibleJson(rawBody: string): unknown {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return rawBody;
  }
}

function buildExecUrl(auth: SpritesAuthConfig, input: SpritesSubmitJobInput): string {
  const url = new URL(`/v1/sprites/${encodeURIComponent(auth.spriteName)}/exec`, auth.apiBaseUrl);
  url.searchParams.append("cmd", "sh");
  url.searchParams.append("cmd", "-lc");
  url.searchParams.append("cmd", input.command);
  url.searchParams.set("path", "sh");

  const env = input.env ?? {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value !== "string") {
      continue;
    }

    url.searchParams.append("env", `${key}=${value}`);
  }

  return url.toString();
}

function buildExternalRef(input: SpritesSubmitJobInput): string {
  const phase = input.phase.replace(/[^a-z0-9_]/gi, "_");
  const run = input.runId.replace(/[^a-z0-9_]/gi, "_");
  return `sprites_${run}_${phase}_${Date.now().toString(36)}`;
}

function extractExitCode(headers: Headers): number | null {
  const raw =
    headers.get("x-exit-code") ??
    headers.get("x-sprite-exit-code") ??
    headers.get("x-process-exit-code");
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function summarizeExecution(
  status: SpritesJobStatus,
  logsInline: string,
  exitCode: number | null
): string {
  if (status === "succeeded") {
    return "Sprites command completed successfully";
  }

  if (exitCode !== null) {
    return `Sprites command failed with exit code ${exitCode}`;
  }

  const firstLine = logsInline
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "Sprites command failed";
}

interface ExecResponse {
  statusCode: number;
  bodyText: string;
  headers: Headers;
}

class HttpSpritesExecutionTransport implements SpritesExecutionTransport {
  private readonly fetchFn: FetchLike;
  private readonly auth: SpritesAuthConfig;
  private readonly resultsByRef = new Map<string, SpritesJobResult>();

  public constructor(input: CreateSpritesExecutionTransportInput) {
    this.fetchFn = input.fetchFn ?? fetch;
    this.auth = input.auth;
  }

  public async submitJob(input: SpritesSubmitJobInput): Promise<SpritesExecutionHandle> {
    const externalRef = buildExternalRef(input);
    const response = await this.executeCommand(input);

    const logsInline = response.bodyText;
    const exitCode = extractExitCode(response.headers);
    const status: SpritesJobStatus =
      exitCode !== null ? (exitCode === 0 ? "succeeded" : "failed") : "succeeded";
    const summary = summarizeExecution(status, logsInline, exitCode);

    const metadata: Record<string, unknown> = {
      ...((input.metadata as Record<string, unknown> | undefined) ?? {}),
      statusCode: response.statusCode,
      exitCode: exitCode ?? undefined
    };

    const result: SpritesJobResult = {
      externalRef,
      status,
      summary,
      logsInline: logsInline.length > 0 ? logsInline : undefined,
      metadata
    };

    this.cacheResult(result);

    return {
      externalRef,
      status,
      summary,
      logsInline: result.logsInline,
      metadata
    };
  }

  public async getJobStatus(externalRef: string): Promise<SpritesJobStatusResult> {
    const result = this.resultsByRef.get(externalRef);
    if (!result) {
      throw new SpritesProviderError(`Unknown Sprites external_ref: ${externalRef}`);
    }

    return {
      externalRef,
      status: result.status,
      metadata: result.metadata
    };
  }

  public async getJobResult(externalRef: string): Promise<SpritesJobResult> {
    const result = this.resultsByRef.get(externalRef);
    if (!result) {
      throw new SpritesProviderError(`Unknown Sprites external_ref: ${externalRef}`);
    }

    return result;
  }

  private cacheResult(result: SpritesJobResult): void {
    this.resultsByRef.set(result.externalRef, result);
    while (this.resultsByRef.size > MAX_CACHED_RESULTS) {
      const oldestRef = this.resultsByRef.keys().next().value;
      if (typeof oldestRef !== "string") {
        break;
      }

      this.resultsByRef.delete(oldestRef);
    }
  }

  private buildHeaders(extra: HeadersInit | undefined): Headers {
    const headers = new Headers(extra ?? undefined);
    headers.set("accept", "application/octet-stream, application/json");
    headers.set("authorization", `Bearer ${this.auth.token}`);
    return headers;
  }

  private async executeCommand(input: SpritesSubmitJobInput): Promise<ExecResponse> {
    const timeout = this.auth.timeoutMs;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const response = await this.fetchFn(buildExecUrl(this.auth, input), {
        method: "POST",
        headers: this.buildHeaders(undefined),
        signal: controller.signal
      });

      const rawBody = await response.text();
      if (!response.ok) {
        throw mapHttpError(response.status, parsePossibleJson(rawBody));
      }

      return {
        statusCode: response.status,
        bodyText: rawBody,
        headers: response.headers
      };
    } catch (error) {
      if (error instanceof SpritesClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new SpritesRetryableTransportError("Sprites request timed out");
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new SpritesRetryableTransportError(`Sprites request failed: ${message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

export function createSpritesExecutionTransport(
  input: CreateSpritesExecutionTransportInput
): SpritesExecutionTransport {
  return new HttpSpritesExecutionTransport(input);
}

export function createSpritesExecutionTransportFromEnv(
  env: Record<string, string | undefined>,
  options: Pick<CreateSpritesExecutionTransportInput, "fetchFn"> = {}
): SpritesExecutionTransport {
  const auth = loadSpritesAuthConfigFromEnv(env);
  return createSpritesExecutionTransport({
    auth,
    fetchFn: options.fetchFn
  });
}
