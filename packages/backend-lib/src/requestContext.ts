import { SpanStatusCode } from "@opentelemetry/api";
import { and, eq, inArray, or } from "drizzle-orm";
import { IncomingHttpHeaders } from "http";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import { err, ok } from "neverthrow";
import { sortBy } from "remeda";

import { decodeJwtHeader } from "./auth";
import config from "./config";
import { db } from "./db";
import {
  workspace as dbWorkspace,
  workspaceMembeAccount as dbWorkspaceMembeAccount,
  workspaceMember as dbWorkspaceMember,
  workspaceMemberRole as dbWorkspaceMemberRole,
} from "./db/schema";
import logger from "./logger";
import { withSpan } from "./openTelemetry";
import { requestContextPostProcessor } from "./requestContextPostProcessor";
import {
  NotOnboardedError,
  OpenIdProfile,
  RequestContextErrorType,
  RequestContextResult,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberResource,
  WorkspaceMemberRole,
  WorkspaceMemberRoleResource,
  WorkspaceResource,
  WorkspaceStatusDb,
  WorkspaceStatusDbEnum,
  WorkspaceTypeApp,
  WorkspaceTypeAppEnum,
} from "./types";
import { isProfileEmailVerified } from "./openIdProfile";

export const SESSION_KEY = "df-session-key";

// Role mapping: Hub role → Dittofeed role
// admin, manager, editor → Admin (full access)
// viewer → Viewer (read-only)
function mapHubRoleToDittofeed(hubRole?: string): "Admin" | "Viewer" {
  switch (hubRole) {
    case "admin":
    case "manager":
    case "editor":
      return "Admin";
    case "viewer":
    default:
      return "Viewer";
  }
}

interface RolesWithWorkspace {
  workspace:
    | (WorkspaceResource & {
        status: WorkspaceStatusDb;
        type: WorkspaceTypeApp;
        parentWorkspaceId: string | null;
      })
    | null;
  memberRoles: WorkspaceMemberRoleResource[];
}

