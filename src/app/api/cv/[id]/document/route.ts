import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { cvDocuments } from "@/db/schema";
import { isOpenAccess } from "@/lib/open-access";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isOpenAccess() && !(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value))) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [document] = await getDb().select().from(cvDocuments).where(eq(cvDocuments.variantId, id)).limit(1);
  if (!document) return new Response("No PDF uploaded", { status: 404 });
  const bytes = Buffer.from(document.contentBase64, "base64");
  const disposition = new URL(request.url).searchParams.has("download") ? "attachment" : "inline";
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${document.fileName.replace(/[^a-zA-Z0-9._ -]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}
