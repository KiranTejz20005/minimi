import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch, SafeFetchError, type Transport, type TransportRequest } from "../src/tools/safe-fetch.js";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const resolvePublic = async () => PUBLIC;

function bodyOf(...parts: (string | Buffer)[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const p of parts) yield Buffer.from(p);
  })();
}

type Step = { status?: number; headers?: Record<string, string>; body?: AsyncIterable<Uint8Array> };

function scripted(steps: Record<string, Step>, seen: TransportRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    const s = steps[req.url.href];
    if (!s) throw new Error(`unexpected connect to ${req.url.href}`);
    return {
      status: s.status ?? 200,
      headers: { "content-type": "text/html", ...(s.headers ?? {}) },
      body: s.body ?? bodyOf("ok"),
      destroy() {},
    };
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`;
  }
  return "none";
}

describe("safeFetch: scheme / credentials", () => {
  it("rejects non-http schemes and credentials before any connection", async () => {
    const seen: TransportRequest[] = [];
    const transport = scripted({}, seen);
    expect(await code(safeFetch("file:///etc/passwd", { transport, resolve: resolvePublic }))).toBe("scheme");
    expect(await code(safeFetch("ftp://example.com/", { transport, resolve: resolvePublic }))).toBe("scheme");
    expect(await code(safeFetch("https://user:pw@example.com/", { transport, resolve: resolvePublic }))).toBe("credentials");
    expect(await code(safeFetch("not a url", { transport, resolve: resolvePublic }))).toBe("invalid_url");
    expect(seen).toHaveLength(0);
  });
});

describe("safeFetch: redirects", () => {
  it("follows a public redirect chain and pins the validated address", async () => {
    const seen: TransportRequest[] = [];
    const transport = scripted(
      {
        "https://a.example/": { status: 302, headers: { location: "/b" } },
        "https://a.example/b": { body: bodyOf("hello") },
      },
      seen,
    );
    const r = await safeFetch("https://a.example/", { transport, resolve: resolvePublic });
    expect(r.body.toString()).toBe("hello");
    expect(r.url).toBe("https://a.example/b");
    expect(r.redirects).toBe(1);
    expect(seen.every((q) => q.address.address === "93.184.216.34")).toBe(true);
  });

  for (const target of [
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/",
    "http://2130706433/",
    "file:///etc/passwd",
  ]) {
    it(`never connects to redirect target ${target}`, async () => {
      const seen: TransportRequest[] = [];
      const transport = scripted({ "https://a.example/": { status: 301, headers: { location: target } } }, seen);
      const c = await code(safeFetch("https://a.example/", { transport, resolve: resolvePublic }));
      expect(["blocked", "scheme"]).toContain(c);
      expect(seen.map((q) => q.url.href)).toEqual(["https://a.example/"]);
    });
  }

  it("blocks a redirect to a hostname that resolves privately", async () => {
    const seen: TransportRequest[] = [];
    const resolve = async (h: string) => (h === "evil.example" ? [{ address: "10.0.0.7", family: 4 }] : PUBLIC);
    const transport = scripted({ "https://a.example/": { status: 302, headers: { location: "https://evil.example/" } } }, seen);
    expect(await code(safeFetch("https://a.example/", { transport, resolve }))).toBe("blocked");
    expect(seen).toHaveLength(1);
  });

  it("caps redirect hops", async () => {
    const steps: Record<string, Step> = {};
    for (let i = 0; i < 10; i++) steps[`https://a.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    expect(await code(safeFetch("https://a.example/0", { transport: scripted(steps), resolve: resolvePublic, maxRedirects: 5 }))).toBe("redirects");
  });
});

describe("safeFetch: DNS rebinding", () => {
  it("resolves once per hop and connects to the validated address, never re-resolving", async () => {
    let calls = 0;
    // public on 1st lookup, private on any later lookup (classic rebinding)
    const resolve = async () => (++calls === 1 ? PUBLIC : [{ address: "127.0.0.1", family: 4 }]);
    const seen: TransportRequest[] = [];
    const r = await safeFetch("https://rebind.example/", { transport: scripted({ "https://rebind.example/": {} }, seen), resolve });
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
    expect(seen[0]!.address.address).toBe("93.184.216.34");
  });

  it("rejects when the first answer already contains a private address", async () => {
    const resolve = async () => [PUBLIC[0]!, { address: "192.168.0.9", family: 4 }];
    expect(await code(safeFetch("https://mixed.example/", { transport: scripted({}), resolve }))).toBe("blocked");
  });
});