export async function findAndCreateRoles(
  member: WorkspaceMember,
): Promise<RolesWithWorkspace> {
  const domain = member.email?.split("@")[1];

  const workspaces = await db()
    .select()
    .from(dbWorkspace)
    .leftJoin(
      dbWorkspaceMemberRole,
      and(
        eq(dbWorkspaceMemberRole.workspaceId, dbWorkspace.id),
        eq(dbWorkspaceMemberRole.workspaceMemberId, member.id),
      ),
    )
    .where(
      and(
        eq(dbWorkspace.status, WorkspaceStatusDbEnum.Active),
        or(
          eq(dbWorkspaceMemberRole.workspaceMemberId, member.id),
          domain ? eq(dbWorkspace.domain, domain) : undefined,
        ),
      ),
    );

  const domainWorkspacesWithoutRole = workspaces.filter(
    (w) => w.WorkspaceMemberRole === null,
  );
  let roles = workspaces.flatMap((w) => w.WorkspaceMemberRole ?? []);
  if (domainWorkspacesWithoutRole.length !== 0) {
    const newRoles = (
      await Promise.all(
        domainWorkspacesWithoutRole.map((w) =>
          db()
            .insert(dbWorkspaceMemberRole)
            .values({
              workspaceId: w.Workspace.id,
              workspaceMemberId: member.id,
              role: "Admin",
            })
            .onConflictDoNothing()
            .returning(),
        ),
      )
    ).flat();
    logger().debug(
      {
        newRoles,
      },
      "new roles",
    );
    for (const role of newRoles) {
      roles.push(role);
    }
  }

  const workspaceById = workspaces.reduce((acc, w) => {
    acc.set(w.Workspace.id, w.Workspace);
    return acc;
  }, new Map<string, Workspace>());

  const parentWorkspaces = workspaces.filter(
    (w) => w.Workspace.type === WorkspaceTypeAppEnum.Parent,
  );

  if (parentWorkspaces.length !== 0) {
    const childWorkspaces = await db()
      .select()
      .from(dbWorkspace)
      .where(
        and(
          inArray(
            dbWorkspace.parentWorkspaceId,
            parentWorkspaces.map((w) => w.Workspace.id),
          ),
          eq(dbWorkspace.status, WorkspaceStatusDbEnum.Active),
          eq(dbWorkspace.type, WorkspaceTypeAppEnum.Child),
        ),
      );

    const existingRolesByWorkspaceId = roles.reduce((acc, r) => {
      acc.set(r.workspaceId, r);
      return acc;
    }, new Map<string, WorkspaceMemberRole>());

    for (const childWorkspace of childWorkspaces) {
      if (
        existingRolesByWorkspaceId.has(childWorkspace.id) ||
        !childWorkspace.parentWorkspaceId
      ) {
        continue;
      }
      const parentRole = existingRolesByWorkspaceId.get(
        childWorkspace.parentWorkspaceId,
      );
      if (!parentRole) {
        continue;
      }
      workspaceById.set(childWorkspace.id, childWorkspace);
      roles.push({
        ...parentRole,
        workspaceId: childWorkspace.id,
      });
    }
  }

  const memberRoles = roles.flatMap((r) => {
    const workspace = workspaceById.get(r.workspaceId);
    if (!workspace) {
      return [];
    }

    return {
      workspaceId: r.workspaceId,
      role: r.role,
      workspaceMemberId: member.id,
      workspaceName: workspace.name,
    };
  });

  if (member.lastWorkspaceId) {
    const lastWorkspaceRole = roles.find(
      (r) => r.workspaceId === member.lastWorkspaceId,
    );
    const workspace = workspaceById.get(member.lastWorkspaceId);
    if (lastWorkspaceRole && workspace) {
      return { memberRoles, workspace };
    }
  }

  roles = sortBy(roles, (r) => r.createdAt.getTime());
  const role = roles[0];
  if (!role) {
    logger().debug(
      {
        roles,
      },
      "missing role",
    );
    return {
      memberRoles,
      workspace: null,
    };
  }
  const workspace = workspaceById.get(role.workspaceId);

  if (!workspace) {
    logger().debug(
      {
        role,
        workspaces,
      },
      "missing workspace no role found",
    );
    return {
      memberRoles,
      workspace: null,
    };
  }
  return {
    memberRoles,
    workspace,
  };
}

