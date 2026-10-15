const { z } = require("zod");
const { DevOpsError, PREVIEW } = require("../client.js");
const { formatValue } = require("../format.js");
const { READ_ONLY, ADDITIVE, PROJECT_DESCRIPTION, need, defineTool } = require("./helpers.js");

const SUITE_TYPES = { static: "staticTestSuite", requirement: "requirementTestSuite", query: "dynamicTestSuite" };
const TESTS_RELATION = "Microsoft.VSTS.Common.TestedBy-Reverse";

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeXml = (text) => String(text).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const unescapeXml = (text) => String(text).replace(/&(lt|gt|amp|apos|quot|nbsp);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", apos: "'", quot: '"', nbsp: " " })[e]);
const htmlToText = (html) =>
  unescapeXml(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();

/** Builds the Microsoft.VSTS.TCM.Steps XML from [{ action, expected }]. */
function stepsToXml(steps) {
  const toParam = (text) => escapeXml(`<DIV><P>${escapeHtml(text || "").replace(/\r?\n/g, "<BR/>")}</P></DIV>`);
  const body = steps
    .map(
      (step, i) =>
        `<step id="${i + 2}" type="${step.expected ? "ValidateStep" : "ActionStep"}">` +
        `<parameterizedString isformatted="true">${toParam(step.action)}</parameterizedString>` +
        `<parameterizedString isformatted="true">${toParam(step.expected)}</parameterizedString>` +
        `<description/></step>`
    )
    .join("");
  return `<steps id="0" last="${steps.length + 1}">${body}</steps>`;
}

/** Parses the Steps XML back into [{ step, action, expected }]. */
function xmlToSteps(xml) {
  if (!xml) return [];
  const steps = [];
  const stepRegex = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
  let match;
  while ((match = stepRegex.exec(xml))) {
    const params = [...match[1].matchAll(/<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/gi)].map((m) => htmlToText(unescapeXml(m[1])));
    steps.push({ step: steps.length + 1, action: params[0] || "", expected: params[1] || undefined });
  }
  return steps;
}

const stepsSchema = z
  .array(z.object({ action: z.string().describe("What the tester does."), expected: z.string().optional().describe("Expected result.") }))
  .describe("Ordered test steps.");

function configureTestPlanTools(ctx) {
  const { client } = ctx;
  const testPlanPath = (project) => `${client.projectPath(project)}/_apis/testplan`;

  async function getSuite(project, planId, suiteId) {
    return client.get(`${testPlanPath(project)}/Plans/${planId}/suites/${suiteId}`, { preview: PREVIEW.testSuites });
  }

  async function addTestCasesToSuite(project, planId, suiteId, ids) {
    const body = ids.map((id) => ({ workItem: { id } }));
    const data = await client.post(`${testPlanPath(project)}/Plans/${planId}/Suites/${suiteId}/TestCase`, body, { preview: PREVIEW.suiteTestCases });
    return (data.value || data || []).map((tc) => tc.workItem?.id).filter(Boolean);
  }

  /** Test suite creation fails with TF26071 when the plan is modified concurrently: retry with backoff. */
  async function createSuite(project, planId, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.post(`${testPlanPath(project)}/Plans/${planId}/suites`, body, { preview: PREVIEW.testSuites });
      } catch (error) {
        const concurrency = /TF26071|changed by someone else|got update/i.test(error.message);
        if (!concurrency || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt + Math.random() * 200));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // testplan (read)
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "testplan",
    description:
      "Read Test Plans. Actions: list_plans, list_suites (flat list with parent, type and linked requirement), list_cases (test cases of a suite with configurations/testers), get_test_case (test case fields, readable steps and the work items it tests). When a response includes continuationToken, call again with it to get the next page.",
    annotations: READ_ONLY,
    schema: {
      action: z.enum(["list_plans", "list_suites", "list_cases", "get_test_case"]),
      project: z.string().optional().describe(PROJECT_DESCRIPTION),
      planId: z.number().int().optional().describe("Test plan ID. Required for: list_suites, list_cases."),
      suiteId: z.number().int().optional().describe("Test suite ID. Required for: list_cases."),
      testCaseId: z.number().int().optional().describe("Test case work item ID. Required for: get_test_case."),
      includeInactive: z.boolean().optional().describe("list_plans: include inactive plans. Default false."),
      owner: z.string().optional().describe("list_plans: filter by owner (name or ID)."),
      continuationToken: z.string().optional(),
    },
    handlers: {
      list_plans: async ({ project, includeInactive, owner, continuationToken }) => {
        const p = client.requireProject(project);
        const { data, headers } = await client.request("GET", `${testPlanPath(p)}/plans`, {
          query: { filterActivePlans: includeInactive ? undefined : "true", owner, continuationToken, includePlanDetails: "true" },
          preview: PREVIEW.testPlans,
        });
        return {
          plans: (data.value || []).map((plan) => ({
            id: plan.id,
            name: plan.name,
            state: plan.state,
            iteration: plan.iteration,
            areaPath: plan.areaPath,
            rootSuiteId: plan.rootSuite?.id,
            startDate: plan.startDate,
            endDate: plan.endDate,
            owner: formatValue(plan.owner),
          })),
          continuationToken: headers["x-ms-continuationtoken"] || undefined,
        };
      },

      list_suites: async (args) => {
        need(args, "list_suites", "planId");
        const p = client.requireProject(args.project);
        const { data, headers } = await client.request("GET", `${testPlanPath(p)}/Plans/${args.planId}/suites`, {
          query: { continuationToken: args.continuationToken },
          preview: PREVIEW.testSuites,
        });
        return {
          suites: (data.value || []).map((s) => ({
            id: s.id,
            name: s.name,
            parentSuiteId: s.parentSuite?.id,
            suiteType: s.suiteType,
            requirementId: s.requirementId || undefined,
            queryString: s.queryString || undefined,
          })),
          continuationToken: headers["x-ms-continuationtoken"] || undefined,
        };
      },

      list_cases: async (args) => {
        need(args, "list_cases", "planId", "suiteId");
        const p = client.requireProject(args.project);
        const { data, headers } = await client.request("GET", `${testPlanPath(p)}/Plans/${args.planId}/Suites/${args.suiteId}/TestCase`, {
          query: { continuationToken: args.continuationToken },
          preview: PREVIEW.suiteTestCases,
        });
        return {
          testCases: (data.value || []).map((tc) => ({
            id: tc.workItem?.id,
            title: tc.workItem?.name,
            points: (tc.pointAssignments || []).map((pa) => ({ pointId: pa.id, configuration: pa.configurationName, tester: formatValue(pa.tester) })),
          })),
          continuationToken: headers["x-ms-continuationtoken"] || undefined,
        };
      },

      get_test_case: async (args) => {
        need(args, "get_test_case", "testCaseId");
        const item = await client.getWorkItem(args.testCaseId, { expand: "All" });
        const fields = item.fields || {};
        return {
          id: item.id,
          url: client.workItemWebUrl(item.id, fields["System.TeamProject"]),
          title: fields["System.Title"],
          state: fields["System.State"],
          priority: fields["Microsoft.VSTS.Common.Priority"],
          assignedTo: formatValue(fields["System.AssignedTo"]),
          areaPath: fields["System.AreaPath"],
          iterationPath: fields["System.IterationPath"],
          automationStatus: fields["Microsoft.VSTS.TCM.AutomationStatus"],
          steps: xmlToSteps(fields["Microsoft.VSTS.TCM.Steps"]),
          tests: (item.relations || []).filter((r) => r.rel === TESTS_RELATION).map((r) => Number(r.url.split("/").pop())),
        };
      },
    },
  });

  // ---------------------------------------------------------------------------
  // testplan_write
  // ---------------------------------------------------------------------------
  defineTool(ctx, {
    name: "testplan_write",
    description:
      "Create Test Plans content for QA. Actions: create_plan, create_suite (static, requirement-based for one or more work items, or query-based), add_test_cases (existing test cases into a suite), create_test_cases (create one or more Test Case work items with steps, link them as 'Tests' to the work item they validate and optionally add them to a suite), update_test_case_steps (replace the steps of a test case). Typical QA flow: create_suite type=requirement for a User Story, then create_test_cases with planId/suiteId and testsWorkItemId.",
    annotations: ADDITIVE,
    schema: {
      action: z.enum(["create_plan", "create_suite", "add_test_cases", "create_test_cases", "update_test_case_steps"]),
      project: z.string().optional().describe(PROJECT_DESCRIPTION + " For create_test_cases it is inferred from testsWorkItemId when omitted."),
      name: z.string().optional().describe("Plan or suite name. Required for create_plan and for static/query suites."),
      iteration: z.string().optional().describe("create_plan: iteration path, e.g. 'Project\\Sprint 12'."),
      areaPath: z.string().optional().describe("create_plan / create_test_cases: area path."),
      iterationPath: z.string().optional().describe("create_test_cases: iteration path (copied from testsWorkItemId when omitted)."),
      description: z.string().optional().describe("create_plan: description."),
      startDate: z.string().optional().describe("create_plan: ISO date."),
      endDate: z.string().optional().describe("create_plan: ISO date."),
      planId: z.number().int().optional().describe("Test plan ID. Required for create_suite and add_test_cases; optional for create_test_cases."),
      parentSuiteId: z.number().int().optional().describe("create_suite: parent suite. Defaults to the plan root suite."),
      suiteType: z.enum(["static", "requirement", "query"]).optional().describe("create_suite: default 'static'."),
      requirementIds: z.array(z.number().int()).optional().describe("create_suite type=requirement: work item IDs (one suite is created per requirement)."),
      queryString: z.string().optional().describe("create_suite type=query: WIQL selecting Test Cases."),
      suiteId: z.number().int().optional().describe("Test suite ID. Required for add_test_cases; optional for create_test_cases."),
      testCaseIds: z.array(z.number().int()).optional().describe("add_test_cases: existing Test Case IDs."),
      testsWorkItemId: z.number().int().optional().describe("create_test_cases: work item (User Story, Bug, PBI...) that the new test cases validate."),
      testCases: z
        .array(
          z.object({
            title: z.string(),
            steps: stepsSchema.optional(),
            priority: z.number().int().min(1).max(4).optional(),
            fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Extra fields { name: value }, reference or display names."),
          })
        )
        .max(50)
        .optional()
        .describe("create_test_cases: test cases to create."),
      testCaseId: z.number().int().optional().describe("update_test_case_steps: Test Case ID."),
      steps: stepsSchema.optional().describe("update_test_case_steps: new steps (replaces existing ones)."),
    },
    handlers: {
      create_plan: async (args) => {
        need(args, "create_plan", "name");
        const p = client.requireProject(args.project);
        const plan = await client.post(
          `${testPlanPath(p)}/plans`,
          { name: args.name, iteration: args.iteration, areaPath: args.areaPath, description: args.description, startDate: args.startDate, endDate: args.endDate },
          { preview: PREVIEW.testPlans }
        );
        return { id: plan.id, name: plan.name, rootSuiteId: plan.rootSuite?.id, iteration: plan.iteration, areaPath: plan.areaPath };
      },

      create_suite: async (args) => {
        need(args, "create_suite", "planId");
        const p = client.requireProject(args.project);
        const type = args.suiteType || "static";
        let parentSuiteId = args.parentSuiteId;
        if (!parentSuiteId) {
          const plan = await client.get(`${testPlanPath(p)}/plans/${args.planId}`, { preview: PREVIEW.testPlans });
          parentSuiteId = plan.rootSuite?.id;
        }
        const base = { suiteType: SUITE_TYPES[type], parentSuite: { id: parentSuiteId } };

        if (type === "requirement") {
          need(args, "create_suite (requirement)", "requirementIds");
          const created = [];
          for (const requirementId of args.requirementIds) {
            const suite = await createSuite(p, args.planId, { ...base, requirementId });
            created.push({ id: suite.id, name: suite.name, requirementId });
          }
          return { planId: args.planId, parentSuiteId, suites: created };
        }

        need(args, `create_suite (${type})`, "name");
        if (type === "query") need(args, "create_suite (query)", "queryString");
        const suite = await createSuite(p, args.planId, { ...base, name: args.name, queryString: args.queryString });
        return { planId: args.planId, parentSuiteId, suite: { id: suite.id, name: suite.name, suiteType: suite.suiteType } };
      },

      add_test_cases: async (args) => {
        need(args, "add_test_cases", "planId", "suiteId", "testCaseIds");
        const p = client.requireProject(args.project);
        const added = await addTestCasesToSuite(p, args.planId, args.suiteId, args.testCaseIds);
        return { planId: args.planId, suiteId: args.suiteId, added };
      },

      create_test_cases: async (args) => {
        need(args, "create_test_cases", "testCases");
        if ((args.planId && !args.suiteId) || (!args.planId && args.suiteId)) throw new DevOpsError("planId and suiteId must be provided together.");

        let project = args.project;
        let inheritedArea;
        let inheritedIteration;
        if (args.testsWorkItemId) {
          const tested = await client.getWorkItem(args.testsWorkItemId, { fields: ["System.TeamProject", "System.AreaPath", "System.IterationPath"] });
          project = project || tested.fields["System.TeamProject"];
          inheritedArea = tested.fields["System.AreaPath"];
          inheritedIteration = tested.fields["System.IterationPath"];
        }
        project = client.requireProject(project);

        // A requirement-based suite creates the "Tests" link by itself when a case is added.
        let linkCreatedBySuite = false;
        if (args.planId && args.testsWorkItemId) {
          const suite = await getSuite(project, args.planId, args.suiteId);
          linkCreatedBySuite = suite.suiteType === SUITE_TYPES.requirement && suite.requirementId === args.testsWorkItemId;
        }

        const results = [];
        for (const tc of args.testCases) {
          try {
            const ops = [{ op: "add", path: "/fields/System.Title", value: tc.title }];
            const areaPath = args.areaPath || inheritedArea;
            const iterationPath = args.iterationPath || inheritedIteration;
            if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
            if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
            if (tc.priority) ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: tc.priority });
            if (tc.steps?.length) ops.push({ op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: stepsToXml(tc.steps) });
            ops.push(...(await client.buildFieldOperations(tc.fields)));
            if (args.testsWorkItemId && !linkCreatedBySuite) {
              ops.push({ op: "add", path: "/relations/-", value: { rel: TESTS_RELATION, url: client.workItemApiUrl(args.testsWorkItemId) } });
            }
            const created = await client.createWorkItem(project, "Test Case", ops);
            results.push({ ok: true, id: created.id, title: tc.title, url: client.workItemWebUrl(created.id, project) });
          } catch (error) {
            results.push({ ok: false, title: tc.title, error: error.message });
          }
        }

        const createdIds = results.filter((r) => r.ok).map((r) => r.id);
        let addedToSuite;
        if (args.planId && createdIds.length) {
          addedToSuite = await addTestCasesToSuite(project, args.planId, args.suiteId, createdIds);
        }
        return {
          project,
          testsWorkItemId: args.testsWorkItemId,
          created: createdIds.length,
          failed: results.length - createdIds.length,
          addedToSuite: addedToSuite ? { planId: args.planId, suiteId: args.suiteId, ids: addedToSuite } : undefined,
          results,
        };
      },

      update_test_case_steps: async (args) => {
        need(args, "update_test_case_steps", "testCaseId", "steps");
        await client.updateWorkItem(args.testCaseId, [{ op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: stepsToXml(args.steps) }]);
        return `Steps of test case ${args.testCaseId} replaced (${args.steps.length} steps).`;
      },
    },
  });
}

module.exports = { configureTestPlanTools, stepsToXml, xmlToSteps };
