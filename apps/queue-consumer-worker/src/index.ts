import {
  createCoderunnerAdapterFromEnv,
  isRetryableCoderunnerError,
  type CoderunnerEnv
} from "@bob/adapters-coderunner";
import {
  STATION_NAMES,
  isPrMode,
  isRunQueueMessage,
  isRunStatus,
  isTerminalRunStatus,
  isTerminalStationExecutionResponse,
  parseStationExecutionMetadataJson,
  type CoderunnerAdapter,
  type CoderunnerTaskInput,
  type RunQueueMessage,
  type RunStatus,
  type StationExecutionMetadata,
  type StationExecutionResult,
  type StationName
} from "@bob/core";

export interface Env extends CoderunnerEnv {
  DB: D1Database;
  LOCAL_QUEUE_SHARED_SECRET?: string;
  __TEST_CODERUNNER_ADAPTER__?: CoderunnerAdapter;
}

interface RunExecutionRow {
  id: string;
  status: string;
  current_station: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
}

interface RunContextRow {
  id: string;
  repo_id: string;
  issue_number: number;
  goal: string | null;
  requestor: string;
  base_branch: string;
  pr_mode: string;
  status: string;
  current_station: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  repo_owner: string;
  repo_name: string;
  config_path: string;
}

interface StationExecutionRow {
  id: string;
  status: string;
  started_at: string | null;
  external_ref: string | null;
  metadata_json: string | null;
  summary: string | null;
}

const RUN_RESUME_STALE_MS = 30_000;
const RUN_HEARTBEAT_INTERVAL_MS = 5_000;
const LOCAL_QUEUE_CONSUME_PATH = "/__queue/consume";
const LOCAL_QUEUE_SECRET_HEADER = "x-bob-local-queue-secret";
const RUNNER_LOG_EXCERPT_LIMIT = 4_000;
const STATION_SUMMARY_LIMIT = 500;

class RetryableStationExecutionError extends Error {
  public readonly station: StationName;

  public constructor(station: StationName, message: string) {
    super(message);
    this.name = "RetryableStationExecutionError";
    this.station = station;
  }
}

class StationTerminalFailureError extends Error {
  public readonly station: StationName;

  public constructor(station: StationName, message: string) {
    super(message);
    this.name = "StationTerminalFailureError";
    this.station = station;
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAffectedRowCount(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

function logEvent(event: string, payload: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event,
      ...payload
    })
  );
}

function truncateSummary(summary: string): string {
  if (summary.length <= STATION_SUMMARY_LIMIT) {
    return summary;
  }

  return `${summary.slice(0, STATION_SUMMARY_LIMIT - 18)}... [truncated]`;
}

function asStationName(value: string | null): StationName | null {
  if (!value) {
    return null;
  }

  return STATION_NAMES.find((station) => station === value) ?? null;
}

function parseRunStatus(status: string): RunStatus | null {
  return isRunStatus(status) ? status : null;
}

function shouldResumeRunningRun(run: RunExecutionRow): boolean {
  if (run.status !== "running") {
    return false;
  }

  const lastHeartbeat = run.heartbeat_at ?? run.started_at;
  if (!lastHeartbeat) {
    return true;
  }

  const heartbeatAt = Date.parse(lastHeartbeat);
  if (Number.isNaN(heartbeatAt)) {
    return true;
  }

  return Date.now() - heartbeatAt >= RUN_RESUME_STALE_MS;
}

function stationExecutionId(runId: string, station: StationName): string {
  return `station_${runId}_${station}`;
}

function toCoderunnerTaskInput(
  run: RunContextRow,
  resume: { externalRef: string; metadataJson: string | null } | null
): CoderunnerTaskInput {
  const prMode = isPrMode(run.pr_mode) ? run.pr_mode : "draft";
  const resumeMetadata = parseStationExecutionMetadataJson(resume?.metadataJson ?? null);

  return {
    runId: run.id,
    issueNumber: run.issue_number,
    goal: run.goal,
    requestor: run.requestor,
    prMode,
    repo: {
      id: run.repo_id,
      owner: run.repo_owner,
      name: run.repo_name,
      baseBranch: run.base_branch,
      configPath: run.config_path
    },
    resume: resume
      ? {
          externalRef: resume.externalRef,
          metadata: resumeMetadata
        }
      : undefined
  };
}

