import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { isOpenAccess } from "@/lib/open-access";
import { isPublicPath } from "@/lib/public-paths";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isOpenAccess()) return pathname === "/login" ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();
  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|design/).*)"],
};
