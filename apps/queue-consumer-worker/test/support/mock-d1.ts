export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  config_path: string;
}

export interface RunRow {
  id: string;
  repo_id: string;
  issue_number: number;
  goal: string | null;
  status: string;
  current_station: string | null;
  requestor: string;
  base_branch: string;
  pr_mode: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
}

export interface StationExecutionRow {
  id: string;
  run_id: string;
  station: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
  external_ref: string | null;
  metadata_json: string | null;
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  type: string;
  storage: string;
  payload: string | null;
  created_at: string;
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

  public async first<T = unknown>(): Promise<T | null> {
    return this.db.first(this.sql, this.params) as T | null;
  }
}

export class MockD1Database {
  private readonly repos: RepoRow[] = [];
  private readonly runs: RunRow[] = [];
  private readonly stationExecutions: StationExecutionRow[] = [];
  private readonly artifacts: ArtifactRow[] = [];

  public prepare(sql: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, normalizeSql(sql)) as unknown as D1PreparedStatement;
  }

  public seedRepo(repo: Partial<RepoRow> = {}): RepoRow {
    const seeded: RepoRow = {
      id: repo.id ?? "repo_1",
      owner: repo.owner ?? "sociotechnica-org",
      name: repo.name ?? "lifebuild",
      config_path: repo.config_path ?? ".bob/factory.yaml"
    };

    this.repos.push(seeded);
    return seeded;
  }

  public seedRun(run: Partial<RunRow> & Pick<RunRow, "id">): RunRow {
    const seeded: RunRow = {
      id: run.id,
      repo_id: run.repo_id ?? "repo_1",
      issue_number: run.issue_number ?? 1,
      goal: run.goal ?? null,
      status: run.status ?? "queued",
      current_station: run.current_station ?? null,
      requestor: run.requestor ?? "jess",
      base_branch: run.base_branch ?? "main",
      pr_mode: run.pr_mode ?? "draft",
      started_at: run.started_at ?? null,
      heartbeat_at: run.heartbeat_at ?? null,
      finished_at: run.finished_at ?? null,
      failure_reason: run.failure_reason ?? null
    };

    this.runs.push(seeded);
    return seeded;
  }

  public seedStationExecution(row: StationExecutionRow): void {
    this.stationExecutions.push({ ...row });
  }

  public getRun(runId: string): RunRow | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  public setRunHeartbeat(runId: string, heartbeatAt: string | null): void {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run) {
      run.heartbeat_at = heartbeatAt;
    }
  }

  public getStationExecution(runId: string, station: string): StationExecutionRow | undefined {
    return this.stationExecutions.find(
      (candidate) => candidate.run_id === runId && candidate.station === station
    );
  }

  public listStations(runId: string): StationExecutionRow[] {
    return this.stationExecutions.filter((row) => row.run_id === runId);
  }

  public listArtifacts(runId: string): ArtifactRow[] {
    return this.artifacts.filter((row) => row.run_id === runId);
  }

  public first(sql: string, params: unknown[]): unknown {
    if (
      sql.includes("select id, status, current_station, started_at, heartbeat_at") &&
      sql.includes("from runs") &&
      sql.includes("where id = ?")
    ) {
      const runId = asString(params[0]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return null;
      }

      return {
        id: run.id,
        status: run.status,
        current_station: run.current_station,
        started_at: run.started_at,
        heartbeat_at: run.heartbeat_at
      };
    }

    if (
      sql.includes("from runs") &&
      sql.includes("inner join repos") &&
      sql.includes("repos.owner as repo_owner") &&
      sql.includes("where runs.id = ?")
    ) {
      const runId = asString(params[0]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return null;
      }

      const repo = this.repos.find((candidate) => candidate.id === run.repo_id);
      if (!repo) {
        return null;
      }

      return {
        id: run.id,
        repo_id: run.repo_id,
        issue_number: run.issue_number,
        goal: run.goal,
        requestor: run.requestor,
        base_branch: run.base_branch,
        pr_mode: run.pr_mode,
        status: run.status,
        current_station: run.current_station,
        started_at: run.started_at,
        heartbeat_at: run.heartbeat_at,
        repo_owner: repo.owner,
        repo_name: repo.name,
        config_path: repo.config_path
      };
    }

    if (
      sql.includes("select id, status, started_at, external_ref, metadata_json, summary") &&
      sql.includes("from station_executions") &&
      sql.includes("where id = ?")
    ) {
      const id = asString(params[0]);
      const row = this.stationExecutions.find((candidate) => candidate.id === id);
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        status: row.status,
        started_at: row.started_at,
        external_ref: row.external_ref,
        metadata_json: row.metadata_json,
        summary: row.summary
      };
    }

    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  public run(sql: string, params: unknown[]): number {
    if (
      sql.startsWith("update runs") &&
      sql.includes("set status = ?") &&
      sql.includes("coalesce(started_at")
    ) {
      const runId = asString(params[5]);
      const expectedStatus = asString(params[6]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.status = asString(params[0]);
      run.started_at = run.started_at ?? asString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.heartbeat_at = asNullableString(params[3]);
      run.failure_reason = asNullableString(params[4]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at = ?")
    ) {
      const runId = asString(params[1]);
      const expectedStatus = asString(params[2]);
      const expectedHeartbeatAt = asString(params[3]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus || run.heartbeat_at !== expectedHeartbeatAt) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at is null and started_at = ?")
    ) {
      const runId = asString(params[1]);
      const expectedStatus = asString(params[2]);
      const expectedStartedAt = asString(params[3]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (
        !run ||
        run.status !== expectedStatus ||
        run.heartbeat_at !== null ||
        run.started_at !== expectedStartedAt
      ) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at is null and started_at is null")
    ) {
      const runId = asString(params[1]);
      const expectedStatus = asString(params[2]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (
        !run ||
        run.status !== expectedStatus ||
        run.heartbeat_at !== null ||
        run.started_at !== null
      ) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set current_station = ?") &&
      sql.includes("heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[2]);
      const expectedStatus = asString(params[3]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.current_station = asNullableString(params[0]);
      run.heartbeat_at = asNullableString(params[1]);
      return 1;
    }

    if (
      sql.startsWith("insert into station_executions") &&
      sql.includes("on conflict(id) do update set")
    ) {
      const id = asString(params[0]);
      const existing = this.stationExecutions.find((candidate) => candidate.id === id);
      if (!existing) {
        this.stationExecutions.push({
          id,
          run_id: asString(params[1]),
          station: asString(params[2]),
          status: asString(params[3]),
          started_at: asNullableString(params[4]),
          finished_at: asNullableString(params[5]),
          duration_ms: asNullableNumber(params[6]),
          summary: asNullableString(params[7]),
          external_ref: asNullableString(params[8]),
          metadata_json: asNullableString(params[9])
        });
        return 1;
      }

      existing.status = asString(params[3]);
      existing.started_at = existing.started_at ?? asNullableString(params[4]);
      existing.finished_at = asNullableString(params[5]);
      existing.duration_ms = asNullableNumber(params[6]);
      existing.summary = asNullableString(params[7]);
      existing.external_ref = asNullableString(params[8]) ?? existing.external_ref;
      existing.metadata_json = asNullableString(params[9]) ?? existing.metadata_json;
      return 1;
    }

    if (
      sql.startsWith("update station_executions") &&
      sql.includes("set external_ref = ?") &&
      sql.includes("metadata_json = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const id = asString(params[3]);
      const expectedStatus = asString(params[4]);
      const row = this.stationExecutions.find((candidate) => candidate.id === id);
      if (!row || row.status !== expectedStatus) {
        return 0;
      }

      row.external_ref = asNullableString(params[0]);
      row.metadata_json = asNullableString(params[1]);
      row.summary = asNullableString(params[2]);
      return 1;
    }

    if (
      sql.startsWith("update station_executions") &&
      sql.includes("set status = ?") &&
      sql.includes("duration_ms = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const id = asString(params[6]);
      const expectedStatus = asString(params[7]);
      const row = this.stationExecutions.find((candidate) => candidate.id === id);
      if (!row || row.status !== expectedStatus) {
        return 0;
      }

      row.status = asString(params[0]);
      row.finished_at = asNullableString(params[1]);
      row.duration_ms = asNullableNumber(params[2]);
      row.summary = asNullableString(params[3]);
      row.external_ref = asNullableString(params[4]);
      row.metadata_json = asNullableString(params[5]);
      return 1;
    }

    if (
      sql.startsWith("update station_executions") &&
      sql.includes("set status = ?") &&
      sql.includes("external_ref = coalesce(?, external_ref)") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const id = asString(params[5]);
      const expectedStatus = asString(params[6]);
      const row = this.stationExecutions.find((candidate) => candidate.id === id);
      if (!row || row.status !== expectedStatus) {
        return 0;
      }

      row.status = asString(params[0]);
      row.finished_at = asNullableString(params[1]);
      row.summary = asNullableString(params[2]);
      row.external_ref = asNullableString(params[3]) ?? row.external_ref;
      row.metadata_json = asNullableString(params[4]) ?? row.metadata_json;
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set status = ?") &&
      sql.includes("finished_at = ?") &&
      sql.includes("failure_reason = ?") &&
      sql.includes("heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[5]);
      const expectedStatus = asString(params[6]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.status = asString(params[0]);
      run.finished_at = asNullableString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.failure_reason = asNullableString(params[3]);
      run.heartbeat_at = asNullableString(params[4]);
      return 1;
    }

    if (sql.startsWith("insert into artifacts") && sql.includes("on conflict(id) do update set")) {
      const id = asString(params[0]);
      const existing = this.artifacts.find((artifact) => artifact.id === id);
      if (!existing) {
        this.artifacts.push({
          id,
          run_id: asString(params[1]),
          type: asString(params[2]),
          storage: asString(params[3]),
          payload: asNullableString(params[4]),
          created_at: asString(params[5])
        });
        return 1;
      }

      existing.payload = asNullableString(params[4]);
      existing.created_at = asString(params[5]);
      return 1;
    }

    throw new Error(`Unsupported SQL: ${sql}`);
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

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number") {
    throw new Error(`Expected number but got ${typeof value}`);
  }

  return value;
}
