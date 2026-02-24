import type { PrMode } from "@bob/core";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_MODE = "mock";

type FetchLike = typeof fetch;

export interface GitHubAdapterEnv {
  GITHUB_ADAPTER_MODE?: string;
  GITHUB_TOKEN?: string;
  GITHUB_API_BASE_URL?: string;
}

export interface GitHubCreatePrInput {
  runId: string;
  issueNumber: number;
  goal: string | null;
  requestor: string;
  prMode: PrMode;
  repo: {
    owner: string;
    name: string;
    baseBranch: string;
  };
  existingWorkBranch?: string | null;
  existingPrUrl?: string | null;
}

export interface GitHubCreatePrResult {
  workBranch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  branchCreated: boolean;
  prCreated: boolean;
}

export interface GitHubAdapter {
  createPullRequestForRun(input: GitHubCreatePrInput): Promise<GitHubCreatePrResult>;
}

export type GitHubAdapterMode = "mock" | "github";

export interface CreateGitHubAdapterInput {
  mode: GitHubAdapterMode;
  token?: string;
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
}

type GitHubAdapterErrorCode = "config" | "auth" | "retryable" | "provider";

export class GitHubAdapterError extends Error {
  public readonly code: GitHubAdapterErrorCode;
  public readonly retryable: boolean;
  public readonly statusCode: number | null;

  public constructor(input: {
    message: string;
    code: GitHubAdapterErrorCode;
    retryable: boolean;
    statusCode?: number | null;
    cause?: unknown;
  }) {
    super(input.message, {
      cause: input.cause
    });
    this.name = "GitHubAdapterError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.statusCode = input.statusCode ?? null;
  }
}

class GitHubConfigError extends GitHubAdapterError {
  public constructor(message: string) {
    super({
      message,
      code: "config",
      retryable: false
    });
    this.name = "GitHubConfigError";
  }
}

class GitHubAuthError extends GitHubAdapterError {
  public constructor(message: string, statusCode?: number) {
    super({
      message,
      code: "auth",
      retryable: false,
      statusCode: statusCode ?? null
    });
    this.name = "GitHubAuthError";
  }
}

class GitHubRetryableError extends GitHubAdapterError {
  public constructor(message: string, statusCode?: number, cause?: unknown) {
    super({
      message,
      code: "retryable",
      retryable: true,
      statusCode: statusCode ?? null,
      cause
    });
    this.name = "GitHubRetryableError";
  }
}

class GitHubProviderError extends GitHubAdapterError {
  public constructor(message: string, statusCode?: number, cause?: unknown) {
    super({
      message,
      code: "provider",
      retryable: false,
      statusCode: statusCode ?? null,
      cause
    });
    this.name = "GitHubProviderError";
  }
}

interface GitHubApiResponse<T> {
  status: number;
  body: T;
}

interface GitRefResponse {
  object?: {
    sha?: string;
  };
}

interface GitHubPrResponse {
  number?: number;
  html_url?: string;
  url?: string;
  head?: {
    ref?: string;
  };
}

interface GitHubContentResponse {
  sha?: string;
  commit?: {
    sha?: string;
  };
}

function normalizeApiBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_GITHUB_API_BASE_URL;
  }

  return trimmed.replace(/\/+$/u, "");
}

function normalizeMode(rawMode: string | undefined): GitHubAdapterMode {
  const normalized = (rawMode?.trim() || DEFAULT_MODE).toLowerCase();
  if (normalized === "mock" || normalized === "github") {
    return normalized;
  }

  throw new GitHubConfigError(`Unsupported GITHUB_ADAPTER_MODE: ${normalized}`);
}

function requireToken(mode: GitHubAdapterMode, token: string | undefined): string {
  const trimmed = token?.trim();
  if (!trimmed) {
    throw new GitHubConfigError(`GITHUB_TOKEN is required for GITHUB_ADAPTER_MODE=${mode}`);
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return "Unexpected GitHub API response";
  }

  const direct = asNonEmptyString(payload.message);
  if (direct) {
    return direct;
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    const first = errors[0];
    if (isRecord(first)) {
      const firstMessage = asNonEmptyString(first.message) ?? asNonEmptyString(first.code);
      if (firstMessage) {
        return firstMessage;
      }
    }
  }

  return "Unexpected GitHub API response";
}

function encodeGitHubPath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeWorkBranch(runId: string): string {
  const slug = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$|^$/gu, "run");
  const trimmedSlug = slug.slice(0, 48);
  return `bob/${trimmedSlug}`;
}

