import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { getOrCreateWriteKey } from "backend-lib/src/auth";
import { DEFAULT_WRITE_KEY_NAME } from "backend-lib/src/constants";
import { db } from "backend-lib/src/db";
import { workspace as dbWorkspace } from "backend-lib/src/db/schema";
import logger from "backend-lib/src/logger";
import { upsertSubscriptionGroup } from "backend-lib/src/subscriptionGroups";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { and, eq } from "drizzle-orm";
import { writeKeyToHeader } from "isomorphic-lib/src/auth";
import {
  BadRequestResponse,
  ChannelType,
  CreateWorkspaceFromHubRequest,
  CreateWorkspaceFromHubResponse,
  SubscriptionGroupType,
} from "isomorphic-lib/src/types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function workspacesAdminController(
  fastify: DittofeedFastifyInstance,
) {
  // POST /api/admin/workspaces - Create child workspace from Hub
  // Auth: Requires parent workspace's admin API key (via adminAuth middleware)
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/",
    {
      schema: {
        description:
          "Create a child workspace for Hub client provisioning (idempotent). " +
          "Uses parent workspace API key for authentication. " +
          "externalId = Hub client_id UUID ensures uniqueness, name is human-readable.",
        tags: ["Workspaces", "Admin", "Hub"],
        body: CreateWorkspaceFromHubRequest,
        response: {
          200: CreateWorkspaceFromHubResponse,
          201: CreateWorkspaceFromHubResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { name, externalId, adminEmail } = request.body;

      // Get parent workspace ID from the authenticated API key's workspace
      // The adminAuth middleware already validated the API key belongs to an active workspace
      const parentWorkspaceId = request.headers["x-workspace-id"] as string;

      if (!parentWorkspaceId) {
        return reply.status(400).send({
          message: "Parent workspace ID required (via X-Workspace-Id header)",
        });
      }

      logger().info(
        {
          parentWorkspaceId,
          externalId,
          name,
          adminEmail,
        },
        "Hub workspace provisioning request",
      );

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
        const writeKey = writeKeyToHeader({
          secretId: writeKeyResource.secretId,
          writeKeyValue: writeKeyResource.writeKeyValue,
        });

        logger().info(
          {
            workspaceId: existing.id,
            externalId,
            existed: true,
          },
          "Returning existing workspace (idempotent)",
        );

        return reply.status(200).send({
          id: existing.id,
          externalId: existing.externalId ?? externalId,
          name: existing.name,
          writeKey,
          createdAt: existing.createdAt.toISOString(),
          status: existing.status,
          _existed: true,
        });
      }

      // 2. Create new child workspace
      try {
        const [newWorkspace] = await db()
          .insert(dbWorkspace)
          .values({
            name,
            externalId,
            parentWorkspaceId,
            type: "Child", // Always Child for Hub-provisioned workspaces
            status: "Active",
          })
          .returning();

        if (!newWorkspace) {
          return reply
            .status(400)
            .send({ message: "Failed to create workspace" });
        }

        // 3. Create default WriteKey
        const writeKeyResource = await getOrCreateWriteKey({
          workspaceId: newWorkspace.id,
          writeKeyName: DEFAULT_WRITE_KEY_NAME,
        });
        const writeKey = writeKeyToHeader({
          secretId: writeKeyResource.secretId,
          writeKeyValue: writeKeyResource.writeKeyValue,
        });

        // 4. Create default SubscriptionGroup for Email
        await upsertSubscriptionGroup({
          workspaceId: newWorkspace.id,
          name: "Default",
          type: SubscriptionGroupType.OptOut,
          channel: ChannelType.Email,
        });

        logger().info(
          {
            workspaceId: newWorkspace.id,
            externalId,
            parentWorkspaceId,
          },
          "Created new workspace for Hub client",
        );

        return reply.status(201).send({
          id: newWorkspace.id,
          externalId: newWorkspace.externalId ?? externalId,
          name: newWorkspace.name,
          writeKey,
          createdAt: newWorkspace.createdAt.toISOString(),
          status: newWorkspace.status,
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
            const writeKey = writeKeyToHeader({
              secretId: writeKeyResource.secretId,
              writeKeyValue: writeKeyResource.writeKeyValue,
            });
            return reply.status(200).send({
              id: existing.id,
              externalId: existing.externalId ?? externalId,
              name: existing.name,
              writeKey,
              createdAt: existing.createdAt.toISOString(),
              status: existing.status,
              _existed: true,
            });
          }
        }
        logger().error({ error: e, externalId }, "Failed to create workspace");
        throw e;
      }
    },
  );
}