function serializeMetadata(metadata: StationExecutionMetadata | undefined): string | null {
  if (!metadata) {
    return null;
  }

  return JSON.stringify(metadata);
}

function getCoderunnerAdapter(env: Env): CoderunnerAdapter {
  return env.__TEST_CODERUNNER_ADAPTER__ ?? createCoderunnerAdapterFromEnv(env);
}

function getResumeStationIndex(run: RunExecutionRow, currentStationStatus: string | null): number {
  const currentStation = asStationName(run.current_station);
  if (!currentStation) {
    return 0;
  }

  const currentIndex = STATION_NAMES.indexOf(currentStation);
  if (currentIndex < 0) {
    return 0;
  }

  if (currentStationStatus === "succeeded") {
    return Math.min(currentIndex + 1, STATION_NAMES.length);
  }

  return currentIndex;
}

function startRunHeartbeatLoop(env: Env, runId: string, station: StationName): () => void {
  const timer = setInterval(() => {
    void updateRunCurrentStation(env, runId, station).catch((error) => {
      logEvent("run.heartbeat.error", {
        runId,
        station,
        error: errorMessage(error)
      });
    });
  }, RUN_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

function parseStationStartAtMs(stationExecution: StationExecutionRow | null): number {
  if (!stationExecution?.started_at) {
    return Date.now();
  }

  const parsed = Date.parse(stationExecution.started_at);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function buildLogsExcerpt(logsInline: string): {
  excerpt: string;
  truncated: boolean;
  originalLength: number;
} {
  if (logsInline.length <= RUNNER_LOG_EXCERPT_LIMIT) {
    return {
      excerpt: logsInline,
      truncated: false,
      originalLength: logsInline.length
    };
  }

  return {
    excerpt: `${logsInline.slice(0, RUNNER_LOG_EXCERPT_LIMIT)}\n[truncated to ${RUNNER_LOG_EXCERPT_LIMIT} chars]`,
    truncated: true,
    originalLength: logsInline.length
  };
}

async function claimQueuedRun(env: Env, runId: string): Promise<boolean> {
  const claimedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, started_at = COALESCE(started_at, ?), current_station = ?, heartbeat_at = ?, failure_reason = ?
     WHERE id = ? AND status = ?`
  )
    .bind("running", claimedAt, STATION_NAMES[0], claimedAt, null, runId, "queued")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function claimStaleRunningRun(env: Env, run: RunExecutionRow): Promise<boolean> {
  const resumedAt = nowIso();

  if (run.heartbeat_at) {
    const result = await env.DB.prepare(
      `UPDATE runs
       SET heartbeat_at = ?
       WHERE id = ? AND status = ? AND heartbeat_at = ?`
    )
      .bind(resumedAt, run.id, "running", run.heartbeat_at)
      .run();
    return getAffectedRowCount(result) === 1;
  }

  if (run.started_at) {
    const result = await env.DB.prepare(
      `UPDATE runs
       SET heartbeat_at = ?
       WHERE id = ? AND status = ? AND heartbeat_at IS NULL AND started_at = ?`
    )
      .bind(resumedAt, run.id, "running", run.started_at)
      .run();
    return getAffectedRowCount(result) === 1;
  }

  const result = await env.DB.prepare(
    `UPDATE runs
     SET heartbeat_at = ?
     WHERE id = ? AND status = ? AND heartbeat_at IS NULL AND started_at IS NULL`
  )
    .bind(resumedAt, run.id, "running")
    .run();
  return getAffectedRowCount(result) === 1;
}

async function getRunForExecution(env: Env, runId: string): Promise<RunExecutionRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, status, current_station, started_at, heartbeat_at
       FROM runs
       WHERE id = ?
       LIMIT 1`
    )
      .bind(runId)
      .first<RunExecutionRow>()) ?? null
  );
}

