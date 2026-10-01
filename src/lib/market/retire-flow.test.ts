import { describe, expect, it } from "vitest";
import { ApiError } from "../http/client";
import type { RetirementRecord } from "../exchange/retirement";
import { canEditRetirement, canSubmitRetirement, INITIAL_RETIRE_FLOW, reduceRetireFlow, retirementFailureOutcome, type RetireAction, type RetireFlow } from "./retire-flow";

const run = (actions: RetireAction[], from: RetireFlow = INITIAL_RETIRE_FLOW): RetireFlow => actions.reduce(reduceRetireFlow, from);

const FILL: RetireAction[] = [
  { type: "field", name: "quantity", value: "40" },
  { type: "field", name: "reason", value: "Event Offset" },
  { type: "field", name: "beneficiary", value: "Acme Corp" },
  { type: "field", name: "purpose", value: "Annual meeting" },
];
const review = (idempotencyKey: string, available = 100): RetireAction => ({ type: "review", assetId: "asset-1", available, idempotencyKey });
const RECORD = { id: "ret-1", reference: "SIM-RET-1", quantity: 40 } as RetirementRecord;

describe("reduceRetireFlow: details → review", () => {
  it("starts on the details step with empty fields", () => {
    expect(INITIAL_RETIRE_FLOW).toMatchObject({ step: "details", request: null, acknowledged: false, busy: false, uncertain: false, receipt: null });
  });

  it("builds the request with the idempotency key when the details pass, and needs the acknowledgement before it can be submitted", () => {
    const flow = run([...FILL, review("key-0001")]);
    expect(flow.step).toBe("review");
    expect(flow.request).toEqual({
      assetId: "asset-1",
      quantity: 40,
      reason: "Event Offset",
      beneficiary: "Acme Corp",
      purpose: "Annual meeting",
      publicMessage: "",
      idempotencyKey: "key-0001",
      acknowledged: true,
    });
    expect(canSubmitRetirement(flow)).toBe(false);
    expect(reduceRetireFlow(flow, { type: "submit" })).toBe(flow); // 没勾确认:提交动作不生效
    expect(canSubmitRetirement(reduceRetireFlow(flow, { type: "acknowledge", value: true }))).toBe(true);
  });

  it("stays on details with the validation error, and clears it on the next edit", () => {
    const over = run([...FILL, review("key-0001", 39)]);
    expect(over).toMatchObject({ step: "details", formError: "invalidAmount", request: null });
    const missing = run([{ type: "field", name: "quantity", value: "5" }, review("key-0001")]);
    expect(missing).toMatchObject({ step: "details", formError: "missingFields" });
    expect(reduceRetireFlow(over, { type: "field", name: "quantity", value: "39" }).formError).toBeNull();
  });

  it("uses the available quantity at the moment of review (the position can change while the form is open)", () => {
    const filled = run(FILL);
    expect(reduceRetireFlow(filled, review("key-0001", 40)).step).toBe("review");
    expect(reduceRetireFlow(filled, review("key-0001", 10)).formError).toBe("invalidAmount");
  });
});

