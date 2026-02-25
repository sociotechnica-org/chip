import { isPrMode, isRunStatus, type PrMode, type RunQueueMessage } from "@bob/core";
import { requirePassword, type PasswordEnv } from "@bob/security";

const SUPPORTED_OWNER = "sociotechnica-org";
const SUPPORTED_REPO = "lifebuild";
const DEFAULT_CONFIG_PATH = ".bob/factory.yaml";
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const QUEUE_FAILURE_REASON = "queue_publish_failed";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const TEXT_ENCODER = new TextEncoder();
const LOCAL_QUEUE_CONSUME_PATH = "/__queue/consume";
const LOCAL_QUEUE_SECRET_HEADER = "x-bob-local-queue-secret";
const LOCAL_QUEUE_BRIDGE_MAX_RETRIES = 100;
const LOCAL_QUEUE_BRIDGE_DEFAULT_RETRY_DELAY_SECONDS = 30;
const LOCAL_QUEUE_BRIDGE_MAX_RETRY_DELAY_SECONDS = 300;

type IdempotencyStatus = "pending" | "succeeded" | "failed";

export interface Env extends PasswordEnv {
  DB: D1Database;
  RUN_QUEUE: Queue<RunQueueMessage>;
  LOCAL_QUEUE_CONSUMER_URL?: string;
  LOCAL_QUEUE_SHARED_SECRET?: string;
}

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  config_path: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  repo_id: string;
  issue_number: number;
  goal: string | null;
  status: string;
  current_station: string | null;
  requestor: string;
  base_branch: string;
  work_branch: string | null;
  pr_mode: string;
  pr_url: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
}

interface RunWithRepoRow extends RunRow {
  repo_owner: string;
  repo_name: string;
}

interface StationExecutionRow {
  id: string;
  run_id: string;
  station: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
}

interface ArtifactSummaryRow {
  id: string;
  run_id: string;
  type: string;
  storage: string;
  created_at: string;
}

interface ArtifactDetailRow extends ArtifactSummaryRow {
  payload: string | null;
}

interface IdempotencyRow {
  key: string;
  request_hash: string;
  run_id: string;
  status: IdempotencyStatus;
  created_at: string;
  updated_at: string;
}

interface CreateRepoInput {
  owner: string;
  name: string;
  defaultBranch: string;
  configPath: string;
  enabled: boolean;
}

interface CreateRunInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  goal: string | null;
  requestor: string;
  prMode: PrMode;
}

interface ParsedRunRepoIssue {
  owner: string;
  name: string;
  issueNumber: number;
}

type RunActionName = "cancel" | "retry";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function badRequest(message: string): Response {
  return json(400, { error: message });
}

function conflict(message: string): Response {
  return json(409, { error: message });
}

function serverError(message = "Internal server error"): Response {
  return json(500, { error: message });
}

function routeNotFound(): Response {
  return json(404, { error: "Not found" });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOwner(value: string): string {
  return value.trim().toLowerCase();
}

function asSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqlBoolean(value: number): boolean {
  return value === 1;
}

function logEvent(event: string, payload: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event,
      ...payload
    })
  );
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCreateRepoInput(body: unknown): { value?: CreateRepoInput; error?: Response } {
  if (!isObject(body)) {
    return { error: badRequest("Request body must be a JSON object") };
  }

  const owner = body.owner;
  const name = body.name;

  if (!isNonEmptyString(owner) || !isNonEmptyString(name)) {
    return { error: badRequest("owner and name are required") };
  }

  const normalizedOwner = normalizeOwner(owner);
  const normalizedName = normalizeName(name);
  if (normalizedOwner !== SUPPORTED_OWNER || normalizedName !== SUPPORTED_REPO) {
    return { error: badRequest("Only sociotechnica-org/lifebuild is supported in v0") };
  }

  const defaultBranch = isNonEmptyString(body.defaultBranch) ? body.defaultBranch.trim() : "main";
  const configPath = isNonEmptyString(body.configPath)
    ? body.configPath.trim()
    : DEFAULT_CONFIG_PATH;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

  return {
    value: {
      owner: normalizedOwner,
      name: normalizedName,
      defaultBranch,
      configPath,
      enabled
    }
  };
}

function parseCreateRunRepoIssue(body: Record<string, unknown>): {
  value?: ParsedRunRepoIssue;
  error?: Response;
} {
  const repo = body.repo;
  const issue = body.issue;
  if (!isObject(repo) || !isObject(issue)) {
    return { error: badRequest("repo and issue objects are required") };
  }

  const owner = repo.owner;
  const name = repo.name;
  if (!isNonEmptyString(owner) || !isNonEmptyString(name)) {
    return { error: badRequest("repo.owner and repo.name are required") };
  }

  const issueNumber = issue.number;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: badRequest("issue.number must be a positive integer") };
  }

  return {
    value: {
      owner,
      name,
      issueNumber
    }
  };
}

function parseCreateRunGoal(goal: unknown): { value?: string | null; error?: Response } {
  if (goal === undefined) {
    return { value: null };
  }

  if (!isNonEmptyString(goal)) {
    return { error: badRequest("goal must be a non-empty string when provided") };
  }

  return { value: goal.trim() };
}