export async function getMultiTenantRequestContext({
  authorizationToken,
  authProvider,
  profile: profileFromContext,
}: {
  authorizationToken: string | null;
  authProvider?: string;
  profile?: OpenIdProfile;
}): Promise<RequestContextResult> {
  if (!authProvider) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: "Misconfigured auth provider, missing.",
    });
  }

  let profile: OpenIdProfile;
  if (profileFromContext) {
    profile = profileFromContext;
  } else {
    if (!authorizationToken) {
      return err({
        type: RequestContextErrorType.NotAuthenticated,
        message: "authorizationToken is missing",
      });
    }
    const decodedJwt = decodeJwtHeader(authorizationToken);

    if (!decodedJwt) {
      return err({
        type: RequestContextErrorType.NotAuthenticated,
        message: "Unable to decode jwt",
      });
    }
    profile = decodedJwt;
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { sub, email, picture, name, nickname } = profile;
  const emailVerified = isProfileEmailVerified(profile);

  if (!emailVerified) {
    return err({
      type: RequestContextErrorType.EmailNotVerified,
      email,
    });
  }

  // eslint-disable-next-line prefer-const
  let [existingMember, account] = await Promise.all([
    db().query.workspaceMember.findFirst({
      where: eq(dbWorkspaceMember.email, email),
      with: {
        workspaceMemberRoles: {
          limit: 1,
          with: {
            workspace: true,
          },
        },
      },
    }),
    db().query.workspaceMembeAccount.findFirst({
      where: and(
        eq(dbWorkspaceMembeAccount.provider, authProvider),
        eq(dbWorkspaceMembeAccount.providerAccountId, sub),
      ),
    }),
  ]);

  let member: WorkspaceMember;
  if (
    !existingMember ||
    existingMember.emailVerified !== emailVerified ||
    existingMember.image !== picture
  ) {
    const [updatedMember] = await db()
      .insert(dbWorkspaceMember)
      .values({
        id: existingMember?.id,
        email,
        emailVerified,
        image: picture,
        name,
        nickname,
      })
      .onConflictDoUpdate({
        target: existingMember
          ? [dbWorkspaceMember.id]
          : [dbWorkspaceMember.email],
        set: {
          emailVerified,
          image: picture,
          name,
          nickname,
        },
      })
      .returning();
    if (!updatedMember) {
      logger().error("Failed to update member", {
        email,
        emailVerified,
        picture,
        name,
        nickname,
      });
      return err({
        type: RequestContextErrorType.ApplicationError,
        message: "Failed to update member",
      });
    }
    member = updatedMember;
  } else {
    member = existingMember;
  }

  if (!account) {
    await db()
      .insert(dbWorkspaceMembeAccount)
      .values({
        provider: authProvider,
        providerAccountId: sub,
        workspaceMemberId: member.id,
      })
      .onConflictDoNothing();
  }
  if (!member.email) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: "User missing email",
    });
  }

  const { workspace, memberRoles } = await findAndCreateRoles(member);

  // If profile has client_id from Hub, prioritize workspace by externalId
  let resolvedWorkspace = workspace;
  let resolvedMemberRoles = memberRoles;
  const { hubWorkspaceAutoCreate } = config();

  if (profile.client_id) {
    logger().debug(
      { clientId: profile.client_id, hubRole: profile.hub_role, hubWorkspaceAutoCreate },
      "Hub client_id present, attempting workspace lookup by externalId",
    );

    const workspaceByExternalId = await db().query.workspace.findFirst({
      where: and(
        eq(dbWorkspace.externalId, profile.client_id),
        eq(dbWorkspace.status, WorkspaceStatusDbEnum.Active),
      ),
    });

    if (workspaceByExternalId) {
      logger().debug(
        {
          workspaceId: workspaceByExternalId.id,
          workspaceName: workspaceByExternalId.name,
          clientId: profile.client_id,
        },
        "Found workspace by externalId (Hub client_id)",
      );

      // Check if member has role in this workspace
      const existingRole = memberRoles.find(
        (r) => r.workspaceId === workspaceByExternalId.id,
      );

      if (!existingRole && hubWorkspaceAutoCreate) {
        // Auto-create role based on Hub role mapping (only if feature flag is enabled)
        const dittofeedRole = mapHubRoleToDittofeed(profile.hub_role);
        logger().info(
          {
            workspaceId: workspaceByExternalId.id,
            memberId: member.id,
            hubRole: profile.hub_role,
            dittofeedRole,
          },
          "Auto-creating member role for Hub workspace",
        );

        await db()
          .insert(dbWorkspaceMemberRole)
          .values({
            workspaceId: workspaceByExternalId.id,
            workspaceMemberId: member.id,
            role: dittofeedRole,
          })
          .onConflictDoNothing();

        resolvedMemberRoles = [
          ...memberRoles,
          {
            workspaceId: workspaceByExternalId.id,
            workspaceName: workspaceByExternalId.name,
            workspaceMemberId: member.id,
            role: dittofeedRole,
          },
        ];
      } else if (!existingRole) {
        logger().debug(
          {
            workspaceId: workspaceByExternalId.id,
            memberId: member.id,
            hubWorkspaceAutoCreate,
          },
          "Skipping auto-creation of member role (feature flag disabled or role exists)",
        );
      }

      resolvedWorkspace = workspaceByExternalId;
    } else {
      logger().debug(
        { clientId: profile.client_id },
        "No workspace found for Hub client_id, falling back to standard resolution",
      );
    }
  }

  if (
    resolvedWorkspace !== null &&
    resolvedWorkspace.status !== WorkspaceStatusDbEnum.Active
  ) {
    return err({
      type: RequestContextErrorType.WorkspaceInactive,
      message: "Workspace is not active",
      workspace: resolvedWorkspace,
    });
  }
  const memberResouce: WorkspaceMemberResource = {
    id: member.id,
    email: member.email,
    emailVerified: member.emailVerified,
    name: member.name ?? undefined,
    nickname: member.nickname ?? undefined,
    picture: member.image ?? undefined,
    createdAt: member.createdAt.toISOString(),
  };

  if (!resolvedWorkspace) {
    return err({
      type: RequestContextErrorType.NotOnboarded,
      message: "User missing role",
      member: memberResouce,
      memberRoles: resolvedMemberRoles,
    } satisfies NotOnboardedError);
  }

  return ok({
    member: memberResouce,
    workspace: {
      id: resolvedWorkspace.id,
      name: resolvedWorkspace.name,
      type: resolvedWorkspace.type,
      parentWorkspaceId: resolvedWorkspace.parentWorkspaceId ?? undefined,
    },
    memberRoles: resolvedMemberRoles,
  });
}

