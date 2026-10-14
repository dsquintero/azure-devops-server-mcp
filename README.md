# DevOps MCP Adapter 🚀

Model Context Protocol (MCP) server that connects AI assistants (Claude, Cursor, VS Code Copilot…) to **Azure DevOps Server (on-premises)** — and Azure DevOps Services — through the REST API.

The official `@azure-devops/mcp` server only works against the cloud (`dev.azure.com`): it only accepts PATs for cloud hosts and pins `api-version=7.2-preview`. This adapter targets self-hosted collections, defaults to **API 6.0** (Azure DevOps Server 2020) and follows the same tool design as the official server.

## ✨ Features

- **Multi-project:** the scope is whatever your PAT can access. Every tool takes an optional `project`; when it can be inferred (e.g. from a work item ID) you don't need it. `AZURE_DEVOPS_PROJECT` is only a fallback.
- **Any field, no hardcoded mapping:** fields are passed as `{ name: value }` using reference names (`Custom.Cliente`) or display names (`Remaining Work`). Unknown names fail fast with suggestions; `get_type` shows the fields, states and allowed values of each type.
- **API-version aware:** endpoints that are still *preview* in 6.0 (comments, team iterations, test plans…) get the right `-preview.N` suffix automatically.
- **Sprints & capacity:** current sprint of any team, your teams across all projects.
- **Test Plans for QA:** plans, requirement-based suites, test cases with steps linked to the User Story/Bug they validate.
- **Compact responses:** identities flattened, relations summarized, a default column set for lists — fewer tokens.
- **Safe for teams:** read-only mode, MCP tool annotations (`readOnlyHint`/`destructiveHint`), optimistic concurrency on updates.

---

## 🛠️ Setup

### 1. Requirements

- **Node.js 18+** (`npx` must be on your `PATH`). The server is downloaded from GitHub by `npx` the first time it runs.
- A **Personal Access Token** created in your Azure DevOps Server (*User settings → Personal access tokens*) with these scopes:
  - Work Items — Read & Write
  - Project and Team — Read
  - Test Management — Read & Write (only needed for QA / Test Plans)
  - Identity — Read

### 2. Store the PAT in an environment variable

Never paste the PAT in a file that is committed to git. Export it once in your shell profile and reference it from the client configuration:

```bash
# macOS / Linux (~/.zshrc or ~/.bashrc)
export AZURE_DEVOPS_PAT="your-personal-access-token"
```

```powershell
# Windows (PowerShell, persists for new terminals)
setx AZURE_DEVOPS_PAT "your-personal-access-token"
```

Restart the terminal (and the AI client) after setting it.

### 3. Configure your AI client

#### Claude Code

**Option A — CLI, available in all your projects (recommended):**

```bash
claude mcp add --env AZURE_DEVOPS_ORG_URL=https://your-devops-server.com/CollectionName --env AZURE_DEVOPS_PAT=$AZURE_DEVOPS_PAT --env AZURE_DEVOPS_API_VERSION=6.0 --scope user --transport stdio devops-mcp-adapter -- npx -y github:dsquintero/devops-mcp-adapter
```

- `--scope user` stores it in `~/.claude.json` for every project; use `--scope local` (default) for the current project only.
- Everything after `--` is the server command.
- On Windows use `-- cmd /c npx -y github:dsquintero/devops-mcp-adapter`.

**Option B — shared with the team through the repository (`.mcp.json` in the project root):**

```json
{
  "mcpServers": {
    "devops-mcp-adapter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:dsquintero/devops-mcp-adapter"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_API_VERSION": "6.0",
        "AZURE_DEVOPS_PAT": "${AZURE_DEVOPS_PAT}"
      }
    }
  }
}
```

Claude Code expands `${AZURE_DEVOPS_PAT}` from each person's environment, so the file can be committed safely. Each user approves the project server the first time.

**Verify:** run `claude mcp list` (should show `devops-mcp-adapter: ✓ Connected`), or type `/mcp` inside a session. Then ask *"who am I in Azure DevOps?"* — it calls `core` → `whoami`.

#### OpenCode

