# DevOps MCP Adapter 🚀

Custom Model Context Protocol (MCP) server designed specifically to bridge AI Assistants (like Claude or Cursor) with **Azure DevOps Server (On-Premise)** and Azure DevOps Services deployments.

Unlike the official `@azure-devops/mcp` server, this adapter bypasses automatic API discovery issues by interacting directly with the Azure DevOps REST API for specific, common operations.

## ✨ Features

- **Zero Location-Discovery Errors:** Built for On-Premise compatibility.
- **Dynamic API Versioning:** Choose the API version that matches your server (defaults to 7.1).
- **Full Hierarchy Support:** Create and link tasks as children/parents/related items to User Stories or Features.
- **Intelligent Querying (WIQL):** Fetch any item using WIQL syntax with optional specific column (`fields`) selection.
- **Full CRUD:** Create, Read, Update, and Delete Work Items effectively using a normalized property structure.
- **Multi-Project Support:** Agnostic to specific projects (dynamic switching).

---

## 🛠️ Installation & Setup (For AI Assistants)

You don't need to clone or run this manually. Just configure your AI Assistant (Cursor, Claude Desktop, etc.) to use this tool via `npx`!

1. Add the following to your MCP configuration file (e.g. `mcp_config.json`):

```json
{
  "mcpServers": {
    "devops-mcp-adapter": {
      "command": "npx",
      "args": ["-y", "github:dsquintero/devops-mcp-adapter"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_PROJECT": "Your.Project.Name.Here",
        "AZURE_DEVOPS_API_VERSION": "7.1",
        "AZURE_DEVOPS_PAT": "YOUR_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

> **Note:** All 4 environment variables (`ORG_URL`, `PROJECT`, `API_VERSION`, `PAT`) mentioned above are **required** to start the server.

### Requirements

- Your Azure DevOps **Personal Access Token (PAT)** must have `Read & Write` scopes for **Work Items**.
- Node.js installed on your machine (`npx` is required).

---

## 🤖 Available AI Tools

Once connected, your AI will have access to the following operations:

- `get_work_item`: Retrieve details of a specific Work Item by ID, optionally filtering by `fields`.
- `query_work_items`: Execute WIQL queries to find tasks, stories, or bugs, selecting specific `fields` if needed.
- `create_work_item`: Create any type of work item and assign it seamlessly (separates system and custom fields).
- `update_work_item`: Update existing work items easily via standard properties or custom fields mappings.
- `delete_work_item`: Delete an existing work item by ID.
- `create_child_task`: Instantly create a Task and link it (as `Child`) to a parent User Story/Feature.
- `link_work_items`: Attach existing items to each other using `Child`, `Parent`, or `Related` relations.
- `add_hours`: Incrementally add or log your hours to the `Completed Work` field.
