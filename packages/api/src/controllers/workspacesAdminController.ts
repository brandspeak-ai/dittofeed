import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import logger from "backend-lib/src/logger";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { provisionHubWorkspace } from "backend-lib/src/workspaces/createWorkspace";
import { writeKeyToHeader } from "isomorphic-lib/src/auth";
import {
  BadRequestResponse,
  CreateWorkspaceFromHubRequest,
  CreateWorkspaceFromHubResponse,
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

      const result = await provisionHubWorkspace({
        name,
        externalId,
        parentWorkspaceId,
        adminEmail,
      });

      if (result.isErr()) {
        const error = result.error;
        switch (error.type) {
          case "MISSING_PARENT_WORKSPACE_ID":
            return reply.status(400).send({
              message: "Parent workspace ID required",
            });
          case "WORKSPACE_CREATION_FAILED":
            return reply.status(400).send({
              message: error.message,
            });
          case "UNKNOWN_ERROR":
            logger().error(
              { error: error.error, externalId },
              "Failed to create workspace",
            );
            throw error.error;
        }
      }

      const { workspace, writeKey, existed } = result.value;

      // Format writeKey for response (secretId:writeKeyValue format)
      const formattedWriteKey = writeKeyToHeader({
        secretId: workspace.id,
        writeKeyValue: writeKey,
      });

      return reply.status(existed ? 200 : 201).send({
        id: workspace.id,
        externalId: workspace.externalId ?? externalId,
        name: workspace.name,
        writeKey: formattedWriteKey,
        createdAt: workspace.createdAt.toISOString(),
        status: workspace.status,
        ...(existed && { _existed: true }),
      });
    },
  );
}
