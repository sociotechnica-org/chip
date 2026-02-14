import { CoderunnerError } from "@bob/adapters-coderunner";
import type { CoderunnerAdapter, CoderunnerTaskInput } from "@bob/core";
import { describe, expect, it, vi } from "vitest";
import { handleQueue, type Env } from "../src/index";
import { MockD1Database } from "./support/mock-d1";

interface MockQueueMessage {
  id: string;
  body: unknown;
  acked: boolean;
  retries: number;
  ack: () => void;
  retry: () => void;
}

function createMessage(id: string, body: unknown): MockQueueMessage {
  return {
    id,
    body,
    acked: false,
    retries: 0,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retries += 1;
    }
  };
}

function createBaseRunMessage(runId: string) {
  return {
    runId,
    repoId: "repo_1",
    issueNumber: 101,
    requestedAt: new Date().toISOString(),
    requestor: "jess",
    prMode: "draft"
  };
}

function createSuccessAdapter(): CoderunnerAdapter {
  return {
    runImplementTask: async (input: CoderunnerTaskInput) => ({
      outcome: "succeeded",
      summary: `Implemented issue #${input.issueNumber}`,
      logsInline: "implement logs",
      externalRef: input.resume?.externalRef ?? "job_impl_1",
      metadata: {
        phase: "implement",
        mode: "mock",
        attempt: input.resume?.metadata?.attempt === 1 ? 2 : 1
      }
    }),
    runVerifyTask: async (input: CoderunnerTaskInput) => ({
      outcome: "succeeded",
      summary: `Verified ${input.repo.owner}/${input.repo.name}`,
      logsInline: "verify logs",
      externalRef: input.resume?.externalRef ?? "job_verify_1",
      metadata: {
        phase: "verify",
        mode: "mock",
        attempt: input.resume?.metadata?.attempt === 1 ? 2 : 1
      }
    })
  };
}

function createEnv(adapter: CoderunnerAdapter): { env: Env; db: MockD1Database } {
  const db = new MockD1Database();
  db.seedRepo();
  return {
    env: {
      DB: db as unknown as D1Database,
      __TEST_CODERUNNER_ADAPTER__: adapter
    },
    db
  };
}

