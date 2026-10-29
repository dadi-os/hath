/** List and execute grantable registry tools (CLI / ops surface). */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { HathError } from "../errors.js";
import { executeTool } from "../runtime/tools.js";
import { requireActiveAgent, requireToolGrant } from "../tools/shared.js";
import { allTools, findEmbeddedTool, findTool } from "../tools/registry.js";
import { parse } from "./schemas.js";
import { routerToolNames } from "../runtime/router.js";

const nameParam = z.object({ name: z.string().min(1) }).strict();

const executeBody = z
  .object({
    as_agent_id: z.union([z.literal("router"), agentIdSchema]).optional(),
  })
  .passthrough();



/** Register GET /tools, GET /tools/:name, POST /tools/:name/execute. */
export async function registerTools(app: FastifyInstance): Promise<void> {
  app.get("/tools", async () => ({
    tools: allTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  }));

  app.get("/tools/:name", async (request) => {
    const { name } = parse(nameParam, request.params);
    const tool = findTool(name);
    if (!tool) {
      throw new HathError(404, "not_found", `tool ${name} not found`);
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  });

  app.post("/tools/:name/execute", async (request) => {
    const { name } = parse(nameParam, request.params);
    const grantable = findTool(name);
    const tool = grantable ?? findEmbeddedTool(name);
    if (!tool) {
      throw new HathError(404, "not_found", `tool ${name} not found`);
    }
    const raw =
      request.body === undefined || request.body === null || request.body === ""
        ? {}
        : request.body;
    const parsed = parse(executeBody, raw);
    const { as_agent_id: asAgentId, ...input } = parsed;
    const callerId = asAgentId === undefined || asAgentId === "router" ? null : asAgentId;
    const callerKind =
      asAgentId === undefined ? "user" : asAgentId === "router" ? "router" : "agent";
    if (asAgentId === "router" && !routerToolNames().has(name)) {
      throw new HathError(
        422,
        "invalid_request",
        "as_agent_id router is limited to router authority tools",
      );
    }
    if (callerId !== null) {
      await requireActiveAgent(app.db, callerId);
      if (grantable) {
        await requireToolGrant(app.db, callerId, name);
      }
    }
    const result = await executeTool(app.runtime.toolContext(callerId, "work", callerKind), {
      type: "tool_use",
      id: "cli",
      name,
      input,
    });
    return {
      ok: !result.isError,
      content: result.content,
      is_error: result.isError,
    };
  });
}