Add the server to your global config `~/.config/opencode/opencode.json` (all projects) or to `opencode.json` in a project root (shared with the team):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "devops-mcp-adapter": {
      "type": "local",
      "command": ["npx", "-y", "github:dsquintero/devops-mcp-adapter"],
      "enabled": true,
      "timeout": 20000,
      "environment": {
        "AZURE_DEVOPS_ORG_URL": "https://your-devops-server.com/CollectionName",
        "AZURE_DEVOPS_API_VERSION": "6.0",
        "AZURE_DEVOPS_PAT": "{env:AZURE_DEVOPS_PAT}"
      }
    }
  }
}
```

- OpenCode uses `{env:VAR}` (not `${VAR}`) to read environment variables. An unset variable becomes an empty string, the server stops and OpenCode only shows `MCP error -32000: Connection closed` (see Troubleshooting).
- `timeout` raises the default 5 s limit, which can be too short the first time `npx` downloads the package.

**Verify:** run `opencode mcp list`, then ask *"who am I in Azure DevOps?"*.

#### Other clients (Cursor, Claude Desktop, Windsurf…)

They use the common `mcpServers` format (see [mcp_config.example.json](mcp_config.example.json)). Most of them do not expand environment variables, so the PAT must be written in the file — keep that file out of git.

Ready-to-copy files: [examples/claude-code.mcp.json](examples/claude-code.mcp.json) · [examples/opencode.json](examples/opencode.json) · [mcp_config.example.json](mcp_config.example.json)

### 4. Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AZURE_DEVOPS_ORG_URL` | ✅ | | Collection URL, e.g. `https://devops.company.com/DefaultCollection` |
| `AZURE_DEVOPS_PAT` | ✅ | | Personal Access Token |
| `AZURE_DEVOPS_API_VERSION` | | `6.0` | Server API version (`6.0` = Server 2020, `7.0` = Server 2022, `7.1` = Server 2022.1+) |
| `AZURE_DEVOPS_PROJECT` | | | Fallback project when a tool needs one and it cannot be inferred. Leave empty to work across every project |
| `AZURE_DEVOPS_DOMAINS` | | `all` | Comma separated: `core,work,work-items,test-plans` (`core` is always on) |
| `AZURE_DEVOPS_READONLY` | | `false` | `true` registers only read tools |
| `AZURE_DEVOPS_TIMEOUT_MS` | | `30000` | HTTP timeout |
| `NODE_EXTRA_CA_CERTS` | | | Path to the corporate CA (`.pem`) when the server uses an internal certificate |

Suggested profiles:

