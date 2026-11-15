import type { ZodType } from "zod";
import type { DwarTool } from "../types/domain.js";
import type { ToolContext, ToolExecResult } from "./shared.js";

/**
 * One tool, defined once. The zod schema is both the validation applied to model
 * input and the source of the JSON Schema the model sees — they cannot drift.
 */
export type ToolDefinition<T = unknown> = {
  name: string;
  description: string;
  input: ZodType<T>;
  /** JSON Schema shown to the model. Hand-written for now; see note below. */
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, input: T) => Promise<ToolExecResult>;
};

/** Identity helper that types a tool definition by its zod input. */
export function defineTool<T>(definition: ToolDefinition<T>): ToolDefinition<T> {
  return definition;
}

/** The shape the model sees for a zod-defined tool. */
export function asDwarTool(definition: ToolDefinition): DwarTool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
  };
}
