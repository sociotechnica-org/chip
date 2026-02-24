import { describe, expect, it, vi } from "vitest";
import {
  GitHubAdapterError,
  createGitHubAdapter,
  createGitHubAdapterFromEnv,
  isRetryableGitHubError,
  type GitHubCreatePrInput
} from "../src/index";

function createInput(overrides: Partial<GitHubCreatePrInput> = {}): GitHubCreatePrInput {
  return {
    runId: "run_1",
    issueNumber: 77,
    goal: "Ship a working thing",
    requestor: "jess",
    prMode: "draft",
    repo: {
      owner: "sociotechnica-org",
      name: "lifebuild",
      baseBranch: "main"
    },
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("adapters-github", () => {
  it("returns deterministic mock create_pr output", async () => {
    const adapter = createGitHubAdapter({
      mode: "mock"
    });

    const result = await adapter.createPullRequestForRun(createInput());

    expect(result.workBranch).toContain("bob/");
    expect(result.commitSha).toContain("mock-");
    expect(result.prNumber).toBe(77);
    expect(result.prUrl).toContain("github.example");
    expect(result.branchCreated).toBe(true);
    expect(result.prCreated).toBe(true);
  });

  it("creates branch, marker commit, and pull request in github mode", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];

    const fetchFn = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = String(resource);
      const method = (init?.method ?? "GET").toUpperCase();
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body: parsedBody });

      if (method === "GET" && url.includes("/pulls?")) {
        return jsonResponse(200, []);
      }

      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return jsonResponse(200, {
          object: {
            sha: "sha_base"
          }
        });
      }

      if (method === "POST" && url.endsWith("/git/refs")) {
        return jsonResponse(201, {
          ref: "refs/heads/bob/run-1"
        });
      }

      if (method === "PUT" && url.includes("/contents/.bob/runs/run_1.md")) {
        return jsonResponse(201, {
          commit: {
            sha: "sha_commit"
          }
        });
      }

      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse(201, {
          number: 404,
          html_url: "https://github.com/sociotechnica-org/lifebuild/pull/404"
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const adapter = createGitHubAdapter({
      mode: "github",
      token: "ghp_test",
      apiBaseUrl: "https://api.github.test",
      fetchFn
    });

    const result = await adapter.createPullRequestForRun(createInput());

    expect(result).toMatchObject({
      workBranch: "bob/run-1",
      commitSha: "sha_commit",
      prNumber: 404,
      prUrl: "https://github.com/sociotechnica-org/lifebuild/pull/404",
      branchCreated: true,
      prCreated: true
    });

    const methods = calls.map((call) => call.method);
    expect(methods).toEqual(["GET", "GET", "POST", "PUT", "POST"]);
  });

  it("handles branch-already-exists and pr-already-exists idempotently", async () => {
    const fetchFn = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = String(resource);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url.includes("/pulls?")) {
        // First and second pull-list calls: no PR, then existing PR.
        const callCount = fetchFn.mock.calls.filter((entry) => {
          const reqUrl = String(entry[0]);
          const reqMethod = (entry[1]?.method ?? "GET").toUpperCase();
          return reqMethod === "GET" && reqUrl.includes("/pulls?");
        }).length;

        if (callCount === 1) {
          return jsonResponse(200, []);
        }

        return jsonResponse(200, [
          {
            number: 505,
            html_url: "https://github.com/sociotechnica-org/lifebuild/pull/505"
          }
        ]);
      }

      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return jsonResponse(200, {
          object: {
            sha: "sha_base"
          }
        });
      }

      if (method === "POST" && url.endsWith("/git/refs")) {
        return jsonResponse(422, {
          message: "Reference already exists"
        });
      }

      if (method === "PUT" && url.includes("/contents/.bob/runs/run_1.md")) {
        return jsonResponse(409, {
          message: "Conflict"
        });
      }

      if (method === "GET" && url.endsWith("/git/ref/heads/bob/run-1")) {
        return jsonResponse(200, {
          object: {
            sha: "sha_existing_branch"
          }
        });
      }

      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse(422, {
          message: "A pull request already exists for bob/run-1"
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const adapter = createGitHubAdapter({
      mode: "github",
      token: "ghp_test",
      apiBaseUrl: "https://api.github.test",
      fetchFn
    });

    const result = await adapter.createPullRequestForRun(createInput());

    expect(result).toMatchObject({
      workBranch: "bob/run-1",
      commitSha: "sha_existing_branch",
      prNumber: 505,
      prUrl: "https://github.com/sociotechnica-org/lifebuild/pull/505",
      branchCreated: false,
      prCreated: false
    });
  });

  it("treats nested validation duplicate-PR errors as idempotent", async () => {
    const fetchFn = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = String(resource);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url.includes("/pulls?")) {
        // First pull-list call: no PR. Second call after 422: existing PR.
        const callCount = fetchFn.mock.calls.filter((entry) => {
          const reqUrl = String(entry[0]);
          const reqMethod = (entry[1]?.method ?? "GET").toUpperCase();
          return reqMethod === "GET" && reqUrl.includes("/pulls?");
        }).length;

        if (callCount === 1) {
          return jsonResponse(200, []);
        }

        return jsonResponse(200, [
          {
            number: 606,
            html_url: "https://github.com/sociotechnica-org/lifebuild/pull/606"
          }
        ]);
      }

      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return jsonResponse(200, {
          object: {
            sha: "sha_base"
          }
        });
      }

      if (method === "POST" && url.endsWith("/git/refs")) {
        return jsonResponse(201, {
          ref: "refs/heads/bob/run-1"
        });
      }

      if (method === "PUT" && url.includes("/contents/.bob/runs/run_1.md")) {
        return jsonResponse(201, {
          commit: {
            sha: "sha_commit_2"
          }
        });
      }

      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [
            {
              message: "A pull request already exists for bob/run-1"
            }
          ]
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const adapter = createGitHubAdapter({
      mode: "github",
      token: "ghp_test",
      apiBaseUrl: "https://api.github.test",
      fetchFn
    });

    const result = await adapter.createPullRequestForRun(createInput());

    expect(result).toMatchObject({
      workBranch: "bob/run-1",
      commitSha: "sha_commit_2",
      prNumber: 606,
      prUrl: "https://github.com/sociotechnica-org/lifebuild/pull/606",
      branchCreated: true,
      prCreated: false
    });
  });

  it("classifies network errors as retryable", async () => {
    const adapter = createGitHubAdapter({
      mode: "github",
      token: "ghp_test",
      fetchFn: vi.fn(async () => {
        throw new Error("socket hang up");
      })
    });

    let captured: unknown;
    try {
      await adapter.createPullRequestForRun(createInput());
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(GitHubAdapterError);
    expect(isRetryableGitHubError(captured)).toBe(true);
  });

  it("requires token in github mode", () => {
    expect(() =>
      createGitHubAdapterFromEnv({
        GITHUB_ADAPTER_MODE: "github"
      })
    ).toThrowError(/GITHUB_TOKEN is required/);
  });
});