describe("queue-consumer worker", () => {
  it("acks invalid queue messages", async () => {
    const { env, db } = createEnv(createSuccessAdapter());
    db.seedRun({
      id: "run_invalid",
      status: "queued"
    });

    const invalidMessage = createMessage("msg_invalid", { nope: true });

    await handleQueue(
      {
        messages: [invalidMessage as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(invalidMessage.acked).toBe(true);
    expect(db.getRun("run_invalid")?.status).toBe("queued");
  });

  it("executes implement and verify with artifacts", async () => {
    const { env, db } = createEnv(createSuccessAdapter());
    db.seedRun({
      id: "run_success",
      status: "queued",
      goal: "Fix tests"
    });

    const message = createMessage("msg_success", createBaseRunMessage("run_success"));

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_success");
    expect(message.acked).toBe(true);
    expect(run?.status).toBe("succeeded");
    expect(run?.current_station).toBeNull();

    const implementStation = db.getStationExecution("run_success", "implement");
    const verifyStation = db.getStationExecution("run_success", "verify");
    expect(implementStation?.status).toBe("succeeded");
    expect(verifyStation?.status).toBe("succeeded");
    expect(implementStation?.external_ref).toBe("job_impl_1");

    const artifactTypes = db
      .listArtifacts("run_success")
      .map((artifact) => artifact.type)
      .sort((left, right) => left.localeCompare(right));
    expect(artifactTypes).toContain("implement_summary");
    expect(artifactTypes).toContain("verify_summary");
    expect(artifactTypes).toContain("implement_runner_logs_excerpt");
    expect(artifactTypes).toContain("verify_runner_logs_excerpt");

    const implementSummaryArtifact = db
      .listArtifacts("run_success")
      .find((artifact) => artifact.type === "implement_summary");
    expect(implementSummaryArtifact).toBeDefined();
    const payload = JSON.parse(implementSummaryArtifact?.payload ?? "{}");
    expect(payload).toMatchObject({
      station: "implement",
      outcome: "succeeded",
      externalRef: "job_impl_1"
    });
  });

  it("marks run failed when implement returns a terminal failure outcome", async () => {
    const adapter: CoderunnerAdapter = {
      runImplementTask: async () => ({
        outcome: "failed",
        summary: "Compilation failed",
        logsInline: "build error log",
        externalRef: "job_impl_failed",
        metadata: {
          phase: "implement",
          mode: "mock",
          attempt: 1
        }
      }),
      runVerifyTask: vi.fn()
    };

    const { env, db } = createEnv(adapter);
    db.seedRun({
      id: "run_failure",
      status: "queued"
    });

    const message = createMessage("msg_failure", createBaseRunMessage("run_failure"));

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_failure");
    expect(message.acked).toBe(true);
    expect(run?.status).toBe("failed");
    expect(run?.current_station).toBe("implement");

    const implementStation = db.getStationExecution("run_failure", "implement");
    expect(implementStation?.status).toBe("failed");
    expect(implementStation?.summary).toContain("Compilation failed");
    expect(adapter.runVerifyTask).not.toHaveBeenCalled();
  });

  it("resumes stale runs from current station without replaying succeeded stations", async () => {
    const adapter = createSuccessAdapter();
    const { env, db } = createEnv(adapter);
    db.seedRun({
      id: "run_resume",
      status: "running",
      current_station: "plan",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60_000).toISOString()
    });
    db.seedStationExecution({
      id: "station_run_resume_intake",
      run_id: "run_resume",
      station: "intake",
      status: "succeeded",
      started_at: new Date(Date.now() - 90_000).toISOString(),
      finished_at: new Date(Date.now() - 89_500).toISOString(),
      duration_ms: 500,
      summary: "intake done",
      external_ref: null,
      metadata_json: null
    });
    db.seedStationExecution({
      id: "station_run_resume_plan",
      run_id: "run_resume",
      station: "plan",
      status: "succeeded",
      started_at: new Date(Date.now() - 89_000).toISOString(),
      finished_at: new Date(Date.now() - 88_000).toISOString(),
      duration_ms: 1_000,
      summary: "plan done",
      external_ref: null,
      metadata_json: null
    });

    const message = createMessage("msg_resume", createBaseRunMessage("run_resume"));

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(true);
    expect(db.getRun("run_resume")?.status).toBe("succeeded");
    const plan = db.getStationExecution("run_resume", "plan");
    expect(plan?.summary).toBe("plan done");

    const intakeRows = db
      .listStations("run_resume")
      .filter((station) => station.station === "intake" && station.status === "succeeded");
    expect(intakeRows).toHaveLength(1);
  });

  it("uses external_ref resume context instead of starting duplicate execution", async () => {
    const runImplementTask = vi.fn(async (input: CoderunnerTaskInput) => {
      expect(input.resume?.externalRef).toBe("job_existing");
      return {
        outcome: "succeeded",
        summary: "Implement resumed",
        externalRef: input.resume?.externalRef,
        metadata: {
          phase: "implement",
          mode: "modal",
          attempt: 2
        }
      };
    });

    const adapter: CoderunnerAdapter = {
      runImplementTask,
      runVerifyTask: async () => ({
        outcome: "succeeded",
        summary: "Verify succeeded",
        externalRef: "job_verify_resume",
        metadata: {
          phase: "verify",
          mode: "mock",
          attempt: 1
        }
      })
    };

    const { env, db } = createEnv(adapter);
    db.seedRun({
      id: "run_external_ref_resume",
      status: "running",
      current_station: "implement",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60_000).toISOString()
    });
    db.seedStationExecution({
      id: "station_run_external_ref_resume_intake",
      run_id: "run_external_ref_resume",
      station: "intake",
      status: "succeeded",
      started_at: new Date(Date.now() - 120_000).toISOString(),
      finished_at: new Date(Date.now() - 119_000).toISOString(),
      duration_ms: 1_000,
      summary: "intake done",
      external_ref: null,
      metadata_json: null
    });
    db.seedStationExecution({
      id: "station_run_external_ref_resume_plan",
      run_id: "run_external_ref_resume",
      station: "plan",
      status: "succeeded",
      started_at: new Date(Date.now() - 118_000).toISOString(),
      finished_at: new Date(Date.now() - 117_000).toISOString(),
      duration_ms: 1_000,
      summary: "plan done",
      external_ref: null,
      metadata_json: null
    });
    db.seedStationExecution({
      id: "station_run_external_ref_resume_implement",
      run_id: "run_external_ref_resume",
      station: "implement",
      status: "running",
      started_at: new Date(Date.now() - 90_000).toISOString(),
      finished_at: null,
      duration_ms: null,
      summary: "waiting",
      external_ref: "job_existing",
      metadata_json: JSON.stringify({
        phase: "implement",
        mode: "modal",
        attempt: 1,
        providerStatus: "running"
      })
    });

    const message = createMessage(
      "msg_external_ref_resume",
      createBaseRunMessage("run_external_ref_resume")
    );

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(true);
    expect(db.getRun("run_external_ref_resume")?.status).toBe("succeeded");
    expect(runImplementTask).toHaveBeenCalledOnce();
    expect(db.getStationExecution("run_external_ref_resume", "implement")?.external_ref).toBe(
      "job_existing"
    );
  });

  it("persists running metadata and completes on resume", async () => {
    let implementCallCount = 0;
    const seenResumeRefs: string[] = [];

    const adapter: CoderunnerAdapter = {
      runImplementTask: async (input: CoderunnerTaskInput) => {
        implementCallCount += 1;
        if (input.resume?.externalRef) {
          seenResumeRefs.push(input.resume.externalRef);
          return {
            outcome: "succeeded",
            summary: "Implement resumed and succeeded",
            externalRef: input.resume.externalRef,
            metadata: {
              phase: "implement",
              mode: "modal",
              attempt: 2
            },
            logsInline: "resumed logs"
          };
        }

        return {
          outcome: null,
          summary: "Modal job still running",
          externalRef: "job_progress",
          metadata: {
            phase: "implement",
            mode: "modal",
            attempt: 1
          }
        };
      },
      runVerifyTask: async () => ({
        outcome: "succeeded",
        summary: "Verify succeeded",
        externalRef: "job_verify",
        metadata: {
          phase: "verify",
          mode: "mock",
          attempt: 1
        }
      })
    };

    const { env, db } = createEnv(adapter);
    db.seedRun({
      id: "run_progress",
      status: "queued"
    });

    const firstMessage = createMessage("msg_progress_1", createBaseRunMessage("run_progress"));

    await handleQueue(
      {
        messages: [firstMessage as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(firstMessage.acked).toBe(false);
    expect(firstMessage.retries).toBe(1);
    expect(db.getRun("run_progress")?.status).toBe("running");

    const runningImplement = db.getStationExecution("run_progress", "implement");
    expect(runningImplement?.status).toBe("running");
    expect(runningImplement?.external_ref).toBe("job_progress");
    expect(JSON.parse(runningImplement?.metadata_json ?? "{}")).toMatchObject({
      phase: "implement",
      mode: "modal",
      attempt: 1
    });

    db.setRunHeartbeat("run_progress", new Date(Date.now() - 60_000).toISOString());

    const secondMessage = createMessage("msg_progress_2", createBaseRunMessage("run_progress"));

    await handleQueue(
      {
        messages: [secondMessage as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(secondMessage.acked).toBe(true);
    expect(db.getRun("run_progress")?.status).toBe("succeeded");
    expect(implementCallCount).toBe(2);
    expect(seenResumeRefs).toEqual(["job_progress"]);

    const implementSummary = db
      .listArtifacts("run_progress")
      .find((artifact) => artifact.type === "implement_summary");
    expect(implementSummary).toBeDefined();
    expect(JSON.parse(implementSummary?.payload ?? "{}")).toMatchObject({
      station: "implement",
      outcome: "succeeded",
      externalRef: "job_progress"
    });
  });

  it("retries on transient adapter errors and keeps run running", async () => {
    const adapter: CoderunnerAdapter = {
      runImplementTask: async () => {
        throw new CoderunnerError({
          message: "transient modal issue",
          retryable: true,
          code: "transport_retryable"
        });
      },
      runVerifyTask: async () => ({
        outcome: "succeeded",
        summary: "verify",
        metadata: {
          phase: "verify",
          mode: "mock",
          attempt: 1
        }
      })
    };

    const { env, db } = createEnv(adapter);
    db.seedRun({
      id: "run_retryable_error",
      status: "queued"
    });

    const message = createMessage(
      "msg_retryable_error",
      createBaseRunMessage("run_retryable_error")
    );

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(false);
    expect(message.retries).toBe(1);
    expect(db.getRun("run_retryable_error")?.status).toBe("running");
    expect(db.getStationExecution("run_retryable_error", "implement")?.status).toBe("running");
  });
});
