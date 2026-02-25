import type { RunQueueMessage } from "@bob/core";
import { describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../src/index";

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

interface IdempotencyRow {
  key: string;
  request_hash: string;
  run_id: string;
  status: "pending" | "succeeded" | "failed";
  created_at: string;
  updated_at: string;
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

interface ArtifactRow {
  id: string;
  run_id: string;
  type: string;
  storage: string;
  payload: string | null;
  created_at: string;
}

class MockQueue {
  public messages: RunQueueMessage[] = [];
  public failNextSend = false;
  public holdNextSend = false;
  private heldSendResolver: (() => void) | null = null;
  private heldSendReadyResolver: (() => void) | null = null;

  public async send(message: RunQueueMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("Queue unavailable");
    }

    if (this.holdNextSend) {
      this.holdNextSend = false;
      await new Promise<void>((resolve) => {
        this.heldSendResolver = resolve;
        this.heldSendReadyResolver?.();
        this.heldSendReadyResolver = null;
      });
      this.heldSendResolver = null;
    }

    this.messages.push(message);
  }

  public releaseHeldSend(): void {
    this.heldSendResolver?.();
    this.heldSendResolver = null;
  }

  public async waitUntilSendIsHeld(): Promise<void> {
    if (this.heldSendResolver) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.heldSendReadyResolver = resolve;
    });
  }
}

class MockD1PreparedStatement {
  public constructor(
    private readonly db: MockD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  public bind(...params: unknown[]): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.db, this.sql, params);
  }

  public async first<T = unknown>(): Promise<T | null> {
    return this.db.first(this.sql, this.params) as T | null;
  }

  public async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.db.all(this.sql, this.params) as T[] } as D1Result<T>;
  }

  public async run(): Promise<D1Result<never>> {
    const changes = this.db.run(this.sql, this.params);
    return {
      success: true,
      meta: {
        changes,
        duration: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: changes,
        size_after: 0,
        changed_db: false
      } as D1Result<never>["meta"]
    } as D1Result<never>;
  }
}

class MockD1Database {
  private readonly repos: RepoRow[] = [];
  private readonly runs: RunRow[] = [];
  private readonly idempotencyKeys: IdempotencyRow[] = [];
  private readonly stationExecutions: StationExecutionRow[] = [];
  private readonly artifacts: ArtifactRow[] = [];
  public failNextIdempotencySucceededUpdate = false;
  public failNextIdempotencyFailedUpdate = false;
  public failNextRunQueueFailureMarkerUpdate = false;
  public failNextIdempotencyInsert = false;
  public beforeFailedIdempotencyStatusWrite: ((record: IdempotencyRow) => void) | null = null;

