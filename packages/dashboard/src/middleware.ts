import { NextRequest, NextResponse } from "next/server";

const AUTH_TOKEN_COOKIE = "df_auth_token";
const DASHBOARD_BASE_PATH = "/dashboard";
const PUBLIC_PATHS_WITHOUT_BASE_PATH = [
  "/auth/multi-tenant",
  "/api/auth/callback",
  "/api/auth/logout",
  "/public/",
  "/_next/",
  "/favicon.ico",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pathnameWithoutBasePath = pathname.startsWith(DASHBOARD_BASE_PATH)
    ? pathname.slice(DASHBOARD_BASE_PATH.length) || "/"
    : pathname;

  // Skip middleware for public paths
  if (
    PUBLIC_PATHS_WITHOUT_BASE_PATH.some((path) =>
      pathnameWithoutBasePath.startsWith(path),
    )
  ) {
    return NextResponse.next();
  }

  // Get the JWT token from the cookie
  const token = request.cookies.get(AUTH_TOKEN_COOKIE)?.value;

  // Clone the request headers and add Authorization if token exists
  const requestHeaders = new Headers(request.headers);

  if (token) {
    requestHeaders.set("Authorization", `Bearer ${token}`);
  } else {
    requestHeaders.delete("Authorization");
  }

  // Return response with modified headers
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
