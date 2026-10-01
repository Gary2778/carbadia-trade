import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../http/client";
import type { RetirementInput, RetirementRecord } from "../exchange/retirement";
import type { RetirementResult } from "../exchange/retirement-form";
import { canEditRetirement, canSubmitRetirement, INITIAL_RETIRE_FLOW, type RetireAction } from "./retire-flow";
import { clearRetireFlows, dispatchRetireFlow, holdsRetireOutcome, retireFlowOf, submitRetireFlow, subscribeRetireFlows, watchRetireFlow } from "./retire-flow-store";

// 注销流程的模块级存放处(node 环境)。「挂载 / 卸载」= watchRetireFlow 与它返回的解除函数(RetireDialog 经 useRetireFlow 在 effect 里调用);
// 提交用注入的假实现,结果由测试决定何时、以什么回来。

const A = "asset-1";
const B = "asset-2";
const RECORD = { id: "ret-1", reference: "SIM-RET-1", certificateUrl: "/api/retirements/ret-1/certificate", quantity: 40 } as RetirementRecord;
const OK: RetirementResult = { retirement: RECORD, replayed: false };

const FILL: RetireAction[] = [
  { type: "field", name: "quantity", value: "40" },
  { type: "field", name: "reason", value: "Event Offset" },
  { type: "field", name: "beneficiary", value: "Acme Corp" },
  { type: "field", name: "purpose", value: "Annual meeting" },
];
/** 填写 → 复核(定下幂等键)→ 勾选确认 */
function toReady(assetId: string, idempotencyKey: string): void {
  for (const action of FILL) dispatchRetireFlow(assetId, action);
  dispatchRetireFlow(assetId, { type: "review", assetId, available: 100, idempotencyKey });
  dispatchRetireFlow(assetId, { type: "acknowledge", value: true });
}

