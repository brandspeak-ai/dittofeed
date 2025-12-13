import { LoadingButton } from "@mui/lab";
import { Alert, Stack, Typography, useTheme } from "@mui/material";
import backendConfig from "backend-lib/src/config";
import { serialize } from "cookie";
import { UNAUTHORIZED_PAGE } from "isomorphic-lib/src/constants";
import { GetServerSideProps, NextPage } from "next";

import NavCard from "../../components/layout/drawer/drawerContent/navCard";
import {
  AUTH_STATE_COOKIE,
  buildAuthorizationUrl,
  generateOAuthState,
  getStateCookieOptions,
} from "../../lib/multiTenantAuth";

interface MultiTenantAuthProps {
  authorizationUrl: string;
  error?: string;
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

    return {
      props: {
        authorizationUrl,
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
  function MultiTenantAuth({ authorizationUrl, error }) {
    const theme = useTheme();

    const handleLogin = () => {
      if (authorizationUrl) {
        window.location.href = authorizationUrl;
      }
    };

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
