import { requireUser } from "@/lib/server/auth";
import { fail, handle } from "@/lib/server/api";
import { getRetirement, renderRetirementCertificate } from "@/lib/exchange/retirement";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const record = await getRetirement(user.id, id);
    if (!record) return fail("Simulation certificate not found", 404);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(renderRetirementCertificate(record), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${record.reference}.html"`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return handle(error);
  }
}
