import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../http/client";
import { retirementOutcomeUncertain } from "./retirement-outcome";

afterEach(() => vi.unstubAllGlobals());

async function responseError(status: number, body: string): Promise<ApiError> {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
  try {
    await api("/api/retirements", { method: "POST" });
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected the response to fail");
}

describe("retirement request outcome", () => {
  it("keeps the same request locked when a committed response is truncated", async () => {
    const error = await responseError(201, '{"ok":true,"data":');
    expect(retirementOutcomeUncertain(error, false)).toBe(true);
  });

  it.each([401, 429])("does not unlock an uncertain request when a retry returns %i", async (status) => {
    const firstError = await responseError(503, '{"ok":false,"error":"Unavailable"}');
    const uncertain = retirementOutcomeUncertain(firstError, false);
    const retryError = await responseError(status, '{"ok":false,"error":"Request rejected"}');
    expect(retirementOutcomeUncertain(retryError, uncertain)).toBe(true);
  });

  it("allows correction after the first request is definitively rejected", async () => {
    const error = await responseError(400, '{"ok":false,"error":"Invalid quantity"}');
    expect(retirementOutcomeUncertain(error, false)).toBe(false);
  });

  it("keeps an interrupted network request locked", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Connection interrupted"); });
    const error = await api("/api/retirements", { method: "POST" }).catch((failure: unknown) => failure);
    expect(retirementOutcomeUncertain(error, false)).toBe(true);
  });
});