describe("reduceRetireFlow: submitting", () => {
  const ready = run([...FILL, review("key-0001"), { type: "acknowledge", value: true }]);

  it("marks the request in flight and ignores a second submit, edits and acknowledgement changes meanwhile", () => {
    const busy = reduceRetireFlow(ready, { type: "submit" });
    expect(busy.busy).toBe(true);
    expect(canSubmitRetirement(busy)).toBe(false);
    expect(reduceRetireFlow(busy, { type: "submit" })).toBe(busy);
    expect(reduceRetireFlow(busy, { type: "edit" })).toBe(busy);
    expect(reduceRetireFlow(busy, { type: "acknowledge", value: false })).toBe(busy);
    expect(reduceRetireFlow(busy, { type: "field", name: "quantity", value: "1" })).toBe(busy);
  });

  it("moves to the receipt on success and drops the request", () => {
    const done = run([{ type: "submit" }, { type: "succeeded", retirement: RECORD }], ready);
    expect(done).toMatchObject({ step: "receipt", receipt: RECORD, request: null, busy: false, uncertain: false, submitError: null });
  });

  it("an uncertain failure (network, 5xx, unreadable 2xx) keeps the very same request for the retry and locks editing", () => {
    for (const error of [new ApiError("Failed to fetch", 0), new ApiError("The account is busy.", 503), new ApiError("Failed to parse response", 201), new TypeError("boom")]) {
      const failed = run([{ type: "submit" }, { type: "failed", error }], ready);
      expect(failed).toMatchObject({ step: "review", busy: false, uncertain: true, acknowledged: true });
      expect(failed.request).toBe(ready.request); // 同一个请求对象:同一个 idempotencyKey、同一份明细
      expect(canEditRetirement(failed)).toBe(false);
      expect(reduceRetireFlow(failed, { type: "edit" })).toBe(failed);
      expect(canSubmitRetirement(failed)).toBe(true);
      // 重试仍带同一个键;这次成功 → 回执
      const retried = run([{ type: "submit" }], failed);
      expect(retried.request?.idempotencyKey).toBe("key-0001");
      expect(run([{ type: "succeeded", retirement: RECORD }], retried).step).toBe("receipt");
    }
  });

  it("records the server's text and status for the error line", () => {
    const failed = run([{ type: "submit" }, { type: "failed", error: new ApiError("Available holdings changed. Refresh and review the amount again.", 409) }], ready);
    expect(failed.submitError).toEqual({ message: "Available holdings changed. Refresh and review the amount again.", status: 409, conflictAfterUncertain: false });
    const thrown = run([{ type: "submit" }, { type: "failed", error: new TypeError("boom") }], ready);
    expect(thrown.submitError).toEqual({ message: "boom", status: null, conflictAfterUncertain: false });
  });

  it("a later definite rejection does not unlock a request whose first outcome is unknown", () => {
    const failed = run([{ type: "submit" }, { type: "failed", error: new ApiError("Unavailable", 503) }, { type: "submit" }, { type: "failed", error: new ApiError("Too many requests", 429) }], ready);
    expect(failed.uncertain).toBe(true);
    expect(failed.request?.idempotencyKey).toBe("key-0001");
    expect(canEditRetirement(failed)).toBe(false);
  });

  it("a 409 on the retry of an uncertain request releases the lock: no longer uncertain, flagged for its own sentence, editable, new key on the next review", () => {
    const uncertain = run([{ type: "submit" }, { type: "failed", error: new ApiError("Unavailable", 503) }], ready);
    expect(uncertain.uncertain).toBe(true);
    for (const message of [
      "Insufficient available holdings. Credits locked in sell orders or OTC listings cannot be retired.",
      "Available holdings changed. Refresh and review the amount again.",
      "This request identifier was already used with different retirement details",
    ]) {
      const conflict = run([{ type: "submit" }, { type: "failed", error: new ApiError(message, 409) }], uncertain);
      expect(conflict).toMatchObject({ step: "review", busy: false, uncertain: false, acknowledged: true });
      expect(conflict.submitError).toEqual({ message, status: 409, conflictAfterUncertain: true });
      expect(conflict.request).toBe(ready.request); // 还没改之前,请求与键原样
      expect(canEditRetirement(conflict)).toBe(true);
      expect(canSubmitRetirement(conflict)).toBe(true);
      const edited = reduceRetireFlow(conflict, { type: "edit" });
      expect(edited).toMatchObject({ step: "details", request: null, submitError: null, uncertain: false });
      expect(edited.fields.beneficiary).toBe("Acme Corp");
      const again = run([{ type: "field", name: "quantity", value: "10" }, review("key-0002")], edited);
      expect(again.request).toMatchObject({ quantity: 10, idempotencyKey: "key-0002" });
      expect(again.uncertain).toBe(false);
    }
  });

  it("after the release, a further 409 on the same request is an ordinary rejection; a further network failure locks it again", () => {
    const released = run(
      [{ type: "submit" }, { type: "failed", error: new ApiError("Unavailable", 503) }, { type: "submit" }, { type: "failed", error: new ApiError("Insufficient available holdings.", 409) }],
      ready,
    );
    const again = run([{ type: "submit" }, { type: "failed", error: new ApiError("Insufficient available holdings.", 409) }], released);
    expect(again).toMatchObject({ uncertain: false, submitError: { status: 409, conflictAfterUncertain: false } });
    const dropped = run([{ type: "submit" }, { type: "failed", error: new ApiError("Failed to fetch", 0) }], released);
    expect(dropped.uncertain).toBe(true);
    expect(canEditRetirement(dropped)).toBe(false);
    expect(dropped.request?.idempotencyKey).toBe("key-0001");
  });

  it("retirementFailureOutcome: only a 409 after an uncertain attempt releases; every other later failure stays uncertain", () => {
    expect(retirementFailureOutcome(new ApiError("x", 409), true)).toEqual({ uncertain: false, submitError: { message: "x", status: 409, conflictAfterUncertain: true } });
    expect(retirementFailureOutcome(new ApiError("x", 409), false)).toEqual({ uncertain: false, submitError: { message: "x", status: 409, conflictAfterUncertain: false } });
    for (const status of [0, 200, 400, 401, 429, 500, 503]) {
      expect(retirementFailureOutcome(new ApiError("x", status), true), String(status)).toEqual({ uncertain: true, submitError: { message: "x", status, conflictAfterUncertain: false } });
    }
    expect(retirementFailureOutcome(new TypeError("boom"), true)).toEqual({ uncertain: true, submitError: { message: "boom", status: null, conflictAfterUncertain: false } });
    expect(retirementFailureOutcome("text", false)).toEqual({ uncertain: true, submitError: { message: "text", status: null, conflictAfterUncertain: false } });
  });

  it("a definite rejection (4xx) allows editing; the next review takes a new key", () => {
    const rejected = run([{ type: "submit" }, { type: "failed", error: new ApiError("Insufficient available holdings.", 409) }], ready);
    expect(rejected).toMatchObject({ step: "review", uncertain: false });
    expect(canEditRetirement(rejected)).toBe(true);
    const edited = reduceRetireFlow(rejected, { type: "edit" });
    expect(edited).toMatchObject({ step: "details", request: null, submitError: null, acknowledged: false });
    expect(edited.fields.beneficiary).toBe("Acme Corp"); // 填过的内容留着
    const again = run([{ type: "field", name: "quantity", value: "10" }, review("key-0002")], edited);
    expect(again.request).toMatchObject({ quantity: 10, idempotencyKey: "key-0002" });
    expect(again.acknowledged).toBe(false);
  });

  it("ignores a result that arrives when nothing is in flight", () => {
    expect(reduceRetireFlow(ready, { type: "succeeded", retirement: RECORD })).toBe(ready);
    expect(reduceRetireFlow(ready, { type: "failed", error: new ApiError("late", 500) })).toBe(ready);
  });
});

describe("reduceRetireFlow: after the receipt", () => {
  const done = run([...FILL, { type: "field", name: "publicMessage", value: "note" }, review("key-0001"), { type: "acknowledge", value: true }, { type: "submit" }, { type: "succeeded", retirement: RECORD }]);

  it("retire more: back to details with the amount cleared and the other fields kept", () => {
    const next = reduceRetireFlow(done, { type: "again" });
    expect(next).toMatchObject({ step: "details", receipt: null, request: null, acknowledged: false });
    expect(next.fields).toEqual({ ...done.fields, quantity: "" });
    // 下一笔是新的请求,新的键
    expect(run([{ type: "field", name: "quantity", value: "5" }, review("key-0002")], next).request?.idempotencyKey).toBe("key-0002");
  });

  it("reset returns the initial state", () => {
    expect(reduceRetireFlow(done, { type: "reset" })).toBe(INITIAL_RETIRE_FLOW);
  });

  it("again only applies on the receipt step", () => {
    const filled = run(FILL);
    expect(reduceRetireFlow(filled, { type: "again" })).toBe(filled);
  });
});
