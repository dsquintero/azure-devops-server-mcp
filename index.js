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
        name: "get_work_item",
        description: "Get details for a specific Work Item by ID.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The ID of the work item" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" },
            fields: { 
              type: "array", 
              items: { type: "string" }, 
              description: "Optional list of specific field names to retrieve, e.g. ['System.Title', 'System.State']." 
            }
          },
          required: ["id"]
        }
      },
      {
        name: "update_work_item",
        description: "Update an existing work item by providing fields to change.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The ID of the work item to update" },
            title: { type: "string", description: "Title of the work item" },
            assignedTo: { type: "string", description: "Email or name of the person" },
            tags: { type: "string", description: "Comma separated tags, e.g. 'AI, Backend'" },
            state: { type: "string", description: "State of the work item, e.g. 'Active', 'Closed', 'Resolved'" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" },
            customFields: {
              type: "object",
              description: "Optional key-value object for any other Azure DevOps fields. Key must be the full field reference name.",
              additionalProperties: true
            }
          },
          required: ["id"]
        }
      },
      {
        name: "delete_work_item",
        description: "Delete an existing work item.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The ID of the work item to delete" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["id"]
        }
      },
      {
        name: "query_work_items",
        description: "Run a WIQL query to fetch work items. Useful for getting user tasks.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The WIQL query, e.g., SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.AssignedTo] = '@Me'" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" },
            fields: { 
              type: "array", 
              items: { type: "string" }, 
              description: "Optional list of specific field names to retrieve for the resulting items." 
            }
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
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" },
            customFields: {
              type: "object",
              description: "Optional key-value object for any other Azure DevOps fields. Key must be the full field reference name, e.g. 'System.Description' or 'Microsoft.VSTS.Scheduling.OriginalEstimate'.",
              additionalProperties: true
            }
          },
          required: ["type", "title"]
        }
      },
      {
        name: "add_hours",
        description: "Add or log hours to a work item by adjusting its Completed Work field.",
        inputSchema: {
          type: "object",
          properties: {
            workItemId: { type: "number", description: "The ID of the work item" },
            hoursToAdd: { type: "number", description: "The number of hours to add/log" },
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" }
          },
          required: ["workItemId", "hoursToAdd"]
        }
      },

      {
        name: "link_work_items",
        description: "Link an existing work item to another (e.g. Parent, Child, Related).",
        inputSchema: {
          type: "object",
          properties: {
            parentId: { type: "number", description: "The ID of the source or parent work item" },
            childId: { type: "number", description: "The ID of the target or child work item" },
            linkType: { type: "string", description: "The relationship type: 'Child', 'Parent', or 'Related'. Defaults to 'Child'." }
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
            project: { type: "string", description: "Project name (optional if AZURE_DEVOPS_PROJECT env var is set)" },
            customFields: {
              type: "object",
              description: "Optional key-value object for any other Azure DevOps fields. Key must be the full field reference name, e.g. 'System.Description' or 'Microsoft.VSTS.Scheduling.OriginalEstimate'.",
              additionalProperties: true
            }
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

    if (request.params.name === "get_work_item") {
      const result = await api.getWorkItem(args.id, args.project, args.fields);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (request.params.name === "update_work_item") {
      const systemFields = {
        Title: args.title,
        AssignedTo: args.assignedTo,
        Tags: args.tags,
        State: args.state
      };
      const result = await api.updateWorkItemFields(args.id, systemFields, args.customFields, args.project);
      return { content: [{ type: "text", text: `Item updated successfully! ID: ${result.id}\nURL: ${result._links?.html?.href}` }] };
    }

    if (request.params.name === "delete_work_item") {
      await api.deleteWorkItem(args.id, args.project);
      return { content: [{ type: "text", text: `Item ${args.id} deleted successfully.` }] };
    }
    
    if (request.params.name === "query_work_items") {
      const result = await api.runWiqlQuery(args.query, args.project);
      
      // If the query returns work items, fetch the rich details to be useful
      if (result && result.workItems && result.workItems.length > 0) {
          const ids = result.workItems.map(w => w.id).slice(0, 50); // Get top 50 to avoid overloading
          const details = await api.listWorkItems(ids, args.fields);
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    
    if (request.params.name === "create_work_item") {
      const systemFields = {
        Title: args.title,
        AssignedTo: args.assignedTo,
        Tags: args.tags
      };
      const result = await api.createWorkItem(args.type, systemFields, args.customFields, args.project);
      return { content: [{ type: "text", text: `Item created successfully! ID: ${result.id}\nURL: ${result._links?.html?.href}` }] };
    }
    
    if (request.params.name === "add_hours") {
      const result = await api.addHours(args.workItemId, args.hoursToAdd, args.project);
      return { content: [{ type: "text", text: `Hours logged successfully. Old hours: ${result.currentHours}. New total Completed Work: ${result.newHours}.` }] };
    }


    if (request.params.name === "link_work_items") {
      const linkType = args.linkType || "Child";
      const result = await api.linkWorkItems(args.parentId, args.childId, linkType);
      return { content: [{ type: "text", text: `Successfully linked Item ${args.childId} as ${linkType} to Item ${args.parentId}.\nURL: ${result._links?.html?.href}` }] };
    }

    if (request.params.name === "create_child_task") {
      const systemFields = {
        Title: args.title,
        AssignedTo: args.assignedTo,
        Tags: args.tags
      };
      const result = await api.createChildTask(args.parentId, systemFields, args.customFields, args.project);
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
