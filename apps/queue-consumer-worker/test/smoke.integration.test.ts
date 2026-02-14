import type { CoderunnerAdapter, CoderunnerTaskInput } from "@bob/core";
import { describe, expect, it } from "vitest";
import { handleFetch, handleQueue, type Env } from "../src/index";
import { MockD1Database } from "./support/mock-d1";

function createSuccessAdapter(): CoderunnerAdapter {
  return {
    runImplementTask: async (input: CoderunnerTaskInput) => ({
      outcome: "succeeded",
      summary: `Implemented issue #${input.issueNumber}`,
      logsInline: "implement logs",
      externalRef: input.resume?.externalRef ?? "job_impl_smoke",
      metadata: {
        phase: "implement",
        mode: "mock",
        attempt: 1
      }
    }),
    runVerifyTask: async () => ({
      outcome: "succeeded",
      summary: "Verify passed",
      logsInline: "verify logs",
      externalRef: "job_verify_smoke",
      metadata: {
        phase: "verify",
        mode: "mock",
        attempt: 1
      }
    })
  };
}

function createEnv(localQueueSecret?: string): { env: Env; db: MockD1Database } {
  const db = new MockD1Database();
  db.seedRepo();
  return {
    env: {
      DB: db as unknown as D1Database,
      LOCAL_QUEUE_SHARED_SECRET: localQueueSecret,
      __TEST_CODERUNNER_ADAPTER__: createSuccessAdapter()
    },
    db
  };
}

describe("queue-consumer smoke", () => {
  it("serves /healthz", async () => {
    const response = await handleFetch(new Request("https://example.com/healthz"), {
      DB: {} as D1Database
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "queue-consumer-worker"
    });
  });

  it("rejects /__queue/consume when shared secret is not configured", async () => {
    const { env } = createEnv();
    const response = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runId: "run_missing",
          repoId: "repo_1",
          issueNumber: 1,
          requestedAt: new Date().toISOString(),
          requestor: "smoke",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Local queue consume endpoint is disabled"
    });
  });

  it("requires matching shared secret for /__queue/consume", async () => {
    const { env } = createEnv("local-secret");
    const requestBody = JSON.stringify({
      runId: "run_missing",
      repoId: "repo_1",
      issueNumber: 1,
      requestedAt: new Date().toISOString(),
      requestor: "smoke",
      prMode: "draft"
    });

    const unauthorized = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: requestBody
      }),
      env
    );

    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: "Unauthorized local queue dispatch"
    });
  });

  it("accepts authenticated /__queue/consume dispatches", async () => {
    const { env, db } = createEnv("local-secret");
    db.seedRun({
      id: "run_via_local_consume",
      status: "queued"
    });

    const response = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-local-queue-secret": "local-secret"
        },
        body: JSON.stringify({
          runId: "run_via_local_consume",
          repoId: "repo_1",
          issueNumber: 1,
          requestedAt: new Date().toISOString(),
          requestor: "smoke",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "ack"
    });
    expect(db.getRun("run_via_local_consume")?.status).toBe("succeeded");
    expect(db.listStations("run_via_local_consume").length).toBe(5);
    expect(db.listArtifacts("run_via_local_consume").length).toBeGreaterThanOrEqual(5);
  });

  it("processes a queued run to terminal status", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_smoke",
      status: "queued"
    });

    let acked = false;
    await handleQueue(
      {
        messages: [
          {
            id: "msg_smoke",
            body: {
              runId: "run_smoke",
              repoId: "repo_1",
              issueNumber: 5,
              requestedAt: new Date().toISOString(),
              requestor: "smoke",
              prMode: "draft"
            },
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("retry should not be called in smoke path");
            }
          } as unknown as Message<unknown>
        ]
      } as MessageBatch<unknown>,
      env
    );

    expect(acked).toBe(true);
    expect(db.getRun("run_smoke")?.status).toBe("succeeded");
    expect(db.listStations("run_smoke").length).toBe(5);
    expect(db.listArtifacts("run_smoke").length).toBeGreaterThanOrEqual(5);
  });
});