function parseCreateRunPrMode(prMode: unknown): { value?: PrMode; error?: Response } {
  const prModeValue = isNonEmptyString(prMode) ? prMode : "draft";
  if (!isPrMode(prModeValue)) {
    return { error: badRequest("prMode must be one of: draft, ready") };
  }

  return { value: prModeValue };
}

function validateCreateRunInput(body: unknown): { value?: CreateRunInput; error?: Response } {
  if (!isObject(body)) {
    return { error: badRequest("Request body must be a JSON object") };
  }

  const repoIssue = parseCreateRunRepoIssue(body);
  if (repoIssue.error || !repoIssue.value) {
    return { error: repoIssue.error ?? serverError() };
  }

  if (!isNonEmptyString(body.requestor)) {
    return { error: badRequest("requestor is required") };
  }

  const parsedPrMode = parseCreateRunPrMode(body.prMode);
  if (parsedPrMode.error || !parsedPrMode.value) {
    return { error: parsedPrMode.error ?? serverError() };
  }

  const parsedGoal = parseCreateRunGoal(body.goal);
  if (parsedGoal.error || parsedGoal.value === undefined) {
    return { error: parsedGoal.error ?? serverError() };
  }

  return {
    value: {
      repoOwner: normalizeOwner(repoIssue.value.owner),
      repoName: normalizeName(repoIssue.value.name),
      issueNumber: repoIssue.value.issueNumber,
      goal: parsedGoal.value,
      requestor: body.requestor.trim(),
      prMode: parsedPrMode.value
    }
  };
}

function canonicalRunRequestPayload(input: CreateRunInput): string {
  return JSON.stringify({
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    issueNumber: input.issueNumber,
    goal: input.goal,
    requestor: input.requestor,
    prMode: input.prMode
  });
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseJson(request: Request): Promise<{ value?: unknown; error?: Response }> {
  try {
    return { value: await request.json() };
  } catch {
    return { error: badRequest("Invalid JSON body") };
  }
}

function serializeRepo(row: RepoRow): Record<string, unknown> {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    configPath: row.config_path,
    enabled: fromSqlBoolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeRun(row: RunWithRepoRow): Record<string, unknown> {
  return {
    id: row.id,
    repoId: row.repo_id,
    repo: {
      owner: row.repo_owner,
      name: row.repo_name
    },
    issueNumber: row.issue_number,
    goal: row.goal,
    status: row.status,
    currentStation: row.current_station,
    requestor: row.requestor,
    baseBranch: row.base_branch,
    workBranch: row.work_branch,
    prMode: row.pr_mode,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureReason: row.failure_reason
  };
}

function serializeStationExecution(row: StationExecutionRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    station: row.station,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    summary: row.summary
  };
}

function serializeArtifactSummary(row: ArtifactSummaryRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    storage: row.storage,
    createdAt: row.created_at
  };
}

function parseArtifactPayload(row: ArtifactDetailRow): unknown {
  if (row.storage !== "inline") {
    return null;
  }

  if (row.payload === null) {
    return null;
  }

  try {
    return JSON.parse(row.payload);
  } catch {
    return row.payload;
  }
}

function serializeArtifactDetail(row: ArtifactDetailRow): Record<string, unknown> {
  return {
    ...serializeArtifactSummary(row),
    payload: parseArtifactPayload(row)
  };
}

function parseRunId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)$/);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

interface RunActionPathParams {
  runId: string;
  action: RunActionName;
}

function parseRunActionPath(pathname: string): RunActionPathParams | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/(cancel|retry)$/);
  if (!match) {
    return null;
  }

  try {
    return {
      runId: decodeURIComponent(match[1]),
      action: match[2] as RunActionName
    };
  } catch {
    return null;
  }
}

interface RunArtifactPathParams {
  runId: string;
  artifactId: string;
}

function parseRunArtifactPath(pathname: string): RunArtifactPathParams | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (!match) {
    return null;
  }

  try {
    return {
      runId: decodeURIComponent(match[1]),
      artifactId: decodeURIComponent(match[2])
    };
  } catch {
    return null;
  }
}

function parseLimit(value: string | null): number | null {
  if (!value) {
    return DEFAULT_LIST_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
    return null;
  }

  return parsed;
}

function parseRepoFilter(value: string | null): { owner: string; name: string } | null {
  if (!value) {
    return null;
  }

  const [owner, name, ...rest] = value.split("/");
  if (rest.length > 0 || !owner || !name) {
    return null;
  }

  return {
    owner: normalizeOwner(owner),
    name: normalizeName(name)
  };
}

async function getRepoByOwnerName(env: Env, owner: string, name: string): Promise<RepoRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, owner, name, default_branch, config_path, enabled, created_at, updated_at
     FROM repos
     WHERE owner = ? AND name = ?
     LIMIT 1`
    )
      .bind(owner, name)
      .first<RepoRow>()) ?? null
  );
}

async function createRepo(env: Env, input: CreateRepoInput): Promise<RepoRow> {
  const id = `repo_${crypto.randomUUID()}`;
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner, name, default_branch, config_path, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.owner,
      input.name,
      input.defaultBranch,
      input.configPath,
      asSqlBoolean(input.enabled),
      timestamp,
      timestamp
    )
    .run();

  const created = await getRepoByOwnerName(env, input.owner, input.name);
  if (!created) {
    throw new Error("Failed to load repo after insert");
  }

  return created;
}

async function listRepos(env: Env): Promise<RepoRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, owner, name, default_branch, config_path, enabled, created_at, updated_at
     FROM repos
     ORDER BY owner ASC, name ASC`
  ).all<RepoRow>();

  return result.results ?? [];
}