async function getRunContextForExecution(env: Env, runId: string): Promise<RunContextRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT
        runs.id,
        runs.repo_id,
        runs.issue_number,
        runs.goal,
        runs.requestor,
        runs.base_branch,
        runs.pr_mode,
        runs.status,
        runs.current_station,
        runs.started_at,
        runs.heartbeat_at,
        repos.owner AS repo_owner,
        repos.name AS repo_name,
        repos.config_path
       FROM runs
       INNER JOIN repos ON repos.id = runs.repo_id
       WHERE runs.id = ?
       LIMIT 1`
    )
      .bind(runId)
      .first<RunContextRow>()) ?? null
  );
}

async function getStationExecution(
  env: Env,
  runId: string,
  station: StationName
): Promise<StationExecutionRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, status, started_at, external_ref, metadata_json, summary
       FROM station_executions
       WHERE id = ?
       LIMIT 1`
    )
      .bind(stationExecutionId(runId, station))
      .first<StationExecutionRow>()) ?? null
  );
}

async function getStationExecutionStatus(
  env: Env,
  runId: string,
  station: StationName
): Promise<string | null> {
  const row = await getStationExecution(env, runId, station);
  return row?.status ?? null;
}

async function updateRunCurrentStation(
  env: Env,
  runId: string,
  station: StationName
): Promise<void> {
  const heartbeatAt = nowIso();
  await env.DB.prepare(
    `UPDATE runs
     SET current_station = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind(station, heartbeatAt, runId, "running")
    .run();
}

async function markStationRunning(
  env: Env,
  runId: string,
  station: StationName,
  startedAt: string,
  externalRef: string | null,
  metadataJson: string | null
): Promise<void> {
  const id = stationExecutionId(runId, station);
  await env.DB.prepare(
    `INSERT INTO station_executions (
      id,
      run_id,
      station,
      status,
      started_at,
      finished_at,
      duration_ms,
      summary,
      external_ref,
      metadata_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      started_at = COALESCE(station_executions.started_at, excluded.started_at),
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      summary = excluded.summary,
      external_ref = COALESCE(excluded.external_ref, station_executions.external_ref),
      metadata_json = COALESCE(excluded.metadata_json, station_executions.metadata_json)`
  )
    .bind(id, runId, station, "running", startedAt, null, null, null, externalRef, metadataJson)
    .run();
}

async function persistStationExternalState(
  env: Env,
  runId: string,
  station: StationName,
  externalRef: string,
  metadata: StationExecutionMetadata | undefined,
  summary: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE station_executions
     SET external_ref = ?, metadata_json = ?, summary = ?
     WHERE id = ? AND status = ?`
  )
    .bind(
      externalRef,
      serializeMetadata(metadata),
      truncateSummary(summary),
      stationExecutionId(runId, station),
      "running"
    )
    .run();
}

async function markStationSucceeded(
  env: Env,
  runId: string,
  station: StationName,
  startedAtMs: number,
  summary: string,
  externalRef: string | null,
  metadataJson: string | null
): Promise<void> {
  const finishedAt = nowIso();
  const durationMs = Math.max(1, Date.now() - startedAtMs);
  await env.DB.prepare(
    `UPDATE station_executions
     SET status = ?, finished_at = ?, duration_ms = ?, summary = ?, external_ref = ?, metadata_json = ?
     WHERE id = ? AND status = ?`
  )
    .bind(
      "succeeded",
      finishedAt,
      durationMs,
      truncateSummary(summary),
      externalRef,
      metadataJson,
      stationExecutionId(runId, station),
      "running"
    )
    .run();
}

async function markStationFailed(
  env: Env,
  runId: string,
  station: StationName,
  reason: string,
  externalRef: string | null,
  metadataJson: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE station_executions
     SET status = ?, finished_at = ?, summary = ?, external_ref = COALESCE(?, external_ref), metadata_json = COALESCE(?, metadata_json)
     WHERE id = ? AND status = ?`
  )
    .bind(
      "failed",
      nowIso(),
      truncateSummary(reason),
      externalRef,
      metadataJson,
      stationExecutionId(runId, station),
      "running"
    )
    .run();
}

async function markRunSucceeded(env: Env, runId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind("succeeded", nowIso(), null, null, nowIso(), runId, "running")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function markRunFailed(
  env: Env,
  runId: string,
  station: StationName,
  reason: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind("failed", nowIso(), station, truncateSummary(reason), nowIso(), runId, "running")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function upsertArtifact(
  env: Env,
  runId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const artifactId = `artifact_${runId}_${type}`;
  await env.DB.prepare(
    `INSERT INTO artifacts (id, run_id, type, storage, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      created_at = excluded.created_at`
  )
    .bind(artifactId, runId, type, "inline", JSON.stringify(payload), nowIso())
    .run();
}

async function persistLightweightStationArtifact(
  env: Env,
  run: RunContextRow,
  station: Extract<StationName, "intake" | "plan" | "create_pr">,
  result: StationExecutionResult
): Promise<void> {
  const type = `${station}_summary`;
  await upsertArtifact(env, run.id, type, {
    station,
    outcome: result.outcome,
    summary: result.summary,
    repo: `${run.repo_owner}/${run.repo_name}`,
    issueNumber: run.issue_number
  });
}

async function persistExecutionArtifacts(
  env: Env,
  runId: string,
  station: Extract<StationName, "implement" | "verify">,
  result: StationExecutionResult
): Promise<void> {
  const summaryType = `${station}_summary`;
  await upsertArtifact(env, runId, summaryType, {
    station,
    outcome: result.outcome,
    summary: result.summary,
    externalRef: result.externalRef ?? null,
    metadata: result.metadata ?? null
  });

  if (result.logsInline && result.logsInline.length > 0) {
    const excerpt = buildLogsExcerpt(result.logsInline);
    await upsertArtifact(env, runId, `${station}_runner_logs_excerpt`, {
      station,
      excerpt: excerpt.excerpt,
      truncated: excerpt.truncated,
      originalLength: excerpt.originalLength,
      note: excerpt.truncated ? "Log output truncated for inline artifact storage" : null
    });
  }
}

async function executeImplementStation(
  run: RunContextRow,
  stationExecution: StationExecutionRow | null,
  adapter: CoderunnerAdapter
) {
  const resume = stationExecution?.external_ref
    ? {
        externalRef: stationExecution.external_ref,
        metadataJson: stationExecution.metadata_json
      }
    : null;

  return adapter.runImplementTask(toCoderunnerTaskInput(run, resume));
}

async function executeVerifyStation(
  run: RunContextRow,
  stationExecution: StationExecutionRow | null,
  adapter: CoderunnerAdapter
) {
  const resume = stationExecution?.external_ref
    ? {
        externalRef: stationExecution.external_ref,
        metadataJson: stationExecution.metadata_json
      }
    : null;

  return adapter.runVerifyTask(toCoderunnerTaskInput(run, resume));
}

function executeSkeletonStation(
  run: RunContextRow,
  station: Extract<StationName, "intake" | "plan" | "create_pr">
): StationExecutionResult {
  if (station === "intake") {
    return {
      outcome: "succeeded",
      summary: `Intake captured ${run.repo_owner}/${run.repo_name}#${run.issue_number}`
    };
  }

  if (station === "plan") {
    return {
      outcome: "succeeded",
      summary: run.goal
        ? `Plan prepared for goal: ${run.goal}`
        : `Plan prepared for issue #${run.issue_number}`
    };
  }

  return {
    outcome: "succeeded",
    summary: "create_pr placeholder remains until PR5"
  };
}

