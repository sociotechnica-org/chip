import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";
const PASSWORD = "e2e-password";
const LOCAL_QUEUE_SECRET = "e2e-local-queue-secret";

const QUEUE_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONTROL_PACKAGE_DIR = fileURLToPath(new URL("../../control-worker", import.meta.url));

interface WorkerHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
}

interface RunPayload {
  id: string;
  repoId: string;
  issueNumber: number;
  status: string;
  currentStation: string | null;
  requestor: string;
  prMode: "draft" | "ready";
  createdAt: string;
  workBranch: string | null;
  prUrl: string | null;
}

interface RunDetailResponse {
  run: RunPayload;
  stations: Array<{
    station: string;
    status: string;
  }>;
  artifacts: Array<{
    type: string;
  }>;
}

class MockGitHubServer {
  private server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private port = 0;
  private readonly branchHeads = new Map<string, string>([["main", "sha_main"]]);
  private readonly markerFiles = new Set<string>();
  private readonly pulls: Array<{ number: number; head: string; base: string; htmlUrl: string }> =
    [];
  private commitCounter = 0;
  private nextPrNumber = 100;

  public failNextPrCreate = false;

  public readonly branchCreateAttempts = new Map<string, number>();
  public readonly prCreateAttempts = new Map<string, number>();

  public async start(port: number): Promise<void> {
    this.port = port;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, HOST, () => resolve());
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public get baseUrl(): string {
    return `http://${HOST}:${this.port}`;
  }

  public getOpenPullCount(branch: string): number {
    return this.pulls.filter((pull) => pull.head === branch).length;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", this.baseUrl);

    if (method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, {
        ok: true
      });
      return;
    }

    const refMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/u);
    if (method === "GET" && refMatch) {
      const branch = decodeURIComponent(refMatch[3]);
      const sha = this.branchHeads.get(branch);
      if (!sha) {
        this.json(response, 404, {
          message: "Reference not found"
        });
        return;
      }

      this.json(response, 200, {
        object: {
          sha
        }
      });
      return;
    }

    const refsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/u);
    if (method === "POST" && refsMatch) {
      const body = (await this.readJsonBody(request)) as {
        ref?: string;
        sha?: string;
      };
      const ref = body.ref ?? "";
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
      this.branchCreateAttempts.set(branch, (this.branchCreateAttempts.get(branch) ?? 0) + 1);

      if (!branch || !body.sha) {
        this.json(response, 422, {
          message: "Invalid ref"
        });
        return;
      }

      if (this.branchHeads.has(branch)) {
        this.json(response, 422, {
          message: "Reference already exists"
        });
        return;
      }

      this.branchHeads.set(branch, body.sha);
      this.json(response, 201, {
        ref,
        object: {
          sha: body.sha
        }
      });
      return;
    }

    const contentsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/u);
    if (method === "PUT" && contentsMatch) {
      const path = decodeURIComponent(contentsMatch[3]);
      const body = (await this.readJsonBody(request)) as {
        branch?: string;
      };
      const branch = body.branch ?? "";
      if (!branch || !this.branchHeads.has(branch)) {
        this.json(response, 404, {
          message: "Branch not found"
        });
        return;
      }

      const markerKey = `${branch}:${path}`;
      if (this.markerFiles.has(markerKey)) {
        this.json(response, 409, {
          message: "Conflict"
        });
        return;
      }

      this.markerFiles.add(markerKey);
      this.commitCounter += 1;
      const commitSha = `sha_commit_${this.commitCounter}`;
      this.branchHeads.set(branch, commitSha);
      this.json(response, 201, {
        commit: {
          sha: commitSha
        }
      });
      return;
    }

    const pullsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/u);
    if (pullsMatch && method === "GET") {
      const base = url.searchParams.get("base") ?? "";
      const head = url.searchParams.get("head") ?? "";
      const branch = head.includes(":") ? head.split(":", 2)[1] : head;
      const matching = this.pulls
        .filter((pull) => pull.base === base && pull.head === branch)
        .map((pull) => ({
          number: pull.number,
          html_url: pull.htmlUrl,
          head: {
            ref: pull.head
          }
        }));

      this.json(response, 200, matching);
      return;
    }

    if (pullsMatch && method === "POST") {
      const body = (await this.readJsonBody(request)) as {
        head?: string;
        base?: string;
      };
      const head = body.head ?? "";
      const base = body.base ?? "";
      this.prCreateAttempts.set(head, (this.prCreateAttempts.get(head) ?? 0) + 1);

      if (this.failNextPrCreate) {
        this.failNextPrCreate = false;
        this.json(response, 503, {
          message: "Temporary GitHub outage"
        });
        return;
      }

      const existing = this.pulls.find((pull) => pull.head === head && pull.base === base);
      if (existing) {
        this.json(response, 422, {
          message: `A pull request already exists for ${head}`
        });
        return;
      }

      const baseSha = this.branchHeads.get(base);
      const headSha = this.branchHeads.get(head);
      if (!baseSha || !headSha || baseSha === headSha) {
        this.json(response, 422, {
          message: "No commits between base and head"
        });
        return;
      }

      const prNumber = this.nextPrNumber;
      this.nextPrNumber += 1;
      const htmlUrl = `https://github.com/sociotechnica-org/lifebuild/pull/${prNumber}`;
      this.pulls.push({
        number: prNumber,
        head,
        base,
        htmlUrl
      });

      this.json(response, 201, {
        number: prNumber,
        html_url: htmlUrl,
        head: {
          ref: head
        }
      });
      return;
    }

    this.json(response, 404, {
      message: `Unhandled route: ${method} ${url.pathname}`
    });
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }
}