async function getRunById(env: Env, runId: string): Promise<RunWithRepoRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT
      runs.id,
      runs.repo_id,
      runs.issue_number,
      runs.goal,
      runs.status,
      runs.current_station,
      runs.requestor,
      runs.base_branch,
      runs.work_branch,
      runs.pr_mode,
      runs.pr_url,
      runs.created_at,
      runs.started_at,
      runs.finished_at,
      runs.failure_reason,
      repos.owner AS repo_owner,
      repos.name AS repo_name
     FROM runs
     INNER JOIN repos ON repos.id = runs.repo_id
     WHERE runs.id = ?
     LIMIT 1`
    )
      .bind(runId)
      .first<RunWithRepoRow>()) ?? null
  );
}

async function cancelRunById(env: Env, runId: string): Promise<boolean> {
  const canceledAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE runs
     SET
      status = CASE WHEN status IN ('queued', 'running') THEN 'canceled' ELSE status END,
      current_station = CASE WHEN status IN ('queued', 'running') THEN NULL ELSE current_station END,
      finished_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE finished_at END,
      failure_reason = CASE WHEN status IN ('queued', 'running') THEN NULL ELSE failure_reason END
     WHERE id = ?`
  )
    .bind(canceledAt, runId)
    .run();

  return getAffectedRowCount(result) > 0;
}

async function createRetryRunFromRun(
  env: Env,
  sourceRun: RunWithRepoRow
): Promise<RunWithRepoRow | null> {
  const runId = `run_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO runs (
      id,
      repo_id,
      issue_number,
      goal,
      status,
      current_station,
      requestor,
      base_branch,
      work_branch,
      pr_mode,
      pr_url,
      created_at,
      started_at,
      finished_at,
      failure_reason
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      runId,
      sourceRun.repo_id,
      sourceRun.issue_number,
      sourceRun.goal,
      "queued",
      null,
      sourceRun.requestor,
      sourceRun.base_branch,
      null,
      sourceRun.pr_mode,
      null,
      createdAt,
      null,
      null,
      null
    )
    .run();

  return getRunById(env, runId);
}

interface ListRunsFilters {
  status: string | null;
  repo: { owner: string; name: string } | null;
  limit: number;
}

async function listRuns(env: Env, filters: ListRunsFilters): Promise<RunWithRepoRow[]> {
  const whereClauses: string[] = [];
  const binds: Array<string | number> = [];

  if (filters.status) {
    whereClauses.push("runs.status = ?");
    binds.push(filters.status);
  }

  if (filters.repo) {
    whereClauses.push("repos.owner = ? AND repos.name = ?");
    binds.push(filters.repo.owner, filters.repo.name);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const query = `SELECT
    runs.id,
    runs.repo_id,
    runs.issue_number,
    runs.goal,
    runs.status,
    runs.current_station,
    runs.requestor,
    runs.base_branch,
    runs.work_branch,
    runs.pr_mode,
    runs.pr_url,
    runs.created_at,
    runs.started_at,
    runs.finished_at,
    runs.failure_reason,
    repos.owner AS repo_owner,
    repos.name AS repo_name
   FROM runs
   INNER JOIN repos ON repos.id = runs.repo_id
   ${whereSql}
   ORDER BY runs.created_at DESC
   LIMIT ?`;
  binds.push(filters.limit);

  const statement = env.DB.prepare(query).bind(...binds);
  const result = await statement.all<RunWithRepoRow>();
  return result.results ?? [];
}

async function listStationExecutionsByRunId(
  env: Env,
  runId: string
): Promise<StationExecutionRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, run_id, station, status, started_at, finished_at, duration_ms, summary
     FROM station_executions
     WHERE run_id = ?
     ORDER BY
      CASE station
        WHEN 'intake' THEN 0
        WHEN 'plan' THEN 1
        WHEN 'implement' THEN 2
        WHEN 'verify' THEN 3
        WHEN 'create_pr' THEN 4
        ELSE 5
      END ASC,
      started_at ASC,
      id ASC`
  )
    .bind(runId)
    .all<StationExecutionRow>();

  return result.results ?? [];
}

async function listArtifactSummariesByRunId(
  env: Env,
  runId: string
): Promise<ArtifactSummaryRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, run_id, type, storage, created_at
     FROM artifacts
     WHERE run_id = ?
     ORDER BY created_at DESC, id DESC`
  )
    .bind(runId)
    .all<ArtifactSummaryRow>();

  return result.results ?? [];
}

async function getArtifactByRunId(env: Env, runId: string, artifactId: string): Promise<ArtifactDetailRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, run_id, type, storage, payload, created_at
       FROM artifacts
       WHERE run_id = ? AND id = ?
       LIMIT 1`
    )
      .bind(runId, artifactId)
      .first<ArtifactDetailRow>()) ?? null
  );
}