async function executeStation(
  env: Env,
  run: RunContextRow,
  station: StationName,
  adapter: CoderunnerAdapter
): Promise<void> {
  const existingStationExecution = await getStationExecution(env, run.id, station);
  if (existingStationExecution?.status === "succeeded") {
    logEvent("station.skip.already_succeeded", {
      runId: run.id,
      station
    });
    return;
  }

  const startedAt = existingStationExecution?.started_at ?? nowIso();
  const startedAtMs = parseStationStartAtMs(existingStationExecution);
  await updateRunCurrentStation(env, run.id, station);
  await markStationRunning(
    env,
    run.id,
    station,
    startedAt,
    existingStationExecution?.external_ref ?? null,
    existingStationExecution?.metadata_json ?? null
  );

  logEvent("station.started", {
    runId: run.id,
    station,
    resumed: existingStationExecution !== null
  });

  const stopHeartbeatLoop = startRunHeartbeatLoop(env, run.id, station);
  try {
    const executionResult =
      station === "implement"
        ? await executeImplementStation(run, existingStationExecution, adapter)
        : station === "verify"
          ? await executeVerifyStation(run, existingStationExecution, adapter)
          : executeSkeletonStation(run, station);

    if (!isTerminalStationExecutionResponse(executionResult)) {
      await persistStationExternalState(
        env,
        run.id,
        station,
        executionResult.externalRef,
        executionResult.metadata,
        executionResult.summary
      );
      throw new RetryableStationExecutionError(
        station,
        `${station} execution still running; external_ref=${executionResult.externalRef}`
      );
    }

    const metadataJson = serializeMetadata(executionResult.metadata);
    const externalRef = executionResult.externalRef ?? null;
    if (executionResult.outcome === "succeeded") {
      await markStationSucceeded(
        env,
        run.id,
        station,
        startedAtMs,
        executionResult.summary,
        externalRef,
        metadataJson
      );
    } else {
      await markStationFailed(
        env,
        run.id,
        station,
        `${station} ${executionResult.outcome}: ${executionResult.summary}`,
        externalRef,
        metadataJson
      );
    }

    if (station === "implement" || station === "verify") {
      await persistExecutionArtifacts(env, run.id, station, executionResult);
    } else {
      await persistLightweightStationArtifact(env, run, station, executionResult);
    }

    if (executionResult.outcome !== "succeeded") {
      throw new StationTerminalFailureError(
        station,
        `${station} ${executionResult.outcome}: ${executionResult.summary}`
      );
    }

    logEvent("station.succeeded", {
      runId: run.id,
      station,
      externalRef
    });
  } catch (error) {
    if (
      error instanceof RetryableStationExecutionError ||
      error instanceof StationTerminalFailureError
    ) {
      throw error;
    }

    if (isRetryableCoderunnerError(error)) {
      throw new RetryableStationExecutionError(
        station,
        `Retryable station error at ${station}: ${errorMessage(error)}`
      );
    }

    const stationError = `Station ${station} execution error: ${errorMessage(error)}`;
    try {
      await markStationFailed(
        env,
        run.id,
        station,
        stationError,
        existingStationExecution?.external_ref ?? null,
        existingStationExecution?.metadata_json ?? null
      );
    } catch (markError) {
      logEvent("station.failed.mark_error", {
        runId: run.id,
        station,
        error: errorMessage(markError)
      });
    }

    throw new StationTerminalFailureError(station, stationError);
  } finally {
    stopHeartbeatLoop();
  }
}

