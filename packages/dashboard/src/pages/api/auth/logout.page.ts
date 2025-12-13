import backendConfig from "backend-lib/src/config";
import { serialize } from "cookie";
import type { NextApiRequest, NextApiResponse } from "next";

import { AUTH_TOKEN_COOKIE } from "../../../lib/multiTenantAuth";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only handle GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check auth mode
  if (backendConfig().authMode !== "multi-tenant") {
    return res.status(404).json({ error: "Not found" });
  }

  const isProduction = process.env.NODE_ENV === "production";

  // Clear the auth token cookie
  res.setHeader(
    "Set-Cookie",
    serialize(AUTH_TOKEN_COOKIE, "", {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
  );

  // Redirect to login page
  return res.redirect("/dashboard/auth/multi-tenant");
}
