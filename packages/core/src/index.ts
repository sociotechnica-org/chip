export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "canceled"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const STATION_NAMES = ["intake", "plan", "implement", "verify", "create_pr"] as const;

export type StationName = (typeof STATION_NAMES)[number];

export const STATION_EXECUTION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped"
] as const;

export type StationExecutionStatus = (typeof STATION_EXECUTION_STATUSES)[number];

export const PR_MODES = ["draft", "ready"] as const;

export type PrMode = (typeof PR_MODES)[number];

export const EXECUTION_PHASES = ["implement", "verify"] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export const EXECUTION_OUTCOMES = ["succeeded", "failed", "canceled", "timeout"] as const;

export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

export const MODAL_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "timeout"
] as const;

export type ModalJobStatus = (typeof MODAL_JOB_STATUSES)[number];

export const CODERUNNER_MODES = ["mock", "modal"] as const;

export type CoderunnerMode = (typeof CODERUNNER_MODES)[number];

export interface StationExecutionMetadata extends Record<string, unknown> {
  phase: ExecutionPhase;
  mode: CoderunnerMode;
  attempt: number;
}

export interface StationExecutionResult {
  outcome: ExecutionOutcome;
  summary: string;
  logsInline?: string;
  externalRef?: string;
  metadata?: StationExecutionMetadata;
}

export interface StationExecutionInProgress {
  outcome: null;
  summary: string;
  externalRef: string;
  metadata?: StationExecutionMetadata;
}

export type StationExecutionResponse = StationExecutionResult | StationExecutionInProgress;

export interface ModalSubmitJobInput {
  phase: ExecutionPhase;
  runId: string;
  command: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ModalExecutionHandle {
  externalRef: string;
  status: ModalJobStatus;
  metadata?: Record<string, unknown>;
}

export interface ModalJobStatusResult {
  externalRef: string;
  status: ModalJobStatus;
  metadata?: Record<string, unknown>;
}

export interface ModalJobResult {
  externalRef: string;
  status: ModalJobStatus;
  summary: string;
  logsInline?: string;
  metadata?: Record<string, unknown>;
}

export interface ModalExecutionTransport {
  submitJob(input: ModalSubmitJobInput): Promise<ModalExecutionHandle>;
  getJobStatus(externalRef: string): Promise<ModalJobStatusResult>;
  getJobResult(externalRef: string): Promise<ModalJobResult>;
}

export interface CoderunnerResumeInput {
  externalRef: string;
  metadata?: StationExecutionMetadata | null;
}

export interface CoderunnerTaskInput {
  runId: string;
  issueNumber: number;
  goal: string | null;
  requestor: string;
  prMode: PrMode;
  repo: {
    id: string;
    owner: string;
    name: string;
    baseBranch: string;
    configPath: string;
  };
  resume?: CoderunnerResumeInput;
}

export interface CoderunnerAdapter {
  runImplementTask(input: CoderunnerTaskInput): Promise<StationExecutionResponse>;
  runVerifyTask(input: CoderunnerTaskInput): Promise<StationExecutionResponse>;
}

export interface RunQueueMessage {
  runId: string;
  repoId: string;
  issueNumber: number;
  requestedAt: string;
  prMode: PrMode;
  requestor: string;
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: []
};

const STATION_TRANSITIONS: Readonly<
  Record<StationExecutionStatus, readonly StationExecutionStatus[]>
> = {
  pending: ["running", "skipped"],
  running: ["succeeded", "failed", "skipped"],
  succeeded: [],
  failed: [],
  skipped: []
};

export function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.includes(value as RunStatus);
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.includes(status as TerminalRunStatus);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isStationName(value: string): value is StationName {
  return STATION_NAMES.includes(value as StationName);
}

export function isStationExecutionStatus(value: string): value is StationExecutionStatus {
  return STATION_EXECUTION_STATUSES.includes(value as StationExecutionStatus);
}

export function canTransitionStationStatus(
  from: StationExecutionStatus,
  to: StationExecutionStatus
): boolean {
  return STATION_TRANSITIONS[from].includes(to);
}

export function isPrMode(value: string): value is PrMode {
  return PR_MODES.includes(value as PrMode);
}

export function isExecutionPhase(value: string): value is ExecutionPhase {
  return EXECUTION_PHASES.includes(value as ExecutionPhase);
}

export function isExecutionOutcome(value: string): value is ExecutionOutcome {
  return EXECUTION_OUTCOMES.includes(value as ExecutionOutcome);
}

export function isModalJobStatus(value: string): value is ModalJobStatus {
  return MODAL_JOB_STATUSES.includes(value as ModalJobStatus);
}

export function isCoderunnerMode(value: string): value is CoderunnerMode {
  return CODERUNNER_MODES.includes(value as CoderunnerMode);
}

export function isTerminalModalJobStatus(status: ModalJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function isTerminalStationExecutionResponse(
  value: StationExecutionResponse
): value is StationExecutionResult {
  return value.outcome !== null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isStationExecutionMetadata(value: unknown): value is StationExecutionMetadata {
  if (!isRecord(value)) {
    return false;
  }

  const phase = value.phase;
  const mode = value.mode;
  const attempt = value.attempt;
  return (
    typeof phase === "string" &&
    isExecutionPhase(phase) &&
    typeof mode === "string" &&
    isCoderunnerMode(mode) &&
    typeof attempt === "number" &&
    Number.isInteger(attempt) &&
    attempt >= 1
  );
}

export function parseStationExecutionMetadataJson(
  metadataJson: string | null | undefined
): StationExecutionMetadata | null {
  if (!metadataJson) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return isStationExecutionMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRunQueueMessage(value: unknown): value is RunQueueMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RunQueueMessage>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.repoId === "string" &&
    Number.isInteger(candidate.issueNumber) &&
    typeof candidate.requestedAt === "string" &&
    typeof candidate.requestor === "string" &&
    typeof candidate.prMode === "string" &&
    isPrMode(candidate.prMode)
  );
}
