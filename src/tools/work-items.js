const { z } = require("zod");
const { DevOpsError, PREVIEW, enc } = require("../client.js");
const { DEFAULT_LIST_FIELDS, formatWorkItem, formatWorkItemRows, formatValue, workItemIdFromUrl } = require("../format.js");
const { READ_ONLY, ADDITIVE, DESTRUCTIVE, PROJECT_DESCRIPTION, need, defineTool } = require("./helpers.js");
const { resolveIterationId, TEAM_DESCRIPTION } = require("./work.js");

const LINK_TYPES = {
  child: "System.LinkTypes.Hierarchy-Forward",
  parent: "System.LinkTypes.Hierarchy-Reverse",
  related: "System.LinkTypes.Related",
  duplicate: "System.LinkTypes.Duplicate-Forward",
  "duplicate of": "System.LinkTypes.Duplicate-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  predecessor: "System.LinkTypes.Dependency-Reverse",
  "tested by": "Microsoft.VSTS.Common.TestedBy-Forward",
  tests: "Microsoft.VSTS.Common.TestedBy-Reverse",
  affects: "Microsoft.VSTS.Common.Affects-Forward",
  "affected by": "Microsoft.VSTS.Common.Affects-Reverse",
  hyperlink: "Hyperlink",
};

// Fields that change on every revision and only add noise to the history.
const HISTORY_NOISE = new Set([
  "System.Rev",
  "System.AuthorizedDate",
  "System.RevisedDate",
  "System.ChangedDate",
  "System.ChangedBy",
  "System.AuthorizedAs",
  "System.PersonId",
  "System.Watermark",
  "System.CommentCount",
]);

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldsMap = z
  .record(z.string(), fieldValue)
  .describe(
    "Fields to set as { name: value }. Keys can be reference names ('System.Title', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Custom.MyField') or display names ('Title', 'Remaining Work'). Use null to clear a field (update only). Rich text fields (Description, Acceptance Criteria, Repro Steps) take HTML. Identity fields take an email or 'Display Name <DOMAIN\\user>'. Use wit_work_item action 'get_type' to discover fields and allowed values."
  );