function base64EncodeUtf8(value: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function prTitle(input: GitHubCreatePrInput): string {
  return `Issue #${input.issueNumber}: automated implementation`;
}

function prBody(input: GitHubCreatePrInput): string {
  const lines = [
    `Automated run from bob-the-builder.`,
    "",
    `- Run: ${input.runId}`,
    `- Issue: #${input.issueNumber}`,
    `- Requestor: ${input.requestor}`
  ];

  if (input.goal) {
    lines.push(`- Goal: ${input.goal}`);
  }

  return lines.join("\n");
}

function markerFilePath(runId: string): string {
  return `.bob/runs/${runId}.md`;
}

function markerFileContent(input: GitHubCreatePrInput): string {
  const lines = [
    "# bob-the-builder run marker",
    "",
    `run_id: ${input.runId}`,
    `issue_number: ${input.issueNumber}`,
    `requestor: ${input.requestor}`,
    `pr_mode: ${input.prMode}`,
    `goal: ${input.goal ?? ""}`
  ];
  return `${lines.join("\n")}\n`;
}

function maybeGitHubRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function mapApiFailure(status: number, payload: unknown): GitHubAdapterError {
  const message = parseErrorMessage(payload);

  if (status === 401 || status === 403) {
    return new GitHubAuthError(message, status);
  }

  if (maybeGitHubRetryableStatus(status)) {
    return new GitHubRetryableError(message, status);
  }

  return new GitHubProviderError(message, status);
}

function isBranchExistsError(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  const message = asNonEmptyString(payload.message)?.toLowerCase();
  return Boolean(message && message.includes("reference already exists"));
}

function isPullRequestExistsError(payload: unknown): boolean {
  const duplicateMessagePattern = /(a )?pull request already exists/iu;

  if (!isRecord(payload)) {
    return false;
  }

  const message = asNonEmptyString(payload.message)?.toLowerCase();
  if (message && duplicateMessagePattern.test(message)) {
    return true;
  }

  const errors = payload.errors;
  if (!Array.isArray(errors)) {
    return false;
  }

  for (const error of errors) {
    if (typeof error === "string" && duplicateMessagePattern.test(error)) {
      return true;
    }

    if (!isRecord(error)) {
      continue;
    }

    const nestedMessage =
      asNonEmptyString(error.message) ??
      asNonEmptyString(error.code) ??
      asNonEmptyString(error.resource);
    if (nestedMessage && duplicateMessagePattern.test(nestedMessage)) {
      return true;
    }
  }

  return false;
}

class MockGitHubAdapter implements GitHubAdapter {
  public async createPullRequestForRun(input: GitHubCreatePrInput): Promise<GitHubCreatePrResult> {
    const workBranch = input.existingWorkBranch?.trim() || normalizeWorkBranch(input.runId);
    const commitSha = `mock-${input.runId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 24)}`;
    const prNumber = Math.max(1, input.issueNumber);

    return {
      workBranch,
      commitSha,
      prNumber,
      prUrl: `https://github.example/${input.repo.owner}/${input.repo.name}/pull/${prNumber}`,
      branchCreated: !input.existingWorkBranch,
      prCreated: !input.existingPrUrl
    };
  }
}

class GitHubRestAdapter implements GitHubAdapter {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;

  public constructor(input: { token: string; apiBaseUrl: string; fetchFn?: FetchLike }) {
    this.token = input.token;
    this.apiBaseUrl = input.apiBaseUrl;
    this.fetchFn =
      input.fetchFn ?? ((resource: RequestInfo | URL, init?: RequestInit) => fetch(resource, init));
  }

  public async createPullRequestForRun(input: GitHubCreatePrInput): Promise<GitHubCreatePrResult> {
    const workBranch = input.existingWorkBranch?.trim() || normalizeWorkBranch(input.runId);

    const existingPr = await this.findOpenPullRequest(input, workBranch);
    if (existingPr) {
      const commitSha = await this.getBranchHeadSha(input, workBranch);
      return {
        workBranch,
        commitSha,
        prNumber: existingPr.prNumber,
        prUrl: existingPr.prUrl,
        branchCreated: false,
        prCreated: false
      };
    }

    const baseSha = await this.getBranchHeadSha(input, input.repo.baseBranch);
    const branchCreated = await this.ensureBranch(input, workBranch, baseSha);
    const commitSha = await this.ensureRunMarkerCommit(input, workBranch);

    const prResult = await this.createOrLoadPullRequest(input, workBranch);

    return {
      workBranch,
      commitSha,
      prNumber: prResult.prNumber,
      prUrl: prResult.prUrl,
      branchCreated,
      prCreated: prResult.created
    };
  }

  private async ensureBranch(
    input: GitHubCreatePrInput,
    workBranch: string,
    sha: string
  ): Promise<boolean> {
    const response = await this.apiRequest<unknown>(
      "POST",
      `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/git/refs`,
      {
        ref: `refs/heads/${workBranch}`,
        sha
      },
      {
        allowErrorStatuses: [422]
      }
    );

    if (response.status === 201) {
      return true;
    }

    if (response.status === 422 && isBranchExistsError(response.body)) {
      return false;
    }

    throw mapApiFailure(response.status, response.body);
  }

  private async ensureRunMarkerCommit(
    input: GitHubCreatePrInput,
    workBranch: string
  ): Promise<string> {
    const path = markerFilePath(input.runId);
    const content = base64EncodeUtf8(markerFileContent(input));

    const createResponse = await this.apiRequest<GitHubContentResponse | unknown>(
      "PUT",
      `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/contents/${encodeGitHubPath(path)}`,
      {
        message: `chore: record automated run ${input.runId}`,
        content,
        branch: workBranch
      },
      {
        allowErrorStatuses: [409, 422]
      }
    );

    if (createResponse.status === 200 || createResponse.status === 201) {
      const commitSha = asNonEmptyString(
        (createResponse.body as GitHubContentResponse).commit?.sha
      );
      if (commitSha) {
        return commitSha;
      }
      return this.getBranchHeadSha(input, workBranch);
    }

    // On idempotent retries the marker may already exist or conflict; treat as already committed.
    if (createResponse.status === 409 || createResponse.status === 422) {
      return this.getBranchHeadSha(input, workBranch);
    }

    throw mapApiFailure(createResponse.status, createResponse.body);
  }

  private async createOrLoadPullRequest(
    input: GitHubCreatePrInput,
    workBranch: string
  ): Promise<{ prNumber: number; prUrl: string; created: boolean }> {
    const createResponse = await this.apiRequest<GitHubPrResponse | unknown>(
      "POST",
      `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/pulls`,
      {
        title: prTitle(input),
        body: prBody(input),
        head: workBranch,
        base: input.repo.baseBranch,
        draft: input.prMode === "draft"
      },
      {
        allowErrorStatuses: [422]
      }
    );

    if (createResponse.status === 201) {
      return this.parsePullRequest(createResponse.body as GitHubPrResponse, true);
    }

    if (createResponse.status === 422 && isPullRequestExistsError(createResponse.body)) {
      const existing = await this.findOpenPullRequest(input, workBranch);
      if (existing) {
        return {
          ...existing,
          created: false
        };
      }
    }

    throw mapApiFailure(createResponse.status, createResponse.body);
  }

  private async findOpenPullRequest(
    input: GitHubCreatePrInput,
    workBranch: string
  ): Promise<{ prNumber: number; prUrl: string } | null> {
    const query = new URLSearchParams({
      state: "open",
      head: `${input.repo.owner}:${workBranch}`,
      base: input.repo.baseBranch,
      per_page: "1"
    });

    const response = await this.apiRequest<GitHubPrResponse[] | unknown>(
      "GET",
      `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/pulls?${query.toString()}`
    );

    if (!Array.isArray(response.body) || response.body.length === 0) {
      return null;
    }

    const parsed = this.parsePullRequest(response.body[0], false);
    return {
      prNumber: parsed.prNumber,
      prUrl: parsed.prUrl
    };
  }

  private parsePullRequest(
    payload: GitHubPrResponse,
    created: boolean
  ): { prNumber: number; prUrl: string; created: boolean } {
    const prNumber = typeof payload.number === "number" ? payload.number : null;
    const prUrl = asNonEmptyString(payload.html_url) ?? asNonEmptyString(payload.url);

    if (!prNumber || !prUrl) {
      throw new GitHubProviderError("GitHub pull request response missing required fields");
    }

    return {
      prNumber,
      prUrl,
      created
    };
  }

  private async getBranchHeadSha(input: GitHubCreatePrInput, branch: string): Promise<string> {
    const response = await this.apiRequest<GitRefResponse | unknown>(
      "GET",
      `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/git/ref/heads/${encodeGitHubPath(branch)}`
    );

    const sha = asNonEmptyString((response.body as GitRefResponse).object?.sha);
    if (!sha) {
      throw new GitHubProviderError(`GitHub branch ref response missing SHA for ${branch}`);
    }

    return sha;
  }

  private async apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: {
      allowErrorStatuses?: number[];
    }
  ): Promise<GitHubApiResponse<T>> {
    const url = `${this.apiBaseUrl}${path}`;
    let response: Response;

    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new GitHubRetryableError(
        `GitHub request failed for ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    }

    let parsedBody: unknown = null;
    try {
      const raw = await response.text();
      if (raw.trim().length > 0) {
        parsedBody = JSON.parse(raw);
      }
    } catch {
      parsedBody = null;
    }

    const allowErrorStatuses = options?.allowErrorStatuses ?? [];
    if (!response.ok && !allowErrorStatuses.includes(response.status)) {
      throw mapApiFailure(response.status, parsedBody);
    }

    return {
      status: response.status,
      body: parsedBody as T
    };
  }
}

export function createGitHubAdapter(input: CreateGitHubAdapterInput): GitHubAdapter {
  if (input.mode === "mock") {
    return new MockGitHubAdapter();
  }

  const token = requireToken(input.mode, input.token);
  return new GitHubRestAdapter({
    token,
    apiBaseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
    fetchFn: input.fetchFn
  });
}

export function createGitHubAdapterFromEnv(
  env: GitHubAdapterEnv,
  overrides: Partial<CreateGitHubAdapterInput> = {}
): GitHubAdapter {
  const mode = overrides.mode ?? normalizeMode(env.GITHUB_ADAPTER_MODE);

  return createGitHubAdapter({
    mode,
    token: overrides.token ?? env.GITHUB_TOKEN,
    apiBaseUrl: overrides.apiBaseUrl ?? env.GITHUB_API_BASE_URL,
    fetchFn: overrides.fetchFn
  });
}

export function isRetryableGitHubError(error: unknown): boolean {
  return error instanceof GitHubAdapterError && error.retryable;
}
