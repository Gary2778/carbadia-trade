/** 带 HTTP 状态码的请求错误：调用方可按状态区分处理（如 401 → 引导登录）；网络层失败无状态码，用 0 表示 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError((e as Error).message, 0);
  }
  const json = await res.json().catch(() => ({ ok: false, error: "Failed to parse response" }));
  if (!res.ok || !json.ok) {
    throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status);
  }
  return json.data as T;
}