describe("safeFetch: body limits and deadlines", () => {
  it("aborts a streamed body once the cap is exceeded", async () => {
    let pulled = 0;
    let destroyed = false;
    const body = (async function* () {
      for (let i = 0; i < 1000; i++) {
        pulled++;
        yield Buffer.alloc(1000, 97);
      }
    })();
    const transport: Transport = async () => ({ status: 200, headers: {}, body, destroy: () => { destroyed = true; } });
    expect(await code(safeFetch("https://a.example/", { transport, resolve: resolvePublic, maxBytes: 5000 }))).toBe("too_large");
    expect(pulled).toBeLessThan(10);
    expect(destroyed).toBe(true);
  });

  it("rejects early on an oversized content-length", async () => {
    const transport = scripted({ "https://a.example/": { headers: { "content-length": "9999999" } } });
    expect(await code(safeFetch("https://a.example/", { transport, resolve: resolvePublic, maxBytes: 1000 }))).toBe("too_large");
  });

  it("cuts a slow-drip body at the total deadline", async () => {
    const body = (async function* () {
      for (;;) {
        await new Promise((r) => setTimeout(r, 30));
        yield Buffer.from("x");
      }
    })();
    const transport: Transport = async () => ({ status: 200, headers: {}, body, destroy() {} });
    const t0 = Date.now();
    expect(await code(safeFetch("https://a.example/", { transport, resolve: resolvePublic, timeoutMs: 150 }))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("cuts a body that never yields", async () => {
    const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) as AsyncIterator<Uint8Array> };
    const transport: Transport = async () => ({ status: 200, headers: {}, body, destroy() {} });
    expect(await code(safeFetch("https://a.example/", { transport, resolve: resolvePublic, timeoutMs: 100 }))).toBe("timeout");
  });

  it("honours caller cancellation", async () => {
    const ac = new AbortController();
    const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) as AsyncIterator<Uint8Array> };
    const transport: Transport = async () => ({ status: 200, headers: {}, body, destroy() {} });
    const p = safeFetch("https://a.example/", { transport, resolve: resolvePublic, signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 30);
    expect(await code(p)).toBe("aborted");
  });

  it("hides internal error details from transport failures", async () => {
    const transport: Transport = async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:22"); };
    try {
      await safeFetch("https://a.example/", { transport, resolve: resolvePublic });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("request failed");
    }
  });
});

describe("safeFetch: real node transport against a local server (allowPrivate, test only)", () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  it("is blocked by default", async () => {
    const port = await start((_q, s) => s.end("secret"));
    expect(await code(safeFetch(`http://127.0.0.1:${port}/`))).toBe("blocked");
  });

  it("fetches with allowPrivate and sets identity encoding", async () => {
    let enc = "";
    const port = await start((q, s) => {
      enc = String(q.headers["accept-encoding"]);
      s.setHeader("content-type", "text/plain");
      s.end("hi there");
    });
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(r.body.toString()).toBe("hi there");
    expect(r.contentType).toBe("text/plain");
    expect(enc).toBe("identity");
  });

  it("pins the connection to the injected resolver answer (Host header keeps the name)", async () => {
    let host = "";
    const port = await start((q, s) => {
      host = String(q.headers.host);
      s.end("pinned");
    });
    const r = await safeFetch(`http://pinned.example:${port}/`, {
      allowPrivate: true,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(r.body.toString()).toBe("pinned");
    expect(host).toBe(`pinned.example:${port}`);
  });

  it("follows real redirects hop by hop", async () => {
    const port = await start((q, s) => {
      if (q.url === "/") {
        s.statusCode = 302;
        s.setHeader("location", "/dest");
        s.end();
      } else s.end("arrived");
    });
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(r.body.toString()).toBe("arrived");
    expect(r.redirects).toBe(1);
  });
});
