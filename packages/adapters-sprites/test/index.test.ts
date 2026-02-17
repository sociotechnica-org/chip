import { describe, expect, it, vi } from "vitest";
import {
  SpritesAuthError,
  SpritesConfigError,
  SpritesProviderError,
  SpritesRetryableTransportError,
  createSpritesExecutionTransport,
  loadSpritesAuthConfigFromEnv
} from "../src/index";

type Listener = (event: unknown) => void;

class MockWebSocket {
  public binaryType = "arraybuffer";
  public readyState = 0;
  public readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    error: [],
    close: []
  };

  public constructor(
    public readonly url: string,
    public readonly init: { headers: Record<string, string> }
  ) {}

  public addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    this.listeners[type].push(listener);
  }

  public send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "" });
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  public message(data: unknown): void {
    this.emit("message", { data });
  }

  public fail(): void {
    this.emit("error", {});
  }

  private emit(type: "open" | "message" | "error" | "close", payload: unknown): void {
    for (const listener of this.listeners[type]) {
      listener(payload);
    }
  }
}

function stdoutFrame(value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  const frame = new Uint8Array(body.length + 1);
  frame[0] = 1;
  frame.set(body, 1);
  return frame;
}

function exitFrame(code: number): Uint8Array {
  return new Uint8Array([3, code]);
}

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

describe("WebSocket sprites transport", () => {
  const auth = {
    token: "sprite-token",
    spriteName: "my-sprite",
    apiBaseUrl: "https://api.sprites.dev",
    timeoutMs: 200
  };

  it("uses provider session ids and sends env via stdin frames", async () => {
    const sockets: MockWebSocket[] = [];
    const transport = createSpritesExecutionTransport({
      auth,
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"type":"session_info","session_id":"sess_123"}');
          socket.message(stdoutFrame("ok\n"));
          socket.message(exitFrame(0));
        });
        return socket;
      }
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

    expect(submit.externalRef).toBe("sess_123");
    expect(submit.status).toBe("succeeded");
    expect(submit.summary).toContain("completed");

    const socket = sockets[0];
    const calledUrl = new URL(socket.url);
    expect(calledUrl.pathname).toBe("/v1/sprites/my-sprite/exec");
    expect(calledUrl.searchParams.get("cc")).toBe("true");
    expect(calledUrl.searchParams.get("detachable")).toBe("true");
    expect(calledUrl.searchParams.getAll("env")).toEqual([]);
    expect(socket.init.headers.authorization).toBe("Bearer sprite-token");

    const stdinFrame = socket.sent[0];
    expect(stdinFrame).toBeInstanceOf(Uint8Array);
    const stdinBody = new TextDecoder().decode((stdinFrame as Uint8Array).subarray(1));
    expect(stdinBody).toContain("A=one");
    expect(stdinBody).toContain("B=two");
    expect(stdinBody).toContain("__SPRITES_ENV_DONE__");

    const eofFrame = socket.sent[1];
    expect(Array.from(eofFrame as Uint8Array)).toEqual([4]);
  });

  it("marks non-zero exit codes as failed", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"type":"session_info","session_id":"sess_404"}');
          socket.message(stdoutFrame("boom"));
          socket.message(exitFrame(3));
        });
        return socket;
      }
    });

    const submit = await transport.submitJob({
      phase: "implement",
      runId: "run_1",
      command: "false"
    });

    expect(submit.status).toBe("failed");
    expect(submit.summary).toContain("exit code 3");
  });

  it("returns running status when an attached session does not exit before timeout", async () => {
    const transport = createSpritesExecutionTransport({
      auth: {
        ...auth,
        timeoutMs: 20
      },
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"type":"session_info","session_id":"sess_live"}');
        });
        return socket;
      }
    });

    const result = await transport.getJobResult("sess_live");
    expect(result.status).toBe("running");
    expect(result.externalRef).toBe("sess_live");
  });

  it("maps auth failures from session list lookup", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid token" }), {
          status: 401,
          headers: {
            "content-type": "application/json"
          }
        })
      ),
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"error":"session not found: missing"}');
        });
        return socket;
      }
    });

    await expect(transport.getJobResult("missing")).rejects.toBeInstanceOf(SpritesAuthError);
  });

  it("maps retryable transport failures from session list lookup", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response("temporarily unavailable", {
          status: 503,
          headers: {
            "content-type": "text/plain"
          }
        })
      ),
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"error":"session not found: missing"}');
        });
        return socket;
      }
    });

    await expect(transport.getJobResult("missing")).rejects.toBeInstanceOf(
      SpritesRetryableTransportError
    );
  });

  it("rejects unknown external refs", async () => {
    const transport = createSpritesExecutionTransport({
      auth,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ count: 0, sessions: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      ),
      webSocketFactory: (url, init) => {
        const socket = new MockWebSocket(url, init);
        queueMicrotask(() => {
          socket.open();
          socket.message('{"error":"session not found: missing"}');
        });
        return socket;
      }
    });

    await expect(transport.getJobResult("missing")).rejects.toBeInstanceOf(SpritesProviderError);
  });

  it("calls default global fetch without rebinding this", async () => {
    const originalFetch = globalThis.fetch;
    const seenThisValues: unknown[] = [];
    const fetchStub = vi.fn(function (this: unknown) {
      seenThisValues.push(this);
      return Promise.resolve(
        new Response(JSON.stringify({ count: 0, sessions: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      );
    }) as unknown as typeof fetch;

    Object.defineProperty(globalThis, "fetch", {
      value: fetchStub,
      configurable: true,
      writable: true
    });

    try {
      const transport = createSpritesExecutionTransport({
        auth,
        webSocketFactory: (url, init) => {
          const socket = new MockWebSocket(url, init);
          queueMicrotask(() => {
            socket.open();
            socket.message('{"error":"session not found: missing"}');
          });
          return socket;
        }
      });

      await expect(transport.getJobResult("missing")).rejects.toBeInstanceOf(SpritesProviderError);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(seenThisValues[0]).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        value: originalFetch,
        configurable: true,
        writable: true
      });
    }
  });
});
