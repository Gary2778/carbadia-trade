import { destroySession } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";

export async function POST() {
  try {
    await destroySession();
    return ok({ loggedOut: true });
  } catch (err) {
    return handle(err);
  }
}