| Role | Settings |
| --- | --- |
| Developers / SM / PO | defaults |
| QA | defaults (Test Plans included) |
| Read-only users, reporting | `AZURE_DEVOPS_READONLY=true` |
| Only boards, smaller tool list | `AZURE_DEVOPS_DOMAINS=work,work-items` |

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid configuration: AZURE_DEVOPS_PAT is required`, or the client only says `Connection closed` / `failed` | A required variable is not visible to the client: restart the terminal and the client after exporting it, and check `{env:…}` (OpenCode) vs `${…}` (Claude Code). Running the server command in a terminal with the same variables prints the exact error |
| `[HTTP 401]` / `[HTTP 203]` | PAT expired or wrong |
| `[HTTP 403]` | PAT missing a scope, or no permission on that project |
| `Network error (UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT…)` | Set `NODE_EXTRA_CA_CERTS` to the corporate CA |
| `Network error (ENOTFOUND / ECONNREFUSED / ETIMEDOUT)` | Check the URL and that you are on the VPN |
| OpenCode shows the server as failed on first start | Increase `timeout`, or run `npx -y github:dsquintero/devops-mcp-adapter` once in a terminal to warm the cache (stop it with Ctrl+C) |

---

## 🤖 Tools

Tools are grouped by domain and use an `action` parameter (same design as the official server).

### `core` (read)
| Action | Description |
| --- | --- |
| `whoami` | Authenticated user and connection info (useful to validate the setup) |
| `list_projects` | Every project the PAT can see |
| `list_teams` | Teams of a project, or — without project — the teams you belong to across all projects |
| `search_identities` | Find users by name/email for `Assigned To` or WIQL |

### `work` (read)
| Action | Description |
| --- | --- |
| `list_team_iterations` | Sprints of a team (`timeframe`: current / past / future) |
| `list_iterations` | Iteration tree of a project |
| `get_team_capacity` | Capacity and days off per member (current sprint by default) |

### `wit_work_item` (read)
| Action | Description |
| --- | --- |
| `get` / `get_batch` | Work items by ID, from any project |
| `my` | Items assigned to / created by me, across all projects or one |
| `list_for_iteration` | Items in a team sprint (current by default), with their parent |
| `list_comments` | Discussion of a work item |
| `list_history` | Who changed what and when |
| `list_types` / `get_type` | Types of a project; states, fields, required flags and allowed values of a type |

### `wit_query` (read)
| Action | Description |
| --- | --- |
| `wiql` | Ad-hoc WIQL (collection-wide when no project is given) |
| `list_saved` / `run_saved` | Saved queries (by ID or path, e.g. `Shared Queries/Sprint/Bugs`) |

### `wit_work_item_write`
| Action | Description |
| --- | --- |
| `create` | Create any type with any fields, optionally under a parent |
| `update` | Set or clear (`null`) fields, optional raw JSON-PATCH and `expectedRev` |
| `update_batch` | Update several items |
| `add_children` | Create several children; Area/Iteration copied from the parent |
| `add_hours` | Add to Completed Work, optionally decreasing Remaining Work |
| `delete` | Move to the recycle bin |

### `wit_comment_write` — `add`, `update`

### `wit_link_write` — `link`, `unlink`
Link types: `child`, `parent`, `related`, `duplicate`, `duplicate of`, `successor`, `predecessor`, `tested by`, `tests`, `affects`, `affected by`, `hyperlink` (e.g. to reference a pull request hosted in the cloud organization).

### `testplan` (read)
| Action | Description |
| --- | --- |
| `list_plans` / `list_suites` / `list_cases` | Navigate Test Plans |
| `get_test_case` | Fields, readable steps and the work items it tests |

### `testplan_write`
| Action | Description |
| --- | --- |
| `create_plan` | New test plan |
| `create_suite` | Static, query-based, or requirement-based (one per User Story/Bug) |
| `add_test_cases` | Add existing test cases to a suite |
| `create_test_cases` | Create test cases with steps, linked to the work item they test and optionally added to a suite |
| `update_test_case_steps` | Replace the steps of a test case |

### Example prompts

- *"What's in the current sprint of team Equipo 1 in Proyecto B, grouped by state?"*
- *"Create 3 tasks under story 4521 for backend, frontend and QA, 4h remaining each."*
- *"Log 2 hours on task 4533 and reduce its remaining work."*
- *"Create a requirement suite for story 4521 in plan 87 and write test cases for its acceptance criteria."*

---

## ⬆️ Migrating from 1.x

Tool names changed to the action-based design:

| 1.x | 2.x |
| --- | --- |
| `get_work_item` | `wit_work_item` → `get` |
| `query_work_items` | `wit_query` → `wiql` |
| `create_work_item` | `wit_work_item_write` → `create` |
| `update_work_item` | `wit_work_item_write` → `update` |
| `delete_work_item` | `wit_work_item_write` → `delete` |
| `create_child_task` | `wit_work_item_write` → `add_children` / `create` with `parentId` |
| `link_work_items` | `wit_link_write` → `link` |
| `add_hours` | `wit_work_item_write` → `add_hours` |

`title`/`assignedTo`/`tags`/`state`/`customFields` are replaced by a single `fields` map. `AZURE_DEVOPS_PROJECT` and `AZURE_DEVOPS_API_VERSION` are now optional.

## 🧪 Development

```bash
npm install
npm test
```

To try a local checkout in Claude Code or OpenCode, replace the `npx` command with `node /absolute/path/to/devops-mcp-adapter/index.js`.

Tests run the real MCP server over stdio against a fake Azure DevOps Server, checking URLs, api-versions and request bodies.
