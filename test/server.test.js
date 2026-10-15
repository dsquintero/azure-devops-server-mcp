const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { stepsToXml, xmlToSteps } = require("../src/tools/test-plans.js");

// ---------------------------------------------------------------------------
// Fake Azure DevOps Server (collection "Coll")
// ---------------------------------------------------------------------------
const requests = [];
let baseUrl;
let nextId = 500;

const FIELDS = [
  { name: "ID", referenceName: "System.Id", type: "integer" },
  { name: "Work Item Type", referenceName: "System.WorkItemType", type: "string" },
  { name: "Title", referenceName: "System.Title", type: "string" },
  { name: "State", referenceName: "System.State", type: "string" },
  { name: "Assigned To", referenceName: "System.AssignedTo", type: "identity" },
  { name: "Team Project", referenceName: "System.TeamProject", type: "string" },
  { name: "Area Path", referenceName: "System.AreaPath", type: "treePath" },
  { name: "Iteration Path", referenceName: "System.IterationPath", type: "treePath" },
  { name: "Remaining Work", referenceName: "Microsoft.VSTS.Scheduling.RemainingWork", type: "double" },
  { name: "Completed Work", referenceName: "Microsoft.VSTS.Scheduling.CompletedWork", type: "double" },
  { name: "Cliente", referenceName: "Custom.Cliente", type: "string" },
  { name: "Description", referenceName: "System.Description", type: "html" },
  { name: "Activity", referenceName: "Microsoft.VSTS.Common.Activity", type: "string" },
];

const WORK_ITEMS = {
  100: {
    id: 100,
    rev: 7,
    fields: {
      "System.Title": "Login con SSO",
      "System.WorkItemType": "User Story",
      "System.State": "Active",
      "System.TeamProject": "Proyecto B",
      "System.AreaPath": "Proyecto B\\Equipo 1",
      "System.IterationPath": "Proyecto B\\Sprint 5",
      "System.AssignedTo": { displayName: "Ana", uniqueName: "CORP\\ana" },
      "Microsoft.VSTS.Scheduling.CompletedWork": 2,
      "Microsoft.VSTS.Scheduling.RemainingWork": 5,
    },
    relations: [
      { rel: "System.LinkTypes.Related", url: "http://x/Coll/_apis/wit/workItems/200" },
      { rel: "System.LinkTypes.Hierarchy-Forward", url: "http://x/Coll/_apis/wit/workItems/300" },
    ],
  },
};

function pick(item, fields) {
  if (!fields) return item;
  const out = { id: item.id, rev: item.rev, fields: {} };
  for (const f of fields) if (f in item.fields) out.fields[f] = item.fields[f];
  return out;
}

const RULE_ERROR = {
  status: 400,
  data: {
    message: "TF401320: Rule Error for field Description. Error code: Required, InvalidEmpty. One additional error occurred during validation of the work item.",
    customProperties: {
      RuleValidationErrors: [
        { fieldReferenceName: "System.Description", fieldStatusFlags: "required, invalidEmpty" },
        { fieldReferenceName: "Microsoft.VSTS.Common.Activity", fieldStatusFlags: "required, hasValues, limitedToValues, invalidEmpty" },
      ],
    },
  },
};

const PREVIEW_ONLY = {
  status: 400,
  data: { message: 'The requested version "6.0" of the resource is under preview.', typeKey: "VssInvalidPreviewVersionException" },
};

