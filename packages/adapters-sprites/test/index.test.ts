import { describe, expect, it, vi } from "vitest";
import {
  SpritesAuthError,
  SpritesConfigError,
  SpritesProviderError,
  SpritesRetryableTransportError,
  createSpritesExecutionTransport,
  loadSpritesAuthConfigFromEnv
} from "../src/index";

describe("loadSpritesAuthConfigFromEnv", () => {
  it("requires Sprites token configuration", () => {
    expect(() =>
      loadSpritesAuthConfigFromEnv({
        SPRITE_NAME: "runner"
      })
    ).toThrowError(SpritesConfigError);

    expect(() =>
      loadSpritesAuthConfigFromEnv({
        SPRITE_TOKEN: "token"
      })
    ).toThrowError(SpritesConfigError);
  });

  it("uses defaults and trims env values", () => {
    const config = loadSpritesAuthConfigFromEnv({
      SPRITE_TOKEN: "  sprite-token  ",
      SPRITE_NAME: "  bob-runner  ",
      SPRITES_API_BASE_URL: "https://sprites.example.com///",
      SPRITES_TIMEOUT_MS: "15000"
    });

    expect(config).toEqual({
      token: "sprite-token",
      spriteName: "bob-runner",
      apiBaseUrl: "https://sprites.example.com",
      timeoutMs: 15000
    });
  });
});

describe("Http sprites transport", () => {
  const auth = {
    token: "sprite-token",
    spriteName: "my-sprite",
    apiBaseUrl: "https://api.sprites.dev",
    timeoutMs: 5000
  };

  it("sends bearer auth and query params when submitting commands", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("ok\n", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-exit-code": "0"
        }
      })
    );

    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn
    });

    const submit = await transport.submitJob({
      phase: "implement",
      runId: "run_1",
      command: "echo hello",
      env: {
        B: "two",
        A: "one"
      }
    });

    expect(submit.status).toBe("succeeded");
    expect(submit.summary).toContain("completed");

    const call = fetchFn.mock.calls[0];
    const calledUrl = new URL(String(call?.[0]));
    const init = call?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);

    expect(init?.method).toBe("POST");
    expect(calledUrl.pathname).toBe("/v1/sprites/my-sprite/exec");
    expect(calledUrl.searchParams.getAll("cmd")).toEqual(["sh", "-lc", "echo hello"]);
    expect(calledUrl.searchParams.getAll("env")).toEqual(["A=one", "B=two"]);
    expect(calledUrl.searchParams.get("path")).toBe("sh");
    expect(headers.get("authorization")).toBe("Bearer sprite-token");

    await expect(transport.getJobStatus(submit.externalRef)).resolves.toMatchObject({
      externalRef: submit.externalRef,
      status: "succeeded"
    });

    await expect(transport.getJobResult(submit.externalRef)).resolves.toMatchObject({
      externalRef: submit.externalRef,
      status: "succeeded",
      logsInline: "ok\n"
    });
  });

  it("marks non-zero exit codes as failed", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response("boom", {
          status: 200,
          headers: {
            "x-exit-code": "3"
          }
        })
      )
    });

    const submit = await transport.submitJob({
      phase: "implement",
      runId: "run_1",
      command: "false"
    });

    expect(submit.status).toBe("failed");
    expect(submit.summary).toContain("exit code 3");
  });

  it("maps auth failures", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid token" }), {
          status: 401,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    });

    await expect(
      transport.submitJob({
        phase: "implement",
        runId: "run_1",
        command: "echo test"
      })
    ).rejects.toBeInstanceOf(SpritesAuthError);
  });

  it("maps retryable transport failures", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response("temporarily unavailable", {
          status: 503,
          headers: {
            "content-type": "text/plain"
          }
        })
      )
    });

    await expect(
      transport.submitJob({
        phase: "implement",
        runId: "run_1",
        command: "echo test"
      })
    ).rejects.toBeInstanceOf(SpritesRetryableTransportError);
  });

  it("maps terminal provider failures", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response("invalid payload", {
          status: 400,
          headers: {
            "content-type": "text/plain"
          }
        })
      )
    });

    await expect(
      transport.submitJob({
        phase: "implement",
        runId: "run_1",
        command: "echo test"
      })
    ).rejects.toBeInstanceOf(SpritesProviderError);
  });

  it("rejects unknown external refs", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn()
    });

    await expect(transport.getJobStatus("missing")).rejects.toBeInstanceOf(SpritesProviderError);
    await expect(transport.getJobResult("missing")).rejects.toBeInstanceOf(SpritesProviderError);
  });
});
