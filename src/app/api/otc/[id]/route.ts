import { requireUser } from "@/lib/server/auth";
import { cancelListing } from "@/lib/exchange/otc";
import { ok, handle } from "@/lib/server/api";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const listing = await cancelListing(user.id, id);
    return ok(listing);
  } catch (err) {
    return handle(err);
  }
}
