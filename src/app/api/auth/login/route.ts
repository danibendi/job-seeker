import { compare } from "bcryptjs";
import { and, eq, gte, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { loginAttempts } from "@/db/schema";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";

function requestIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: NextRequest) {
  const ip = requestIp(request);
  const db = getDb();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [failures] = await db.select({ count: sql<number>`count(*)::int` }).from(loginAttempts).where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, 0), gte(loginAttempts.createdAt, since)));
  if ((failures?.count ?? 0) >= 8) return NextResponse.json({ error: "Too many attempts. Try again in an hour." }, { status: 429 });

  const body = await request.json().catch(() => ({})) as { password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (!hash) return NextResponse.json({ error: "Login is not configured." }, { status: 503 });

  const valid = await compare(password, hash);
  await db.insert(loginAttempts).values({ ip, success: valid ? 1 : 0 });
  if (!valid) return NextResponse.json({ error: "That password didn’t work. Please try again." }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions);
  return response;
}