async function setRunQueueFailureMarker(env: Env, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs
     SET failure_reason = ?
     WHERE id = ?`
  )
    .bind(QUEUE_FAILURE_REASON, runId)
    .run();
}

async function clearRunQueueFailureMarker(env: Env, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs
     SET failure_reason = ?
     WHERE id = ?`
  )
    .bind(null, runId)
    .run();
}

async function deleteRun(env: Env, runId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(runId).run();
}

async function getIdempotencyRow(env: Env, key: string): Promise<IdempotencyRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT key, request_hash, run_id, status, created_at, updated_at
     FROM run_idempotency_keys
     WHERE key = ?
     LIMIT 1`
    )
      .bind(key)
      .first<IdempotencyRow>()) ?? null
  );
}

async function claimIdempotencyKey(
  env: Env,
  key: string,
  requestHash: string,
  runId: string
): Promise<boolean> {
  try {
    const timestamp = nowIso();
    await env.DB.prepare(
      `INSERT INTO run_idempotency_keys (key, request_hash, run_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(key, requestHash, runId, "pending", timestamp, timestamp)
      .run();
    return true;
  } catch (error) {
    if (isConstraintError(error)) {
      return false;
    }
    throw error;
  }
}

async function setIdempotencyStatus(
  env: Env,
  key: string,
  status: IdempotencyStatus
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE run_idempotency_keys
     SET status = ?, updated_at = ?
     WHERE key = ? AND status = ?`
  )
    .bind(status, nowIso(), key, "pending")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function setRunQueueFailureMarkerSafely(
  env: Env,
  runId: string,
  idempotencyKey: string,
  event: string
): Promise<void> {
  try {
    await setRunQueueFailureMarker(env, runId);
  } catch (error) {
    logEvent(event, {
      runId,
      idempotencyKey,
      error: errorMessage(error)
    });
  }
}

async function clearRunQueueFailureMarkerSafely(
  env: Env,
  runId: string,
  idempotencyKey: string,
  event: string
): Promise<void> {
  try {
    await clearRunQueueFailureMarker(env, runId);
  } catch (error) {
    logEvent(event, {
      runId,
      idempotencyKey,
      error: errorMessage(error)
    });
  }
}

async function setIdempotencyStatusSafely(
  env: Env,
  key: string,
  nextStatus: IdempotencyStatus,
  runId: string,
  event: string
): Promise<boolean> {
  try {
    return await setIdempotencyStatus(env, key, nextStatus);
  } catch (error) {
    logEvent(event, {
      runId,
      idempotencyKey: key,
      error: errorMessage(error)
    });
    return false;
  }
}

async function loadIdempotencyStatus(
  env: Env,
  key: string,
  fallback: IdempotencyStatus
): Promise<IdempotencyStatus> {
  const latest = await getIdempotencyRow(env, key);
  return latest?.status ?? fallback;
}

interface EnqueueFailureResponseInput {
  env: Env;
  run: RunWithRepoRow;
  idempotencyKey: string;
  replayed: boolean;
  enqueueError: unknown;
  markerFailureEvent: string;
  idempotencyFailureEvent: string;
  enqueueFailureEvent: string;
}

async function buildEnqueueFailureResponse(input: EnqueueFailureResponseInput): Promise<Response> {
  await setRunQueueFailureMarkerSafely(
    input.env,
    input.run.id,
    input.idempotencyKey,
    input.markerFailureEvent
  );

  const idempotencyUpdated = await setIdempotencyStatusSafely(
    input.env,
    input.idempotencyKey,
    "failed",
    input.run.id,
    input.idempotencyFailureEvent
  );
  const idempotencyStatus = idempotencyUpdated
    ? ("failed" as const)
    : await loadIdempotencyStatus(input.env, input.idempotencyKey, "pending");

  logEvent(input.enqueueFailureEvent, {
    runId: input.run.id,
    idempotencyKey: input.idempotencyKey,
    error: errorMessage(input.enqueueError)
  });

  const failedRun = await getRunById(input.env, input.run.id);
  return json(503, {
    error: "Failed to enqueue run",
    run: serializeRun(failedRun ?? input.run),
    idempotency: serializeIdempotency(input.idempotencyKey, input.replayed, idempotencyStatus)
  });
}

function getAffectedRowCount(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

async function claimRequeueRetry(env: Env, idempotency: IdempotencyRow): Promise<boolean> {
  const claimedAt = nowIso();

  if (idempotency.status === "failed") {
    const result = await env.DB.prepare(
      `UPDATE run_idempotency_keys
       SET status = ?, updated_at = ?
       WHERE key = ? AND status = ?`
    )
      .bind("pending", claimedAt, idempotency.key, "failed")
      .run();

    return getAffectedRowCount(result) === 1;
  }

  if (idempotency.status === "pending") {
    const result = await env.DB.prepare(
      `UPDATE run_idempotency_keys
       SET updated_at = ?
       WHERE key = ? AND status = ? AND updated_at = ?`
    )
      .bind(claimedAt, idempotency.key, "pending", idempotency.updated_at)
      .run();

    return getAffectedRowCount(result) === 1;
  }

  return false;
}

function buildQueueMessage(run: RunWithRepoRow): RunQueueMessage {
  return {
    runId: run.id,
    repoId: run.repo_id,
    issueNumber: run.issue_number,
    requestedAt: run.created_at,
    prMode: run.pr_mode as PrMode,
    requestor: run.requestor
  };
}

async function dispatchLocalQueueMessageBestEffort(
  env: Env,
  run: RunWithRepoRow,
  message: RunQueueMessage,
  ctx: ExecutionContext | undefined,
  attempt = 1
): Promise<void> {
  const rawConsumerUrl = env.LOCAL_QUEUE_CONSUMER_URL;
  if (!isNonEmptyString(rawConsumerUrl)) {
    return;
  }

  const consumerUrl = rawConsumerUrl.trim().replace(/\/+$/, "");
  const endpoint = `${consumerUrl}${LOCAL_QUEUE_CONSUME_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (isNonEmptyString(env.LOCAL_QUEUE_SHARED_SECRET)) {
    headers[LOCAL_QUEUE_SECRET_HEADER] = env.LOCAL_QUEUE_SHARED_SECRET.trim();
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message)
    });
  } catch (error) {
    logEvent("run.local_queue_bridge.error", {
      runId: run.id,
      endpoint,
      attempt,
      error: errorMessage(error)
    });
    return;
  }

  const body = (await response.text()).slice(0, 500);
  if (!response.ok) {
    const retry = parseLocalQueueRetryResponse(body);
    if (retry) {
      if (attempt >= LOCAL_QUEUE_BRIDGE_MAX_RETRIES) {
        logEvent("run.local_queue_bridge.retry_exhausted", {
          runId: run.id,
          endpoint,
          attempts: attempt
        });
        return;
      }
      if (!ctx) {
        logEvent("run.local_queue_bridge.retry_dropped_no_context", {
          runId: run.id,
          endpoint,
          attempt
        });
        return;
      }

      const nextAttempt = attempt + 1;
      const delaySeconds = retry.delaySeconds;
      logEvent("run.local_queue_bridge.retry_scheduled", {
        runId: run.id,
        endpoint,
        attempt,
        nextAttempt,
        delaySeconds
      });

      ctx.waitUntil(
        (async () => {
          await sleep(delaySeconds * 1_000);
          await dispatchLocalQueueMessageBestEffort(env, run, message, ctx, nextAttempt);
        })()
      );
      return;
    }

    logEvent("run.local_queue_bridge.failed", {
      runId: run.id,
      endpoint,
      attempt,
      status: response.status,
      body
    });
    return;
  }

  logEvent("run.local_queue_bridge.dispatched", {
    runId: run.id,
    endpoint,
    attempt
  });
}

