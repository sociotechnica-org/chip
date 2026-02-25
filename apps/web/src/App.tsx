import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  cancelRun,
  createIdempotencyKey,
  createRun,
  ensureDefaultRepo,
  getRunArtifact,
  getRunDetail,
  listRuns,
  retryRun,
  type ApiConfig
} from "./api";
import type { ArtifactDetail, PrMode, RunDetailResponse, RunStatus, RunSummary } from "./types";

const API_BASE_URL_STORAGE_KEY = "bob.web.apiBaseUrl";
const API_PASSWORD_STORAGE_KEY = "bob.web.password";

function loadStoredConfig(): ApiConfig | null {
  if (typeof window === "undefined") {
    return null;
  }

  const baseUrl = window.localStorage.getItem(API_BASE_URL_STORAGE_KEY) ?? "/api";
  const password = window.localStorage.getItem(API_PASSWORD_STORAGE_KEY) ?? "";
  if (!password) {
    return null;
  }

  return {
    baseUrl,
    password
  };
}

function saveConfig(config: ApiConfig): void {
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, config.baseUrl);
  window.localStorage.setItem(API_PASSWORD_STORAGE_KEY, config.password);
}

function clearConfig(): void {
  window.localStorage.removeItem(API_BASE_URL_STORAGE_KEY);
  window.localStorage.removeItem(API_PASSWORD_STORAGE_KEY);
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "n/a";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString();
}

function statusClassName(status: RunStatus | string): string {
  return `status-pill status-${status}`;
}

