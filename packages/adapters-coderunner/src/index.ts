import {
  isCoderunnerMode,
  isTerminalSpritesJobStatus,
  type CoderunnerAdapter,
  type CoderunnerMode,
  type CoderunnerTaskInput,
  type ExecutionOutcome,
  type ExecutionPhase,
  type SpritesExecutionTransport,
  type SpritesJobResult,
  type SpritesJobStatus,
  type StationExecutionMetadata,
  type StationExecutionResponse
} from "@bob/core";
import {
  createSpritesExecutionTransportFromEnv,
  isRetryableSpritesError
} from "@bob/adapters-sprites";

export interface CoderunnerEnv {
  CODERUNNER_MODE?: string;
  CLAUDE_CODE_API_KEY?: string;
  SPRITE_TOKEN?: string;
  SPRITE_NAME?: string;
  SPRITES_API_BASE_URL?: string;
  SPRITES_TIMEOUT_MS?: string;
}

export interface CreateCoderunnerAdapterInput {
  mode: CoderunnerMode;
  claudeCodeApiKey?: string;
  spritesTransport?: SpritesExecutionTransport;
  nowIso?: () => string;
}

export class CoderunnerError extends Error {
  public readonly retryable: boolean;
  public readonly code: "config" | "transport_retryable" | "provider";

  public constructor(input: {
    message: string;
    retryable: boolean;
    code: CoderunnerError["code"];
    cause?: unknown;
  }) {
    super(input.message, {
      cause: input.cause
    });
    this.name = "CoderunnerError";
    this.retryable = input.retryable;
    this.code = input.code;
  }
}

const DEFAULT_MODE: CoderunnerMode = "mock";

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeMode(rawMode: string | undefined): CoderunnerMode {
  const normalized = rawMode?.trim() || DEFAULT_MODE;
  if (!isCoderunnerMode(normalized)) {
    throw new CoderunnerError({
      message: `Unsupported CODERUNNER_MODE: ${normalized}`,
      retryable: false,
      code: "config"
    });
  }

  return normalized;
}

function requireApiKey(mode: CoderunnerMode, rawApiKey: string | undefined): string {
  const apiKey = rawApiKey?.trim();
  if (!apiKey) {
    throw new CoderunnerError({
      message: `CLAUDE_CODE_API_KEY is required for CODERUNNER_MODE=${mode}`,
      retryable: false,
      code: "config"
    });
  }

  return apiKey;
}

function mapSpritesStatusToOutcome(status: SpritesJobStatus): ExecutionOutcome {
  if (status === "succeeded") {
    return "succeeded";
  }

  if (status === "canceled") {
    return "canceled";
  }

  if (status === "timeout") {
    return "timeout";
  }

  return "failed";
}

function shouldMockFail(goal: string | null, marker: string): boolean {
  return goal?.toLowerCase().includes(marker) ?? false;
}

function parseMockOutcome(phase: ExecutionPhase, goal: string | null): ExecutionOutcome {
  if (shouldMockFail(goal, "[mock-timeout]")) {
    return "timeout";
  }

  if (shouldMockFail(goal, "[mock-canceled]")) {
    return "canceled";
  }

  if (shouldMockFail(goal, "[mock-fail]")) {
    return "failed";
  }

  if (phase === "verify" && shouldMockFail(goal, "[verify-fail]")) {
    return "failed";
  }

  return "succeeded";
}

class ClaudeCodeRunner implements CoderunnerAdapter {
  private readonly mode: CoderunnerMode;
  private readonly transport: SpritesExecutionTransport | null;
  private readonly claudeCodeApiKey: string | null;
  private readonly nowIso: () => string;

  public constructor(input: CreateCoderunnerAdapterInput) {
    this.mode = input.mode;
    this.transport = input.spritesTransport ?? null;
    this.claudeCodeApiKey = input.claudeCodeApiKey?.trim() || null;
    this.nowIso = input.nowIso ?? nowIso;
  }

  public runImplementTask(input: CoderunnerTaskInput): Promise<StationExecutionResponse> {
    return this.executeTask("implement", input);
  }

  public runVerifyTask(input: CoderunnerTaskInput): Promise<StationExecutionResponse> {
    return this.executeTask("verify", input);
  }

