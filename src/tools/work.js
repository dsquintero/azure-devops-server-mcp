const { z } = require("zod");
const { DevOpsError } = require("../client.js");
const { READ_ONLY, PROJECT_DESCRIPTION, defineTool } = require("./helpers.js");

const TEAM_DESCRIPTION = "Team name or ID. Optional: the project's default team is used when omitted. Use core action 'list_teams' to discover teams.";

function formatIteration(it) {
  return {
    id: it.id,
    name: it.name,
    path: it.path,
    startDate: it.attributes?.startDate,
    finishDate: it.attributes?.finishDate,
    timeFrame: it.attributes?.timeFrame,
  };
}

/** Resolves "current" (or an omitted value) to the team's current iteration ID. */
async function resolveIterationId(client, project, team, iterationId) {
  if (iterationId && iterationId.toLowerCase() !== "current") return iterationId;
  const data = await client.get(`${client.teamPath(project, team)}/_apis/work/teamsettings/iterations`, { query: { $timeframe: "current" } });
  const current = (data.value || [])[0];
  if (!current) throw new DevOpsError(`The team ${team ? `'${team}'` : "(default)"} of project '${project}' has no current iteration.`);
  return current.id;
}

function flattenNodes(node, depth = 0, out = []) {
  if (!node) return out;
  out.push({
    id: node.identifier || node.id,
    name: node.name,
    path: node.path?.replace(/^\\([^\\]+)\\Iteration/, "$1"),
    startDate: node.attributes?.startDate,
    finishDate: node.attributes?.finishDate,
    depth,
  });
  for (const child of node.children || []) flattenNodes(child, depth + 1, out);
  return out;
}

function configureWorkTools(ctx) {
  const { client } = ctx;

  defineTool(ctx, {
    name: "work",
    description:
      "Sprints/iterations and capacity. Actions: list_team_iterations (iterations subscribed by a team, filter by timeframe current|past|future), list_iterations (whole iteration tree of a project), get_team_capacity (member capacity and days off for an iteration; iterationId defaults to the current sprint).",
    annotations: READ_ONLY,
    schema: {
      action: z.enum(["list_team_iterations", "list_iterations", "get_team_capacity"]),
      project: z.string().optional().describe(PROJECT_DESCRIPTION),
      team: z.string().optional().describe(TEAM_DESCRIPTION),
      timeframe: z.enum(["current", "past", "future"]).optional().describe("list_team_iterations: filter by timeframe. Omit for all."),
      depth: z.number().int().min(1).max(10).optional().describe("list_iterations: depth of the tree. Default 2."),
      iterationId: z.string().optional().describe("get_team_capacity: iteration GUID, or 'current' (default)."),
    },
    handlers: {
      list_team_iterations: async ({ project, team, timeframe }) => {
        const p = client.requireProject(project);
        const data = await client.get(`${client.teamPath(p, team)}/_apis/work/teamsettings/iterations`, { query: { $timeframe: timeframe } });
        return (data.value || []).map(formatIteration);
      },

      list_iterations: async ({ project, depth = 2 }) => {
        const p = client.requireProject(project);
        const root = await client.get(`${client.projectPath(p)}/_apis/wit/classificationnodes/Iterations`, { query: { $depth: depth } });
        return flattenNodes(root);
      },

      get_team_capacity: async (args) => {
        const p = client.requireProject(args.project);
        const iterationId = await resolveIterationId(client, p, args.team, args.iterationId);
        const data = await client.get(`${client.teamPath(p, args.team)}/_apis/work/teamsettings/iterations/${encodeURIComponent(iterationId)}/capacities`);
        const members = Array.isArray(data) ? data : data.value || data.teamMembers || [];
        return {
          iterationId,
          members: members.map((m) => ({
            member: m.teamMember ? `${m.teamMember.displayName} <${m.teamMember.uniqueName}>` : undefined,
            activities: (m.activities || []).map((a) => ({ name: a.name, capacityPerDay: a.capacityPerDay })),
            daysOff: (m.daysOff || []).map((d) => ({ start: d.start, end: d.end })),
          })),
        };
      },
    },
  });
}

module.exports = { configureWorkTools, resolveIterationId, TEAM_DESCRIPTION };
