export type PrMode = "draft" | "ready";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface RunSummary {
  id: string;
  repoId: string;
  repo: {
    owner: string;
    name: string;
  };
  issueNumber: number;
  goal: string | null;
  status: RunStatus;
  currentStation: string | null;
  requestor: string;
  baseBranch: string;
  workBranch: string | null;
  prMode: PrMode;
  prUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

export interface StationExecutionSummary {
  id: string;
  runId: string;
  station: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
}

export interface ArtifactSummary {
  id: string;
  runId: string;
  type: string;
  storage: string;
  createdAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  payload: unknown;
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface RunDetailResponse {
  run: RunSummary;
  stations: StationExecutionSummary[];
  artifacts: ArtifactSummary[];
}

export interface ArtifactDetailResponse {
  artifact: ArtifactDetail;
}
