import { randomBytes } from "crypto";
import { createSigner } from "fast-jwt";

// Cookie name for storing the JWT token
export const AUTH_TOKEN_COOKIE = "df_auth_token";
export const AUTH_STATE_COOKIE = "df_oauth_state";

// OAuth configuration - these should be set via environment variables
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  redirectUri: string;
  scope: string;
}

export function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  const authorizationUrl =
    process.env.OAUTH_AUTHORIZATION_URL ||
    "https://hub.aws.brandspeak.ai/oauth2/authorize";
  const tokenUrl =
    process.env.OAUTH_TOKEN_URL || "https://hub.aws.brandspeak.ai/oauth2/token";
  const userInfoUrl =
    process.env.OAUTH_USERINFO_URL ||
    "https://hub.aws.brandspeak.ai/oauth2/userinfo";
  const redirectUri =
    process.env.OAUTH_REDIRECT_URI ||
    "https://template.brandspeak.ai/dashboard/api/auth/callback";
  const scope = process.env.OAUTH_SCOPE || "openid profile email";

  if (!clientId || !clientSecret) {
    throw new Error(
      "OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be configured for multi-tenant auth",
    );
  }

  return {
    clientId,
    clientSecret,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
    redirectUri,
    scope,
  };
}

// Generate a random state for CSRF protection
export function generateOAuthState(): string {
  return randomBytes(32).toString("hex");
}

// Build the OAuth authorization URL
export function buildAuthorizationUrl(state: string): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
  });
  return `${config.authorizationUrl}?${params.toString()}`;
}

// User info response from brandspeak-hub
export interface UserInfoResponse {
  sub: string;
  email: string;
  name?: string;
  organizations?: {
    id: string;
    name: string;
    role: string;
  }[];
  // Hub client context for multi-tenant workspace resolution
  client_id?: string;
  client_name?: string;
  role?: string; // Hub role (admin, manager, editor, viewer)
  external_mappings?: {
    dittofeed?: { workspace_id: string };
    postiz?: { organization_id: string };
  };
}

// Token response from OAuth provider
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

// Exchange authorization code for tokens
export async function exchangeCodeForTokens(
  code: string,
): Promise<TokenResponse> {
  const config = getOAuthConfig();

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Fetch user info from OAuth provider
export async function fetchUserInfo(
  accessToken: string,
): Promise<UserInfoResponse> {
  const config = getOAuthConfig();

  const response = await fetch(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch user info: ${response.status} - ${errorText}`,
    );
  }

  return response.json();
}

// OpenIdProfile that Dittofeed expects
export interface OpenIdProfile {
  sub: string;
  email: string;
  email_verified: boolean | "true" | "false";
  picture?: string;
  name?: string;
  nickname?: string;
  // Hub claims for client-centric multi-tenancy
  client_id?: string;
  hub_role?: string;
}

// Generate a JWT token with OpenIdProfile claims
// Note: Dittofeed's backend uses fast-jwt decoder which doesn't verify signatures
// So we can use a simple signing approach
export function generateJwtToken(
  profile: OpenIdProfile,
  secretKey: string,
  expiresInSeconds: number = 24 * 60 * 60, // 24 hours default
): string {
  const signer = createSigner({
    key: secretKey,
    algorithm: "HS256",
    expiresIn: expiresInSeconds * 1000, // fast-jwt expects milliseconds
  });

  return signer(profile);
}

// Convert UserInfoResponse to OpenIdProfile
export function userInfoToOpenIdProfile(
  userInfo: UserInfoResponse,
): OpenIdProfile {
  return {
    sub: userInfo.sub,
    email: userInfo.email,
    email_verified: true, // Assume verified if they went through brandspeak-hub auth
    name: userInfo.name,
    nickname: userInfo.name?.split(" ")[0], // Use first name as nickname
    // Hub claims for client-centric workspace resolution
    client_id: userInfo.client_id,
    hub_role: userInfo.role,
  };
}

// Cookie options for secure storage
export function getAuthCookieOptions(secure = true) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 24 * 60 * 60, // 24 hours in seconds
  };
}

export function getStateCookieOptions(secure = true) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 10 * 60, // 10 minutes for state
  };
}