function parseLocalQueueRetryResponse(body: string): { delaySeconds: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (!isObject(parsed) || parsed.outcome !== "retry") {
    return null;
  }

  const rawDelay = parsed.delaySeconds;
  if (typeof rawDelay === "number" && Number.isFinite(rawDelay)) {
    const rounded = Math.floor(rawDelay);
    if (rounded >= 1) {
      return {
        delaySeconds: Math.min(rounded, LOCAL_QUEUE_BRIDGE_MAX_RETRY_DELAY_SECONDS)
      };
    }
  }

  return {
    delaySeconds: LOCAL_QUEUE_BRIDGE_DEFAULT_RETRY_DELAY_SECONDS
  };
}

async function enqueueRun(env: Env, run: RunWithRepoRow, ctx?: ExecutionContext): Promise<void> {
  const message = buildQueueMessage(run);
  // The durable queue is the source of truth; local bridge is best-effort for local dev wiring.
  await env.RUN_QUEUE.send(message);
  await dispatchLocalQueueMessageBestEffort(env, run, message, ctx);
}

function serializeIdempotency(
  key: string,
  replayed: boolean,
  status: IdempotencyStatus,
  requeued = false
): Record<string, unknown> {
  return {
    key,
    replayed,
    status,
    requeued
  };
}

function shouldRetryQueuePublish(existingKey: IdempotencyRow, run: RunWithRepoRow): boolean {
  if (run.status !== "queued") {
    return false;
  }

  if (run.failure_reason === QUEUE_FAILURE_REASON) {
    return existingKey.status === "failed" || existingKey.status === "pending";
  }

  // Avoid duplicate queue messages: pending without explicit failure marker is ambiguous.
  return existingKey.status === "failed";
}

async function buildReplayStateResponse(env: Env, key: string, runId: string): Promise<Response> {
  const latestKey = await getIdempotencyRow(env, key);
  const latestRun = await getRunById(env, runId);
  if (!latestKey || !latestRun) {
    return serverError("Failed to reload run after requeue claim conflict");
  }

  const statusCode = latestKey.status === "succeeded" ? 200 : 202;
  return json(statusCode, {
    run: serializeRun(latestRun),
    idempotency: serializeIdempotency(key, true, latestKey.status)
  });
}

async function deleteRunOrServerError(
  env: Env,
  runId: string,
  idempotencyKey: string,
  event: string,
  message: string
): Promise<Response | null> {
  try {
    await deleteRun(env, runId);
    return null;
  } catch (error) {
    logEvent(event, {
      runId,
      idempotencyKey,
      error: errorMessage(error)
    });
    return serverError(message);
  }
}

