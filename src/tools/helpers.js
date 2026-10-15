const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const PROJECT_DESCRIPTION =
  "Project name or ID. Optional when it can be inferred (e.g. from the work item) or AZURE_DEVOPS_PROJECT is set. Use core action 'list_projects' to discover projects.";

function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Throws a user-facing error when a parameter required by the chosen action is missing. */
function need(args, action, ...names) {
  const missing = names.filter((name) => args[name] === undefined || args[name] === null || args[name] === "" || (Array.isArray(args[name]) && args[name].length === 0));
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required for action '${action}'.`);
}

/**
 * Registers an action-based tool. `handlers` maps each action to an async function receiving the args.
 * Read-only tools are always registered; write tools are skipped when the server runs in read-only mode.
 */
function defineTool(ctx, { name, description, annotations, schema, handlers }) {
  if (ctx.config.readOnly && !annotations.readOnlyHint) return;

  ctx.server.registerTool(name, { description, inputSchema: schema, annotations }, async (args) => {
    const handler = handlers[args.action];
    if (!handler) return fail(`Unknown action '${args.action}' for ${name}.`);
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(`Error in ${name} (${args.action}): ${error.message}`);
    }
  });
}

module.exports = { READ_ONLY, ADDITIVE, DESTRUCTIVE, PROJECT_DESCRIPTION, ok, fail, need, defineTool };