  private async executeTask(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput
  ): Promise<StationExecutionResponse> {
    if (this.mode === "mock") {
      return this.runMockTask(phase, input);
    }

    if (!this.transport) {
      throw new CoderunnerError({
        message: "Sprites transport is required for sprites coderunner mode",
        retryable: false,
        code: "config"
      });
    }

    if (!this.claudeCodeApiKey) {
      throw new CoderunnerError({
        message: "CLAUDE_CODE_API_KEY is required for sprites coderunner mode",
        retryable: false,
        code: "config"
      });
    }

    try {
      return await this.startSpritesTask(phase, input);
    } catch (error) {
      if (error instanceof CoderunnerError) {
        throw error;
      }

      if (isRetryableSpritesError(error)) {
        throw new CoderunnerError({
          message: `Sprites transport retryable error during ${phase}`,
          retryable: true,
          code: "transport_retryable",
          cause: error
        });
      }

      throw new CoderunnerError({
        message: `Sprites execution failed during ${phase}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: false,
        code: "provider",
        cause: error
      });
    }
  }

  private buildMetadata(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput,
    providerStatus: string
  ): StationExecutionMetadata {
    const previousAttempt = input.resume?.metadata?.attempt;
    const attempt =
      typeof previousAttempt === "number" &&
      Number.isInteger(previousAttempt) &&
      previousAttempt >= 1
        ? previousAttempt + 1
        : 1;

    return {
      phase,
      mode: this.mode,
      attempt,
      providerStatus,
      updatedAt: this.nowIso()
    };
  }

  private buildSpritesCommand(phase: ExecutionPhase, input: CoderunnerTaskInput): string {
    const base = `claude-code ${phase}`;
    const repo = `--repo ${input.repo.owner}/${input.repo.name}`;
    const issue = `--issue ${input.issueNumber}`;
    const configPath = `--config-path ${input.repo.configPath}`;
    const goal = input.goal ? `--goal ${JSON.stringify(input.goal)}` : "";
    return [base, repo, issue, configPath, goal].filter((value) => value.length > 0).join(" ");
  }

  private toExecutionResponse(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput,
    result: SpritesJobResult
  ): StationExecutionResponse {
    const metadata = this.buildMetadata(phase, input, result.status);
    if (!isTerminalSpritesJobStatus(result.status)) {
      return {
        outcome: null,
        summary: `${phase} execution still ${result.status}`,
        externalRef: result.externalRef,
        metadata
      };
    }

    const outcome = mapSpritesStatusToOutcome(result.status);
    const summaryPrefix = phase === "implement" ? "Implement" : "Verify";
    const summary =
      result.summary ||
      `${summaryPrefix} ${outcome} for ${input.repo.owner}/${input.repo.name}#${input.issueNumber}`;

    return {
      outcome,
      summary,
      logsInline: result.logsInline,
      externalRef: result.externalRef,
      metadata
    };
  }

  private async startSpritesTask(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput
  ): Promise<StationExecutionResponse> {
    const submit = await this.transport!.submitJob({
      phase,
      runId: input.runId,
      command: this.buildSpritesCommand(phase, input),
      env: {
        CLAUDE_CODE_API_KEY: this.claudeCodeApiKey!
      },
      metadata: {
        runId: input.runId,
        phase,
        repo: `${input.repo.owner}/${input.repo.name}`,
        issueNumber: input.issueNumber,
        requestor: input.requestor
      }
    });

    const metadata = this.buildMetadata(phase, input, submit.status);
    if (!isTerminalSpritesJobStatus(submit.status)) {
      return {
        outcome: null,
        summary: submit.summary ?? `${phase} execution submitted to Sprites`,
        externalRef: submit.externalRef,
        metadata
      };
    }

    if (typeof submit.summary === "string" && submit.summary.trim().length > 0) {
      return {
        outcome: mapSpritesStatusToOutcome(submit.status),
        summary: submit.summary,
        logsInline: submit.logsInline,
        externalRef: submit.externalRef,
        metadata
      };
    }

    try {
      const result = await this.transport!.getJobResult(submit.externalRef);
      return this.toExecutionResponse(phase, input, result);
    } catch (error) {
      if (isRetryableSpritesError(error)) {
        return {
          outcome: null,
          summary: `${phase} execution result fetch retryable; will resume from external_ref=${submit.externalRef}`,
          externalRef: submit.externalRef,
          metadata
        };
      }

      throw error;
    }
  }

  private runMockTask(phase: ExecutionPhase, input: CoderunnerTaskInput): StationExecutionResponse {
    const outcome = parseMockOutcome(phase, input.goal);
    const summaryPrefix = phase === "implement" ? "Implement" : "Verify";
    const summary =
      outcome === "succeeded"
        ? `${summaryPrefix} completed in mock mode`
        : `${summaryPrefix} ${outcome} in mock mode`;

    const externalRef = input.resume?.externalRef ?? `mock_${phase}_${input.runId}`;
    const logsInline = [
      `[mock/${phase}] repo=${input.repo.owner}/${input.repo.name}`,
      `[mock/${phase}] issue=${input.issueNumber}`,
      `[mock/${phase}] outcome=${outcome}`
    ].join("\\n");

    return {
      outcome,
      summary,
      logsInline,
      externalRef,
      metadata: this.buildMetadata(phase, input, outcome)
    };
  }
}

export function createCoderunnerAdapter(input: CreateCoderunnerAdapterInput): CoderunnerAdapter {
  return new ClaudeCodeRunner(input);
}

export function createCoderunnerAdapterFromEnv(
  env: CoderunnerEnv,
  overrides: Partial<CreateCoderunnerAdapterInput> = {}
): CoderunnerAdapter {
  const mode = overrides.mode ?? normalizeMode(env.CODERUNNER_MODE);
  if (mode === "mock") {
    return createCoderunnerAdapter({
      mode,
      nowIso: overrides.nowIso
    });
  }

  const spritesTransport =
    overrides.spritesTransport ??
    createSpritesExecutionTransportFromEnv({
      SPRITE_TOKEN: env.SPRITE_TOKEN,
      SPRITE_NAME: env.SPRITE_NAME,
      SPRITES_API_BASE_URL: env.SPRITES_API_BASE_URL,
      SPRITES_TIMEOUT_MS: env.SPRITES_TIMEOUT_MS
    });

  return createCoderunnerAdapter({
    mode,
    spritesTransport,
    claudeCodeApiKey: requireApiKey(mode, overrides.claudeCodeApiKey ?? env.CLAUDE_CODE_API_KEY),
    nowIso: overrides.nowIso
  });
}

export function isRetryableCoderunnerError(error: unknown): boolean {
  return error instanceof CoderunnerError && error.retryable;
}