async function runWorkflowSkeleton(env: Env, runId: string, startStationIndex = 0): Promise<void> {
  const run = await getRunContextForExecution(env, runId);
  if (!run) {
    throw new Error(`Run context missing for ${runId}`);
  }

  const coderunnerAdapter = getCoderunnerAdapter(env);
  const normalizedStart = Math.max(0, Math.min(startStationIndex, STATION_NAMES.length));

  for (const station of STATION_NAMES.slice(normalizedStart)) {
    await executeStation(env, run, station, coderunnerAdapter);
  }

  const markedSucceeded = await markRunSucceeded(env, runId);
  if (!markedSucceeded) {
    logEvent("run.succeeded.noop", {
      runId
    });
    return;
  }

  logEvent("run.succeeded", { runId });
}

async function handleTerminalRunFailure(
  env: Env,
  runId: string,
  station: StationName,
  reason: string,
  message: Message<unknown>
): Promise<void> {
  let markedFailed = false;
  try {
    markedFailed = await markRunFailed(env, runId, station, reason);
  } catch (error) {
    logEvent("run.failed.mark_error", {
      runId,
      station,
      error: errorMessage(error)
    });
  }

  if (markedFailed) {
    message.ack();
    return;
  }

  const latestRun = await getRunForExecution(env, runId);
  const latestStatus = latestRun ? parseRunStatus(latestRun.status) : null;
  if (!latestRun || (latestStatus && isTerminalRunStatus(latestStatus))) {
    message.ack();
    return;
  }

  message.retry();
}

