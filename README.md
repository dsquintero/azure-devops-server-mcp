# DevOps MCP Adapter 🚀

Custom Model Context Protocol (MCP) server designed specifically to bridge AI Assistants (like Claude or Cursor) with **Azure DevOps Server (On-Premise)** deployments.

Unlike the official `@azure-devops/mcp` server, this adapter bypasses automatic API discovery issues by interacting directly with the Azure DevOps REST API for specific, common operations.

## ✨ Features

- **Zero Location-Discovery Errors:** Built for On-Premise compatibility.
- **Full Hierarchy Support:** Create tasks entirely linked as children of User Stories or Features.
- **Intelligent Querying (WIQL):** Fetch any item using WIQL syntax.
- **Time Tracking:** Log completed hours and run validation constraints (e.g. check if 9 hours are logged daily).
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
        "AZURE_DEVOPS_PAT": "YOUR_PERSONAL_ACCESS_TOKEN",
        "AZURE_DEVOPS_PROJECT": "Your.Project.Name.Here"
      }
    }
  }
}
```

### Requirements

- Your Azure DevOps **Personal Access Token (PAT)** must have `Read & Write` scopes for **Work Items**.
- Node.js installed on your machine (`npx` is required).

---

## 🤖 Available AI Tools

Once connected, your AI will have access to:

- `query_work_items`: Execute WIQL queries to find tasks, stories, or bugs.
- `create_work_item`: Create any type of work item and assign it seamlessly.
- `create_child_task`: Instantly create a Task and link it (as `Child`) to a parent User Story/Feature.
- `link_work_items`: Attach an existing independent task to a broader parent item.
- `log_hours`: Incrementally log your hours to the `Completed Work` field.
- `validate_daily_hours`: Validates if a user has met the daily 9-hour work logging quota in a specific project.