let controlWorker: WorkerHandle | null = null;
let queueWorker: WorkerHandle | null = null;
let githubServer: MockGitHubServer | null = null;
let persistPath = "";
let controlPort = 0;
let queuePort = 0;
let githubPort = 0;
let controlInspectorPort = 0;
let queueInspectorPort = 0;

function workerCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function reserveOpenPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();

    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve port")));
        return;
      }

      const reserved = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(reserved);
      });
    });
  });
}

function applyMigrations(path: string): void {
  const result = spawnSync(
    workerCommand(),
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.jsonc",
      "--persist-to",
      path
    ],
    {
      cwd: CONTROL_PACKAGE_DIR,
      encoding: "utf8",
      env: process.env
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed applying migrations.\nstdout:\n${result.stdout || "<empty>"}\nstderr:\n${
        result.stderr || "<empty>"
      }`
    );
  }
}

function startWorker(options: {
  cwd: string;
  port: number;
  inspectorPort: number;
  persistPath: string;
  vars: Record<string, string>;
}): WorkerHandle {
  const args = [
    "dev",
    "--port",
    String(options.port),
    "--ip",
    HOST,
    "--local",
    "--persist-to",
    options.persistPath,
    "--inspector-port",
    String(options.inspectorPort),
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn"
  ];

  for (const [key, value] of Object.entries(options.vars)) {
    args.push("--var", `${key}:${value}`);
  }

  const child = spawn(workerCommand(), args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  const handle: WorkerHandle = {
    child,
    stdout: "",
    stderr: ""
  };

  child.stdout.on("data", (chunk: Buffer) => {
    handle.stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    handle.stderr += chunk.toString();
  });

  return handle;
}

async function stopWorker(handle: WorkerHandle | null): Promise<void> {
  if (!handle || handle.child.killed || handle.child.exitCode !== null) {
    return;
  }

  handle.child.kill("SIGINT");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited && handle.child.exitCode === null) {
    handle.child.kill("SIGKILL");
  }
}

async function waitForHealth(
  baseUrl: string,
  worker: WorkerHandle,
  timeoutMs = 20_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (worker.child.exitCode !== null) {
      throw new Error(
        `Worker exited before ready (${baseUrl}).\nstdout:\n${worker.stdout || "<empty>"}\nstderr:\n${
          worker.stderr || "<empty>"
        }`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Startup race.
    }

    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for ${baseUrl}.\nstdout:\n${worker.stdout || "<empty>"}\nstderr:\n${
      worker.stderr || "<empty>"
    }`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controlBaseUrl(): string {
  return `http://${HOST}:${controlPort}`;
}

function queueBaseUrl(): string {
  return `http://${HOST}:${queuePort}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${PASSWORD}`,
    ...extra
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.trim().length > 0) {
    body = JSON.parse(text);
  }

  return {
    status: response.status,
    body
  };
}

async function ensureRepoRegistered(): Promise<void> {
  const response = await requestJson(controlBaseUrl(), "/v1/repos", {
    method: "POST",
    headers: authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({
      owner: "sociotechnica-org",
      name: "lifebuild"
    })
  });

  expect([201, 409]).toContain(response.status);
}

async function createRun(issueNumber: number, idempotencyKey: string): Promise<RunPayload> {
  const response = await requestJson(controlBaseUrl(), "/v1/runs", {
    method: "POST",
    headers: authHeaders({
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    }),
    body: JSON.stringify({
      repo: {
        owner: "sociotechnica-org",
        name: "lifebuild"
      },
      issue: {
        number: issueNumber
      },
      requestor: "e2e",
      prMode: "draft"
    })
  });

  expect(response.status).toBe(202);
  const body = response.body as {
    run: RunPayload;
  };
  return body.run;
}

async function getRunDetail(runId: string): Promise<RunDetailResponse> {
  const response = await requestJson(controlBaseUrl(), `/v1/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders()
  });
  expect(response.status).toBe(200);
  return response.body as RunDetailResponse;
}

async function waitForRun(
  runId: string,
  predicate: (detail: RunDetailResponse) => boolean,
  timeoutMs = 20_000
): Promise<RunDetailResponse> {
  const startedAt = Date.now();
  let last: RunDetailResponse | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const detail = await getRunDetail(runId);
    last = detail;
    if (predicate(detail)) {
      return detail;
    }

    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for run ${runId}. Last status: ${last?.run.status ?? "unknown"}`
  );
}

function buildQueueMessage(run: RunPayload): Record<string, unknown> {
  return {
    runId: run.id,
    repoId: run.repoId,
    issueNumber: run.issueNumber,
    requestedAt: run.createdAt,
    requestor: run.requestor,
    prMode: run.prMode
  };
}

describe("queue-consumer e2e issue-to-pr", () => {
  beforeAll(async () => {
    controlPort = await reserveOpenPort();
    queuePort = await reserveOpenPort();
    githubPort = await reserveOpenPort();
    controlInspectorPort = await reserveOpenPort();
    queueInspectorPort = await reserveOpenPort();

    persistPath = await mkdtemp(join(tmpdir(), "bob-e2e-"));
    applyMigrations(persistPath);

    githubServer = new MockGitHubServer();
    await githubServer.start(githubPort);

    queueWorker = startWorker({
      cwd: QUEUE_PACKAGE_DIR,
      port: queuePort,
      inspectorPort: queueInspectorPort,
      persistPath,
      vars: {
        LOCAL_QUEUE_SHARED_SECRET: LOCAL_QUEUE_SECRET,
        RUN_RESUME_STALE_MS: "200",
        CODERUNNER_MODE: "mock",
        GITHUB_ADAPTER_MODE: "github",
        GITHUB_TOKEN: "ghp_e2e",
        GITHUB_API_BASE_URL: githubServer.baseUrl
      }
    });

    controlWorker = startWorker({
      cwd: CONTROL_PACKAGE_DIR,
      port: controlPort,
      inspectorPort: controlInspectorPort,
      persistPath,
      vars: {
        BOB_PASSWORD: PASSWORD,
        LOCAL_QUEUE_CONSUMER_URL: queueBaseUrl(),
        LOCAL_QUEUE_SHARED_SECRET: LOCAL_QUEUE_SECRET
      }
    });

    await waitForHealth(queueBaseUrl(), queueWorker);
    await waitForHealth(controlBaseUrl(), controlWorker);
    await ensureRepoRegistered();
  });

  afterAll(async () => {
    await stopWorker(controlWorker);
    await stopWorker(queueWorker);
    await githubServer?.stop();
    if (persistPath) {
      await rm(persistPath, { recursive: true, force: true });
    }
  });

  it("completes issue-to-pr with mocked GitHub", async () => {
    const run = await createRun(501, "e2e-success-501");

    const detail = await waitForRun(run.id, (candidate) => candidate.run.status === "succeeded");
    expect(detail.run.workBranch).toBeTruthy();
    expect(detail.run.prUrl).toMatch(
      /^https:\/\/github\.com\/sociotechnica-org\/lifebuild\/pull\//u
    );

    const stationStatuses = detail.stations.map((station) => station.status);
    expect(stationStatuses).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded"
    ]);

    const artifactTypes = detail.artifacts.map((artifact) => artifact.type);
    expect(artifactTypes).toContain("create_pr_metadata");

    const branch = detail.run.workBranch as string;
    expect((githubServer as MockGitHubServer).branchCreateAttempts.get(branch)).toBe(1);
    expect((githubServer as MockGitHubServer).prCreateAttempts.get(branch)).toBe(1);
    expect((githubServer as MockGitHubServer).getOpenPullCount(branch)).toBe(1);
  });

  it("recovers from partial create_pr success without duplicate pull requests", async () => {
    (githubServer as MockGitHubServer).failNextPrCreate = true;
    const run = await createRun(502, "e2e-partial-502");

    await waitForRun(
      run.id,
      (candidate) =>
        candidate.run.status === "running" &&
        (candidate.run.currentStation === "create_pr" || candidate.run.currentStation === "verify")
    );

    let dispatched = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestJson(queueBaseUrl(), "/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-local-queue-secret": LOCAL_QUEUE_SECRET
        },
        body: JSON.stringify(buildQueueMessage(run))
      });

      if (response.status === 202) {
        dispatched = true;
        break;
      }

      await sleep(250);
    }

    expect(dispatched).toBe(true);

    const detail = await waitForRun(run.id, (candidate) => candidate.run.status === "succeeded");
    const branch = detail.run.workBranch as string;

    expect(
      (githubServer as MockGitHubServer).branchCreateAttempts.get(branch)
    ).toBeGreaterThanOrEqual(2);
    expect((githubServer as MockGitHubServer).prCreateAttempts.get(branch)).toBeGreaterThanOrEqual(
      2
    );
    expect((githubServer as MockGitHubServer).getOpenPullCount(branch)).toBe(1);
    expect(detail.run.prUrl).toMatch(
      /^https:\/\/github\.com\/sociotechnica-org\/lifebuild\/pull\//u
    );
  });
});