function route(req, body) {
  const url = new URL(req.url, baseUrl);
  const p = decodeURIComponent(url.pathname);
  const m = req.method;
  const version = url.searchParams.get("api-version");

  // Location service: released (GA) versions per resource, like Azure DevOps Server 2020.1.
  if (m === "OPTIONS" && p === "/Coll/_apis/wit") {
    return { value: [{ releasedVersion: "6.0", maxVersion: "6.1" }, { releasedVersion: "0.0", maxVersion: "6.1" }, { releasedVersion: "5.1", maxVersion: "6.1" }] };
  }
  // A resource the adapter does not know is preview: only "-preview" versions are accepted.
  if (m === "GET" && p === "/Coll/_apis/wit/workItems/100/updates") {
    return version.includes("-preview") ? { value: [{ rev: 2, revisedBy: { displayName: "Ana" }, fields: { "System.State": { oldValue: "New", newValue: "Active" } } }] } : PREVIEW_ONLY;
  }

  // Process rules of the fake "Bug" type: Description and Activity are required on create.
  if (m === "POST" && p.endsWith("/_apis/wit/workitems/$Bug")) {
    const has = (f) => body.some((o) => o.path === `/fields/${f}`);
    if (!has("System.Description") || !has("Microsoft.VSTS.Common.Activity")) return RULE_ERROR;
    if (url.searchParams.get("validateOnly") === "true") return { rev: 0, fields: {} };
  }
  if (m === "GET" && p === "/Coll/Proyecto B/_apis/wit/workitemtypes/Bug/fields") {
    return { value: [{ referenceName: "System.Title", name: "Title", alwaysRequired: true }, { referenceName: "System.Description", name: "Description" }, { referenceName: "Microsoft.VSTS.Common.Activity", name: "Activity", allowedValues: ["Development", "Testing"] }] };
  }
  if (m === "GET" && p === "/Coll/Proyecto B/_apis/wit/workitemtypes/Bug/states") return { value: [{ name: "New", category: "Proposed" }] };

  if (m === "GET" && p === "/Coll/_apis/wit/fields") return { value: FIELDS };
  if (m === "POST" && p === "/Coll/_apis/wit/workitemsbatch") {
    return { value: body.ids.map((id) => WORK_ITEMS[id] && pick(WORK_ITEMS[id], body.fields)).filter(Boolean) };
  }
  if (m === "POST" && /\/_apis\/wit\/wiql$/.test(p)) return { workItems: [{ id: 100 }] };
  if (m === "POST" && /^\/Coll\/[^/]+\/_apis\/wit\/workitems\/\$/.test(p)) {
    const id = nextId++;
    const fields = {};
    for (const op of body) if (op.path.startsWith("/fields/")) fields[op.path.slice(8)] = op.value;
    return { id, rev: 1, fields: { ...fields, "System.TeamProject": p.split("/")[2] } };
  }
  if (m === "PATCH" && /^\/Coll\/_apis\/wit\/workitems\/\d+$/.test(p)) {
    return { id: Number(p.split("/").pop()), rev: 8, fields: WORK_ITEMS[100].fields };
  }
  if (m === "POST" && /\/_apis\/wit\/workItems\/100\/comments$/.test(p)) return { id: 9, createdDate: "2026-10-14" };
  if (m === "GET" && p === "/Coll/Proyecto B/_apis/testplan/Plans/1/suites/2") {
    return { id: 2, suiteType: "requirementTestSuite", requirementId: 100 };
  }
  if (m === "POST" && p === "/Coll/Proyecto B/_apis/testplan/Plans/1/Suites/2/TestCase") {
    return { value: body.map((b) => ({ workItem: { id: b.workItem.id } })) };
  }
  if (m === "POST" && p === "/Coll/_apis/IdentityPicker/Identities") {
    return { results: [{ identities: body.query === "dani" ? [{ localId: "u1", displayName: "Daniel Quintero", scopeName: "SE", samAccountName: "daniel.quintero", mail: "dq@x.com", entityType: "User", active: true }] : [] }] };
  }
  if (m === "GET" && p === "/Coll/_apis/identities") return { value: [{ id: "u2", providerDisplayName: "Exacto", properties: { Account: { $value: "exacto" } } }] };
  if (m === "GET" && p === "/Coll/_apis/connectionData") return { authenticatedUser: { id: "u1", providerDisplayName: "Daniel Quintero" } };
  if (m === "GET" && p === "/Coll/_apis/teams") return { value: [{ id: "t1", name: "Equipo 1", projectName: "Proyecto B" }] };
  return null;
}

let server;
let client;

async function startClient(extraEnv = {}) {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "index.js")],
      env: { ...process.env, AZURE_DEVOPS_ORG_URL: `${baseUrl}/Coll`, AZURE_DEVOPS_PAT: "test-pat", AZURE_DEVOPS_PROJECT: "", ...extraEnv },
      stderr: "ignore",
    })
  );
  return c;
}

