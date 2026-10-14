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

function route(req, body) {
  const url = new URL(req.url, baseUrl);
  const p = decodeURIComponent(url.pathname);
  const m = req.method;

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
      const data = route(req, body);
      res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || { message: `no route ${req.method} ${url.pathname}` }));
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
