import { getCurrentUser } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return ok(null);
    return ok({
      id: user.id,
      email: user.email,
      name: user.name,
      cashBalance: Number(user.cashBalance), // BigInt → number, 否则 JSON 序列化 throw
      lockedCash: Number(user.lockedCash),
    });
  } catch (err) {
    return handle(err);
  }
}
