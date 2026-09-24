import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const call = (path: string[], search = "") =>
  GET(new Request(`http://localhost/api/real/${path.join("/")}${search}`), { params: Promise.resolve({ path }) });

describe("GET /api/real/[...path]", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("非白名单路径 404,不碰上游", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(["co2"]);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功时透传 JSON 并加 5 分钟缓存头", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://carbadia.io/api/real/projects?registry=verra");
        return new Response('{"ok":true,"data":[1]}', { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const res = await call(["projects"], "?registry=verra");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe('{"ok":true,"data":[1]}');
  });

  it("上游非 2xx → 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const res = await call(["overview"]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "registry data unavailable" });
  });

  it("上游抛错(超时/断网)→ 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = await call(["overview"]);
    expect(res.status).toBe(502);
  });
});
