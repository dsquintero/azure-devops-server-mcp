#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const DevOpsAPI = require('./api.js');
const api = new DevOpsAPI();

// Create the MCP server
const server = new Server(
  {
    name: "devops-mcp-adapter",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query_work_items",
        description: "Run a WIQL query to fetch work items. Useful for getting user tasks.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The WIQL query, e.g., SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.AssignedTo] = '@Me'" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["query"]
        }
      },
      {
        name: "create_work_item",
        description: "Create a new work item (Task, User Story, Feature).",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Work item type (e.g. Task, User Story, Feature)" },
            title: { type: "string", description: "Title of the work item" },
            assignedTo: { type: "string", description: "Email or name of the person" },
            tags: { type: "string", description: "Comma separated tags, e.g. 'AI, Backend'" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["type", "title"]
        }
      },
      {
        name: "log_hours",
        description: "Log hours to a work item by adjusting its Completed Work field.",
        inputSchema: {
          type: "object",
          properties: {
            workItemId: { type: "number", description: "The ID of the work item" },
            hoursToAdd: { type: "number", description: "The number of hours to add/log" }
          },
          required: ["workItemId", "hoursToAdd"]
        }
      },
      {
        name: "validate_daily_hours",
        description: "Validates if the user has logged 9 hours minimum for the given day in the configured project.",
        inputSchema: {
          type: "object",
          properties: {
            userEmail: { type: "string", description: "The user email or name to query for today's tasks" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["userEmail"]
        }
      },
      {
        name: "link_work_items",
        description: "Link an existing work item to a parent (e.g. link a Task to a User Story).",
        inputSchema: {
          type: "object",
          properties: {
            parentId: { type: "number", description: "The ID of the parent (e.g. User Story/Feature)" },
            childId: { type: "number", description: "The ID of the existing child (e.g. Task)" }
          },
          required: ["parentId", "childId"]
        }
      },
      {
        name: "create_child_task",
        description: "Creates a new Task and automatically links it to an existing parent HU or FT.",
        inputSchema: {
          type: "object",
          properties: {
            parentId: { type: "number", description: "The ID of the parent (e.g. User Story/Feature)" },
            title: { type: "string", description: "Title of the new task" },
            assignedTo: { type: "string", description: "Email or name of the person" },
            tags: { type: "string", description: "Comma separated tags, e.g. 'AI, Backend'" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["parentId", "title"]
        }
      }
    ]
  };
});

// Handle tools execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments || {};
    
    if (request.params.name === "query_work_items") {
      const result = await api.runWiqlQuery(args.query, args.project);
      
      // If the query returns work items, fetch the rich details to be useful
      if (result && result.workItems && result.workItems.length > 0) {
          const ids = result.workItems.map(w => w.id).slice(0, 50); // Get top 50 to avoid overloading
          const details = await api.getWorkItemsDetails(ids);
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    
    if (request.params.name === "create_work_item") {
      const result = await api.createWorkItem(args.type, args.title, args.assignedTo, args.tags, args.project);
      return { content: [{ type: "text", text: `Item created successfully! ID: ${result.id}\nURL: ${result._links?.html?.href}` }] };
    }
    
    if (request.params.name === "log_hours") {
      // 1. Fetch current item state to get current hours
      const itemDetails = await api.getWorkItemsDetails([args.workItemId]);
      if (!itemDetails || itemDetails.length === 0) {
          throw new Error("Work Item not found");
      }
      const item = itemDetails[0];
      const currentHours = item.fields["Microsoft.VSTS.Scheduling.CompletedWork"] || 0;
      const newHours = currentHours + args.hoursToAdd;
      
      // 2. Patch the hours
      const patch = [{
          "op": "add",
          "path": "/fields/Microsoft.VSTS.Scheduling.CompletedWork",
          "value": newHours
      }];
      
      const updateResult = await api.updateWorkItem(args.workItemId, patch);
      return { content: [{ type: "text", text: `Hours logged successfully. Old hours: ${currentHours}. New total Completed Work: ${newHours}.` }] };
    }
    
    if (request.params.name === "validate_daily_hours") {
      const items = await api.getCurrentUserDailyTasks(args.userEmail, args.project);
      let totalHoursToday = 0;
      
      items.forEach(item => {
          totalHoursToday += (item.fields["Microsoft.VSTS.Scheduling.CompletedWork"] || 0);
      });
      
      const requiredHours = 9;
      const isCompliant = totalHoursToday >= requiredHours;
      const difference = Math.abs(requiredHours - totalHoursToday);
      
      let report = `Daily Hours Report for ${args.userEmail}\n`;
      report += `Total Scheduled Completed Work for tasks modified today: ${totalHoursToday} hrs\n`;
      report += `Target: ${requiredHours} hrs\n`;
      report += `Status: ${isCompliant ? 'COMPLIANT ✅' : 'DEFICIT ❌'}\n`;
      
      if (!isCompliant) {
          report += `You need to log ${difference} more hours to reach the daily 9-hour goal.\n\n`;
      }
      
      report += "Tasks analyzed:\n";
      items.forEach(item => {
          report += `- [${item.fields["System.WorkItemType"]}] ID: ${item.id} - ${item.fields["System.Title"]} (${item.fields["Microsoft.VSTS.Scheduling.CompletedWork"] || 0} hrs)\n`;
      });
      
      return { content: [{ type: "text", text: report }] };
    }

    if (request.params.name === "link_work_items") {
      const result = await api.linkWorkItems(args.parentId, args.childId, "Child");
      return { content: [{ type: "text", text: `Successfully linked Task ${args.childId} as a Child to Parent ${args.parentId}.\nURL: ${result._links?.html?.href}` }] };
    }

    if (request.params.name === "create_child_task") {
      const result = await api.createChildTask(args.parentId, args.title, args.assignedTo, args.tags, args.project);
      return { content: [{ type: "text", text: `Successfully created Task ${result.id} and linked it as a Child to Parent ${args.parentId}.\nURL: ${result._links?.html?.href}` }] };
    }

    throw new Error(`Tool unknown: ${request.params.name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error calling tool ${request.params.name}: ${error.message}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Custom MCP Devops Server running on stdio");
}

main().catch(console.error);