async function processQueueMessage(env: Env, message: Message<unknown>): Promise<void> {
  if (!isRunQueueMessage(message.body)) {
    logEvent("queue.message.invalid", {
      messageId: message.id
    });
    message.ack();
    return;
  }

  const payload: RunQueueMessage = message.body;
  const run = await getRunForExecution(env, payload.runId);
  if (!run) {
    logEvent("run.missing", { runId: payload.runId, messageId: message.id });
    message.ack();
    return;
  }

  const runStatus = parseRunStatus(run.status);
  if (!runStatus) {
    logEvent("run.skip.invalid_status", {
      runId: payload.runId,
      messageId: message.id,
      status: run.status
    });
    message.ack();
    return;
  }

  if (isTerminalRunStatus(runStatus)) {
    logEvent("run.skip.terminal", {
      runId: payload.runId,
      messageId: message.id,
      status: runStatus
    });
    message.ack();
    return;
  }

  let startStationIndex = 0;
  if (runStatus === "queued") {
    const claimed = await claimQueuedRun(env, payload.runId);
    if (!claimed) {
      const latestRun = await getRunForExecution(env, payload.runId);
      const latestStatus = latestRun ? parseRunStatus(latestRun.status) : null;
      if (latestStatus && isTerminalRunStatus(latestStatus)) {
        logEvent("run.claim.contended.terminal", {
          runId: payload.runId,
          messageId: message.id,
          status: latestStatus
        });
        message.ack();
        return;
      }

      logEvent("run.claim.contended.retry", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    logEvent("run.claimed", { runId: payload.runId, messageId: message.id });
  } else if (runStatus === "running") {
    if (!shouldResumeRunningRun(run)) {
      logEvent("run.defer.running", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    const claimedResume = await claimStaleRunningRun(env, run);
    if (!claimedResume) {
      logEvent("run.resume.claim_contended", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    logEvent("run.resume.stale_running", {
      runId: payload.runId,
      messageId: message.id
    });

    const currentStation = asStationName(run.current_station);
    if (currentStation) {
      const currentStationStatus = await getStationExecutionStatus(
        env,
        payload.runId,
        currentStation
      );
      startStationIndex = getResumeStationIndex(run, currentStationStatus);
    }
  } else {
    logEvent("run.skip.unexpected_status", {
      runId: payload.runId,
      messageId: message.id,
      status: runStatus
    });
    message.ack();
    return;
  }

  try {
    await runWorkflowSkeleton(env, run.id, startStationIndex);
    message.ack();
  } catch (error) {
    if (error instanceof RetryableStationExecutionError) {
      logEvent("run.retry.station_in_progress", {
        runId: payload.runId,
        station: error.station,
        reason: error.message
      });
      message.retry();
      return;
    }

    if (error instanceof StationTerminalFailureError) {
      logEvent("run.failed.station_terminal", {
        runId: payload.runId,
        station: error.station,
        reason: error.message
      });
      await handleTerminalRunFailure(env, payload.runId, error.station, error.message, message);
      return;
    }

    const reason = `Workflow execution error: ${errorMessage(error)}`;
    const latestRun = await getRunForExecution(env, payload.runId);
    const failureStation = asStationName(latestRun?.current_station ?? null) ?? STATION_NAMES[0];

    logEvent("run.failed.unexpected", {
      runId: payload.runId,
      station: failureStation,
      reason
    });

    await handleTerminalRunFailure(env, payload.runId, failureStation, reason, message);
  }
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  logEvent("queue.batch.received", {
    size: batch.messages.length
  });

  for (const message of batch.messages) {
    await processQueueMessage(env, message);
  }
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "POST" && url.pathname === LOCAL_QUEUE_CONSUME_PATH) {
    const localQueueSecret = env.LOCAL_QUEUE_SHARED_SECRET?.trim();
    if (!localQueueSecret) {
      logEvent("local_queue.consume.secret_missing");
      return json(503, { error: "Local queue consume endpoint is disabled" });
    }

    const providedSecret = request.headers.get(LOCAL_QUEUE_SECRET_HEADER);
    if (providedSecret !== localQueueSecret) {
      return json(401, { error: "Unauthorized local queue dispatch" });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON" });
    }

    let wasAcked = false;
    let shouldRetry = false;
    const syntheticMessage = {
      id: `local_${crypto.randomUUID()}`,
      body,
      ack() {
        wasAcked = true;
      },
      retry() {
        shouldRetry = true;
      }
    } satisfies Pick<Message<unknown>, "id" | "body" | "ack" | "retry">;

    await processQueueMessage(env, syntheticMessage as unknown as Message<unknown>);
    if (shouldRetry) {
      return json(503, { ok: false, outcome: "retry" });
    }

    return json(202, { ok: true, outcome: wasAcked ? "ack" : "none" });
  }

  if (method === "GET" && url.pathname === "/healthz") {
    return json(200, {
      ok: true,
      service: "queue-consumer-worker"
    });
  }

  return json(404, { error: "Not found" });
}

export default {
  fetch: handleFetch,
  queue: handleQueue
} satisfies ExportedHandler<Env>;
