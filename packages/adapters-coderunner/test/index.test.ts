import { SpritesRetryableTransportError } from "@bob/adapters-sprites";
import type { CoderunnerTaskInput, SpritesExecutionTransport } from "@bob/core";
import { describe, expect, it, vi } from "vitest";
import { CoderunnerError, createCoderunnerAdapter } from "../src/index";

function createTaskInput(overrides: Partial<CoderunnerTaskInput> = {}): CoderunnerTaskInput {
  return {
    runId: "run_1",
    issueNumber: 101,
    goal: "Fix issue",
    requestor: "jess",
    prMode: "draft",
    repo: {
      id: "repo_1",
      owner: "sociotechnica-org",
      name: "lifebuild",
      baseBranch: "main",
      configPath: ".bob/factory.yaml"
    },
    ...overrides
  };
}

function createTransport(): {
  transport: SpritesExecutionTransport;
  submitJob: ReturnType<typeof vi.fn>;
  getJobStatus: ReturnType<typeof vi.fn>;
  getJobResult: ReturnType<typeof vi.fn>;
} {
  const submitJob = vi.fn();
  const getJobStatus = vi.fn();
  const getJobResult = vi.fn();

  const transport: SpritesExecutionTransport = {
    submitJob,
    getJobStatus,
    getJobResult
  };

  return {
    transport,
    submitJob,
    getJobStatus,
    getJobResult
  };
}

describe("coderunner adapter", () => {
  it("returns mock success result by default", async () => {
    const adapter = createCoderunnerAdapter({
      mode: "mock",
      nowIso: () => "2026-02-14T00:00:00.000Z"
    });

    const result = await adapter.runImplementTask(createTaskInput());

    expect(result.outcome).toBe("succeeded");
    expect(result.summary).toContain("mock mode");
    expect(result.externalRef).toContain("mock_implement");
  });

  it("maps mock failure markers", async () => {
    const adapter = createCoderunnerAdapter({
      mode: "mock"
    });

    const result = await adapter.runVerifyTask(createTaskInput({ goal: "[mock-fail] verify" }));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toContain("failed");
  });

  it("keeps verify-specific failure markers scoped to verify phase", async () => {
    const adapter = createCoderunnerAdapter({
      mode: "mock"
    });

    const implementResult = await adapter.runImplementTask(
      createTaskInput({ goal: "[verify-fail] only verify should fail" })
    );
    const verifyResult = await adapter.runVerifyTask(
      createTaskInput({ goal: "[verify-fail] only verify should fail" })
    );

    expect(implementResult.outcome).toBe("succeeded");
    expect(verifyResult.outcome).toBe("failed");
  });

  it("maps sprites terminal outcomes", async () => {
    const { transport, submitJob } = createTransport();
    submitJob.mockResolvedValue({
      externalRef: "job_timeout",
      status: "timeout",
      summary: "Timed out",
      logsInline: "sprites logs"
    });

    const adapter = createCoderunnerAdapter({
      mode: "sprites",
      spritesTransport: transport,
      claudeCodeApiKey: "claude-key"
    });

    const result = await adapter.runImplementTask(createTaskInput());

    if (result.outcome === null) {
      throw new Error("Expected terminal result");
    }

    expect(result.outcome).toBe("timeout");
    expect(result.summary).toBe("Timed out");
    expect(result.logsInline).toBe("sprites logs");
  });

  it("treats nonterminal sprites submit payloads as in-progress", async () => {
    const { transport, submitJob } = createTransport();
    submitJob.mockResolvedValue({
      externalRef: "job_result_pending",
      status: "running",
      summary: "still running"
    });

    const adapter = createCoderunnerAdapter({
      mode: "sprites",
      spritesTransport: transport,
      claudeCodeApiKey: "claude-key"
    });

    const result = await adapter.runImplementTask(createTaskInput());

    expect(result.outcome).toBeNull();
    expect(result.externalRef).toBe("job_result_pending");
    expect(result.summary).toContain("still running");
  });

  it("returns in-progress response when terminal submit result fetch is retryable", async () => {
    const { transport, submitJob, getJobResult } = createTransport();
    submitJob.mockResolvedValue({
      externalRef: "job_terminal_retryable",
      status: "succeeded"
    });
    getJobResult.mockRejectedValue(new SpritesRetryableTransportError("temporary fetch failure"));

    const adapter = createCoderunnerAdapter({
      mode: "sprites",
      spritesTransport: transport,
      claudeCodeApiKey: "claude-key"
    });

    const result = await adapter.runImplementTask(createTaskInput());

    expect(result.outcome).toBeNull();
    expect(result.externalRef).toBe("job_terminal_retryable");
    expect(result.summary).toContain("result fetch retryable");
    expect(submitJob).toHaveBeenCalledOnce();
    expect(getJobResult).toHaveBeenCalledOnce();
  });

  it("increments metadata attempt when resumed metadata exists", async () => {
    const { transport, submitJob } = createTransport();
    submitJob.mockResolvedValue({
      externalRef: "job_2",
      status: "succeeded",
      summary: "ok"
    });

    const adapter = createCoderunnerAdapter({
      mode: "sprites",
      spritesTransport: transport,
      claudeCodeApiKey: "claude-key"
    });

    const result = await adapter.runImplementTask(
      createTaskInput({
        resume: {
          externalRef: "old_job",
          metadata: {
            phase: "implement",
            mode: "sprites",
            attempt: 1
          }
        }
      })
    );

    if (result.outcome === null) {
      throw new Error("Expected terminal result");
    }

    expect(result.metadata).toMatchObject({
      attempt: 2,
      phase: "implement",
      mode: "sprites"
    });
  });

  it("classifies retryable sprites errors", async () => {
    const { transport, submitJob } = createTransport();
    submitJob.mockRejectedValue(new SpritesRetryableTransportError("temporary"));

    const adapter = createCoderunnerAdapter({
      mode: "sprites",
      spritesTransport: transport,
      claudeCodeApiKey: "claude-key"
    });

    await expect(adapter.runImplementTask(createTaskInput())).rejects.toBeInstanceOf(
      CoderunnerError
    );

    try {
      await adapter.runImplementTask(createTaskInput());
      throw new Error("Expected retryable coderunner error");
    } catch (error) {
      expect(error).toBeInstanceOf(CoderunnerError);
      expect((error as CoderunnerError).retryable).toBe(true);
    }
  });
});
