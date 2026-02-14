import {
  isCoderunnerMode,
  isTerminalModalJobStatus,
  type CoderunnerAdapter,
  type CoderunnerMode,
  type CoderunnerTaskInput,
  type ExecutionOutcome,
  type ExecutionPhase,
  type ModalExecutionTransport,
  type ModalJobResult,
  type ModalJobStatus,
  type ModalJobStatusResult,
  type StationExecutionMetadata,
  type StationExecutionResponse,
  type StationExecutionResult
} from "@bob/core";
import { createModalExecutionTransportFromEnv, isRetryableModalError } from "@bob/adapters-modal";

export interface CoderunnerEnv {
  CODERUNNER_MODE?: string;
  CLAUDE_CODE_API_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_API_BASE_URL?: string;
  MODAL_TIMEOUT_MS?: string;
}

export interface CreateCoderunnerAdapterInput {
  mode: CoderunnerMode;
  claudeCodeApiKey?: string;
  modalTransport?: ModalExecutionTransport;
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

function mapModalStatusToOutcome(status: ModalJobStatus): ExecutionOutcome {
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

function parseMockOutcome(goal: string | null): ExecutionOutcome {
  if (shouldMockFail(goal, "[mock-timeout]")) {
    return "timeout";
  }

  if (shouldMockFail(goal, "[mock-canceled]")) {
    return "canceled";
  }

  if (shouldMockFail(goal, "[mock-fail]") || shouldMockFail(goal, "[verify-fail]")) {
    return "failed";
  }

  return "succeeded";
}

class ClaudeCodeRunner implements CoderunnerAdapter {
  private readonly mode: CoderunnerMode;
  private readonly transport: ModalExecutionTransport | null;
  private readonly claudeCodeApiKey: string | null;
  private readonly nowIso: () => string;

  public constructor(input: CreateCoderunnerAdapterInput) {
    this.mode = input.mode;
    this.transport = input.modalTransport ?? null;
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
        message: "Modal transport is required for modal coderunner mode",
        retryable: false,
        code: "config"
      });
    }

    if (!this.claudeCodeApiKey) {
      throw new CoderunnerError({
        message: "CLAUDE_CODE_API_KEY is required for modal coderunner mode",
        retryable: false,
        code: "config"
      });
    }

    try {
      if (input.resume?.externalRef) {
        return await this.resumeModalTask(phase, input);
      }

      return await this.startModalTask(phase, input);
    } catch (error) {
      if (error instanceof CoderunnerError) {
        throw error;
      }

      if (isRetryableModalError(error)) {
        throw new CoderunnerError({
          message: `Modal transport retryable error during ${phase}`,
          retryable: true,
          code: "transport_retryable",
          cause: error
        });
      }

      throw new CoderunnerError({
        message: `Modal execution failed during ${phase}: ${
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

  private buildModalCommand(phase: ExecutionPhase, input: CoderunnerTaskInput): string {
    const base = `claude-code ${phase}`;
    const repo = `--repo ${input.repo.owner}/${input.repo.name}`;
    const issue = `--issue ${input.issueNumber}`;
    const configPath = `--config-path ${input.repo.configPath}`;
    const goal = input.goal ? `--goal ${JSON.stringify(input.goal)}` : "";
    return [base, repo, issue, configPath, goal].filter((value) => value.length > 0).join(" ");
  }

  private toTerminalResult(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput,
    result: ModalJobResult
  ): StationExecutionResult {
    const outcome = mapModalStatusToOutcome(result.status);
    const summaryPrefix = phase === "implement" ? "Implement" : "Verify";
    const summary =
      result.summary ||
      `${summaryPrefix} ${outcome} for ${input.repo.owner}/${input.repo.name}#${input.issueNumber}`;

    return {
      outcome,
      summary,
      logsInline: result.logsInline,
      externalRef: result.externalRef,
      metadata: this.buildMetadata(phase, input, result.status)
    };
  }

  private async startModalTask(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput
  ): Promise<StationExecutionResponse> {
    const submit = await this.transport!.submitJob({
      phase,
      runId: input.runId,
      command: this.buildModalCommand(phase, input),
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
    if (!isTerminalModalJobStatus(submit.status)) {
      return {
        outcome: null,
        summary: `${phase} execution submitted to Modal`,
        externalRef: submit.externalRef,
        metadata
      };
    }

    const result = await this.transport!.getJobResult(submit.externalRef);
    return this.toTerminalResult(phase, input, result);
  }

  private async resumeModalTask(
    phase: ExecutionPhase,
    input: CoderunnerTaskInput
  ): Promise<StationExecutionResponse> {
    const externalRef = input.resume!.externalRef;
    const statusResult: ModalJobStatusResult = await this.transport!.getJobStatus(externalRef);
    const metadata = this.buildMetadata(phase, input, statusResult.status);
    if (!isTerminalModalJobStatus(statusResult.status)) {
      return {
        outcome: null,
        summary: `${phase} execution still ${statusResult.status}`,
        externalRef,
        metadata
      };
    }

    const result = await this.transport!.getJobResult(externalRef);
    return this.toTerminalResult(phase, input, result);
  }

  private runMockTask(phase: ExecutionPhase, input: CoderunnerTaskInput): StationExecutionResponse {
    const outcome = parseMockOutcome(input.goal);
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

  const modalTransport =
    overrides.modalTransport ??
    createModalExecutionTransportFromEnv({
      MODAL_TOKEN_ID: env.MODAL_TOKEN_ID,
      MODAL_TOKEN_SECRET: env.MODAL_TOKEN_SECRET,
      MODAL_API_BASE_URL: env.MODAL_API_BASE_URL,
      MODAL_TIMEOUT_MS: env.MODAL_TIMEOUT_MS
    });

  return createCoderunnerAdapter({
    mode,
    modalTransport,
    claudeCodeApiKey: requireApiKey(mode, overrides.claudeCodeApiKey ?? env.CLAUDE_CODE_API_KEY),
    nowIso: overrides.nowIso
  });
}

export function isRetryableCoderunnerError(error: unknown): boolean {
  return error instanceof CoderunnerError && error.retryable;
}
