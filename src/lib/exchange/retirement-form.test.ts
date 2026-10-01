import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../http/client";
import {
  displayRetirementReason,
  EMPTY_RETIREMENT_FIELDS,
  isRetirementResult,
  OTHER_REASON,
  RETIREMENT_FIELD_MAX,
  RETIREMENT_REASONS,
  retirementDetails,
  retirementFailure,
  retirementRequest,
  submitRetirement,
  UNREADABLE_RETIREMENT_RESPONSE,
  type RetirementFields,
} from "./retirement-form";
import { retirementOutcomeUncertain } from "./retirement-outcome";

// retirement.ts 顶层引了 Prisma 客户端与发布器;这里只要它的 zod schema,用空壳顶掉数据库(本文件不发任何查询)
vi.mock("../server/db", () => ({ prisma: {} }));

const KEY = "11111111-2222-4333-8444-555555555555";
const fields = (patch: Partial<RetirementFields> = {}): RetirementFields => ({
  ...EMPTY_RETIREMENT_FIELDS,
  quantity: "25",
  reason: "Event Offset",
  beneficiary: "  Acme Corp  ",
  purpose: " Annual meeting ",
  ...patch,
});

describe("retirementDetails (details → review validation)", () => {
  it("accepts a whole amount within the available holdings and trims the text fields", () => {
    expect(retirementDetails("asset-1", 100, fields({ publicMessage: " hello " }))).toEqual({
      ok: true,
      details: { assetId: "asset-1", quantity: 25, reason: "Event Offset", beneficiary: "Acme Corp", purpose: "Annual meeting", publicMessage: "hello" },
    });
  });

  it("caps the amount at the position's available (tradable) quantity", () => {
    expect(retirementDetails("asset-1", 25, fields())).toMatchObject({ ok: true });
    expect(retirementDetails("asset-1", 24, fields())).toEqual({ ok: false, error: "invalidAmount" });
    expect(retirementDetails("asset-1", 0, fields({ quantity: "1" }))).toEqual({ ok: false, error: "invalidAmount" });
  });

  it.each(["", "0", "-3", "2.5", "abc", "1e400", "9007199254740993"])("rejects the amount %j", (quantity) => {
    expect(retirementDetails("asset-1", Number.MAX_SAFE_INTEGER, fields({ quantity }))).toEqual({ ok: false, error: "invalidAmount" });
  });

  it("checks the amount before the text fields, and needs a position", () => {
    expect(retirementDetails("asset-1", 100, fields({ quantity: "0", beneficiary: "" }))).toEqual({ ok: false, error: "invalidAmount" });
    expect(retirementDetails("", 100, fields())).toEqual({ ok: false, error: "invalidAmount" });
  });

  it.each<[string, Partial<RetirementFields>]>([
    ["no reason chosen", { reason: "" }],
    ["Other with a blank custom reason", { reason: OTHER_REASON, customReason: "   " }],
    ["blank beneficiary", { beneficiary: "  " }],
    ["blank purpose", { purpose: "" }],
  ])("reports missing fields: %s", (_name, patch) => {
    expect(retirementDetails("asset-1", 100, fields(patch))).toEqual({ ok: false, error: "missingFields" });
  });

  it('stores a custom reason as "Other: <text>" and ignores the custom text when a preset is chosen', () => {
    const other = retirementDetails("asset-1", 100, fields({ reason: OTHER_REASON, customReason: " learning the flow " }));
    expect(other).toMatchObject({ ok: true, details: { reason: "Other: learning the flow" } });
    const preset = retirementDetails("asset-1", 100, fields({ customReason: "left over from before" }));
    expect(preset).toMatchObject({ ok: true, details: { reason: "Event Offset" } });
  });
});

describe("retirementRequest / the server schema", () => {
  it("adds the idempotency key and the acknowledgement; the server schema accepts the result unchanged", async () => {
    const { retirementInputSchema } = await import("./retirement");
    const checked = retirementDetails("asset-1", 100, fields({ publicMessage: "note" }));
    if (!checked.ok) throw new Error("expected valid details");
    const request = retirementRequest(checked.details, KEY);
    expect(request).toEqual({ ...checked.details, idempotencyKey: KEY, acknowledged: true });
    expect(retirementInputSchema.parse(request)).toEqual(request);
    // crypto.randomUUID() 的形状就是服务端认的请求标识
    expect(retirementInputSchema.safeParse(retirementRequest(checked.details, crypto.randomUUID())).success).toBe(true);
  });

  it("keeps every text field within the server's limits when the inputs are filled to their maxLength", async () => {
    const { retirementInputSchema } = await import("./retirement");
    const full = retirementDetails(
      "asset-1",
      100,
      fields({
        reason: OTHER_REASON,
        customReason: "r".repeat(RETIREMENT_FIELD_MAX.customReason),
        beneficiary: "b".repeat(RETIREMENT_FIELD_MAX.beneficiary),
        purpose: "p".repeat(RETIREMENT_FIELD_MAX.purpose),
        publicMessage: "m".repeat(RETIREMENT_FIELD_MAX.publicMessage),
      }),
    );
    if (!full.ok) throw new Error("expected valid details");
    expect(full.details.reason).toHaveLength(200);
    expect(retirementInputSchema.safeParse(retirementRequest(full.details, KEY)).success).toBe(true);
    // 再多一个字符服务端就拒(输入框的 maxLength 不能比它宽)
    const tooLong = { ...retirementRequest(full.details, KEY), reason: `${full.details.reason}x` };
    expect(retirementInputSchema.safeParse(tooLong).success).toBe(false);
  });

  it("every preset reason is a valid stored reason", async () => {
    const { retirementInputSchema } = await import("./retirement");
    for (const option of RETIREMENT_REASONS.filter((o) => o.value !== OTHER_REASON)) {
      const checked = retirementDetails("asset-1", 100, fields({ reason: option.value }));
      if (!checked.ok) throw new Error(`expected ${option.value} to be valid`);
      expect(retirementInputSchema.safeParse(retirementRequest(checked.details, KEY)).success).toBe(true);
    }
    expect(RETIREMENT_REASONS.map((o) => o.value)).toContain(OTHER_REASON);
    expect(RETIREMENT_REASONS).toHaveLength(6);
  });
});

