import { requireUser } from "@/lib/server/auth";
import { fail, handle, ok, parseBody } from "@/lib/server/api";
import { rateLimit } from "@/lib/server/rate-limit";
import { listRetirements, retireCredits, retirementInputSchema, retirementRecord, RetirementError } from "@/lib/exchange/retirement";

const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const user = await requireUser();
    return ok(await listRetirements(user.id), { headers: privateHeaders });
  } catch (error) {
    return handle(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!rateLimit(`retirement:${user.id}`, 20, 60_000)) return fail("Too many requests. Please retry later.", 429);
    const body = await parseBody(request, retirementInputSchema);
    const result = await retireCredits(user.id, body);
    return ok({ retirement: retirementRecord(result.retirement), replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: privateHeaders });
  } catch (error) {
    return error instanceof RetirementError ? fail(error.message, error.status) : handle(error);
  }
}