async function call(name, args) {
  requests.length = 0;
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  assert.ok(!result.isError, `tool error: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const find = (method, pathPart) => requests.find((r) => r.method === method && r.path.includes(pathPart));

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, "http://x");
      requests.push({ method: req.method, path: decodeURIComponent(url.pathname), version: url.searchParams.get("api-version"), query: url.searchParams, body, auth: req.headers.authorization });
      const result = route(req, body);
      const [status, data] = result?.status ? [result.status, result.data] : [result ? 200 : 404, result || { message: `no route ${req.method} ${url.pathname}` }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  client = await startClient();
});

after(async () => {
  await client?.close();
  server?.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("registers every domain and annotates read/write tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["core", "testplan", "testplan_write", "wit_comment_write", "wit_link_write", "wit_query", "wit_work_item", "wit_work_item_write", "work"]);
  assert.equal(tools.find((t) => t.name === "wit_work_item").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "wit_work_item_write").annotations.destructiveHint, true);
});

test("detects the api-version from the server location service", async () => {
  const fresh = await startClient();
  requests.length = 0;
  const res = await fresh.callTool({ name: "core", arguments: { action: "whoami" } });
  await fresh.close();
  const [first, second] = requests;
  assert.equal(first.method, "OPTIONS");
  assert.equal(first.path, "/Coll/_apis/wit");
  assert.equal(second.version, "6.0-preview.1");
  const me = JSON.parse(res.content[0].text);
  assert.equal(me.apiVersion, "6.0");
  assert.equal(me.apiVersionSource, "detected from the server");
});

test("retries with -preview when a resource is preview on this server", async () => {
  const history = await call("wit_work_item", { action: "list_history", id: 100 });
  const attempts = requests.filter((r) => r.path.endsWith("/updates")).map((r) => r.version);
  assert.deepEqual(attempts, ["6.0", "6.0-preview"]);
  assert.deepEqual(history[0].changes, { "System.State": { from: "New", to: "Active" } });
});

test("a configured api-version skips detection", async () => {
  const fixed = await startClient({ AZURE_DEVOPS_API_VERSION: "7.0" });
  requests.length = 0;
  await fixed.callTool({ name: "wit_comment_write", arguments: { action: "add", workItemId: 100, text: "x" } });
  await fixed.close();
  assert.ok(!requests.some((r) => r.method === "OPTIONS"));
  assert.equal(requests.find((r) => r.path.endsWith("/comments")).version, "7.0-preview.3");
});

test("read-only mode hides write tools", async () => {
  const readOnly = await startClient({ AZURE_DEVOPS_READONLY: "true" });
  const { tools } = await readOnly.listTools();
  await readOnly.close();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["core", "testplan", "wit_query", "wit_work_item", "work"]);
});

test("create resolves display names, defaults to api 6.0 and inherits paths from the parent's project", async () => {
  const result = await call("wit_work_item_write", {
    action: "create",
    workItemType: "Task",
    parentId: 100,
    fields: { Title: "Configurar IdP", "Remaining Work": 4, "Custom.Cliente": "ACME" },
  });
  const post = find("POST", "/_apis/wit/workitems/$Task");
  assert.equal(post.path, "/Coll/Proyecto B/_apis/wit/workitems/$Task");
  assert.equal(post.version, "6.0");
  assert.equal(post.auth, `Basic ${Buffer.from(":test-pat").toString("base64")}`);
  const paths = Object.fromEntries(post.body.filter((o) => o.path.startsWith("/fields/")).map((o) => [o.path, o.value]));
  assert.deepEqual(paths, {
    "/fields/System.Title": "Configurar IdP",
    "/fields/Microsoft.VSTS.Scheduling.RemainingWork": 4,
    "/fields/Custom.Cliente": "ACME",
    "/fields/System.AreaPath": "Proyecto B\\Equipo 1",
    "/fields/System.IterationPath": "Proyecto B\\Sprint 5",
  });
  const relation = post.body.find((o) => o.path === "/relations/-");
  assert.equal(relation.value.rel, "System.LinkTypes.Hierarchy-Reverse");
  assert.match(relation.value.url, /\/Coll\/_apis\/wit\/workItems\/100$/);
  assert.equal(result.created.title, "Configurar IdP");
});

test("unknown fields fail with suggestions instead of reaching the server", async () => {
  const result = await client.callTool({ name: "wit_work_item_write", arguments: { action: "update", id: 100, fields: { Remaining: 1 } } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Did you mean: Remaining Work/);
});

test("get_type reports fields required by process rules without creating anything", async () => {
  const type = await call("wit_work_item", { action: "get_type", project: "Proyecto B", workItemType: "Bug" });
  const probe = find("POST", "/_apis/wit/workitems/$Bug");
  assert.equal(probe.query.get("validateOnly"), "true");
  assert.deepEqual(type.requiredOnCreate, ["System.Title", "System.Description", "Microsoft.VSTS.Common.Activity"]);
  assert.equal(type.fields.find((f) => f.referenceName === "Microsoft.VSTS.Common.Activity").required, true);
});

test("rule errors list every invalid field and validateOnly saves nothing", async () => {
  const bad = await client.callTool({ name: "wit_work_item_write", arguments: { action: "create", project: "Proyecto B", workItemType: "Bug", fields: { Title: "x" } } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Fields with errors: System.Description \(required, invalidEmpty\); Microsoft.VSTS.Common.Activity/);
  const ok = await call("wit_work_item_write", { action: "create", project: "Proyecto B", workItemType: "Bug", validateOnly: true, fields: { Title: "x", Description: "d", "Microsoft.VSTS.Common.Activity": "Testing" } });
  assert.match(ok, /nothing was saved/);
  assert.equal(find("POST", "/_apis/wit/workitems/$Bug").query.get("validateOnly"), "true");
});

test("update with null removes the field and supports optimistic concurrency", async () => {
  await call("wit_work_item_write", { action: "update", id: 100, expectedRev: 7, fields: { "Assigned To": null, State: "Resolved" } });
  const patch = find("PATCH", "/_apis/wit/workitems/100");
  assert.deepEqual(patch.body, [
    { op: "test", path: "/rev", value: 7 },
    { op: "remove", path: "/fields/System.AssignedTo" },
    { op: "add", path: "/fields/System.State", value: "Resolved" },
  ]);
});

test("'my' without project queries the whole collection", async () => {
  const result = await call("wit_work_item", { action: "my" });
  const wiql = find("POST", "/_apis/wit/wiql");
  assert.equal(wiql.path, "/Coll/_apis/wit/wiql");
  assert.match(wiql.body.query, /\[System.AssignedTo\] = @Me/);
  assert.doesNotMatch(wiql.body.query, /TeamProject/);
  assert.equal(result.items[0]["System.AssignedTo"], "Ana <CORP\\ana>");
});

test("comments use the 6.0 preview version and infer the project from the work item", async () => {
  await call("wit_comment_write", { action: "add", workItemId: 100, text: "Listo para QA" });
  const post = find("POST", "/comments");
  assert.equal(post.path, "/Coll/Proyecto B/_apis/wit/workItems/100/comments");
  assert.equal(post.version, "6.0-preview.3");
});

test("unlink removes the matching relation by index", async () => {
  await call("wit_link_write", { action: "unlink", id: 100, targetId: 300, linkType: "child" });
  const patch = find("PATCH", "/_apis/wit/workitems/100");
  assert.deepEqual(patch.body, [
    { op: "test", path: "/rev", value: 7 },
    { op: "remove", path: "/relations/1" },
  ]);
});

test("add_hours increments Completed Work and decreases Remaining Work", async () => {
  const result = await call("wit_work_item_write", { action: "add_hours", id: 100, hours: 3, decreaseRemaining: true });
  assert.deepEqual(result, { id: 100, previousCompletedWork: 2, completedWork: 5, remainingWork: 2 });
});

test("list_teams without project returns my teams across projects", async () => {
  const teams = await call("core", { action: "list_teams" });
  const get = find("GET", "/_apis/teams");
  assert.equal(get.version, "6.0-preview.3");
  assert.equal(get.query.get("$mine"), "true");
  assert.deepEqual(teams, [{ id: "t1", name: "Equipo 1", project: "Proyecto B" }]);
});

test("search_identities uses the identity picker (prefix) and falls back to exact search", async () => {
  const found = await call("core", { action: "search_identities", search: "dani", top: 1 });
  const picker = find("POST", "/IdentityPicker/Identities");
  assert.equal(picker.version, "6.0-preview.1");
  assert.ok(picker.body.options.MinResults < picker.body.options.MaxResults);
  assert.deepEqual(found, [{ id: "u1", displayName: "Daniel Quintero", account: "SE\\daniel.quintero", mail: "dq@x.com" }]);
  const fallback = await call("core", { action: "search_identities", search: "exacto" });
  assert.equal(fallback[0].displayName, "Exacto");
});

test("create_test_cases in a requirement suite lets the suite create the Tests link", async () => {
  const result = await call("testplan_write", {
    action: "create_test_cases",
    testsWorkItemId: 100,
    planId: 1,
    suiteId: 2,
    testCases: [{ title: "Login OK", steps: [{ action: "Abrir <login>", expected: "Se muestra el formulario" }], priority: 1 }],
  });
  const create = find("POST", "/_apis/wit/workitems/$Test Case");
  assert.equal(create.path, "/Coll/Proyecto B/_apis/wit/workitems/$Test Case");
  assert.ok(!create.body.some((o) => o.path === "/relations/-"), "suite should create the link");
  const add = find("POST", "/Suites/2/TestCase");
  assert.equal(add.version, "6.0-preview.2");
  assert.equal(result.created, 1);
  assert.deepEqual(result.addedToSuite.ids, [result.results[0].id]);
});

test("test steps XML round-trips with escaping", () => {
  const steps = [
    { action: "Ingresar usuario <admin> & clave", expected: "Ve el \"dashboard\"" },
    { action: "Cerrar sesión" },
  ];
  const xml = stepsToXml(steps);
  assert.match(xml, /^<steps id="0" last="3">/);
  assert.match(xml, /type="ValidateStep"/);
  assert.match(xml, /type="ActionStep"/);
  assert.deepEqual(xmlToSteps(xml), [
    { step: 1, action: "Ingresar usuario <admin> & clave", expected: 'Ve el "dashboard"' },
    { step: 2, action: "Cerrar sesión", expected: undefined },
  ]);
});
