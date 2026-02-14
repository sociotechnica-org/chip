import { describe, expect, it, vi } from "vitest";
import {
  ModalAuthError,
  ModalConfigError,
  ModalProviderError,
  ModalRetryableTransportError,
  createModalExecutionTransport,
  loadModalAuthConfigFromEnv
} from "../src/index";

describe("loadModalAuthConfigFromEnv", () => {
  it("requires Modal token configuration", () => {
    expect(() =>
      loadModalAuthConfigFromEnv({
        MODAL_TOKEN_SECRET: "secret"
      })
    ).toThrowError(ModalConfigError);

    expect(() =>
      loadModalAuthConfigFromEnv({
        MODAL_TOKEN_ID: "id"
      })
    ).toThrowError(ModalConfigError);
  });

  it("uses defaults and trims env values", () => {
    const config = loadModalAuthConfigFromEnv({
      MODAL_TOKEN_ID: "  token-id  ",
      MODAL_TOKEN_SECRET: "  token-secret  ",
      MODAL_API_BASE_URL: "https://modal.example.com/v2///",
      MODAL_TIMEOUT_MS: "15000"
    });

    expect(config).toEqual({
      tokenId: "token-id",
      tokenSecret: "token-secret",
      apiBaseUrl: "https://modal.example.com/v2",
      timeoutMs: 15000
    });
  });
});

describe("Http modal transport", () => {
  const auth = {
    tokenId: "token-id",
    tokenSecret: "token-secret",
    apiBaseUrl: "https://modal.example.com",
    timeoutMs: 5000
  };

  it("sends auth headers when submitting jobs", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "job_123", status: "queued" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );

    const transport = createModalExecutionTransport({
      auth,
      fetchFn
    });

    await transport.submitJob({
      phase: "implement",
      runId: "run_1",
      command: "implement: fix issue"
    });

    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe("https://modal.example.com/jobs");

    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("Modal-Key")).toBe("token-id");
    expect(headers.get("Modal-Secret")).toBe("token-secret");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("maps auth failures", async () => {
    const transport = createModalExecutionTransport({
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
        command: "implement"
      })
    ).rejects.toBeInstanceOf(ModalAuthError);
  });

  it("maps retryable transport failures", async () => {
    const transport = createModalExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    });

    await expect(transport.getJobStatus("job_1")).rejects.toBeInstanceOf(
      ModalRetryableTransportError
    );
  });

  it("maps terminal provider failures", async () => {
    const transport = createModalExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid payload" }), {
          status: 400,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    });

    await expect(transport.getJobResult("job_1")).rejects.toBeInstanceOf(ModalProviderError);
  });

  it("rejects invalid status payloads", async () => {
    const transport = createModalExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "job_1", status: "unknown" }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    });

    await expect(transport.getJobStatus("job_1")).rejects.toBeInstanceOf(ModalProviderError);
  });
});