export function App() {
  const storedConfig = loadStoredConfig();
  const [apiBaseUrlInput, setApiBaseUrlInput] = useState(storedConfig?.baseUrl ?? "/api");
  const [passwordInput, setPasswordInput] = useState(storedConfig?.password ?? "");
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(storedConfig);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);

  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetail | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const [issueNumberInput, setIssueNumberInput] = useState("1");
  const [requestorInput, setRequestorInput] = useState("operator");
  const [goalInput, setGoalInput] = useState("");
  const [prModeInput, setPrModeInput] = useState<PrMode>("draft");
  const [createRunLoading, setCreateRunLoading] = useState(false);
  const [ensureRepoLoading, setEnsureRepoLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runActionLoading, setRunActionLoading] = useState(false);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );

  const refreshRuns = useCallback(
    async ({ silent }: { silent?: boolean } = {}): Promise<void> => {
      if (!apiConfig) {
        return;
      }

      if (!silent) {
        setRunsLoading(true);
      }
      setRunsError(null);
      try {
        const response = await listRuns(apiConfig);
        setRuns(response.runs);
        setSelectedRunId((current) => {
          if (current && response.runs.some((run) => run.id === current)) {
            return current;
          }

          return response.runs[0]?.id ?? null;
        });
      } catch (error) {
        setRunsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!silent) {
          setRunsLoading(false);
        }
      }
    },
    [apiConfig]
  );

  const refreshRunDetail = useCallback(
    async (runId: string, { silent }: { silent?: boolean } = {}): Promise<void> => {
      if (!apiConfig) {
        return;
      }

      if (!silent) {
        setRunDetailLoading(true);
      }
      setRunDetailError(null);
      try {
        const response = await getRunDetail(apiConfig, runId);
        setRunDetail(response);
        setSelectedArtifactId((current) => {
          if (current && response.artifacts.some((artifact) => artifact.id === current)) {
            return current;
          }

          return response.artifacts[0]?.id ?? null;
        });
      } catch (error) {
        setRunDetailError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!silent) {
          setRunDetailLoading(false);
        }
      }
    },
    [apiConfig]
  );

  useEffect(() => {
    if (!apiConfig) {
      return;
    }

    void refreshRuns();
  }, [apiConfig, refreshRuns]);

  useEffect(() => {
    if (!apiConfig || !selectedRunId) {
      setRunDetail(null);
      setRunDetailError(null);
      setSelectedArtifactId(null);
      setArtifactDetail(null);
      return;
    }

    void refreshRunDetail(selectedRunId);
  }, [apiConfig, refreshRunDetail, selectedRunId]);

  useEffect(() => {
    if (!apiConfig || !selectedRunId || !runDetail) {
      return;
    }

    const runIsActive = runDetail.run.status === "queued" || runDetail.run.status === "running";
    if (!runIsActive) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshRuns({ silent: true });
      void refreshRunDetail(selectedRunId, { silent: true });
    }, 2_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [apiConfig, refreshRunDetail, refreshRuns, runDetail, selectedRunId]);

  useEffect(() => {
    if (!apiConfig || !selectedRunId || !selectedArtifactId) {
      setArtifactDetail(null);
      setArtifactError(null);
      return;
    }

    let active = true;
    const loadArtifact = async (): Promise<void> => {
      setArtifactLoading(true);
      setArtifactError(null);
      try {
        const response = await getRunArtifact(apiConfig, selectedRunId, selectedArtifactId);
        if (!active) {
          return;
        }
        setArtifactDetail(response.artifact);
      } catch (error) {
        if (!active) {
          return;
        }
        setArtifactDetail(null);
        setArtifactError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) {
          setArtifactLoading(false);
        }
      }
    };

    void loadArtifact();
    return () => {
      active = false;
    };
  }, [apiConfig, selectedArtifactId, selectedRunId]);

  const handleSaveApiConfig = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setActionMessage(null);
    setActionError(null);

    const nextPassword = passwordInput.trim();
    if (!nextPassword) {
      setActionError("Password is required");
      return;
    }

    const nextConfig = {
      baseUrl: apiBaseUrlInput.trim() || "/api",
      password: nextPassword
    };
    saveConfig(nextConfig);
    setApiConfig(nextConfig);
    setActionMessage("API configuration saved");
  };

  const handleClearApiConfig = (): void => {
    clearConfig();
    setApiConfig(null);
    setPasswordInput("");
    setActionMessage("Stored credentials cleared");
    setActionError(null);
    setRuns([]);
    setSelectedRunId(null);
    setRunDetail(null);
  };

  const handleEnsureRepo = async (): Promise<void> => {
    if (!apiConfig) {
      return;
    }

    setEnsureRepoLoading(true);
    setActionError(null);
    setActionMessage(null);
    try {
      await ensureDefaultRepo(apiConfig);
      setActionMessage("Default repo ensured");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already exists")) {
        setActionMessage("Default repo already exists");
      } else {
        setActionError(message);
      }
    } finally {
      setEnsureRepoLoading(false);
    }
  };

  const handleCreateRun = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!apiConfig) {
      return;
    }

    const issueNumber = Number.parseInt(issueNumberInput, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      setActionError("Issue number must be a positive integer");
      return;
    }

    const requestor = requestorInput.trim();
    if (!requestor) {
      setActionError("Requestor is required");
      return;
    }

    setCreateRunLoading(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const run = await createRun(apiConfig, {
        issueNumber,
        requestor,
        goal: goalInput.trim(),
        prMode: prModeInput,
        idempotencyKey: createIdempotencyKey()
      });
      setActionMessage(`Run submitted: ${run.id}`);
      await refreshRuns();
      setSelectedRunId(run.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateRunLoading(false);
    }
  };

  const handleCancelRun = async (): Promise<void> => {
    if (!apiConfig || !selectedRunId) {
      return;
    }

    setRunActionLoading(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const run = await cancelRun(apiConfig, selectedRunId);
      setActionMessage(`Run canceled: ${run.id}`);
      await refreshRuns();
      await refreshRunDetail(run.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunActionLoading(false);
    }
  };

  const handleRetryRun = async (): Promise<void> => {
    if (!apiConfig || !selectedRunId) {
      return;
    }

    setRunActionLoading(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await retryRun(apiConfig, selectedRunId);
      setActionMessage(`Retry submitted: ${response.run.id}`);
      await refreshRuns();
      setSelectedRunId(response.run.id);
      await refreshRunDetail(response.run.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunActionLoading(false);
    }
  };

  const canCancel = selectedRun?.status === "queued" || selectedRun?.status === "running";
  const canRetry = selectedRun?.status === "failed" || selectedRun?.status === "canceled";

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>chip operator dashboard</h1>
        <p>Submit runs, monitor station progression, and inspect artifacts from one place.</p>
      </header>

      <section className="panel">
        <h2>API auth</h2>
        <form className="config-form" onSubmit={handleSaveApiConfig}>
          <label>
            API base URL
            <input
              value={apiBaseUrlInput}
              onChange={(event) => setApiBaseUrlInput(event.target.value)}
              placeholder="/api"
            />
          </label>
          <label>
            Bearer password
            <input
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              type="password"
              placeholder="BOB_PASSWORD"
            />
          </label>
          <div className="button-row">
            <button type="submit">Save</button>
            <button type="button" onClick={handleClearApiConfig}>
              Clear
            </button>
            <button type="button" onClick={() => void refreshRuns()} disabled={!apiConfig}>
              Refresh runs
            </button>
            <button type="button" onClick={() => void handleEnsureRepo()} disabled={!apiConfig}>
              {ensureRepoLoading ? "Ensuring repo..." : "Ensure default repo"}
            </button>
          </div>
        </form>
      </section>

      {actionMessage ? <p className="callout success">{actionMessage}</p> : null}
      {actionError ? <p className="callout error">{actionError}</p> : null}

      <section className="workspace-grid">
        <div className="column">
          <section className="panel">
            <h2>Submit run</h2>
            <form className="run-form" onSubmit={(event) => void handleCreateRun(event)}>
              <label>
                Issue number
                <input
                  value={issueNumberInput}
                  onChange={(event) => setIssueNumberInput(event.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </label>
              <label>
                Requestor
                <input
                  value={requestorInput}
                  onChange={(event) => setRequestorInput(event.target.value)}
                />
              </label>
              <label>
                Goal (optional)
                <textarea
                  value={goalInput}
                  onChange={(event) => setGoalInput(event.target.value)}
                />
              </label>
              <label>
                PR mode
                <select
                  value={prModeInput}
                  onChange={(event) => setPrModeInput(event.target.value as PrMode)}
                >
                  <option value="draft">draft</option>
                  <option value="ready">ready</option>
                </select>
              </label>
              <button type="submit" disabled={!apiConfig || createRunLoading}>
                {createRunLoading ? "Submitting..." : "Submit run"}
              </button>
            </form>
          </section>

          <section className="panel">
            <h2>Runs</h2>
            {!apiConfig ? <p>Save API credentials to load runs.</p> : null}
            {runsLoading ? <p>Loading runs...</p> : null}
            {runsError ? <p className="callout error">{runsError}</p> : null}
            {!runsLoading && !runsError && apiConfig && runs.length === 0 ? (
              <p>No runs yet. Submit one to begin.</p>
            ) : null}
            <ul className="run-list">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    className={`run-item ${run.id === selectedRunId ? "selected" : ""}`}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <div className="run-item-title">
                      <strong>{run.id}</strong>
                      <span className={statusClassName(run.status)}>{run.status}</span>
                    </div>
                    <div className="run-item-meta">
                      <span>
                        {run.repo.owner}/{run.repo.name}#{run.issueNumber}
                      </span>
                      <span>{formatTimestamp(run.createdAt)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="column">
          <section className="panel">
            <h2>Run detail</h2>
            {!selectedRunId ? <p>Select a run to view details.</p> : null}
            {runDetailLoading ? <p>Loading run detail...</p> : null}
            {runDetailError ? <p className="callout error">{runDetailError}</p> : null}

            {runDetail ? (
              <div className="run-detail">
                <div className="run-summary-grid">
                  <div>
                    <span className="label">Run ID</span>
                    <strong>{runDetail.run.id}</strong>
                  </div>
                  <div>
                    <span className="label">Status</span>
                    <span className={statusClassName(runDetail.run.status)}>
                      {runDetail.run.status}
                    </span>
                  </div>
                  <div>
                    <span className="label">Issue</span>
                    <strong>
                      {runDetail.run.repo.owner}/{runDetail.run.repo.name}#
                      {runDetail.run.issueNumber}
                    </strong>
                  </div>
                  <div>
                    <span className="label">Current station</span>
                    <strong>{runDetail.run.currentStation ?? "n/a"}</strong>
                  </div>
                  <div>
                    <span className="label">PR URL</span>
                    {runDetail.run.prUrl ? (
                      <a href={runDetail.run.prUrl} target="_blank" rel="noreferrer">
                        {runDetail.run.prUrl}
                      </a>
                    ) : (
                      <strong>n/a</strong>
                    )}
                  </div>
                  <div>
                    <span className="label">Failure reason</span>
                    <strong>{runDetail.run.failureReason ?? "n/a"}</strong>
                  </div>
                </div>

                <div className="button-row">
                  <button
                    type="button"
                    onClick={() => void handleCancelRun()}
                    disabled={!apiConfig || !canCancel || runActionLoading}
                  >
                    Cancel run
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRetryRun()}
                    disabled={!apiConfig || !canRetry || runActionLoading}
                  >
                    Retry run
                  </button>
                </div>

                <h3>Stations</h3>
                {runDetail.stations.length === 0 ? <p>No station executions yet.</p> : null}
                <ol className="station-list">
                  {runDetail.stations.map((station) => (
                    <li key={station.id} className="station-item">
                      <div className="station-heading">
                        <strong>{station.station}</strong>
                        <span className={statusClassName(station.status)}>{station.status}</span>
                      </div>
                      <div className="station-meta">
                        <span>start: {formatTimestamp(station.startedAt)}</span>
                        <span>finish: {formatTimestamp(station.finishedAt)}</span>
                        <span>duration: {station.durationMs ?? "n/a"}ms</span>
                      </div>
                      <p>{station.summary ?? "No summary"}</p>
                    </li>
                  ))}
                </ol>

                <h3>Artifacts</h3>
                {runDetail.artifacts.length === 0 ? <p>No artifacts yet.</p> : null}
                <div className="artifact-grid">
                  <ul className="artifact-list">
                    {runDetail.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <button
                          type="button"
                          className={`artifact-item ${
                            selectedArtifactId === artifact.id ? "selected" : ""
                          }`}
                          onClick={() => setSelectedArtifactId(artifact.id)}
                        >
                          <strong>{artifact.type}</strong>
                          <span>{formatTimestamp(artifact.createdAt)}</span>
                          <span>storage: {artifact.storage}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="artifact-viewer">
                    {!selectedArtifactId ? <p>Select an artifact to view payload.</p> : null}
                    {artifactLoading ? <p>Loading artifact...</p> : null}
                    {artifactError ? <p className="callout error">{artifactError}</p> : null}
                    {artifactDetail ? (
                      <>
                        <h4>{artifactDetail.type}</h4>
                        <pre>{JSON.stringify(artifactDetail.payload, null, 2)}</pre>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
