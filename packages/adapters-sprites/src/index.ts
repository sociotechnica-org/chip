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
const STREAM_ID_STDIN = 0;
const STREAM_ID_STDOUT = 1;
const STREAM_ID_STDERR = 2;
const STREAM_ID_EXIT = 3;
const STREAM_ID_STDIN_EOF = 4;
const ENV_SENTINEL = "__SPRITES_ENV_DONE__";
const CONTROL_PREFIX = "control:";

type FetchLike = typeof fetch;

type SpritesWebSocketInit = {
  headers: Record<string, string>;
};

interface SpritesWebSocketLike {
  binaryType: string;
  readyState: number;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void
  ): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

type SpritesWebSocketFactory = (url: string, init: SpritesWebSocketInit) => SpritesWebSocketLike;

export interface SpritesAuthConfig {
  token: string;
  spriteName: string;
  apiBaseUrl: string;
  timeoutMs: number;
}

export interface CreateSpritesExecutionTransportInput {
  auth: SpritesAuthConfig;
  fetchFn?: FetchLike;
  webSocketFactory?: SpritesWebSocketFactory;
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

export function isRetryableSpritesError(error: unknown): error is SpritesClientError {
  return error instanceof SpritesClientError && error.retryable;
}

function requireEnvValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new SpritesConfigError(`${key} is required`);
  }

  return value;
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SpritesConfigError(`${key} must be a positive integer`);
  }

  return parsed;
}

function parseTimeoutMs(rawTimeoutMs: string | undefined): number {
  const timeoutValue = rawTimeoutMs?.trim();
  if (!timeoutValue) {
    return DEFAULT_TIMEOUT_MS;
  }

  return parsePositiveInteger(timeoutValue, "SPRITES_TIMEOUT_MS");
}

