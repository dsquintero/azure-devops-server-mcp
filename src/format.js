/**
 * Helpers that turn verbose Azure DevOps payloads into compact, LLM-friendly objects.
 */

/** Fields returned for list operations when the caller does not choose fields. */
const DEFAULT_LIST_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.TeamProject",
  "System.IterationPath",
  "System.Tags",
];

const RELATION_NAMES = {
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Related": "Related",
  "System.LinkTypes.Duplicate-Forward": "Duplicate",
  "System.LinkTypes.Duplicate-Reverse": "Duplicate Of",
  "System.LinkTypes.Dependency-Forward": "Successor",
  "System.LinkTypes.Dependency-Reverse": "Predecessor",
  "Microsoft.VSTS.Common.TestedBy-Forward": "Tested By",
  "Microsoft.VSTS.Common.TestedBy-Reverse": "Tests",
  "Microsoft.VSTS.Common.Affects-Forward": "Affects",
  "Microsoft.VSTS.Common.Affects-Reverse": "Affected By",
  AttachedFile: "Attachment",
  Hyperlink: "Hyperlink",
  ArtifactLink: "Artifact",
};

/** Turns identity objects into "Display Name <unique name>". */
function formatValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "displayName" in value) {
    return value.uniqueName ? `${value.displayName} <${value.uniqueName}>` : value.displayName;
  }
  return value;
}

function workItemIdFromUrl(url) {
  const match = /\/workItems\/(\d+)$/i.exec(url || "");
  return match ? Number(match[1]) : undefined;
}

function formatRelation(relation) {
  const targetId = workItemIdFromUrl(relation.url);
  const out = { type: RELATION_NAMES[relation.rel] || relation.rel };
  if (targetId) out.id = targetId;
  else out.url = relation.url;
  if (relation.attributes?.name && !targetId) out.name = relation.attributes.name;
  if (relation.attributes?.comment) out.comment = relation.attributes.comment;
  return out;
}

/** Compacts a work item: flattens identities, summarizes relations, adds the web URL. */
function formatWorkItem(item, client) {
  const fields = {};
  for (const [name, value] of Object.entries(item.fields || {})) {
    fields[name] = formatValue(value);
  }
  const out = {
    id: item.id,
    rev: item.rev,
    url: client.workItemWebUrl(item.id, fields["System.TeamProject"]),
    fields,
  };
  if (item.relations) out.relations = item.relations.map(formatRelation);
  return out;
}

/** Formats a list of work items as compact rows ({ id, ...fields }). */
function formatWorkItemRows(items) {
  return items.map((item) => {
    const row = { id: item.id };
    for (const [name, value] of Object.entries(item.fields || {})) {
      if (name === "System.Id") continue;
      row[name] = formatValue(value);
    }
    return row;
  });
}

/** Strips the noisy properties Azure DevOps adds to most resources. */
function stripLinks(value) {
  if (Array.isArray(value)) return value.map(stripLinks);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "_links" || key === "imageUrl" || key === "descriptor") continue;
      out[key] = stripLinks(inner);
    }
    return out;
  }
  return value;
}

module.exports = {
  DEFAULT_LIST_FIELDS,
  RELATION_NAMES,
  formatValue,
  formatWorkItem,
  formatWorkItemRows,
  formatRelation,
  stripLinks,
  workItemIdFromUrl,
};