/** 结果由测试放行的提交;calls 记下每次发出去的请求对象 */
function deferredSubmit() {
  const calls: RetirementInput[] = [];
  let settle: { resolve: (result: RetirementResult) => void; reject: (error: unknown) => void } | null = null;
  const submit = (input: RetirementInput) => {
    calls.push(input);
    return new Promise<RetirementResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return { calls, submit, resolve: (result: RetirementResult = OK) => settle?.resolve(result), reject: (error: unknown) => settle?.reject(error) };
}
const failing = (error: unknown) => async () => Promise.reject(error);
const succeeding = (calls: RetirementInput[] = []) => async (input: RetirementInput) => {
  calls.push(input);
  return OK;
};

beforeEach(() => clearRetireFlows());

describe("retire flow store: while a dialog is mounted", () => {
  it("starts from the initial flow and keeps every step per asset", () => {
    const unwatch = watchRetireFlow(A);
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    toReady(A, "key-0001");
    expect(retireFlowOf(A)).toMatchObject({ step: "review", acknowledged: true, request: { assetId: A, quantity: 40, idempotencyKey: "key-0001" } });
    // 另一个持仓是另一份
    expect(retireFlowOf(B)).toBe(INITIAL_RETIRE_FLOW);
    unwatch();
  });

  it("notifies subscribers on every change, and not when an action changes nothing", () => {
    const unwatch = watchRetireFlow(A);
    const listener = vi.fn();
    const stop = subscribeRetireFlows(listener);
    dispatchRetireFlow(A, { type: "field", name: "quantity", value: "5" });
    expect(listener).toHaveBeenCalledTimes(1);
    dispatchRetireFlow(A, { type: "edit" }); // 不在复核:无变化
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    dispatchRetireFlow(A, { type: "field", name: "quantity", value: "6" });
    expect(listener).toHaveBeenCalledTimes(1);
    unwatch();
  });

  it("submits only what can be submitted, once: no acknowledgement → nothing sent; a second call while in flight → nothing sent", async () => {
    const unwatch = watchRetireFlow(A);
    const pending = deferredSubmit();
    expect(submitRetireFlow(A, pending.submit)).toBeNull(); // 还在填写
    for (const action of FILL) dispatchRetireFlow(A, action);
    dispatchRetireFlow(A, { type: "review", assetId: A, available: 100, idempotencyKey: "key-0001" });
    expect(submitRetireFlow(A, pending.submit)).toBeNull(); // 没勾确认
    dispatchRetireFlow(A, { type: "acknowledge", value: true });
    const first = submitRetireFlow(A, pending.submit);
    expect(first).not.toBeNull();
    expect(retireFlowOf(A).busy).toBe(true);
    expect(submitRetireFlow(A, pending.submit)).toBeNull(); // 在途:双击不发第二次
    expect(pending.calls).toHaveLength(1);
    pending.resolve();
    expect(await first).toEqual({ ok: true, retirement: RECORD });
    // 有组件在看:回执留着,看完(reset)才清
    expect(retireFlowOf(A)).toMatchObject({ step: "receipt", receipt: RECORD, request: null });
    dispatchRetireFlow(A, { type: "reset" });
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    unwatch();
  });

  it("a definite rejection stays on the review step for the mounted dialog to show", async () => {
    const unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    const outcome = await submitRetireFlow(A, failing(new ApiError("Insufficient available holdings.", 409)));
    expect(outcome).toEqual({ ok: false, uncertain: false, error: { message: "Insufficient available holdings.", status: 409, conflictAfterUncertain: false } });
    expect(retireFlowOf(A)).toMatchObject({ step: "review", uncertain: false, submitError: { status: 409 } });
    unwatch();
  });
});

describe("retire flow store: what survives unmounting", () => {
  it("drops a flow whose outcome is settled when the last viewer leaves: half-filled details, an unsubmitted review, a rejection, a receipt", async () => {
    // 填到一半
    let unwatch = watchRetireFlow(A);
    dispatchRetireFlow(A, FILL[0]);
    unwatch();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    // 没提交的复核:键还没用过,丢了无妨
    unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    unwatch();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    // 明确被拒
    unwatch = watchRetireFlow(A);
    toReady(A, "key-0002");
    await submitRetireFlow(A, failing(new ApiError("Insufficient available holdings.", 409)));
    unwatch();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    // 回执
    unwatch = watchRetireFlow(A);
    toReady(A, "key-0003");
    await submitRetireFlow(A, succeeding());
    expect(retireFlowOf(A).step).toBe("receipt");
    unwatch();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
  });

  it("keeps the state while another viewer of the same asset is still mounted, and unwatching twice counts once", () => {
    const first = watchRetireFlow(A);
    const second = watchRetireFlow(A);
    dispatchRetireFlow(A, FILL[0]);
    first();
    first();
    expect(retireFlowOf(A).fields.quantity).toBe("40");
    second();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
  });

  it("an uncertain review survives unmounting: the same request object and key, Edit still locked, and the retry sends that very request", async () => {
    let unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    const request = retireFlowOf(A).request;
    const outcome = await submitRetireFlow(A, failing(new ApiError("The account is busy.", 503)));
    expect(outcome).toEqual({ ok: false, uncertain: true, error: { message: "The account is busy.", status: 503, conflictAfterUncertain: false } });
    const before = retireFlowOf(A);
    expect(holdsRetireOutcome(before)).toBe(true);

    unwatch(); // 换底部页签 / 在别的行点「注销」/ 持仓行消失:对话框卸载
    expect(retireFlowOf(A)).toBe(before);

    // 别的持仓此时照常是一份新的
    const other = watchRetireFlow(B);
    toReady(B, "key-other");
    expect(retireFlowOf(B).request?.idempotencyKey).toBe("key-other");
    other();
    expect(retireFlowOf(A)).toBe(before);

    unwatch = watchRetireFlow(A); // 回来再点同一持仓的「注销」
    const restored = retireFlowOf(A);
    expect(restored).toMatchObject({ step: "review", uncertain: true, acknowledged: true, busy: false });
    expect(restored.request).toBe(request);
    expect(restored.request?.idempotencyKey).toBe("key-0001");
    expect(canEditRetirement(restored)).toBe(false);
    expect(dispatchRetireFlow(A, { type: "edit" })).toBe(restored);
    // 再点「复核」也换不了键:不在填写步骤,动作不生效
    expect(dispatchRetireFlow(A, { type: "review", assetId: A, available: 100, idempotencyKey: "key-0002" })).toBe(restored);
    expect(canSubmitRetirement(restored)).toBe(true);

    const sent: RetirementInput[] = [];
    expect(await submitRetireFlow(A, succeeding(sent))).toEqual({ ok: true, retirement: RECORD });
    expect(sent).toEqual([request]);
    expect(sent[0]).toBe(request);
    expect(retireFlowOf(A)).toMatchObject({ step: "receipt", uncertain: false, request: null });
    unwatch();
    // 成功了结:键不再留着
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
  });

  it("a request in flight survives unmounting and its result lands without the component: success clears the flow", async () => {
    const unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    const pending = deferredSubmit();
    const settled = submitRetireFlow(A, pending.submit);
    unwatch();
    expect(retireFlowOf(A)).toMatchObject({ step: "review", busy: true, request: { idempotencyKey: "key-0001" } });
    // 在途期间再挂上来:看到的是在途的那一份,不能再提交一次
    const back = watchRetireFlow(A);
    expect(submitRetireFlow(A, pending.submit)).toBeNull();
    back();
    pending.resolve();
    expect(await settled).toEqual({ ok: true, retirement: RECORD });
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    expect(pending.calls).toHaveLength(1);
  });

  it("… an uncertain result stays, with its key, for the next mount", async () => {
    const unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    const request = retireFlowOf(A).request;
    const pending = deferredSubmit();
    const settled = submitRetireFlow(A, pending.submit);
    unwatch();
    pending.reject(new ApiError("Failed to fetch", 0));
    expect(await settled).toMatchObject({ ok: false, uncertain: true });
    const kept = retireFlowOf(A);
    expect(kept).toMatchObject({ step: "review", busy: false, uncertain: true });
    expect(kept.request).toBe(request);
    // 没人看的时候直接重试(下次挂载后用户点「确认」)仍是同一个请求
    const again = watchRetireFlow(A);
    const sent: RetirementInput[] = [];
    await submitRetireFlow(A, succeeding(sent));
    expect(sent[0]).toBe(request);
    again();
  });

  it("… a definite rejection clears the flow, and the settlement still tells the caller what to say", async () => {
    const unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    const pending = deferredSubmit();
    const settled = submitRetireFlow(A, pending.submit);
    unwatch();
    pending.reject(new ApiError("Insufficient available holdings.", 409));
    expect(await settled).toEqual({ ok: false, uncertain: false, error: { message: "Insufficient available holdings.", status: 409, conflictAfterUncertain: false } });
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
  });

  it("a 409 on the retry of an uncertain request releases it: kept for a mounted dialog (editable), cleared when nobody is watching", async () => {
    // 对话框挂着:留在复核,已解锁
    let unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    await submitRetireFlow(A, failing(new ApiError("Unavailable", 503)));
    const conflict = await submitRetireFlow(A, failing(new ApiError("Insufficient available holdings.", 409)));
    expect(conflict).toEqual({ ok: false, uncertain: false, error: { message: "Insufficient available holdings.", status: 409, conflictAfterUncertain: true } });
    expect(retireFlowOf(A)).toMatchObject({ step: "review", uncertain: false, submitError: { conflictAfterUncertain: true } });
    expect(canEditRetirement(retireFlowOf(A))).toBe(true);
    // 回去改、再复核:新键
    dispatchRetireFlow(A, { type: "edit" });
    dispatchRetireFlow(A, { type: "review", assetId: A, available: 100, idempotencyKey: "key-0002" });
    expect(retireFlowOf(A).request?.idempotencyKey).toBe("key-0002");
    unwatch();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);

    // 没人看的时候重试的结果回来:不再是不确定 → 了结
    unwatch = watchRetireFlow(B);
    toReady(B, "key-0003");
    await submitRetireFlow(B, failing(new ApiError("Unavailable", 503)));
    const pending = deferredSubmit();
    const settled = submitRetireFlow(B, pending.submit);
    unwatch();
    pending.reject(new ApiError("Insufficient available holdings.", 409));
    expect(await settled).toMatchObject({ ok: false, uncertain: false, error: { conflictAfterUncertain: true } });
    expect(retireFlowOf(B)).toBe(INITIAL_RETIRE_FLOW);
  });
});