export function loadSpritesAuthConfigFromEnv(
  env: Record<string, string | undefined>
): SpritesAuthConfig {
  const token = requireEnvValue(env, "SPRITE_TOKEN");
  const spriteName = requireEnvValue(env, "SPRITE_NAME");

  const rawBaseUrl = env.SPRITES_API_BASE_URL?.trim();
  const apiBaseUrl = rawBaseUrl?.replace(/\/+$/, "") || DEFAULT_SPRITES_API_BASE_URL;
  const timeoutMs = parseTimeoutMs(env.SPRITES_TIMEOUT_MS);

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

function toWebSocketBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.startsWith("https://")) {
    return `wss://${apiBaseUrl.slice("https://".length)}`;
  }

  if (apiBaseUrl.startsWith("http://")) {
    return `ws://${apiBaseUrl.slice("http://".length)}`;
  }

  if (apiBaseUrl.startsWith("wss://") || apiBaseUrl.startsWith("ws://")) {
    return apiBaseUrl;
  }

  throw new SpritesConfigError(`Unsupported SPRITES_API_BASE_URL: ${apiBaseUrl}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildLauncherCommand(command: string): string {
  if (command.trim().length === 0) {
    throw new SpritesProviderError("Sprites command must not be empty");
  }

  const escapedCommand = shellQuote(command);
  return [
    "set -eu",
    "while IFS= read -r __sprites_env_line; do",
    `  if [ "$__sprites_env_line" = "${ENV_SENTINEL}" ]; then break; fi`,
    '  export "$__sprites_env_line"',
    "done",
    `exec sh -lc ${escapedCommand}`
  ].join("; ");
}

function buildNewSessionUrl(auth: SpritesAuthConfig, launcherCommand: string): string {
  const url = new URL(
    `/v1/sprites/${encodeURIComponent(auth.spriteName)}/exec`,
    toWebSocketBaseUrl(auth.apiBaseUrl)
  );
  url.searchParams.append("cmd", "sh");
  url.searchParams.append("cmd", "-lc");
  url.searchParams.append("cmd", launcherCommand);
  url.searchParams.set("path", "sh");
  url.searchParams.set("stdin", "true");
  url.searchParams.set("cc", "true");
  url.searchParams.set("detachable", "true");
  return url.toString();
}

function buildAttachSessionUrl(auth: SpritesAuthConfig, sessionId: string): string {
  const url = new URL(
    `/v1/sprites/${encodeURIComponent(auth.spriteName)}/exec`,
    toWebSocketBaseUrl(auth.apiBaseUrl)
  );
  url.searchParams.set("id", sessionId);
  url.searchParams.set("stdin", "true");
  url.searchParams.set("cc", "true");
  return url.toString();
}

function parseSessionId(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }

  return null;
}

function parseExitCode(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }

  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function extractControlPayload(data: string): unknown {
  const body = data.startsWith(CONTROL_PREFIX) ? data.slice(CONTROL_PREFIX.length) : data;
  try {
    return JSON.parse(body);
  } catch {
    return data;
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof Buffer !== "undefined" && data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return null;
}

function buildStdinFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = STREAM_ID_STDIN;
  frame.set(payload, 1);
  return frame;
}

function buildStdinEofFrame(): Uint8Array {
  return new Uint8Array([STREAM_ID_STDIN_EOF]);
}

function encodeEnvPayload(env: Record<string, string> | undefined): Uint8Array {
  const lines: string[] = [];
  for (const key of Object.keys(env ?? {}).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new SpritesProviderError(`Invalid environment variable key: ${key}`);
    }

    const value = env?.[key];
    if (typeof value !== "string") {
      continue;
    }

    if (value.includes("\n") || value.includes("\r") || value.includes("\u0000")) {
      throw new SpritesProviderError(
        `Environment variable ${key} contains unsupported newline or null characters`
      );
    }

    lines.push(`${key}=${value}`);
  }

  lines.push(ENV_SENTINEL);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
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

function decodeChunks(chunks: Uint8Array[]): string {
  if (chunks.length === 0) {
    return "";
  }

  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(merged);
}

function defaultWebSocketFactory(url: string, init: SpritesWebSocketInit): SpritesWebSocketLike {
  if (typeof WebSocket !== "function") {
    throw new SpritesConfigError("WebSocket runtime support is required for Sprites transport");
  }

  const WebSocketCtor = WebSocket as unknown as {
    new (url: string, protocols?: unknown): SpritesWebSocketLike;
  };

  try {
    return new WebSocketCtor(url, {
      headers: init.headers
    });
  } catch (error) {
    throw new SpritesConfigError(
      `Unable to initialize Sprites WebSocket client: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

interface WebSocketRunResult {
  sessionId: string | null;
  logsInline: string;
  exitCode: number | null;
  providerErrorMessage: string | null;
  timedOut: boolean;
}

interface SessionListItem {
  id: string;
  isActive: boolean;
}

interface WebSocketRunState {
  sessionId: string | null;
  outputChunks: Uint8Array[];
  exitCode: number | null;
  providerErrorMessage: string | null;
}

function toWebSocketRunResult(state: WebSocketRunState, timedOut: boolean): WebSocketRunResult {
  return {
    sessionId: state.sessionId,
    logsInline: decodeChunks(state.outputChunks),
    exitCode: state.exitCode,
    providerErrorMessage: state.providerErrorMessage,
    timedOut
  };
}

function updateStateFromControlPayload(state: WebSocketRunState, payload: string): boolean {
  const parsed = extractControlPayload(payload);
  if (!isRecord(parsed)) {
    return false;
  }

  const parsedSessionId = parseSessionId(parsed.session_id);
  if (parsedSessionId) {
    state.sessionId = parsedSessionId;
  }

  const parsedExitCode = parseExitCode(parsed.exit_code);
  if (parsedExitCode !== null) {
    state.exitCode = parsedExitCode;
  }

  const errorMessage =
    asNonEmptyString(parsed.error) ??
    (isRecord(parsed.args) ? asNonEmptyString(parsed.args.error) : null);
  if (errorMessage) {
    state.providerErrorMessage = errorMessage;
  }

  const messageType = asNonEmptyString(parsed.type);
  if (messageType === "exit" || messageType === "session_exited") {
    return true;
  }

  return Boolean(state.providerErrorMessage);
}

function updateStateFromBinaryPayload(
  state: WebSocketRunState,
  binaryPayload: Uint8Array
): boolean {
  if (binaryPayload.length === 0) {
    return false;
  }

  const streamId = binaryPayload[0];
  const streamData = binaryPayload.subarray(1);

  if (streamId === STREAM_ID_STDOUT || streamId === STREAM_ID_STDERR) {
    state.outputChunks.push(new Uint8Array(streamData));
    return false;
  }

  if (streamId === STREAM_ID_EXIT) {
    state.exitCode = streamData.length > 0 ? streamData[0] : 0;
    return true;
  }

  return false;
}

class SpritesWebSocketSession {
  private readonly socket: SpritesWebSocketLike;
  private readonly timeoutMs: number;
  private readonly sendStdinPayload: Uint8Array | null;

  public constructor(input: {
    socket: SpritesWebSocketLike;
    timeoutMs: number;
    sendStdinPayload: Uint8Array | null;
  }) {
    this.socket = input.socket;
    this.timeoutMs = input.timeoutMs;
    this.sendStdinPayload = input.sendStdinPayload;
  }

  public async run(): Promise<WebSocketRunResult> {
    this.socket.binaryType = "arraybuffer";

    return await new Promise<WebSocketRunResult>((resolve, reject) => {
      let completed = false;
      const state: WebSocketRunState = {
        sessionId: null,
        outputChunks: [],
        exitCode: null,
        providerErrorMessage: null
      };

      const finish = (result: WebSocketRunResult): void => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timeoutHandle);
        try {
          this.socket.close(1000, "");
        } catch {
          // no-op
        }
        resolve(result);
      };

      const fail = (error: Error): void => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timeoutHandle);
        try {
          this.socket.close(1011, "");
        } catch {
          // no-op
        }
        reject(error);
      };

      const timeoutHandle = setTimeout(() => {
        finish(toWebSocketRunResult(state, true));
      }, this.timeoutMs);

      this.socket.addEventListener("open", () => {
        if (!this.sendStdinPayload) {
          return;
        }

        try {
          this.socket.send(buildStdinFrame(this.sendStdinPayload));
          this.socket.send(buildStdinEofFrame());
        } catch (error) {
          fail(
            new SpritesRetryableTransportError(
              `Failed to send Sprites stdin payload: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        }
      });

      this.socket.addEventListener("message", (event) => {
        const messageEvent = event as { data?: unknown };
        const payload = messageEvent.data;

        if (typeof payload === "string") {
          if (updateStateFromControlPayload(state, payload)) {
            finish(toWebSocketRunResult(state, false));
          }
          return;
        }

        const binaryPayload = toUint8Array(payload);
        if (!binaryPayload) {
          return;
        }

        if (updateStateFromBinaryPayload(state, binaryPayload)) {
          finish(toWebSocketRunResult(state, false));
        }
      });

      this.socket.addEventListener("error", () => {
        fail(new SpritesRetryableTransportError("Sprites websocket request failed"));
      });

      this.socket.addEventListener("close", () => {
        finish(toWebSocketRunResult(state, false));
      });
    });
  }
}

class WebSocketSpritesExecutionTransport implements SpritesExecutionTransport {
  private readonly fetchFn: FetchLike;
  private readonly auth: SpritesAuthConfig;
  private readonly webSocketFactory: SpritesWebSocketFactory;

  public constructor(input: CreateSpritesExecutionTransportInput) {
    this.fetchFn =
      input.fetchFn ?? ((resource: RequestInfo | URL, init?: RequestInit) => fetch(resource, init));
    this.auth = input.auth;
    this.webSocketFactory = input.webSocketFactory ?? defaultWebSocketFactory;
  }

  public async submitJob(input: SpritesSubmitJobInput): Promise<SpritesExecutionHandle> {
    const launcherCommand = buildLauncherCommand(input.command);
    const session = await this.runSession({
      url: buildNewSessionUrl(this.auth, launcherCommand),
      stdinPayload: encodeEnvPayload(input.env)
    });

    if (session.providerErrorMessage) {
      throw this.mapWebSocketProviderError(session.providerErrorMessage);
    }

    if (!session.sessionId) {
      throw new SpritesProviderError("Sprites did not return a session_id for submitted command");
    }

    const metadata: Record<string, unknown> = {
      ...((input.metadata as Record<string, unknown> | undefined) ?? {}),
      sessionId: session.sessionId,
      timedOut: session.timedOut
    };

    if (session.exitCode === null) {
      return {
        externalRef: session.sessionId,
        status: "running",
        summary: "Sprites command is still running",
        metadata
      };
    }

    const status: SpritesJobStatus = session.exitCode === 0 ? "succeeded" : "failed";
    const summary = summarizeExecution(status, session.logsInline, session.exitCode);
    return {
      externalRef: session.sessionId,
      status,
      summary,
      logsInline: session.logsInline.length > 0 ? session.logsInline : undefined,
      metadata: {
        ...metadata,
        exitCode: session.exitCode
      }
    };
  }

  public async getJobStatus(externalRef: string): Promise<SpritesJobStatusResult> {
    const session = await this.findSession(externalRef);
    if (!session) {
      throw new SpritesProviderError(`Unknown Sprites external_ref: ${externalRef}`);
    }

    return {
      externalRef,
      status: session.isActive ? "running" : "running",
      metadata: {
        sessionId: externalRef,
        isActive: session.isActive
      }
    };
  }

  public async getJobResult(externalRef: string): Promise<SpritesJobResult> {
    const session = await this.runSession({
      url: buildAttachSessionUrl(this.auth, externalRef),
      stdinPayload: null
    });

    if (session.providerErrorMessage) {
      const providerError = this.mapWebSocketProviderError(session.providerErrorMessage);
      if (/session not found/i.test(providerError.message)) {
        const listed = await this.findSession(externalRef);
        if (listed) {
          return {
            externalRef,
            status: "running",
            summary: "Sprites session is pending attach",
            metadata: {
              sessionId: externalRef,
              isActive: listed.isActive
            }
          };
        }

        throw new SpritesProviderError(`Unknown Sprites external_ref: ${externalRef}`);
      }

      throw providerError;
    }

    const resolvedSessionId = session.sessionId ?? externalRef;
    if (session.exitCode === null) {
      return {
        externalRef: resolvedSessionId,
        status: "running",
        summary: "Sprites command is still running",
        logsInline: session.logsInline.length > 0 ? session.logsInline : undefined,
        metadata: {
          sessionId: resolvedSessionId,
          timedOut: session.timedOut
        }
      };
    }

    const status: SpritesJobStatus = session.exitCode === 0 ? "succeeded" : "failed";
    return {
      externalRef: resolvedSessionId,
      status,
      summary: summarizeExecution(status, session.logsInline, session.exitCode),
      logsInline: session.logsInline.length > 0 ? session.logsInline : undefined,
      metadata: {
        sessionId: resolvedSessionId,
        exitCode: session.exitCode
      }
    };
  }

  private mapWebSocketProviderError(message: string): SpritesClientError {
    if (/auth/i.test(message)) {
      return new SpritesAuthError(message);
    }

    return new SpritesProviderError(message);
  }

  private async runSession(input: {
    url: string;
    stdinPayload: Uint8Array | null;
  }): Promise<WebSocketRunResult> {
    const socket = this.webSocketFactory(input.url, {
      headers: {
        authorization: `Bearer ${this.auth.token}`
      }
    });

    return new SpritesWebSocketSession({
      socket,
      timeoutMs: this.auth.timeoutMs,
      sendStdinPayload: input.stdinPayload
    }).run();
  }

  private buildHeaders(extra: HeadersInit | undefined): Headers {
    const headers = new Headers(extra ?? undefined);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.auth.token}`);
    return headers;
  }

  private buildSessionListUrl(): string {
    const url = new URL(
      `/v1/sprites/${encodeURIComponent(this.auth.spriteName)}/exec`,
      this.auth.apiBaseUrl
    );
    url.searchParams.set("inactive", "true");
    url.searchParams.set("limit", "200");
    return url.toString();
  }

  private parseSessionListPayload(payload: unknown): SessionListItem[] {
    if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
      throw new SpritesProviderError("Unexpected Sprites session list response");
    }

    const sessions: SessionListItem[] = [];
    for (const session of payload.sessions) {
      if (!isRecord(session)) {
        continue;
      }

      const id = parseSessionId(session.id);
      if (!id) {
        continue;
      }

      sessions.push({
        id,
        isActive: Boolean(session.is_active)
      });
    }

    return sessions;
  }

  private async fetchSessionList(): Promise<SessionListItem[]> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.auth.timeoutMs);

    try {
      const response = await this.fetchFn(this.buildSessionListUrl(), {
        method: "GET",
        headers: this.buildHeaders(undefined),
        signal: controller.signal
      });

      const rawBody = await response.text();
      if (!response.ok) {
        throw mapHttpError(response.status, parsePossibleJson(rawBody));
      }

      const payload = parsePossibleJson(rawBody);
      return this.parseSessionListPayload(payload);
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

  private async findSession(externalRef: string): Promise<SessionListItem | null> {
    const sessions = await this.fetchSessionList();
    for (const session of sessions) {
      if (session.id === externalRef) {
        return session;
      }
    }

    return null;
  }
}

export function createSpritesExecutionTransport(
  input: CreateSpritesExecutionTransportInput
): SpritesExecutionTransport {
  return new WebSocketSpritesExecutionTransport(input);
}

export function createSpritesExecutionTransportFromEnv(
  env: Record<string, string | undefined>,
  options: Pick<CreateSpritesExecutionTransportInput, "fetchFn" | "webSocketFactory"> = {}
): SpritesExecutionTransport {
  const auth = loadSpritesAuthConfigFromEnv(env);
  return createSpritesExecutionTransport({
    auth,
    fetchFn: options.fetchFn,
    webSocketFactory: options.webSocketFactory
  });
}