describe("the old /retirement page", () => {
  it("takes the reason presets from this module (one list for the page and the dialog) and names OTC listings correctly in Chinese", () => {
    const page = readFileSync(fileURLToPath(new URL("../../app/retirement/page.tsx", import.meta.url)), "utf8");
    expect(page).toContain('import { RETIREMENT_REASONS } from "@/lib/exchange/retirement-form";');
    expect(page).not.toMatch(/const RETIREMENT_REASONS\b/);
    // 两处中文原来是乱码「场插件牌」;英文原文是 OTC listings
    expect(page).not.toContain("场插件牌");
    expect(page.match(/场外挂牌/g)).toHaveLength(2);
  });
});

describe("displayRetirementReason", () => {
  it("shows the stored English reason as is in English", () => {
    expect(displayRetirementReason("ESG Commitment", false)).toBe("ESG Commitment");
    expect(displayRetirementReason("Other: learning", false)).toBe("Other: learning");
  });

  it("localises presets and the Other prefix in Chinese, and leaves unknown text alone", () => {
    expect(displayRetirementReason("ESG Commitment", true)).toBe("ESG 承诺");
    expect(displayRetirementReason("Other: learning", true)).toBe("其他：learning");
    expect(displayRetirementReason("Legacy free text", true)).toBe("Legacy free text");
  });
});

describe("submitRetirement", () => {
  afterEach(() => vi.unstubAllGlobals());

  const input = retirementRequest({ assetId: "asset-1", quantity: 5, reason: "Event Offset", beneficiary: "Acme", purpose: "Test", publicMessage: "" }, KEY);
  const RECORD = { id: "ret-1", reference: "SIM-RET-1", certificateUrl: "/api/retirements/ret-1/certificate", quantity: 5, symbol: "VCS-FOR-2021" };

  it("POSTs the request body to /api/retirements and returns the record with the replay flag", async () => {
    const request = vi.fn(async () => ({ retirement: RECORD, replayed: false }));
    const result = await submitRetirement(input, request as never);
    expect(request).toHaveBeenCalledWith("/api/retirements", { method: "POST", body: JSON.stringify(input) });
    expect(result).toEqual({ retirement: RECORD, replayed: false });
    // 重放(200):同一条记录,replayed: true
    expect(await submitRetirement(input, (async () => ({ retirement: RECORD, replayed: true })) as never)).toEqual({ retirement: RECORD, replayed: true });
  });

  it("lets the ApiError through for the caller to classify", async () => {
    const failure = new ApiError("Unavailable", 503);
    await expect(submitRetirement(input, (async () => Promise.reject(failure)) as never)).rejects.toBe(failure);
  });

  it("checks the shape of a success response: id, reference and certificateUrl non-empty strings, quantity a positive whole number", () => {
    expect(isRetirementResult({ retirement: RECORD, replayed: false })).toBe(true);
    expect(isRetirementResult({ retirement: RECORD })).toBe(true); // replayed 缺了不碍事(按 false 算)
    for (const data of [
      undefined,
      null,
      "ok",
      {},
      { retirement: null },
      { retirement: "ret-1" },
      { retirement: { ...RECORD, id: "" } },
      { retirement: { ...RECORD, id: 7 } },
      { retirement: { ...RECORD, reference: undefined } },
      { retirement: { ...RECORD, certificateUrl: "" } },
      { retirement: { ...RECORD, quantity: 0 } },
      { retirement: { ...RECORD, quantity: -5 } },
      { retirement: { ...RECORD, quantity: 2.5 } },
      { retirement: { ...RECORD, quantity: "5" } },
      { retirement: { ...RECORD, quantity: Number.NaN } },
    ]) {
      expect(isRetirementResult(data), JSON.stringify(data)).toBe(false);
    }
  });

  it("a 2xx without a usable record is not a success: it throws a 2xx ApiError, which the outcome check treats as uncertain (same key is retried)", async () => {
    for (const data of [undefined, {}, { retirement: { id: "ret-1" } }, { retirement: { ...RECORD, certificateUrl: "" }, replayed: false }]) {
      const error = await submitRetirement(input, (async () => data) as never).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 200, message: UNREADABLE_RETIREMENT_RESPONSE });
      expect(retirementOutcomeUncertain(error, false)).toBe(true);
    }
  });

  it("through the real api(): a 201 whose data has no retirement is rejected the same way, and a complete one is returned", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, data: { replayed: false } }), { status: 201 }));
    const error = await submitRetirement(input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ status: 200, message: UNREADABLE_RETIREMENT_RESPONSE });
    expect(retirementOutcomeUncertain(error, false)).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, data: { retirement: RECORD, replayed: false } }), { status: 201 }));
    expect((await submitRetirement(input)).retirement).toEqual(RECORD);
  });
});

describe("retirementFailure", () => {
  it("maps the statuses the dialog words itself and leaves the rest to the server's text", () => {
    expect(retirementFailure(401)).toBe("session");
    expect(retirementFailure(409)).toBe("holdingsChanged");
    expect(retirementFailure(429)).toBe("rateLimited");
    for (const status of [0, 400, 500, 503]) expect(retirementFailure(status)).toBe("other");
  });
});
