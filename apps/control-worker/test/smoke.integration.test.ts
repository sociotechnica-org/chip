import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REQUESTED_PORT = process.env.BOB_SMOKE_PORT ? Number(process.env.BOB_SMOKE_PORT) : undefined;
const REQUESTED_INSPECTOR_PORT = process.env.BOB_SMOKE_INSPECTOR_PORT
  ? Number(process.env.BOB_SMOKE_INSPECTOR_PORT)
  : undefined;
const HOST = "127.0.0.1";
const PASSWORD = process.env.BOB_PASSWORD ?? "replace-me";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let worker: ChildProcessByStdio<null, Readable, Readable> | undefined;
let workerStdout = "";
let workerStderr = "";
let port = REQUESTED_PORT ?? 0;
let inspectorPort = REQUESTED_INSPECTOR_PORT ?? 0;
let persistPath = "";

function getBaseUrl(): string {
  return `http://${HOST}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${PASSWORD}`,
    ...extra
  };
}

function applyMigrations(): void {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
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
      persistPath
    ],
    {
      cwd: PACKAGE_DIR,
      env: process.env,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to apply D1 migrations.\nstdout:\n${result.stdout || "<empty>"}\nstderr:\n${result.stderr || "<empty>"}`
    );
  }
}

function startWorker(): ChildProcessByStdio<null, Readable, Readable> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    command,
    [
      "dev",
      "--port",
      String(port),
      "--ip",
      HOST,
      "--local",
      "--persist-to",
      persistPath,
      "--inspector-port",
      String(inspectorPort),
      "--var",
      `BOB_PASSWORD:${PASSWORD}`,
      "--var",
      "LOCAL_QUEUE_CONSUMER_URL:",
      "--var",
      "LOCAL_QUEUE_SHARED_SECRET:",
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn"
    ],
    {
      cwd: PACKAGE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  child.stdout.on("data", (chunk: Buffer) => {
    workerStdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    workerStderr += chunk.toString();
  });

  return child;
}

async function reserveOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to allocate an ephemeral port"));
        });
        return;
      }

      const reservedPort = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(reservedPort);
      });
    });
  });
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  const baseUrl = getBaseUrl();

  while (Date.now() - start < timeoutMs) {
    if (!worker || worker.exitCode !== null) {
      throw new Error(
        `Worker exited before becoming ready. Exit code: ${worker?.exitCode ?? "unknown"}`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Worker is still starting.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for worker at ${baseUrl}`);
}

async function stopWorker(): Promise<void> {
  if (!worker || worker.killed || worker.exitCode !== null) {
    return;
  }

  worker.kill("SIGINT");

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, 3_000);

    worker?.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited && worker.exitCode === null) {
    worker.kill("SIGKILL");
  }
}

async function requestJson(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${getBaseUrl()}${path}`, init);
  const text = await response.text();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response for ${path} but got: ${text || "<empty>"}`);
  }

  return {
    status: response.status,
    body: json
  };
}

describe("control worker integration", () => {
  beforeAll(async () => {
    if (!REQUESTED_PORT) {
      port = await reserveOpenPort();
    }
    if (!REQUESTED_INSPECTOR_PORT) {
      inspectorPort = await reserveOpenPort();
    }

    persistPath = await mkdtemp(join(tmpdir(), "bob-control-smoke-"));
    applyMigrations();

    worker = startWorker();
    try {
      await waitForServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nworker stdout:\n${workerStdout || "<empty>"}\n\nworker stderr:\n${workerStderr || "<empty>"}`
      );
    }
  });

  afterAll(async () => {
    await stopWorker();
    if (persistPath) {
      await rm(persistPath, { recursive: true, force: true });
    }
  });

  it("serves /healthz without auth", async () => {
    const response = await requestJson("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: "control-worker"
    });
  });

  it("returns 401 for /v1/ping without auth", async () => {
    const response = await requestJson("/v1/ping");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Unauthorized"
    });
  });

  it("returns 401 for /v1/ping with cookie auth", async () => {
    const response = await requestJson("/v1/ping", {
      headers: {
        cookie: `bob_password=${PASSWORD}`
      }
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Unauthorized"
    });
  });

  it("returns pong for /v1/ping with valid bearer auth", async () => {
    const response = await requestJson("/v1/ping", {
      headers: authHeaders()
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      message: "pong"
    });
  });

  it("supports repo and run lifecycle API routes", async () => {
    const createRepo = await requestJson("/v1/repos", {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify({
        owner: "sociotechnica-org",
        name: "lifebuild"
      })
    });
    expect(createRepo.status).toBe(201);

    const listRepos = await requestJson("/v1/repos", {
      headers: authHeaders()
    });
    expect(listRepos.status).toBe(200);
    expect(listRepos.body).toMatchObject({
      repos: [
        {
          owner: "sociotechnica-org",
          name: "lifebuild"
        }
      ]
    });

    const runPayload = {
      repo: {
        owner: "sociotechnica-org",
        name: "lifebuild"
      },
      issue: {
        number: 123
      },
      requestor: "jess",
      prMode: "draft"
    };

    const createRun = await requestJson("/v1/runs", {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json",
        "Idempotency-Key": "smoke-run-123"
      }),
      body: JSON.stringify(runPayload)
    });
    expect(createRun.status).toBe(202);
    expect(createRun.body).toMatchObject({
      run: {
        issueNumber: 123,
        status: "queued",
        repo: {
          owner: "sociotechnica-org",
          name: "lifebuild"
        }
      },
      idempotency: {
        key: "smoke-run-123",
        replayed: false
      }
    });

    const createdRunBody = createRun.body as Record<string, unknown>;
    const createdRun = createdRunBody.run as Record<string, unknown>;
    const runId = createdRun.id as string;
    expect(typeof runId).toBe("string");

    const replayRun = await requestJson("/v1/runs", {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json",
        "Idempotency-Key": "smoke-run-123"
      }),
      body: JSON.stringify(runPayload)
    });
    expect(replayRun.status).toBe(200);
    expect(replayRun.body).toMatchObject({
      idempotency: {
        key: "smoke-run-123",
        replayed: true
      }
    });

    const listRuns = await requestJson("/v1/runs", {
      headers: authHeaders()
    });
    expect(listRuns.status).toBe(200);
    expect(listRuns.body).toMatchObject({
      runs: [
        {
          id: runId
        }
      ]
    });

    const getRun = await requestJson(`/v1/runs/${runId}`, {
      headers: authHeaders()
    });
    expect(getRun.status).toBe(200);
    expect(getRun.body).toMatchObject({
      run: {
        id: runId
      },
      stations: [],
      artifacts: []
    });

    const getMissingArtifact = await requestJson(`/v1/runs/${runId}/artifacts/missing`, {
      headers: authHeaders()
    });
    expect(getMissingArtifact.status).toBe(404);
    expect(getMissingArtifact.body).toEqual({
      error: "Not found"
    });
  });
});
