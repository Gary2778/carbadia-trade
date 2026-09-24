import { ApiError } from "../http/client";

export function retirementOutcomeUncertain(
  error: unknown,
  previouslyUncertain: boolean,
): boolean {
  // A later rejection cannot prove that an earlier attempt did not commit.
  // Successful HTTP responses with unreadable bodies also require the same key.
  return previouslyUncertain ||
    !(error instanceof ApiError) ||
    error.status === 0 ||
    (error.status >= 200 && error.status < 300) ||
    error.status >= 500;
}