async function replayExistingRun(
  env: Env,
  key: string,
  requestHash: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const existingKey = await getIdempotencyRow(env, key);
  if (!existingKey) {
    return serverError("Failed to load idempotency record");
  }

  if (existingKey.request_hash !== requestHash) {
    return conflict("Idempotency key already used with different payload");
  }

  const run = await getRunById(env, existingKey.run_id);
  if (!run) {
    return serverError("Failed to load run for idempotency key");
  }

  if (shouldRetryQueuePublish(existingKey, run)) {
    let claimed = false;
    try {
      claimed = await claimRequeueRetry(env, existingKey);
    } catch (error) {
      logEvent("run.idempotency.requeue_claim.failed", {
        runId: run.id,
        idempotencyKey: key,
        error: errorMessage(error)
      });
      return serverError("Failed to claim idempotency key before requeue");
    }

    if (!claimed) {
      return buildReplayStateResponse(env, key, run.id);
    }

    try {
      await enqueueRun(env, run, ctx);
    } catch (error) {
      return buildEnqueueFailureResponse({
        env,
        run,
        idempotencyKey: key,
        replayed: true,
        enqueueError: error,
        markerFailureEvent: "run.queue_failure_marker.failed.after_requeue_enqueue_error",
        idempotencyFailureEvent: "run.idempotency.failed.failed.after_requeue",
        enqueueFailureEvent: "run.enqueue.failed.retry"
      });
    }

    const idempotencySucceeded = await setIdempotencyStatusSafely(
      env,
      key,
      "succeeded",
      run.id,
      "run.idempotency.succeeded.failed.after_requeue"
    );
    const idempotencyStatus = idempotencySucceeded
      ? ("succeeded" as const)
      : await loadIdempotencyStatus(env, key, "pending");

    await clearRunQueueFailureMarkerSafely(
      env,
      run.id,
      key,
      "run.clear_queue_failure_marker.failed.after_requeue"
    );

    const refreshedRun = await getRunById(env, run.id);
    if (!refreshedRun) {
      return serverError("Failed to reload run after requeue");
    }

    return json(202, {
      run: serializeRun(refreshedRun),
      idempotency: serializeIdempotency(key, true, idempotencyStatus, true)
    });
  }

  const statusCode = existingKey.status === "succeeded" ? 200 : 202;
  return json(statusCode, {
    run: serializeRun(run),
    idempotency: serializeIdempotency(key, true, existingKey.status)
  });
}

async function handleCreateRepo(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJson(request);
  if (parsed.error) {
    return parsed.error;
  }

  const validation = validateCreateRepoInput(parsed.value);
  if (validation.error || !validation.value) {
    return validation.error ?? serverError();
  }

  try {
    const repo = await createRepo(env, validation.value);
    return json(201, { repo: serializeRepo(repo) });
  } catch (error) {
    if (isConstraintError(error)) {
      return conflict("Repository already exists");
    }

    logEvent("repo.create.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to create repository");
  }
}

async function handleListRepos(env: Env): Promise<Response> {
  try {
    const repos = await listRepos(env);
    return json(200, { repos: repos.map(serializeRepo) });
  } catch (error) {
    logEvent("repo.list.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to list repositories");
  }
}

function readIdempotencyKey(request: Request): { value?: string; error?: Response } {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return { error: badRequest("Idempotency-Key header is required") };
  }

  return { value: idempotencyKey };
}

async function parseCreateRunRequest(
  request: Request
): Promise<{ value?: CreateRunInput; error?: Response }> {
  const parsed = await parseJson(request);
  if (parsed.error) {
    return { error: parsed.error };
  }

  const validation = validateCreateRunInput(parsed.value);
  if (validation.error || !validation.value) {
    return { error: validation.error ?? serverError() };
  }

  return { value: validation.value };
}

async function resolveEnabledRepo(
  env: Env,
  input: CreateRunInput
): Promise<{ value?: RepoRow; error?: Response }> {
  const repo = await getRepoByOwnerName(env, input.repoOwner, input.repoName);
  if (!repo) {
    return { error: badRequest("Repository not found") };
  }

  if (!fromSqlBoolean(repo.enabled)) {
    return { error: badRequest("Repository is disabled") };
  }

  return { value: repo };
}