  public prepare(sql: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, normalizeSql(sql)) as unknown as D1PreparedStatement;
  }

  public first(sql: string, params: unknown[]): unknown {
    if (sql.includes("from repos") && sql.includes("where owner = ? and name = ?")) {
      const owner = asString(params[0]);
      const name = asString(params[1]);
      return this.repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
    }

    if (sql.includes("from run_idempotency_keys") && sql.includes("where key = ?")) {
      const key = asString(params[0]);
      return this.idempotencyKeys.find((record) => record.key === key) ?? null;
    }

    if (sql.includes("from runs") && sql.includes("where runs.id = ?")) {
      const runId = asString(params[0]);
      const run = this.runs.find((row) => row.id === runId);
      if (!run) {
        return null;
      }

      return this.withRepo(run);
    }

    if (sql.includes("from artifacts") && sql.includes("where run_id = ? and id = ?")) {
      const runId = asString(params[0]);
      const artifactId = asString(params[1]);
      return this.artifacts.find((artifact) => artifact.run_id === runId && artifact.id === artifactId) ?? null;
    }

    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  public all(sql: string, params: unknown[]): unknown[] {
    if (sql.includes("from repos") && sql.includes("order by owner asc")) {
      return [...this.repos].sort((left, right) => {
        if (left.owner === right.owner) {
          return left.name.localeCompare(right.name);
        }
        return left.owner.localeCompare(right.owner);
      });
    }

    if (sql.includes("from runs") && sql.includes("order by runs.created_at desc")) {
      let statusFilter: string | null = null;
      let ownerFilter: string | null = null;
      let nameFilter: string | null = null;
      let paramIndex = 0;

      if (sql.includes("runs.status = ?")) {
        statusFilter = asString(params[paramIndex]);
        paramIndex += 1;
      }

      if (sql.includes("repos.owner = ? and repos.name = ?")) {
        ownerFilter = asString(params[paramIndex]);
        nameFilter = asString(params[paramIndex + 1]);
        paramIndex += 2;
      }

      const limit = Number(params[paramIndex]);
      const rows = this.runs
        .filter((run) => {
          if (statusFilter && run.status !== statusFilter) {
            return false;
          }
          if (ownerFilter && nameFilter) {
            const repo = this.repos.find((candidate) => candidate.id === run.repo_id);
            if (!repo || repo.owner !== ownerFilter || repo.name !== nameFilter) {
              return false;
            }
          }
          return true;
        })
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((run) => this.withRepo(run));

      return rows;
    }

    if (sql.includes("from station_executions") && sql.includes("where run_id = ?")) {
      const runId = asString(params[0]);
      const stationOrder = new Map<string, number>([
        ["intake", 0],
        ["plan", 1],
        ["implement", 2],
        ["verify", 3],
        ["create_pr", 4]
      ]);
      return [...this.stationExecutions]
        .filter((row) => row.run_id === runId)
        .sort((left, right) => {
          const leftOrder = stationOrder.get(left.station) ?? 99;
          const rightOrder = stationOrder.get(right.station) ?? 99;
          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          const leftStarted = left.started_at ?? "";
          const rightStarted = right.started_at ?? "";
          if (leftStarted !== rightStarted) {
            return leftStarted.localeCompare(rightStarted);
          }

          return left.id.localeCompare(right.id);
        });
    }

    if (sql.includes("from artifacts") && sql.includes("where run_id = ?")) {
      const runId = asString(params[0]);
      return [...this.artifacts]
        .filter((row) => row.run_id === runId)
        .sort((left, right) => {
          if (left.created_at !== right.created_at) {
            return right.created_at.localeCompare(left.created_at);
          }

          return right.id.localeCompare(left.id);
        });
    }

    throw new Error(`Unsupported all SQL: ${sql}`);
  }

  public run(sql: string, params: unknown[]): number {
    if (sql.startsWith("insert into repos")) {
      const owner = asString(params[1]);
      const name = asString(params[2]);
      const existing = this.repos.find((repo) => repo.owner === owner && repo.name === name);
      if (existing) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: repos.owner, repos.name");
      }

      this.repos.push({
        id: asString(params[0]),
        owner,
        name,
        default_branch: asString(params[3]),
        config_path: asString(params[4]),
        enabled: Number(params[5]),
        created_at: asString(params[6]),
        updated_at: asString(params[7])
      });
      return 1;
    }

    if (sql.startsWith("insert into runs")) {
      this.runs.push({
        id: asString(params[0]),
        repo_id: asString(params[1]),
        issue_number: Number(params[2]),
        goal: asNullableString(params[3]),
        status: asString(params[4]),
        current_station: asNullableString(params[5]),
        requestor: asString(params[6]),
        base_branch: asString(params[7]),
        work_branch: asNullableString(params[8]),
        pr_mode: asString(params[9]),
        pr_url: asNullableString(params[10]),
        created_at: asString(params[11]),
        started_at: asNullableString(params[12]),
        finished_at: asNullableString(params[13]),
        failure_reason: asNullableString(params[14])
      });
      return 1;
    }

    if (sql.startsWith("update runs")) {
      if (sql.includes("set failure_reason = ?")) {
        if (this.failNextRunQueueFailureMarkerUpdate) {
          this.failNextRunQueueFailureMarkerUpdate = false;
          throw new Error("D1_ERROR: failed to update run queue failure marker");
        }

        const run = this.runs.find((row) => row.id === asString(params[1]));
        if (!run) {
          return 0;
        }

        run.failure_reason = asNullableString(params[0]);
        return 1;
      }

      if (sql.includes("set status = ?, failure_reason = ?, finished_at = ?")) {
        const run = this.runs.find((row) => row.id === asString(params[3]));
        if (!run) {
          return 0;
        }

        run.status = asString(params[0]);
        run.failure_reason = asNullableString(params[1]);
        run.finished_at = asNullableString(params[2]);
        return 1;
      }

      throw new Error(`Unsupported runs update SQL: ${sql}`);
    }

    if (sql.startsWith("delete from runs where id = ?")) {
      const runId = asString(params[0]);
      const index = this.runs.findIndex((row) => row.id === runId);
      if (index >= 0) {
        this.runs.splice(index, 1);
        return 1;
      }
      return 0;
    }

    if (sql.startsWith("insert into run_idempotency_keys")) {
      if (this.failNextIdempotencyInsert) {
        this.failNextIdempotencyInsert = false;
        throw new Error("D1_ERROR: transient idempotency insert failure");
      }

      const key = asString(params[0]);
      const existing = this.idempotencyKeys.find((record) => record.key === key);
      if (existing) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: run_idempotency_keys.key");
      }

      this.idempotencyKeys.push({
        key,
        request_hash: asString(params[1]),
        run_id: asString(params[2]),
        status: asString(params[3]) as IdempotencyRow["status"],
        created_at: asString(params[4]),
        updated_at: asString(params[5])
      });
      return 1;
    }

    if (sql.startsWith("update run_idempotency_keys")) {
      if (sql.includes("set status = ?, updated_at = ?")) {
        const nextStatus = asString(params[0]) as IdempotencyRow["status"];
        const key = asString(params[2]);
        const record = this.idempotencyKeys.find((candidate) => candidate.key === key);
        if (!record) {
          return 0;
        }

        if (nextStatus === "failed" && this.beforeFailedIdempotencyStatusWrite) {
          const hook = this.beforeFailedIdempotencyStatusWrite;
          this.beforeFailedIdempotencyStatusWrite = null;
          hook(record);
        }

        if (sql.includes("where key = ? and status = ?")) {
          const expectedStatus = asString(params[3]) as IdempotencyRow["status"];
          if (record.status !== expectedStatus) {
            return 0;
          }
        }

        if (nextStatus === "succeeded" && this.failNextIdempotencySucceededUpdate) {
          this.failNextIdempotencySucceededUpdate = false;
          throw new Error("D1_ERROR: failed to update idempotency status");
        }
        if (nextStatus === "failed" && this.failNextIdempotencyFailedUpdate) {
          this.failNextIdempotencyFailedUpdate = false;
          throw new Error("D1_ERROR: failed to update idempotency status");
        }

        record.status = nextStatus;
        record.updated_at = asString(params[1]);
        return 1;
      }

      if (sql.includes("set updated_at = ?")) {
        const key = asString(params[1]);
        const expectedStatus = asString(params[2]) as IdempotencyRow["status"];
        const expectedUpdatedAt = asString(params[3]);
        const record = this.idempotencyKeys.find((candidate) => candidate.key === key);
        if (!record) {
          return 0;
        }

        if (record.status !== expectedStatus || record.updated_at !== expectedUpdatedAt) {
          return 0;
        }

        record.updated_at = asString(params[0]);
        return 1;
      }

      throw new Error(`Unsupported run_idempotency_keys update SQL: ${sql}`);
    }

    throw new Error(`Unsupported run SQL: ${sql}`);
  }

  public rewindIdempotencyUpdatedAt(key: string, offsetMs: number): void {
    const record = this.idempotencyKeys.find((candidate) => candidate.key === key);
    if (!record) {
      throw new Error(`Idempotency record ${key} not found`);
    }

    record.updated_at = new Date(Date.now() - offsetMs).toISOString();
  }

  public seedStationExecution(
    runId: string,
    row: Omit<StationExecutionRow, "run_id"> & { run_id?: string }
  ): void {
    this.stationExecutions.push({
      ...row,
      run_id: row.run_id ?? runId
    });
  }

  public seedArtifact(
    runId: string,
    row: Omit<ArtifactRow, "run_id" | "payload"> & { run_id?: string; payload?: string | null }
  ): void {
    this.artifacts.push({
      ...row,
      run_id: row.run_id ?? runId,
      payload: row.payload ?? null
    });
  }

  private withRepo(run: RunRow): Record<string, unknown> {
    const repo = this.repos.find((candidate) => candidate.id === run.repo_id);
    if (!repo) {
      throw new Error(`Repo ${run.repo_id} not found for run ${run.id}`);
    }

    return {
      ...run,
      repo_owner: repo.owner,
      repo_name: repo.name
    };
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string but got ${typeof value}`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asString(value);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer password123",
    ...extra
  };
}

function createEnv(): { env: Env; db: MockD1Database; queue: MockQueue } {
  const db = new MockD1Database();
  const queue = new MockQueue();

  return {
    env: {
      BOB_PASSWORD: "password123",
      DB: db as unknown as D1Database,
      RUN_QUEUE: queue as unknown as Queue<RunQueueMessage>
    },
    db,
    queue
  };
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createRepo(env: Env): Promise<Response> {
  return handleRequest(
    new Request("https://example.com/v1/repos", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        owner: "sociotechnica-org",
        name: "lifebuild"
      })
    }),
    env
  );
}

describe("control worker", () => {
  it("serves health endpoint without auth", async () => {
    const { env } = createEnv();
    const response = await handleRequest(new Request("https://example.com/healthz"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "control-worker" });
  });

  it("requires auth on v1 routes", async () => {
    const { env } = createEnv();
    const response = await handleRequest(new Request("https://example.com/v1/ping"), env);
    expect(response.status).toBe(401);
  });

  it("does not accept cookie auth on v1 routes", async () => {
    const { env } = createEnv();
    const response = await handleRequest(
      new Request("https://example.com/v1/ping", {
        headers: {
          cookie: "bob_password=password123"
        }
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("returns pong for authorized requests", async () => {
    const { env } = createEnv();
    const response = await handleRequest(
      new Request("https://example.com/v1/ping", {
        headers: authHeaders()
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message: "pong" });
  });

  it("creates and lists repositories", async () => {
    const { env } = createEnv();

    const createResponse = await createRepo(env);
    expect(createResponse.status).toBe(201);

    const listResponse = await handleRequest(
      new Request("https://example.com/v1/repos", {
        headers: authHeaders()
      }),
      env
    );

    expect(listResponse.status).toBe(200);
    const payload = await parseJson(listResponse);
    const repos = payload.repos as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(1);
    expect(repos[0]?.owner).toBe("sociotechnica-org");
    expect(repos[0]?.name).toBe("lifebuild");
  });

  it("rejects duplicate repositories with 409", async () => {
    const { env } = createEnv();

    expect((await createRepo(env)).status).toBe(201);
    const duplicateResponse = await createRepo(env);

    expect(duplicateResponse.status).toBe(409);
  });

  it("requires idempotency key when creating runs", async () => {
    const { env } = createEnv();
    await createRepo(env);

    const response = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 123 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it("creates runs and replays duplicate requests without creating duplicates", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 123 },
      requestor: "jess",
      prMode: "draft"
    });

    const createResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "run-123"
        }),
        body: runBody
      }),
      env
    );
    expect(createResponse.status).toBe(202);

    const createPayload = await parseJson(createResponse);
    const run = createPayload.run as Record<string, unknown>;
    expect(typeof run.id).toBe("string");
    expect(run.status).toBe("queued");
    expect(queue.messages).toHaveLength(1);

    const replayResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "run-123"
        }),
        body: runBody
      }),
      env
    );
    expect(replayResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const listResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        headers: authHeaders()
      }),
      env
    );
    expect(listResponse.status).toBe(200);

    const listPayload = await parseJson(listResponse);
    const runs = listPayload.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(run.id);

    const runResponse = await handleRequest(
      new Request(`https://example.com/v1/runs/${run.id as string}`, {
        headers: authHeaders()
      }),
      env
    );
    expect(runResponse.status).toBe(200);
    const runPayload = await parseJson(runResponse);
    expect(runPayload).toMatchObject({
      run: {
        id: run.id
      },
      stations: [],
      artifacts: []
    });
  });

  it("returns station and artifact summaries on run detail endpoint", async () => {
    const { env, db } = createEnv();
    await createRepo(env);

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 456 },
      requestor: "jess",
      prMode: "draft"
    });

    const createResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "run-details-456"
        }),
        body: runBody
      }),
      env
    );
    expect(createResponse.status).toBe(202);
    const createPayload = await parseJson(createResponse);
    const run = createPayload.run as Record<string, unknown>;
    const runId = run.id as string;

    db.seedStationExecution(runId, {
      id: `station_${runId}_intake`,
      station: "intake",
      status: "succeeded",
      started_at: new Date(Date.now() - 2000).toISOString(),
      finished_at: new Date(Date.now() - 1500).toISOString(),
      duration_ms: 500,
      summary: "intake completed"
    });
    db.seedStationExecution(runId, {
      id: `station_${runId}_plan`,
      station: "plan",
      status: "running",
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: null,
      duration_ms: null,
      summary: null
    });
    db.seedArtifact(runId, {
      id: `artifact_${runId}`,
      type: "workflow_summary",
      storage: "inline",
      created_at: new Date().toISOString()
    });

    const detailResponse = await handleRequest(
      new Request(`https://example.com/v1/runs/${runId}`, {
        headers: authHeaders()
      }),
      env
    );
    expect(detailResponse.status).toBe(200);
    const detailPayload = await parseJson(detailResponse);
    const stations = detailPayload.stations as Array<Record<string, unknown>>;
    const artifacts = detailPayload.artifacts as Array<Record<string, unknown>>;

    expect(stations).toHaveLength(2);
    expect(stations[0]).toMatchObject({
      station: "intake",
      status: "succeeded"
    });
    expect(stations[1]).toMatchObject({
      station: "plan",
      status: "running"
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      type: "workflow_summary",
      storage: "inline"
    });
  });

  it("returns artifact payloads on run artifact detail endpoint", async () => {
    const { env, db } = createEnv();
    await createRepo(env);

    const createRunResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "artifact-detail-1"
        }),
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 789 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );
    expect(createRunResponse.status).toBe(202);
    const createPayload = await parseJson(createRunResponse);
    const run = createPayload.run as Record<string, unknown>;
    const runId = run.id as string;
    const artifactId = `artifact_${runId}_verify_summary`;

    db.seedArtifact(runId, {
      id: artifactId,
      type: "verify_summary",
      storage: "inline",
      payload: JSON.stringify({
        station: "verify",
        summary: "All checks passed"
      }),
      created_at: new Date().toISOString()
    });

    const artifactResponse = await handleRequest(
      new Request(`https://example.com/v1/runs/${runId}/artifacts/${artifactId}`, {
        headers: authHeaders()
      }),
      env
    );
    expect(artifactResponse.status).toBe(200);
    const artifactPayload = await parseJson(artifactResponse);
    expect(artifactPayload).toMatchObject({
      artifact: {
        id: artifactId,
        runId,
        type: "verify_summary",
        storage: "inline",
        payload: {
          station: "verify",
          summary: "All checks passed"
        }
      }
    });

    const missingArtifactResponse = await handleRequest(
      new Request(`https://example.com/v1/runs/${runId}/artifacts/missing`, {
        headers: authHeaders()
      }),
      env
    );
    expect(missingArtifactResponse.status).toBe(404);
  });

  it("cleans up created run when idempotency key claim throws", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    db.failNextIdempotencyInsert = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 130 },
      requestor: "jess",
      prMode: "draft"
    });

    const firstResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "claim-failure-key"
        }),
        body: runBody
      }),
      env
    );

    expect(firstResponse.status).toBe(500);
    expect(queue.messages).toHaveLength(0);

    const secondResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "claim-failure-key"
        }),
        body: runBody
      }),
      env
    );

    expect(secondResponse.status).toBe(202);
    expect(queue.messages).toHaveLength(1);

    const listResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        headers: authHeaders()
      }),
      env
    );

    expect(listResponse.status).toBe(200);
    const listPayload = await parseJson(listResponse);
    const runs = listPayload.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
  });

  it("rejects idempotency key reuse with a different payload", async () => {
    const { env } = createEnv();
    await createRepo(env);

    const baseHeaders = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "run-abc"
    });

    const firstResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 123 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(firstResponse.status).toBe(202);

    const secondResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 124 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(secondResponse.status).toBe(409);
  });

  it("retries queue publish with the same idempotency key after transient queue failure", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 222 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-key"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedRun = failedPayload.run as Record<string, unknown>;
    expect(failedRun.status).toBe("queued");
    expect(failedRun.failureReason).toBe("queue_publish_failed");

    const retryResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-key"
        }),
        body: runBody
      }),
      env
    );

    expect(retryResponse.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    const retryPayload = await parseJson(retryResponse);
    const idempotency = retryPayload.idempotency as Record<string, unknown>;
    expect(idempotency.requeued).toBe(true);
  });

  it("treats local queue bridge dispatch failures as non-blocking after queue send", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);
    env.LOCAL_QUEUE_CONSUMER_URL = "http://127.0.0.1:20288";
    env.LOCAL_QUEUE_SHARED_SECRET = "bridge-secret";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bridge unavailable", { status: 503 }));

    try {
      const runBody = JSON.stringify({
        repo: { owner: "sociotechnica-org", name: "lifebuild" },
        issue: { number: 333 },
        requestor: "jess",
        prMode: "draft"
      });

      const failedResponse = await handleRequest(
        new Request("https://example.com/v1/runs", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json",
            "idempotency-key": "local-bridge-failure"
          }),
          body: runBody
        }),
        env
      );

      expect(failedResponse.status).toBe(202);
      const failedPayload = await parseJson(failedResponse);
      const failedRun = failedPayload.run as Record<string, unknown>;
      const failedIdempotency = failedPayload.idempotency as Record<string, unknown>;
      expect(failedRun.status).toBe("queued");
      expect(failedRun.failureReason).toBeNull();
      expect(failedIdempotency.status).toBe("succeeded");
      expect(queue.messages).toHaveLength(1);

      const replayResponse = await handleRequest(
        new Request("https://example.com/v1/runs", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json",
            "idempotency-key": "local-bridge-failure"
          }),
          body: runBody
        }),
        env
      );

      expect(replayResponse.status).toBe(200);
      expect(queue.messages).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("schedules local queue bridge retries when consumer asks for retry", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);
    env.LOCAL_QUEUE_CONSUMER_URL = "http://127.0.0.1:20288";
    env.LOCAL_QUEUE_SHARED_SECRET = "bridge-secret";
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockExecutionContext = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      }
    } as unknown as ExecutionContext;

    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, outcome: "retry" }), {
          status: 503,
          headers: {
            "content-type": "application/json"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, outcome: "ack" }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        })
      );

    try {
      const runBody = JSON.stringify({
        repo: { owner: "sociotechnica-org", name: "lifebuild" },
        issue: { number: 334 },
        requestor: "jess",
        prMode: "draft"
      });

      const createResponse = await handleRequest(
        new Request("https://example.com/v1/runs", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json",
            "idempotency-key": "local-bridge-retry"
          }),
          body: runBody
        }),
        env,
        mockExecutionContext
      );

      expect(createResponse.status).toBe(202);
      expect(queue.messages).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.allSettled(waitUntilPromises);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries queue publish when failed idempotency update throws after enqueue error", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;
    db.failNextIdempotencyFailedUpdate = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 555 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-pending-failed-write"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedRun = failedPayload.run as Record<string, unknown>;
    const failedIdempotency = failedPayload.idempotency as Record<string, unknown>;
    expect(failedRun.status).toBe("queued");
    expect(failedRun.failureReason).toBe("queue_publish_failed");
    expect(failedIdempotency.status).toBe("pending");

    const retryResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-pending-failed-write"
        }),
        body: runBody
      }),
      env
    );

    expect(retryResponse.status).toBe(202);
    const retryPayload = await parseJson(retryResponse);
    const retryIdempotency = retryPayload.idempotency as Record<string, unknown>;
    expect(retryIdempotency.requeued).toBe(true);
    expect(queue.messages).toHaveLength(1);
  });

  it("retries queue publish when queue-failure marker update throws after enqueue error", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;
    db.failNextRunQueueFailureMarkerUpdate = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 556 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-missing-marker"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedRun = failedPayload.run as Record<string, unknown>;
    const failedIdempotency = failedPayload.idempotency as Record<string, unknown>;
    expect(failedRun.status).toBe("queued");
    expect(failedRun.failureReason).toBeNull();
    expect(failedIdempotency.status).toBe("failed");

    const retryResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-missing-marker"
        }),
        body: runBody
      }),
      env
    );

    expect(retryResponse.status).toBe(202);
    const retryPayload = await parseJson(retryResponse);
    const retryIdempotency = retryPayload.idempotency as Record<string, unknown>;
    expect(retryIdempotency.requeued).toBe(true);
    expect(queue.messages).toHaveLength(1);
  });

  it("does not requeue stale pending idempotency without explicit failure marker", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;
    db.failNextRunQueueFailureMarkerUpdate = true;
    db.failNextIdempotencyFailedUpdate = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 557 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-stale-pending"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedRun = failedPayload.run as Record<string, unknown>;
    const failedIdempotency = failedPayload.idempotency as Record<string, unknown>;
    expect(failedRun.failureReason).toBeNull();
    expect(failedIdempotency.status).toBe("pending");
    expect(queue.messages).toHaveLength(0);

    // Pending-without-marker should not requeue because enqueue outcome is ambiguous.
    const immediateReplay = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-stale-pending"
        }),
        body: runBody
      }),
      env
    );
    expect(immediateReplay.status).toBe(202);
    expect(queue.messages).toHaveLength(0);

    db.rewindIdempotencyUpdatedAt("retry-stale-pending", 31_000);

    const staleReplay = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-stale-pending"
        }),
        body: runBody
      }),
      env
    );

    expect(staleReplay.status).toBe(202);
    expect(queue.messages).toHaveLength(0);
  });

  it("claims requeue atomically so concurrent retries enqueue only once", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 558 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedCreate = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-race"
        }),
        body: runBody
      }),
      env
    );
    expect(failedCreate.status).toBe(503);

    queue.holdNextSend = true;
    const retryOnePromise = handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-race"
        }),
        body: runBody
      }),
      env
    );

    await queue.waitUntilSendIsHeld();

    const retryTwoPromise = handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-race"
        }),
        body: runBody
      }),
      env
    );

    queue.releaseHeldSend();

    const [retryOne, retryTwo] = await Promise.all([retryOnePromise, retryTwoPromise]);
    expect(retryOne.status).toBe(202);
    expect(retryTwo.status).toBeGreaterThanOrEqual(200);
    expect(queue.messages).toHaveLength(1);

    const payloads = await Promise.all([parseJson(retryOne), parseJson(retryTwo)]);
    const requeueCount = payloads.filter((payload) => {
      const idempotency = payload.idempotency as Record<string, unknown>;
      return idempotency.requeued === true;
    }).length;
    expect(requeueCount).toBe(1);
  });

  it("does not mark queue failure when idempotency success update fails after enqueue", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    db.failNextIdempotencySucceededUpdate = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 333 },
      requestor: "jess",
      prMode: "draft"
    });

    const firstResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "pending-key"
        }),
        body: runBody
      }),
      env
    );

    expect(firstResponse.status).toBe(202);
    const firstPayload = await parseJson(firstResponse);
    const firstRun = firstPayload.run as Record<string, unknown>;
    const firstIdempotency = firstPayload.idempotency as Record<string, unknown>;
    expect(firstRun.status).toBe("queued");
    expect(firstRun.failureReason).toBeNull();
    expect(firstIdempotency.status).toBe("pending");
    expect(queue.messages).toHaveLength(1);

    const replayResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "pending-key"
        }),
        body: runBody
      }),
      env
    );

    expect(replayResponse.status).toBe(202);
    const replayPayload = await parseJson(replayResponse);
    const replayIdempotency = replayPayload.idempotency as Record<string, unknown>;
    expect(replayIdempotency.replayed).toBe(true);
    expect(replayIdempotency.status).toBe("pending");
    expect(queue.messages).toHaveLength(1);

    db.rewindIdempotencyUpdatedAt("pending-key", 31_000);
    const staleReplay = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "pending-key"
        }),
        body: runBody
      }),
      env
    );

    expect(staleReplay.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
  });

  it("does not overwrite succeeded idempotency status during enqueue-failure race", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 778 },
      requestor: "jess",
      prMode: "draft"
    });

    // Simulate a concurrent replay that already promoted the key to succeeded.
    db.beforeFailedIdempotencyStatusWrite = (record) => {
      record.status = "succeeded";
      record.updated_at = new Date().toISOString();
    };

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "race-no-overwrite"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedIdempotency = failedPayload.idempotency as Record<string, unknown>;
    expect(failedIdempotency.status).toBe("succeeded");

    const replay = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "race-no-overwrite"
        }),
        body: runBody
      }),
      env
    );

    expect(replay.status).toBe(200);
    const replayPayload = await parseJson(replay);
    const replayIdempotency = replayPayload.idempotency as Record<string, unknown>;
    expect(replayIdempotency.status).toBe("succeeded");
    expect(replayIdempotency.requeued).toBe(false);
    expect(queue.messages).toHaveLength(0);
  });

  it("does not enqueue twice when requeue metadata update fails after successful send", async () => {
    const { env, db, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 444 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-no-dup"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    expect(queue.messages).toHaveLength(0);

    db.failNextIdempotencySucceededUpdate = true;
    const retryResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-no-dup"
        }),
        body: runBody
      }),
      env
    );

    expect(retryResponse.status).toBe(202);
    const retryPayload = await parseJson(retryResponse);
    const retryIdempotency = retryPayload.idempotency as Record<string, unknown>;
    expect(retryIdempotency.requeued).toBe(true);
    expect(retryIdempotency.status).toBe("pending");
    expect(queue.messages).toHaveLength(1);

    const secondRetry = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-no-dup"
        }),
        body: runBody
      }),
      env
    );

    expect(secondRetry.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
  });
});
