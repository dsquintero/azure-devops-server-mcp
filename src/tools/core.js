const { z } = require("zod");
const { PREVIEW } = require("../client.js");
const { READ_ONLY, need, defineTool } = require("./helpers.js");

function configureCoreTools(ctx) {
  const { client } = ctx;

  defineTool(ctx, {
    name: "core",
    description:
      "Discover what the PAT can access across the collection. Actions: whoami (authenticated user), list_projects (every project the PAT can see), list_teams (teams of a project, or with mine=true the teams you belong to across ALL projects), search_identities (find users by the beginning of their name, account or e-mail, to use in Assigned To or WIQL).",
    annotations: READ_ONLY,
    schema: {
      action: z.enum(["whoami", "list_projects", "list_teams", "search_identities"]),
      project: z.string().optional().describe("Project name or ID. Used by list_teams (omit together with mine=true to list your teams across all projects)."),
      mine: z.boolean().optional().describe("list_teams: only teams the authenticated user is a member of. Defaults to true when no project is given."),
      search: z.string().optional().describe("Text to search. Required for search_identities (display name, email or DOMAIN\\user)."),
      top: z.number().int().min(1).max(500).optional().describe("Maximum number of results. Default 100."),
      continuationToken: z.string().optional().describe("list_projects: token returned by a previous call to fetch the next page."),
    },
    handlers: {
      whoami: async () => {
        const data = await client.get("/_apis/connectionData", { preview: PREVIEW.connectionData });
        const user = data.authenticatedUser || {};
        return {
          id: user.id,
          displayName: user.providerDisplayName || user.customDisplayName,
          account: user.properties?.Account?.$value,
          mail: user.properties?.Mail?.$value,
          collectionUrl: client.baseUrl,
          apiVersion: client.apiVersion,
          apiVersionSource: client.apiVersionSource,
          defaultProject: client.defaultProject,
        };
      },

      list_projects: async ({ top = 100, continuationToken }) => {
        const { data, headers } = await client.request("GET", "/_apis/projects", {
          query: { $top: top, continuationToken, stateFilter: "wellFormed" },
        });
        return {
          projects: (data.value || []).map((p) => ({ id: p.id, name: p.name, description: p.description })),
          continuationToken: headers["x-ms-continuationtoken"] || undefined,
        };
      },

      list_teams: async ({ project, mine, top = 100 }) => {
        let teams;
        if (project) {
          const data = await client.get(`/_apis/projects/${encodeURIComponent(project)}/teams`, {
            query: { $mine: mine ? "true" : undefined, $top: top },
          });
          teams = data.value || [];
        } else {
          const data = await client.get("/_apis/teams", { query: { $mine: mine === false ? "false" : "true", $top: top }, preview: PREVIEW.teamsMine });
          teams = data.value || [];
        }
        return teams.map((t) => ({ id: t.id, name: t.name, project: t.projectName, description: t.description || undefined }));
      },

      search_identities: async (args) => {
        need(args, "search_identities", "search");
        const top = args.top || 25;
        // The identity picker (used by the web UI) matches by prefix of names and accounts.
        const picker = await client.post(
          "/_apis/IdentityPicker/Identities",
          {
            query: args.search,
            identityTypes: ["user", "group"],
            operationScopes: ["ims", "source"],
            properties: ["DisplayName", "Mail", "SamAccountName", "ScopeName", "Active"],
            // The server requires MinResults < MaxResults.
            options: { MinResults: 1, MaxResults: Math.max(top, 2) },
          },
          { preview: PREVIEW.identityPicker }
        );
        const found = (picker.results?.[0]?.identities || []).map((i) => ({
          id: i.localId || undefined,
          displayName: i.displayName,
          account: i.samAccountName ? (i.scopeName ? `${i.scopeName}\\${i.samAccountName}` : i.samAccountName) : undefined,
          mail: i.mail || undefined,
          isGroup: i.entityType === "Group" || undefined,
          active: i.active === false ? false : undefined,
        }));
        if (found.length) return found.slice(0, top);

        // Fallback: exact match on display name, account or e-mail.
        const data = await client.get("/_apis/identities", {
          query: { searchFilter: "General", filterValue: args.search, queryMembership: "None" },
        });
        return (data.value || []).slice(0, top).map((i) => ({
          id: i.id,
          displayName: i.providerDisplayName || i.customDisplayName,
          account: i.properties?.Account?.$value,
          mail: i.properties?.Mail?.$value,
          isGroup: i.isContainer || undefined,
        }));
      },
    },
  });
}

module.exports = { configureCoreTools };
