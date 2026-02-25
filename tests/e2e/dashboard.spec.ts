import { expect, test } from "@playwright/test";

interface MockRun {
  id: string;
  repoId: string;
  repo: {
    owner: string;
    name: string;
  };
  issueNumber: number;
  goal: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  currentStation: string | null;
  requestor: string;
  baseBranch: string;
  workBranch: string | null;
  prMode: "draft" | "ready";
  prUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

interface MockRunDetail {
  run: MockRun;
  stations: Array<{
    id: string;
    runId: string;
    station: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    summary: string | null;
  }>;
  artifacts: Array<{
    id: string;
    runId: string;
    type: string;
    storage: string;
    createdAt: string;
  }>;
}

function normalizePathname(pathname: string): string {
  return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

test("dashboard submits runs and inspects artifacts", async ({ page }) => {
  const now = "2026-02-25T12:00:00.000Z";
  const runs = new Map<string, MockRun>([
    [
      "run_100",
      {
        id: "run_100",
        repoId: "repo_1",
        repo: {
          owner: "sociotechnica-org",
          name: "lifebuild"
        },
        issueNumber: 100,
        goal: "Investigate issue",
        status: "running",
        currentStation: "implement",
        requestor: "operator",
        baseBranch: "main",
        workBranch: "bob/run_100",
        prMode: "draft",
        prUrl: null,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        failureReason: null
      }
    ]
  ]);

  const runDetails = new Map<string, MockRunDetail>([
    [
      "run_100",
      {
        run: runs.get("run_100") as MockRun,
        stations: [
          {
            id: "station_run_100_intake",
            runId: "run_100",
            station: "intake",
            status: "succeeded",
            startedAt: now,
            finishedAt: now,
            durationMs: 1,
            summary: "Intake complete"
          },
          {
            id: "station_run_100_implement",
            runId: "run_100",
            station: "implement",
            status: "running",
            startedAt: now,
            finishedAt: null,
            durationMs: null,
            summary: "Implementing"
          }
        ],
        artifacts: [
          {
            id: "artifact_run_100_implement_summary",
            runId: "run_100",
            type: "implement_summary",
            storage: "inline",
            createdAt: now
          }
        ]
      }
    ]
  ]);

  const artifacts = new Map<string, unknown>([
    [
      "run_100:artifact_run_100_implement_summary",
      {
        station: "implement",
        outcome: "succeeded",
        summary: "Implemented issue #100"
      }
    ]
  ]);

  let runCounter = 100;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    const pathname = normalizePathname(url.pathname);

    if (method === "POST" && pathname === "/v1/repos") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          repo: {
            id: "repo_1",
            owner: "sociotechnica-org",
            name: "lifebuild",
            defaultBranch: "main",
            configPath: ".bob/factory.yaml",
            enabled: true,
            createdAt: now,
            updatedAt: now
          }
        })
      });
      return;
    }

    if (method === "GET" && pathname === "/v1/runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: Array.from(runs.values()).sort((left, right) => right.id.localeCompare(left.id))
        })
      });
      return;
    }

    if (method === "POST" && pathname === "/v1/runs") {
      const body = request.postDataJSON() as {
        issue?: {
          number?: number;
        };
        requestor?: string;
        goal?: string;
        prMode?: "draft" | "ready";
      };

      runCounter += 1;
      const nextId = `run_${runCounter}`;
      const createdRun: MockRun = {
        id: nextId,
        repoId: "repo_1",
        repo: {
          owner: "sociotechnica-org",
          name: "lifebuild"
        },
        issueNumber: body.issue?.number ?? 1,
        goal: body.goal ?? null,
        status: "queued",
        currentStation: null,
        requestor: body.requestor ?? "operator",
        baseBranch: "main",
        workBranch: null,
        prMode: body.prMode ?? "draft",
        prUrl: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        failureReason: null
      };

      runs.set(nextId, createdRun);
      runDetails.set(nextId, {
        run: createdRun,
        stations: [],
        artifacts: []
      });

      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: createdRun,
          idempotency: {
            key: "mock-idempotency-key",
            replayed: false,
            status: "succeeded"
          }
        })
      });
      return;
    }

    const runCancelMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/u);
    if (method === "POST" && runCancelMatch) {
      const runId = decodeURIComponent(runCancelMatch[1]);
      const run = runs.get(runId);
      if (!run) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" })
        });
        return;
      }

      run.status = "canceled";
      run.finishedAt = now;
      run.currentStation = null;
      runs.set(runId, run);
      runDetails.set(runId, {
        ...(runDetails.get(runId) as MockRunDetail),
        run
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run
        })
      });
      return;
    }

    const runRetryMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/retry$/u);
    if (method === "POST" && runRetryMatch) {
      const sourceRunId = decodeURIComponent(runRetryMatch[1]);
      const sourceRun = runs.get(sourceRunId);
      if (!sourceRun) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" })
        });
        return;
      }

      runCounter += 1;
      const retryRunId = `run_${runCounter}`;
      const retryRun: MockRun = {
        ...sourceRun,
        id: retryRunId,
        status: "queued",
        currentStation: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        failureReason: null,
        workBranch: null,
        prUrl: null
      };
      runs.set(retryRunId, retryRun);
      runDetails.set(retryRunId, {
        run: retryRun,
        stations: [],
        artifacts: []
      });

      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: retryRun,
          retriedFromRunId: sourceRunId
        })
      });
      return;
    }

    const artifactMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/u);
    if (method === "GET" && artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]);
      const artifactId = decodeURIComponent(artifactMatch[2]);
      const detail = runDetails.get(runId);
      const summary = detail?.artifacts.find((artifact) => artifact.id === artifactId);
      const payload = artifacts.get(`${runId}:${artifactId}`);

      if (!summary || payload === undefined) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" })
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          artifact: {
            ...summary,
            payload
          }
        })
      });
      return;
    }

    const runDetailMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/u);
    if (method === "GET" && runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1]);
      const detail = runDetails.get(runId);
      if (!detail) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" })
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail)
      });
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: `Unhandled mocked route: ${method} ${pathname}`
      })
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("BOB_PASSWORD").fill("test-password");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("API configuration saved")).toBeVisible();

  await expect(page.getByRole("button", { name: /run_100/i })).toBeVisible();
  await page.getByRole("button", { name: /run_100/i }).click();
  await expect(page.getByText("run_100")).toBeVisible();
  await expect(page.getByText("implement", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /implement_summary/i }).click();
  await expect(page.locator(".artifact-viewer pre")).toContainText("Implemented issue #100");

  await page.getByRole("button", { name: "Ensure default repo" }).click();
  await expect(page.getByText("Default repo ensured")).toBeVisible();

  await page.getByLabel("Issue number").fill("101");
  await page.getByLabel("Requestor").fill("web-e2e");
  await page.getByLabel("Goal (optional)").fill("Ship dashboard");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByText("Run submitted: run_101")).toBeVisible();
  await expect(page.getByRole("button", { name: /run_101/i })).toBeVisible();

  await page.getByRole("button", { name: /run_100/i }).click();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByText("Run canceled: run_100")).toBeVisible();
  await expect(page.getByText("canceled")).toBeVisible();

  await page.getByRole("button", { name: "Retry run" }).click();
  await expect(page.getByText("Retry submitted: run_102")).toBeVisible();
  await expect(page.getByRole("button", { name: /run_102/i })).toBeVisible();
});