async function getAnonymousRequestContext(): Promise<RequestContextResult> {
  const workspace = await db().query.workspace.findFirst();
  if (!workspace) {
    return err({
      type: RequestContextErrorType.ApplicationError,
      message: `Workspace not found`,
    });
  }
  return ok({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      type: workspace.type,
    },
    member: {
      id: "anonymous",
      email: "anonymous@email.com",
      emailVerified: true,
      createdAt: new Date().toISOString(),
    },
    memberRoles: [
      {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceMemberId: "anonymous",
        role: "Admin",
      },
    ],
  });
}

export async function getRequestContext(
  headers: IncomingHttpHeaders,
  profile?: OpenIdProfile,
): Promise<RequestContextResult> {
  return withSpan({ name: "get-request-context" }, async (span) => {
    const { authMode } = config();
    let result: RequestContextResult;
    switch (authMode) {
      case "anonymous": {
        result = await getAnonymousRequestContext();
        break;
      }
      case "single-tenant": {
        if (headers[SESSION_KEY] !== "true") {
          return err({
            type: RequestContextErrorType.NotAuthenticated,
          });
        }
        result = await getAnonymousRequestContext();
        break;
      }
      case "multi-tenant": {
        const authorizationToken =
          headers.authorization && typeof headers.authorization === "string"
            ? headers.authorization
            : null;

        result = await getMultiTenantRequestContext({
          authorizationToken,
          authProvider: config().authProvider,
          profile,
        });

        result = await requestContextPostProcessor().postProcessor(result);
        break;
      }
    }
    if (result.isOk()) {
      const { id: memberId, email: memberEmail } = result.value.member;
      const { id: workspaceId, name: workspaceName } = result.value.workspace;

      const memberRoles = result.value.memberRoles.flatMap((r) =>
        r.workspaceId === workspaceId ? r.role : [],
      );
      span.setAttributes({
        memberId,
        memberEmail,
        workspaceId,
        workspaceName,
        memberRoles,
      });
      return result;
    }
    switch (result.error.type) {
      // TODO handle when users can request access to a workspace that they
      // currently are not authorized to access
      case RequestContextErrorType.Unauthorized: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          memberEmail: result.error.member.email,
          memberId: result.error.member.id,
          workspaceId: result.error.workspace.id,
          workspaceName: result.error.workspace.name,
        });
        break;
      }
      case RequestContextErrorType.NotOnboarded: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          memberEmail: result.error.member.email,
          memberId: result.error.member.id,
        });
        break;
      }
      case RequestContextErrorType.ApplicationError: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
        });
        break;
      }
      case RequestContextErrorType.EmailNotVerified: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.type,
        });
        span.setAttributes({
          type: result.error.type,
          email: result.error.email,
        });
        break;
      }
      case RequestContextErrorType.NotAuthenticated: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.type,
        });
        span.setAttributes({
          type: result.error.type,
        });
        break;
      }
      case RequestContextErrorType.WorkspaceInactive: {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttributes({
          type: result.error.type,
          workspaceId: result.error.workspace.id,
          workspaceName: result.error.workspace.name,
        });
        break;
      }
      default:
        assertUnreachable(result.error);
    }
    return result;
  });
}