describe("retire flow store: sign-out", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("clearRetireFlows drops everything, uncertain flows included, and tells subscribers", async () => {
    const unwatch = watchRetireFlow(A);
    toReady(A, "key-0001");
    await submitRetireFlow(A, failing(new ApiError("Unavailable", 503)));
    unwatch();
    expect(retireFlowOf(A).uncertain).toBe(true);
    const listener = vi.fn();
    const stop = subscribeRetireFlows(listener);
    clearRetireFlows();
    expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
    expect(listener).toHaveBeenCalledTimes(1);
    clearRetireFlows(); // 已经空了:不再通知
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("a result that comes back after the flows were cleared is not applied and not reported (it belongs to the previous user)", async () => {
    for (const settle of [(p: ReturnType<typeof deferredSubmit>) => p.resolve(), (p: ReturnType<typeof deferredSubmit>) => p.reject(new ApiError("Unavailable", 503))]) {
      const unwatch = watchRetireFlow(A);
      toReady(A, "key-0001");
      const pending = deferredSubmit();
      const settled = submitRetireFlow(A, pending.submit);
      clearRetireFlows();
      settle(pending);
      expect(await settled).toBeNull();
      expect(retireFlowOf(A)).toBe(INITIAL_RETIRE_FLOW);
      unwatch();
    }
  });

  it("is wired to the account store in the browser: sign-out, session loss or a different user clears the flows; a balance update does not", async () => {
    // 模块级订阅只在浏览器里挂(typeof window):给一个 window,重新加载这组模块
    vi.stubGlobal("window", {});
    vi.resetModules();
    const account = await import("./account-store");
    const store = await import("./retire-flow-store");
    const ME = { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 100_000, lockedCash: 0 };
    const makeUncertain = async () => {
      const unwatch = store.watchRetireFlow(A);
      for (const action of FILL) store.dispatchRetireFlow(A, action);
      store.dispatchRetireFlow(A, { type: "review", assetId: A, available: 100, idempotencyKey: "key-0001" });
      store.dispatchRetireFlow(A, { type: "acknowledge", value: true });
      await store.submitRetireFlow(A, failing(new ApiError("Unavailable", 503)));
      unwatch();
      expect(store.retireFlowOf(A).uncertain).toBe(true);
    };

    account.useAccountStore.setState({ me: ME, status: "ready" });
    await makeUncertain();
    // 同一位用户的余额变化:不清
    account.useAccountStore.setState({ me: { ...ME, cashBalance: 5 } });
    expect(store.retireFlowOf(A).uncertain).toBe(true);
    // 登出 / 会话失效
    account.useAccountStore.setState({ me: null, status: "anon" });
    expect(store.retireFlowOf(A).step).toBe("details");
    expect(store.retireFlowOf(A).request).toBeNull();

    // 换号
    account.useAccountStore.setState({ me: ME, status: "ready" });
    await makeUncertain();
    account.useAccountStore.setState({ me: { ...ME, id: "u2" } });
    expect(store.retireFlowOf(A).request).toBeNull();
    expect(store.retireFlowOf(A).uncertain).toBe(false);
  });
});

describe("holdsRetireOutcome", () => {
  it("is true only while the outcome is pending or unknown", () => {
    expect(holdsRetireOutcome(INITIAL_RETIRE_FLOW)).toBe(false);
    expect(holdsRetireOutcome({ ...INITIAL_RETIRE_FLOW, busy: true })).toBe(true);
    expect(holdsRetireOutcome({ ...INITIAL_RETIRE_FLOW, uncertain: true })).toBe(true);
  });
});