async function createQueuedRun(
  env: Env,
  repo: RepoRow,
  input: CreateRunInput,
  idempotencyKey: string
): Promise<{ value?: RunWithRepoRow; error?: Response }> {
  const runId = `run_${crypto.randomUUID()}`;
  try {
    const timestamp = nowIso();
    await env.DB.prepare(
      `INSERT INTO runs (
        id,
        repo_id,
        issue_number,
        goal,
        status,
        current_station,
        requestor,
        base_branch,
        work_branch,
        pr_mode,
        pr_url,
        created_at,
        started_at,
        finished_at,
        failure_reason
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        runId,
        repo.id,
        input.issueNumber,
        input.goal,
        "queued",
        null,
        input.requestor,
        repo.default_branch,
        null,
        input.prMode,
        null,
        timestamp,
        null,
        null,
        null
      )
      .run();

    const createdRun = await getRunById(env, runId);
    if (!createdRun) {
      throw new Error("Failed to load run after insert");
    }

    return { value: createdRun };
  } catch (error) {
    logEvent("run.create.failed", {
      error: error instanceof Error ? error.message : String(error),
      idempotencyKey
    });
    return { error: serverError("Failed to create run") };
  }
}

interface CreateRunPreconditions {
  idempotencyKey: string;
  input: CreateRunInput;
  requestHash: string;
  repo: RepoRow;
}

async function resolveCreateRunPreconditions(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<{ value?: CreateRunPreconditions; response?: Response }> {
  const parsedIdempotencyKey = readIdempotencyKey(request);
  if (parsedIdempotencyKey.error || !parsedIdempotencyKey.value) {
    return { response: parsedIdempotencyKey.error ?? serverError() };
  }

  const createRunInput = await parseCreateRunRequest(request);
  if (createRunInput.error || !createRunInput.value) {
    return { response: createRunInput.error ?? serverError() };
  }

  const idempotencyKey = parsedIdempotencyKey.value;
  const input = createRunInput.value;
  const requestHash = await sha256Hex(canonicalRunRequestPayload(input));

  if (await getIdempotencyRow(env, idempotencyKey)) {
    return {
      response: await replayExistingRun(env, idempotencyKey, requestHash, ctx)
    };
  }

  const repoResolution = await resolveEnabledRepo(env, input);
  if (repoResolution.error || !repoResolution.value) {
    return { response: repoResolution.error ?? serverError() };
  }

  return {
    value: {
      idempotencyKey,
      input,
      requestHash,
      repo: repoResolution.value
    }
  };
}

async function finalizeCreateRunResponse(
  env: Env,
  run: RunWithRepoRow,
  idempotencyKey: string
): Promise<Response> {
  const idempotencySucceeded = await setIdempotencyStatusSafely(
    env,
    idempotencyKey,
    "succeeded",
    run.id,
    "run.idempotency.succeeded.failed.after_enqueue"
  );
  const idempotencyStatus = idempotencySucceeded
    ? ("succeeded" as const)
    : await loadIdempotencyStatus(env, idempotencyKey, "pending");

  return json(202, {
    run: serializeRun(run),
    idempotency: serializeIdempotency(idempotencyKey, false, idempotencyStatus)
  });
}

async function claimNewIdempotencyOrResolveConflict(input: {
  env: Env;
  run: RunWithRepoRow;
  idempotencyKey: string;
  requestHash: string;
  ctx?: ExecutionContext;
}): Promise<{ proceed: boolean; response?: Response }> {
  let claimed = false;
  try {
    claimed = await claimIdempotencyKey(
      input.env,
      input.idempotencyKey,
      input.requestHash,
      input.run.id
    );
  } catch (error) {
    logEvent("run.idempotency.claim.failed", {
      runId: input.run.id,
      idempotencyKey: input.idempotencyKey,
      error: errorMessage(error)
    });

    const cleanupError = await deleteRunOrServerError(
      input.env,
      input.run.id,
      input.idempotencyKey,
      "run.delete.failed.after_idempotency_claim_error",
      "Failed to clean up run after idempotency claim failure"
    );
    if (cleanupError) {
      return {
        proceed: false,
        response: cleanupError
      };
    }

    return {
      proceed: false,
      response: serverError("Failed to claim idempotency key")
    };
  }

  if (claimed) {
    return { proceed: true };
  }

  const cleanupError = await deleteRunOrServerError(
    input.env,
    input.run.id,
    input.idempotencyKey,
    "run.delete.failed.after_idempotency_conflict",
    "Failed to clean up run after idempotency conflict"
  );
  if (cleanupError) {
    return {
      proceed: false,
      response: cleanupError
    };
  }

  return {
    proceed: false,
    response: await replayExistingRun(input.env, input.idempotencyKey, input.requestHash, input.ctx)
  };
}

async function handleCreateRun(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const preconditions = await resolveCreateRunPreconditions(request, env, ctx);
  if (preconditions.response || !preconditions.value) {
    return preconditions.response ?? serverError();
  }

  const { idempotencyKey, input, requestHash, repo } = preconditions.value;
  const createdRun = await createQueuedRun(env, repo, input, idempotencyKey);
  if (createdRun.error || !createdRun.value) {
    return createdRun.error ?? serverError();
  }

  const run = createdRun.value;
  const claimResult = await claimNewIdempotencyOrResolveConflict({
    env,
    run,
    idempotencyKey,
    requestHash,
    ctx
  });
  if (!claimResult.proceed) {
    return claimResult.response ?? serverError();
  }

  try {
    await enqueueRun(env, run, ctx);
  } catch (error) {
    return buildEnqueueFailureResponse({
      env,
      run,
      idempotencyKey,
      replayed: false,
      enqueueError: error,
      markerFailureEvent: "run.queue_failure_marker.failed.after_enqueue_error",
      idempotencyFailureEvent: "run.idempotency.failed.failed.after_enqueue_error",
      enqueueFailureEvent: "run.enqueue.failed"
    });
  }

  return finalizeCreateRunResponse(env, run, idempotencyKey);
}

async function handleListRuns(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get("status");
  if (status && !isRunStatus(status)) {
    return badRequest("Invalid status filter");
  }

  const repoFilter = parseRepoFilter(url.searchParams.get("repo"));
  if (url.searchParams.has("repo") && !repoFilter) {
    return badRequest("repo filter must be in owner/name format");
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  if (!limit) {
    return badRequest(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }

  try {
    const runs = await listRuns(env, {
      status,
      repo: repoFilter,
      limit
    });
    return json(200, { runs: runs.map(serializeRun) });
  } catch (error) {
    logEvent("run.list.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to list runs");
  }
}

async function handleGetRun(runId: string, env: Env): Promise<Response> {
  try {
    const run = await getRunById(env, runId);
    if (!run) {
      return routeNotFound();
    }

    const [stations, artifacts] = await Promise.all([
      listStationExecutionsByRunId(env, runId),
      listArtifactSummariesByRunId(env, runId)
    ]);

    return json(200, {
      run: serializeRun(run),
      stations: stations.map(serializeStationExecution),
      artifacts: artifacts.map(serializeArtifactSummary)
    });
  } catch (error) {
    logEvent("run.get.failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to load run");
  }
}

async function handleGetRunArtifact(runId: string, artifactId: string, env: Env): Promise<Response> {
  try {
    const artifact = await getArtifactByRunId(env, runId, artifactId);
    if (!artifact) {
      return routeNotFound();
    }

    return json(200, {
      artifact: serializeArtifactDetail(artifact)
    });
  } catch (error) {
    logEvent("run.artifact.get.failed", {
      runId,
      artifactId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to load run artifact");
  }
}

async function handleCancelRun(runId: string, env: Env): Promise<Response> {
  try {
    const canceled = await cancelRunById(env, runId);
    if (!canceled) {
      return routeNotFound();
    }

    const run = await getRunById(env, runId);
    if (!run) {
      return routeNotFound();
    }

    return json(200, {
      run: serializeRun(run)
    });
  } catch (error) {
    logEvent("run.cancel.failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to cancel run");
  }
}

async function handleRetryRun(runId: string, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    const sourceRun = await getRunById(env, runId);
    if (!sourceRun) {
      return routeNotFound();
    }

    if (sourceRun.status !== "failed" && sourceRun.status !== "canceled") {
      return badRequest("Only failed or canceled runs can be retried");
    }

    const retryRun = await createRetryRunFromRun(env, sourceRun);
    if (!retryRun) {
      return serverError("Failed to load retry run after insert");
    }

    try {
      await enqueueRun(env, retryRun, ctx);
    } catch (error) {
      await setRunQueueFailureMarkerSafely(
        env,
        retryRun.id,
        "retry",
        "run.retry.queue_failure_marker.failed.after_enqueue_error"
      );
      logEvent("run.retry.enqueue.failed", {
        sourceRunId: runId,
        retryRunId: retryRun.id,
        error: errorMessage(error)
      });

      const failedRetryRun = await getRunById(env, retryRun.id);
      return json(503, {
        error: "Failed to enqueue retry run",
        retriedFromRunId: runId,
        run: serializeRun(failedRetryRun ?? retryRun)
      });
    }

    return json(202, {
      run: serializeRun(retryRun),
      retriedFromRunId: runId
    });
  } catch (error) {
    logEvent("run.retry.failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError("Failed to retry run");
  }
}

function routePublicRequest(method: string, pathname: string): Response | null {
  if (method === "GET" && pathname === "/healthz") {
    return json(200, {
      ok: true,
      service: "control-worker"
    });
  }

  return null;
}

async function routeV1Request(
  method: string,
  url: URL,
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response | null> {
  const key = `${method} ${url.pathname}`;
  if (key === "GET /v1/ping") {
    return json(200, {
      ok: true,
      message: "pong"
    });
  }

  if (key === "POST /v1/repos") {
    return handleCreateRepo(request, env);
  }

  if (key === "GET /v1/repos") {
    return handleListRepos(env);
  }

  if (key === "POST /v1/runs") {
    return handleCreateRun(request, env, ctx);
  }

  if (key === "GET /v1/runs") {
    return handleListRuns(url, env);
  }

  if (method === "POST") {
    const runActionPath = parseRunActionPath(url.pathname);
    if (runActionPath?.action === "cancel") {
      return handleCancelRun(runActionPath.runId, env);
    }
    if (runActionPath?.action === "retry") {
      return handleRetryRun(runActionPath.runId, env, ctx);
    }
  }

  if (method === "GET") {
    const artifactPath = parseRunArtifactPath(url.pathname);
    if (artifactPath) {
      return handleGetRunArtifact(artifactPath.runId, artifactPath.artifactId, env);
    }
  }

  if (method !== "GET") {
    return null;
  }

  const runId = parseRunId(url.pathname);
  if (!runId) {
    return null;
  }

  return handleGetRun(runId, env);
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  logEvent("request.received", {
    method,
    path: url.pathname
  });

  const publicResponse = routePublicRequest(method, url.pathname);
  if (publicResponse) {
    return publicResponse;
  }

  if (!url.pathname.startsWith("/v1/")) {
    return routeNotFound();
  }

  const unauthorized = requirePassword(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  const routed = await routeV1Request(method, url, request, env, ctx);
  if (routed) {
    return routed;
  }

  return routeNotFound();
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handleRequest(request, env, ctx)
} satisfies ExportedHandler<Env>;