const wiqlEscape = (value) => String(value).replace(/'/g, "''");

function summarize(item, client) {
  return {
    id: item.id,
    rev: item.rev,
    type: item.fields?.["System.WorkItemType"],
    title: item.fields?.["System.Title"],
    state: item.fields?.["System.State"],
    url: client.workItemWebUrl(item.id, item.fields?.["System.TeamProject"]),
  };
}

function configureWorkItemTools(ctx) {
  const { client } = ctx;

  /** Fetches work items for a list of IDs as compact rows, keeping the original order. */
  async function rowsFor(ids, fields) {
    const items = await client.getWorkItems(ids, { fields: fields && fields.length ? fields : DEFAULT_LIST_FIELDS });
    return formatWorkItemRows(items);
  }

  /** Runs WIQL and returns rows for the resulting work items (flat and link queries). */
  async function queryRows(result, fields, top) {
    let ids;
    let links;
    if (result.workItems) {
      ids = result.workItems.map((w) => w.id);
    } else {
      const relations = result.workItemRelations || [];
      ids = [...new Set(relations.flatMap((r) => [r.source?.id, r.target?.id]).filter(Boolean))];
      links = relations.filter((r) => r.source && r.target).map((r) => ({ source: r.source.id, target: r.target.id, rel: r.rel }));
    }
    const total = ids.length;
    const items = await rowsFor(ids.slice(0, top), fields);
    return { total, returned: items.length, truncated: total > items.length || undefined, links, items };
  }

  /** Copies area and iteration from the parent unless the caller provided them. */
  async function inheritedPathOperations(parentId, fields) {
    const parent = await client.getWorkItem(parentId, { fields: ["System.TeamProject", "System.AreaPath", "System.IterationPath"] });
    const ops = [];
    const given = new Set(await Promise.all(Object.keys(fields || {}).map((f) => client.resolveFieldName(f))));
    for (const name of ["System.AreaPath", "System.IterationPath"]) {
      if (!given.has(name) && parent.fields[name]) ops.push({ op: "add", path: `/fields/${name}`, value: parent.fields[name] });
    }
    return { ops, project: parent.fields["System.TeamProject"] };
  }

  // ---------------------------------------------------------------------------
  // wit_work_item (read)
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "wit_work_item",
    description:
      "Read work items in any project the PAT can access. Actions: get (one item with all fields and relations), get_batch (several IDs), my (items assigned to or created by me, optionally across all projects), list_for_iteration (items of a team sprint; iterationId defaults to the current sprint), list_comments, list_history (who changed what and when), list_types (work item types of a project), get_type (states, fields with reference names, required flags and allowed values of a type - use it before creating/updating).",
    annotations: READ_ONLY,
    schema: {
      action: z.enum(["get", "get_batch", "my", "list_for_iteration", "list_comments", "list_history", "list_types", "get_type"]),
      id: z.number().int().optional().describe("Work item ID. Required for: get, list_comments, list_history."),
      ids: z.array(z.number().int()).optional().describe("Work item IDs. Required for: get_batch."),
      project: z.string().optional().describe(PROJECT_DESCRIPTION + " For 'my', omit it to search every project."),
      team: z.string().optional().describe(TEAM_DESCRIPTION + " Used for: list_for_iteration."),
      iterationId: z.string().optional().describe("list_for_iteration: iteration GUID (see work action list_team_iterations) or 'current' (default)."),
      fields: z.array(z.string()).optional().describe("Fields to return (reference or display names). get returns all fields when omitted; list actions return a compact default set."),
      role: z.enum(["assigned", "created"]).optional().describe("my: items assigned to me (default) or created by me."),
      includeClosed: z.boolean().optional().describe("my: include items in closed/done/removed states. Default false."),
      workItemTypes: z.array(z.string()).optional().describe("my: filter by work item types, e.g. ['Task','Bug']."),
      workItemType: z.string().optional().describe("Work item type name, e.g. 'User Story'. Required for: get_type."),
      top: z.number().int().min(1).max(1000).optional().describe("Maximum number of results. Default 50 (200 for list_for_iteration)."),
      continuationToken: z.string().optional().describe("list_comments: token from a previous call."),
    },
    handlers: {
      get: async (args) => {
        need(args, "get", "id");
        const item = await client.getWorkItem(args.id, { fields: args.fields });
        return formatWorkItem(item, client);
      },

      get_batch: async (args) => {
        need(args, "get_batch", "ids");
        return rowsFor(args.ids, args.fields);
      },

      my: async ({ project, role = "assigned", includeClosed = false, workItemTypes, fields, top = 50 }) => {
        const p = project || client.defaultProject;
        const conditions = [`[${role === "created" ? "System.CreatedBy" : "System.AssignedTo"}] = @Me`];
        if (p) conditions.push(`[System.TeamProject] = '${wiqlEscape(p)}'`);
        if (!includeClosed) conditions.push("[System.State] NOT IN ('Closed', 'Done', 'Removed')");
        if (workItemTypes?.length) conditions.push(`[System.WorkItemType] IN (${workItemTypes.map((t) => `'${wiqlEscape(t)}'`).join(", ")})`);
        const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
        const result = await client.runWiql(wiql, { top });
        return queryRows(result, fields, top);
      },

      list_for_iteration: async ({ project, team, iterationId, fields, top = 200 }) => {
        const p = client.requireProject(project);
        const resolvedIteration = await resolveIterationId(client, p, team, iterationId);
        const data = await client.get(`${client.teamPath(p, team)}/_apis/work/teamsettings/iterations/${enc(resolvedIteration)}/workitems`, {
          preview: PREVIEW.iterationWorkItems,
        });
        const relations = data.workItemRelations || [];
        const parentOf = new Map();
        for (const r of relations) if (r.source && r.target) parentOf.set(r.target.id, r.source.id);
        const ids = [...new Set(relations.map((r) => r.target?.id).filter(Boolean))];
        const rows = await rowsFor(ids.slice(0, top), fields);
        for (const row of rows) if (parentOf.has(row.id)) row.parentId = parentOf.get(row.id);
        return { iterationId: resolvedIteration, total: ids.length, returned: rows.length, items: rows };
      },

      list_comments: async (args) => {
        need(args, "list_comments", "id");
        const p = await client.projectOfWorkItem(args.id, args.project);
        const data = await client.get(`${client.projectPath(p)}/_apis/wit/workItems/${args.id}/comments`, {
          query: { $top: args.top || 50, continuationToken: args.continuationToken },
          preview: PREVIEW.comments,
        });
        return {
          totalCount: data.totalCount,
          continuationToken: data.continuationToken || undefined,
          comments: (data.comments || []).map((c) => ({
            id: c.id,
            text: c.text,
            createdBy: formatValue(c.createdBy),
            createdDate: c.createdDate,
            modifiedDate: c.modifiedDate !== c.createdDate ? c.modifiedDate : undefined,
          })),
        };
      },

      list_history: async (args) => {
        need(args, "list_history", "id");
        const data = await client.get(`/_apis/wit/workItems/${args.id}/updates`, { query: { $top: args.top || 50 } });
        return (data.value || [])
          .map((u) => {
            const changes = {};
            for (const [name, change] of Object.entries(u.fields || {})) {
              if (HISTORY_NOISE.has(name)) continue;
              changes[name] = { from: formatValue(change.oldValue), to: formatValue(change.newValue) };
            }
            const entry = {
              rev: u.rev,
              by: formatValue(u.revisedBy),
              date: u.fields?.["System.ChangedDate"]?.newValue || u.revisedDate,
            };
            if (Object.keys(changes).length) entry.changes = changes;
            if (u.relations?.added) entry.linksAdded = u.relations.added.map((r) => ({ rel: r.rel, id: workItemIdFromUrl(r.url), url: workItemIdFromUrl(r.url) ? undefined : r.url }));
            if (u.relations?.removed) entry.linksRemoved = u.relations.removed.map((r) => ({ rel: r.rel, id: workItemIdFromUrl(r.url), url: workItemIdFromUrl(r.url) ? undefined : r.url }));
            return entry;
          })
          .filter((e) => e.changes || e.linksAdded || e.linksRemoved);
      },

      list_types: async ({ project }) => {
        const p = client.requireProject(project);
        const data = await client.get(`${client.projectPath(p)}/_apis/wit/workitemtypes`);
        return (data.value || []).filter((t) => !t.isDisabled).map((t) => ({ name: t.name, referenceName: t.referenceName, description: t.description || undefined }));
      },

      get_type: async (args) => {
        need(args, "get_type", "workItemType");
        const p = client.requireProject(args.project);
        const base = `${client.projectPath(p)}/_apis/wit/workitemtypes/${enc(args.workItemType)}`;
        const [fields, states, catalog] = await Promise.all([
          client.get(`${base}/fields`, { query: { $expand: "allowedValues" } }),
          client.get(`${base}/states`),
          client.getFieldCatalog(),
        ]);
        return {
          name: args.workItemType,
          project: p,
          states: (states.value || []).map((s) => ({ name: s.name, category: s.category })),
          fields: (fields.value || []).map((f) => {
            const info = catalog.byKey.get(f.referenceName.toLowerCase());
            return {
              referenceName: f.referenceName,
              name: f.name,
              type: info?.type,
              required: f.alwaysRequired || undefined,
              readOnly: info?.readOnly || undefined,
              defaultValue: f.defaultValue ?? undefined,
              allowedValues: f.allowedValues?.length ? f.allowedValues : undefined,
            };
          }),
        };
      },
    },
  });

  // ---------------------------------------------------------------------------
  // wit_query (read)
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "wit_query",
    description:
      "Search work items. Actions: wiql (ad-hoc WIQL; without project it runs across every project the PAT can see, so do not use @project there), list_saved (saved queries/folders of a project, e.g. 'Shared Queries'), run_saved (execute a saved query by ID or path).",
    annotations: READ_ONLY,
    schema: {
      action: z.enum(["wiql", "list_saved", "run_saved"]),
      wiql: z
        .string()
        .max(32768)
        .optional()
        .describe("WIQL query. Required for: wiql. Example: SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"),
      project: z.string().optional().describe(PROJECT_DESCRIPTION + " Required for list_saved and run_saved."),
      team: z.string().optional().describe("Team context for @CurrentIteration in queries. Optional."),
      query: z.string().optional().describe("Saved query ID (GUID) or path (e.g. 'Shared Queries/Sprint/Bugs'). Required for: run_saved. Optional folder for list_saved."),
      fields: z.array(z.string()).optional().describe("Fields to return for each work item (reference or display names). Defaults to a compact set."),
      top: z.number().int().min(1).max(1000).optional().describe("Maximum work items to return. Default 50."),
    },
    handlers: {
      wiql: async (args) => {
        need(args, "wiql", "wiql");
        const top = args.top || 50;
        const project = args.project || (/@project/i.test(args.wiql) ? client.defaultProject : undefined);
        const result = await client.runWiql(args.wiql, { project, team: args.team, top });
        return queryRows(result, args.fields, top);
      },

      list_saved: async ({ project, query }) => {
        const p = client.requireProject(project);
        const path = query ? `/${query.split("/").map(enc).join("/")}` : "";
        const data = await client.get(`${client.projectPath(p)}/_apis/wit/queries${path}`, { query: { $depth: 2, $expand: "wiql" } });
        const flatten = (node, out = []) => {
          out.push({ id: node.id, path: node.path, isFolder: node.isFolder || undefined, wiql: node.wiql });
          for (const child of node.children || []) flatten(child, out);
          return out;
        };
        return (data.value || [data]).flatMap((n) => flatten(n));
      },

      run_saved: async (args) => {
        need(args, "run_saved", "query");
        const p = client.requireProject(args.project);
        let id = args.query;
        if (!/^[0-9a-f-]{36}$/i.test(id)) {
          const saved = await client.get(`${client.projectPath(p)}/_apis/wit/queries/${id.split("/").map(enc).join("/")}`);
          id = saved.id;
        }
        const top = args.top || 50;
        const result = await client.get(`${client.teamPath(p, args.team)}/_apis/wit/wiql/${id}`, { query: { $top: top } });
        return queryRows(result, args.fields, top);
      },
    },
  });

  // ---------------------------------------------------------------------------
  // wit_work_item_write
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "wit_work_item_write",
    description:
      "Create and modify work items with any field (system or custom). Actions: create (optionally under a parent), update (set/clear fields, optional raw JSON-PATCH), update_batch (several items), add_children (create several children of a parent; area and iteration are copied from the parent unless given), add_hours (add to Completed Work, optionally decreasing Remaining Work), delete (moves to the recycle bin). Tip: call wit_work_item get_type first to know the valid fields/states.",
    annotations: DESTRUCTIVE,
    schema: {
      action: z.enum(["create", "update", "update_batch", "add_children", "add_hours", "delete"]),
      project: z.string().optional().describe(PROJECT_DESCRIPTION + " For create/add_children it is inferred from the parent when parentId is given."),
      id: z.number().int().optional().describe("Work item ID. Required for: update, add_hours, delete."),
      workItemType: z.string().optional().describe("Type to create, e.g. 'Task', 'Bug', 'User Story'. Required for: create, add_children."),
      fields: fieldsMap.optional().describe("Required for create (must include the title). Used by update."),
      parentId: z.number().int().optional().describe("Parent work item. Used by create; required for add_children."),
      inheritPaths: z.boolean().optional().describe("create/add_children with parentId: copy Area Path and Iteration Path from the parent when not provided. Default true."),
      operations: z
        .array(z.object({ op: z.enum(["add", "replace", "remove", "test"]), path: z.string(), value: z.any().optional() }))
        .optional()
        .describe("update: advanced raw JSON-PATCH operations appended after 'fields' (e.g. relations)."),
      expectedRev: z.number().int().optional().describe("update: fail if the work item revision changed since you read it (optimistic concurrency)."),
      items: z
        .array(z.object({ id: z.number().int().optional(), fields: fieldsMap }))
        .max(50)
        .optional()
        .describe("update_batch: [{ id, fields }]. add_children: [{ fields }] (each must include the title)."),
      hours: z.number().optional().describe("add_hours: hours to add to Completed Work."),
      decreaseRemaining: z.boolean().optional().describe("add_hours: also subtract the hours from Remaining Work (never below 0). Default false."),
    },
    handlers: {
      create: async (args) => {
        need(args, "create", "workItemType", "fields");
        const ops = await client.buildFieldOperations(args.fields);
        let project = args.project;
        if (args.parentId) {
          const inherited = await inheritedPathOperations(args.parentId, args.fields);
          project = project || inherited.project;
          if (args.inheritPaths !== false) ops.push(...inherited.ops);
          ops.push({ op: "add", path: "/relations/-", value: { rel: LINK_TYPES.parent, url: client.workItemApiUrl(args.parentId) } });
        }
        const created = await client.createWorkItem(client.requireProject(project), args.workItemType, ops);
        return { created: summarize(created, client), parentId: args.parentId };
      },

      update: async (args) => {
        need(args, "update", "id");
        const ops = [];
        if (args.expectedRev !== undefined) ops.push({ op: "test", path: "/rev", value: args.expectedRev });
        ops.push(...(await client.buildFieldOperations(args.fields, { allowRemove: true })));
        ops.push(...(args.operations || []));
        if (ops.length === (args.expectedRev !== undefined ? 1 : 0)) throw new DevOpsError("Nothing to update: pass 'fields' or 'operations'.");
        const updated = await client.updateWorkItem(args.id, ops);
        return { updated: summarize(updated, client) };
      },

      update_batch: async (args) => {
        need(args, "update_batch", "items");
        const results = [];
        for (const item of args.items) {
          try {
            if (!item.id) throw new DevOpsError("id is required for each item");
            const updated = await client.updateWorkItem(item.id, await client.buildFieldOperations(item.fields, { allowRemove: true }));
            results.push({ ok: true, ...summarize(updated, client) });
          } catch (error) {
            results.push({ ok: false, id: item.id, error: error.message });
          }
        }
        return { updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
      },

      add_children: async (args) => {
        need(args, "add_children", "parentId", "workItemType", "items");
        const inherited = await inheritedPathOperations(args.parentId, {});
        const project = args.project || inherited.project;
        const results = [];
        for (const item of args.items) {
          try {
            const ops = await client.buildFieldOperations(item.fields);
            if (args.inheritPaths !== false) {
              const given = new Set(ops.map((o) => o.path));
              ops.push(...inherited.ops.filter((o) => !given.has(o.path)));
            }
            ops.push({ op: "add", path: "/relations/-", value: { rel: LINK_TYPES.parent, url: client.workItemApiUrl(args.parentId) } });
            const created = await client.createWorkItem(project, args.workItemType, ops);
            results.push({ ok: true, ...summarize(created, client) });
          } catch (error) {
            results.push({ ok: false, title: item.fields?.["System.Title"] || item.fields?.Title, error: error.message });
          }
        }
        return { parentId: args.parentId, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
      },

      add_hours: async (args) => {
        need(args, "add_hours", "id", "hours");
        const completedField = "Microsoft.VSTS.Scheduling.CompletedWork";
        const remainingField = "Microsoft.VSTS.Scheduling.RemainingWork";
        const item = await client.getWorkItem(args.id, { fields: [completedField, remainingField] });
        const previousCompleted = item.fields[completedField] || 0;
        const ops = [
          { op: "test", path: "/rev", value: item.rev },
          { op: "add", path: `/fields/${completedField}`, value: previousCompleted + args.hours },
        ];
        let remaining;
        if (args.decreaseRemaining) {
          remaining = Math.max(0, (item.fields[remainingField] || 0) - args.hours);
          ops.push({ op: "add", path: `/fields/${remainingField}`, value: remaining });
        }
        await client.updateWorkItem(args.id, ops);
        return { id: args.id, previousCompletedWork: previousCompleted, completedWork: previousCompleted + args.hours, remainingWork: remaining };
      },

      delete: async (args) => {
        need(args, "delete", "id");
        await client.delete(`/_apis/wit/workitems/${args.id}`);
        return `Work item ${args.id} moved to the recycle bin (it can be restored from the web UI).`;
      },
    },
  });

  // ---------------------------------------------------------------------------
  // wit_comment_write
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "wit_comment_write",
    description: "Add or edit comments (Discussion) on a work item. Text is HTML; mention people as plain text. Actions: add, update.",
    annotations: ADDITIVE,
    schema: {
      action: z.enum(["add", "update"]),
      workItemId: z.number().int().describe("Work item ID."),
      text: z.string().describe("Comment text (HTML allowed, e.g. <b>bold</b>, <br>)."),
      commentId: z.number().int().optional().describe("Comment ID. Required for: update."),
      project: z.string().optional().describe(PROJECT_DESCRIPTION),
    },
    handlers: {
      add: async (args) => {
        const p = await client.projectOfWorkItem(args.workItemId, args.project);
        const c = await client.post(`${client.projectPath(p)}/_apis/wit/workItems/${args.workItemId}/comments`, { text: args.text }, { preview: PREVIEW.comments });
        return { id: c.id, workItemId: args.workItemId, createdDate: c.createdDate };
      },
      update: async (args) => {
        need(args, "update", "commentId");
        const p = await client.projectOfWorkItem(args.workItemId, args.project);
        const c = await client.patch(`${client.projectPath(p)}/_apis/wit/workItems/${args.workItemId}/comments/${args.commentId}`, { text: args.text }, { preview: PREVIEW.comments });
        return { id: c.id, workItemId: args.workItemId, modifiedDate: c.modifiedDate };
      },
    },
  });

  // ---------------------------------------------------------------------------
  // wit_link_write
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "wit_link_write",
    description:
      "Create or remove links on a work item. 'link' adds to `id` a relation of `linkType` pointing to `targetId`: id=100, targetId=200, linkType='child' makes 200 a child of 100; linkType='tested by' with a Test Case as target links the test. Use linkType='hyperlink' with `url` to reference external resources (e.g. a pull request in the cloud Azure DevOps). Actions: link, unlink.",
    annotations: DESTRUCTIVE,
    schema: {
      action: z.enum(["link", "unlink"]),
      id: z.number().int().describe("Work item that receives (or loses) the link."),
      targetId: z.number().int().optional().describe("Other work item. Required unless linkType is 'hyperlink'."),
      linkType: z
        .enum(Object.keys(LINK_TYPES))
        .optional()
        .describe("Relation seen from `id`. Default 'related'. For unlink, omit to remove every link between both items."),
      url: z.string().url().optional().describe("Required for linkType 'hyperlink'."),
      comment: z.string().optional().describe("link: optional comment stored on the link."),
    },
    handlers: {
      link: async (args) => {
        const linkType = args.linkType || "related";
        let target;
        if (linkType === "hyperlink") {
          need(args, "link (hyperlink)", "url");
          target = args.url;
        } else {
          need(args, "link", "targetId");
          target = client.workItemApiUrl(args.targetId);
        }
        const value = { rel: LINK_TYPES[linkType], url: target };
        if (args.comment) value.attributes = { comment: args.comment };
        await client.updateWorkItem(args.id, [{ op: "add", path: "/relations/-", value }]);
        return `Linked: ${args.id} --[${linkType}]--> ${args.targetId ?? args.url}`;
      },

      unlink: async (args) => {
        if (!args.targetId && !args.url) throw new DevOpsError("targetId or url is required for action 'unlink'.");
        const item = await client.getWorkItem(args.id, { expand: "Relations" });
        const rel = args.linkType ? LINK_TYPES[args.linkType] : undefined;
        const indexes = (item.relations || [])
          .map((r, index) => ({ r, index }))
          .filter(({ r }) => (!rel || r.rel === rel) && (args.url ? r.url === args.url : workItemIdFromUrl(r.url) === args.targetId))
          .map(({ index }) => index)
          .sort((a, b) => b - a);
        if (!indexes.length) throw new DevOpsError(`No matching link found on work item ${args.id}.`);
        const ops = [{ op: "test", path: "/rev", value: item.rev }, ...indexes.map((i) => ({ op: "remove", path: `/relations/${i}` }))];
        await client.updateWorkItem(args.id, ops);
        return `Removed ${indexes.length} link(s) from work item ${args.id}.`;
      },
    },
  });
}

module.exports = { configureWorkItemTools, LINK_TYPES };
