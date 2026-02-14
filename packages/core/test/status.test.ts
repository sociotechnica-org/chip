import { describe, expect, it } from "vitest";
import {
  canTransitionRunStatus,
  canTransitionStationStatus,
  isCoderunnerMode,
  isExecutionOutcome,
  isExecutionPhase,
  isPrMode,
  isRunQueueMessage,
  isRunStatus,
  isStationExecutionMetadata,
  isStationName,
  isTerminalRunStatus,
  isTerminalStationExecutionResponse,
  parseStationExecutionMetadataJson
} from "../src/index";

describe("run status contracts", () => {
  it("allows queued to running", () => {
    expect(canTransitionRunStatus("queued", "running")).toBe(true);
  });

  it("disallows terminal run transitions", () => {
    expect(canTransitionRunStatus("succeeded", "running")).toBe(false);
    expect(isTerminalRunStatus("failed")).toBe(true);
  });

  it("exposes type guards", () => {
    expect(isRunStatus("queued")).toBe(true);
    expect(isRunStatus("other")).toBe(false);
    expect(isPrMode("draft")).toBe(true);
    expect(isPrMode("invalid")).toBe(false);
    expect(isStationName("verify")).toBe(true);
  });
});

describe("station status contracts", () => {
  it("allows pending to running", () => {
    expect(canTransitionStationStatus("pending", "running")).toBe(true);
  });

  it("disallows completed station transitions", () => {
    expect(canTransitionStationStatus("succeeded", "failed")).toBe(false);
  });
});

describe("run queue message contracts", () => {
  it("accepts valid queue messages", () => {
    expect(
      isRunQueueMessage({
        runId: "run_123",
        repoId: "repo_123",
        issueNumber: 7,
        requestedAt: "2026-02-10T00:00:00.000Z",
        prMode: "draft",
        requestor: "jess"
      })
    ).toBe(true);
  });

  it("rejects malformed queue messages", () => {
    expect(
      isRunQueueMessage({
        runId: "run_123",
        repoId: "repo_123",
        issueNumber: "7",
        requestedAt: "2026-02-10T00:00:00.000Z",
        prMode: "draft",
        requestor: "jess"
      })
    ).toBe(false);
  });
});

describe("execution contracts", () => {
  it("validates execution enums", () => {
    expect(isExecutionPhase("implement")).toBe(true);
    expect(isExecutionPhase("create_pr")).toBe(false);
    expect(isExecutionOutcome("timeout")).toBe(true);
    expect(isExecutionOutcome("running")).toBe(false);
    expect(isCoderunnerMode("mock")).toBe(true);
    expect(isCoderunnerMode("something-else")).toBe(false);
  });

  it("validates station metadata payloads", () => {
    const metadata = {
      phase: "implement",
      mode: "modal",
      attempt: 2,
      providerStatus: "running"
    };

    expect(isStationExecutionMetadata(metadata)).toBe(true);
    expect(parseStationExecutionMetadataJson(JSON.stringify(metadata))).toEqual(metadata);
    expect(parseStationExecutionMetadataJson("{not-json")).toBeNull();
    expect(parseStationExecutionMetadataJson(JSON.stringify({ attempt: 1 }))).toBeNull();
  });

  it("detects terminal station execution responses", () => {
    expect(
      isTerminalStationExecutionResponse({
        outcome: "succeeded",
        summary: "done"
      })
    ).toBe(true);

    expect(
      isTerminalStationExecutionResponse({
        outcome: null,
        summary: "still running",
        externalRef: "job_1"
      })
    ).toBe(false);
  });
});
