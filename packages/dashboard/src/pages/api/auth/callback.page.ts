import backendConfig from "backend-lib/src/config";
import logger from "backend-lib/src/logger";
import { serialize } from "cookie";
import type { NextApiRequest, NextApiResponse } from "next";

import {
  AUTH_STATE_COOKIE,
  AUTH_TOKEN_COOKIE,
  exchangeCodeForTokens,
  fetchUserInfo,
  generateJwtToken,
  getAuthCookieOptions,
  userInfoToOpenIdProfile,
} from "../../../lib/multiTenantAuth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // Only handle GET requests (OAuth callback)
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check auth mode
  if (backendConfig().authMode !== "multi-tenant") {
    return res.status(404).json({ error: "Not found" });
  }

  const { code, state, error, error_description: errorDescription } = req.query;

  // Handle OAuth errors
  if (error) {
    logger().error(
      {
        error,
        errorDescription,
      },
      "OAuth error returned",
    );
    return res.redirect(
      `/dashboard/auth/multi-tenant?error=${encodeURIComponent(
        String(errorDescription || error),
      )}`,
    );
  }

  // Validate code
  if (typeof code !== "string") {
    logger().error("Missing authorization code in callback");
    return res.redirect(
      "/dashboard/auth/multi-tenant?error=Missing+authorization+code",
    );
  }

  // Validate state for CSRF protection
  const storedState = req.cookies[AUTH_STATE_COOKIE];
  if (typeof state !== "string" || state !== storedState) {
    logger().error(
      {
        state,
        storedState,
      },
      "Invalid OAuth state",
    );
    return res.redirect(
      "/dashboard/auth/multi-tenant?error=Invalid+state+parameter",
    );
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    // Fetch user info
    const userInfo = await fetchUserInfo(tokens.access_token);

    // Convert to OpenIdProfile
    const profile = userInfoToOpenIdProfile(userInfo);

    // Get secret key for JWT signing
    const { secretKey } = backendConfig();
    if (!secretKey) {
      throw new Error("SECRET_KEY must be configured for multi-tenant auth");
    }

    // Generate JWT token
    const jwtToken = generateJwtToken(profile, secretKey);

    // Set cookies
    const isProduction = process.env.NODE_ENV === "production";
    const cookies = [
      // Set the auth token
      serialize(
        AUTH_TOKEN_COOKIE,
        jwtToken,
        getAuthCookieOptions(isProduction),
      ),
      // Clear the state cookie
      serialize(AUTH_STATE_COOKIE, "", {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    ];

    res.setHeader("Set-Cookie", cookies);

    logger().info(
      {
        email: profile.email,
        sub: profile.sub,
      },
      "User authenticated successfully",
    );

    // Redirect to dashboard
    return res.redirect("/dashboard");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    logger().error(
      {
        error: err,
      },
      "OAuth callback failed",
    );
    return res.redirect(
      `/dashboard/auth/multi-tenant?error=${encodeURIComponent(errorMessage)}`,
    );
  }
}
