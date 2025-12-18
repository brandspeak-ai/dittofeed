import { LoadingButton } from "@mui/lab";
import { Alert, Stack, Typography, useTheme } from "@mui/material";
import backendConfig from "backend-lib/src/config";
import { serialize } from "cookie";
import { UNAUTHORIZED_PAGE } from "isomorphic-lib/src/constants";
import { GetServerSideProps, NextPage } from "next";
import { useEffect, useState } from "react";

import NavCard from "../../components/layout/drawer/drawerContent/navCard";
import {
  AUTH_STATE_COOKIE,
  AUTH_TOKEN_COOKIE,
  buildAuthorizationUrl,
  generateOAuthState,
  getStateCookieOptions,
} from "../../lib/multiTenantAuth";

interface MultiTenantAuthProps {
  authorizationUrl: string;
  error?: string;
  autoLogin?: boolean;
}

export const getServerSideProps: GetServerSideProps<
  MultiTenantAuthProps
> = async (ctx) => {
  if (backendConfig().authMode !== "multi-tenant") {
    return {
      redirect: {
        permanent: false,
        destination: UNAUTHORIZED_PAGE,
      },
    };
  }

  // Check for error from OAuth callback (prevents redirect loop)
  const errorFromCallback = ctx.query.error as string | undefined;

  try {
    // Generate OAuth state for CSRF protection
    const state = generateOAuthState();
    const authorizationUrl = buildAuthorizationUrl(state);

    // Set the state in a cookie for validation on callback
    const cookieOptions = getStateCookieOptions(
      process.env.NODE_ENV === "production",
    );
    ctx.res.setHeader(
      "Set-Cookie",
      serialize(AUTH_STATE_COOKIE, state, cookieOptions),
    );

    // Check if hub_auth_token cookie exists (from BrandSpeak Hub) OR ?auto=true query param
    // If present AND no error from callback, auto-redirect to OAuth flow
    // Don't auto-login if:
    // 1. There was an error from callback (prevents redirect loop on OAuth error)
    // 2. df_auth_token already exists (means OAuth succeeded but session check failed - prevents loop)
    const hubAuthToken = ctx.req.cookies?.hub_auth_token;
    const dfAuthToken = ctx.req.cookies?.[AUTH_TOKEN_COOKIE];
    const autoFromQuery = ctx.query.auto === "true";
    const autoLogin =
      (!!hubAuthToken || autoFromQuery) && !errorFromCallback && !dfAuthToken;

    return {
      props: {
        authorizationUrl,
        autoLogin,
        ...(errorFromCallback && { error: errorFromCallback }),
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to initialize OAuth";
    return {
      props: {
        authorizationUrl: "",
        error: errorMessage,
      },
    };
  }
};

const MultiTenantAuth: NextPage<MultiTenantAuthProps> =
  function MultiTenantAuth({ authorizationUrl, error, autoLogin }) {
    const theme = useTheme();
    const [isRedirecting, setIsRedirecting] = useState(false);

    // Auto-redirect to OAuth flow if hub_auth_token cookie is present
    useEffect(() => {
      if (autoLogin && authorizationUrl && !error && !isRedirecting) {
        setIsRedirecting(true);
        // Small delay to ensure state cookie is set
        setTimeout(() => {
          window.location.href = authorizationUrl;
        }, 100);
      }
    }, [autoLogin, authorizationUrl, error, isRedirecting]);

    const handleLogin = () => {
      if (authorizationUrl) {
        window.location.href = authorizationUrl;
      }
    };

    // Show loading state during auto-redirect
    if (isRedirecting) {
      return (
        <Stack
          sx={{ width: "100%", height: "100vh" }}
          alignItems="center"
          justifyContent="center"
          direction="column"
          spacing={3}
        >
          <NavCard />
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            Signing you in...
          </Typography>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            Redirecting to BrandSpeak for authentication
          </Typography>
        </Stack>
      );
    }

    return (
      <Stack
        sx={{ width: "100%", height: "100vh" }}
        alignItems="center"
        justifyContent="center"
        direction="column"
        spacing={3}
      >
        <NavCard />
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Sign in to Dittofeed
        </Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          Click below to sign in with your BrandSpeak account
        </Typography>
        {error && (
          <Alert severity="error" sx={{ maxWidth: theme.spacing(75) }}>
            {error}
          </Alert>
        )}
        <Stack direction="row" spacing={1} p={3}>
          <LoadingButton
            onClick={handleLogin}
            disabled={!authorizationUrl || !!error}
            sx={{ height: "3.3rem", minWidth: theme.spacing(30) }}
            variant="contained"
          >
            Sign in with BrandSpeak
          </LoadingButton>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </Typography>
      </Stack>
    );
  };

export default MultiTenantAuth;
