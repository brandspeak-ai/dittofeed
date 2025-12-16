import { and, eq } from "drizzle-orm";
import { err, ok, Result } from "neverthrow";
import { ChannelType, SubscriptionGroupType } from "isomorphic-lib/src/types";

import { getOrCreateWriteKey } from "../auth";
import { DEFAULT_WRITE_KEY_NAME } from "../constants";
import { db, insert, QueryError, upsert } from "../db";
import { workspace as dbWorkspace } from "../db/schema";
import logger from "../logger";
import { createWorkspaceMemberRole } from "../rbac";
import { upsertSubscriptionGroup } from "../subscriptionGroups";

export async function createWorkspace(
  values: typeof dbWorkspace.$inferInsert,
): Promise<Result<typeof dbWorkspace.$inferSelect, QueryError>> {
  logger().debug(
    {
      values,
    },
    "creating workspace",
  );
  return insert({
    table: dbWorkspace,
    values,
    doNothingOnConflict: true,
    lookupExisting: eq(dbWorkspace.name, values.name),
  });
}

export async function upsertWorkspace(
  values: typeof dbWorkspace.$inferInsert,
): Promise<Result<typeof dbWorkspace.$inferSelect, QueryError>> {
  if (
    values.domain === undefined &&
    values.externalId === undefined &&
    values.type === undefined &&
    values.status === undefined &&
    values.parentWorkspaceId === undefined
  ) {
    return insert({
      table: dbWorkspace,
      values,
      doNothingOnConflict: true,
      lookupExisting: eq(dbWorkspace.name, values.name),
    });
  }
  return upsert({
    table: dbWorkspace,
    values,
    target: [dbWorkspace.parentWorkspaceId, dbWorkspace.name],
    set: {
      domain: values.domain,
      type: values.type,
      externalId: values.externalId,
      status: values.status,
      parentWorkspaceId: values.parentWorkspaceId,
    },
  });
}

export interface ProvisionHubWorkspaceParams {
  name: string;
  externalId: string;
  parentWorkspaceId: string;
  adminEmail?: string;
}

export interface ProvisionHubWorkspaceResult {
  workspace: typeof dbWorkspace.$inferSelect;
  writeKey: string;
  existed: boolean;
}

export type ProvisionHubWorkspaceError =
  | { type: "MISSING_PARENT_WORKSPACE_ID" }
  | { type: "WORKSPACE_CREATION_FAILED"; message: string }
  | { type: "UNKNOWN_ERROR"; error: unknown };

/**
 * Provision a Hub workspace (idempotent).
 * Creates workspace with externalId, default WriteKey, default SubscriptionGroup,
 * and optionally an admin member.
 */
export async function provisionHubWorkspace(
  params: ProvisionHubWorkspaceParams,
): Promise<Result<ProvisionHubWorkspaceResult, ProvisionHubWorkspaceError>> {
  const { name, externalId, parentWorkspaceId, adminEmail } = params;

  if (!parentWorkspaceId) {
    return err({ type: "MISSING_PARENT_WORKSPACE_ID" });
  }

  logger().info(
    { parentWorkspaceId, externalId, name, adminEmail },
    "Hub workspace provisioning request",
  );

  try {
    // 1. Check if workspace exists by externalId under this parent (idempotent)
    const existing = await db().query.workspace.findFirst({
      where: and(
        eq(dbWorkspace.externalId, externalId),
        eq(dbWorkspace.parentWorkspaceId, parentWorkspaceId),
      ),
    });

    if (existing) {
      // Return existing workspace (idempotent)
      const writeKeyResource = await getOrCreateWriteKey({
        workspaceId: existing.id,
        writeKeyName: DEFAULT_WRITE_KEY_NAME,
      });

      logger().info(
        { workspaceId: existing.id, externalId, existed: true },
        "Returning existing workspace (idempotent)",
      );

      return ok({
        workspace: existing,
        writeKey: writeKeyResource.writeKeyValue,
        existed: true,
      });
    }

    // 2. Create new child workspace
    const [newWorkspace] = await db()
      .insert(dbWorkspace)
      .values({
        name,
        externalId,
        parentWorkspaceId,
        type: "Child",
        status: "Active",
      })
      .returning();

    if (!newWorkspace) {
      return err({
        type: "WORKSPACE_CREATION_FAILED",
        message: "Insert returned no workspace",
      });
    }

    // 3. Create default WriteKey
    const writeKeyResource = await getOrCreateWriteKey({
      workspaceId: newWorkspace.id,
      writeKeyName: DEFAULT_WRITE_KEY_NAME,
    });

    // 4. Create default SubscriptionGroup for Email
    await upsertSubscriptionGroup({
      workspaceId: newWorkspace.id,
      name: "Default",
      type: SubscriptionGroupType.OptOut,
      channel: ChannelType.Email,
    });

    // 5. Create admin member if adminEmail provided
    if (adminEmail) {
      try {
        await createWorkspaceMemberRole({
          workspaceId: newWorkspace.id,
          email: adminEmail,
          role: "Admin",
        });
        logger().info(
          { workspaceId: newWorkspace.id, adminEmail },
          "Created admin member for Hub workspace",
        );
      } catch (e) {
        logger().warn(
          { error: e, workspaceId: newWorkspace.id, adminEmail },
          "Failed to create admin member for Hub workspace",
        );
      }
    }

    logger().info(
      { workspaceId: newWorkspace.id, externalId, parentWorkspaceId },
      "Created new workspace for Hub client",
    );

    return ok({
      workspace: newWorkspace,
      writeKey: writeKeyResource.writeKeyValue,
      existed: false,
    });
  } catch (e: unknown) {
    // Handle unique constraint violation (race condition)
    const error = e as { code?: string };
    if (error.code === "23505") {
      logger().info(
        { externalId },
        "Race condition: workspace created by another request",
      );
      // Return existing workspace
      const existing = await db().query.workspace.findFirst({
        where: and(
          eq(dbWorkspace.externalId, externalId),
          eq(dbWorkspace.parentWorkspaceId, parentWorkspaceId),
        ),
      });
      if (existing) {
        const writeKeyResource = await getOrCreateWriteKey({
          workspaceId: existing.id,
          writeKeyName: DEFAULT_WRITE_KEY_NAME,
        });
        return ok({
          workspace: existing,
          writeKey: writeKeyResource.writeKeyValue,
          existed: true,
        });
      }
    }
    logger().error({ error: e, externalId }, "Failed to create workspace");
    return err({ type: "UNKNOWN_ERROR", error: e });
  }
}
