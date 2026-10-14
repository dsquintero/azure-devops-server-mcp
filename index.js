#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { loadConfig } = require("./src/config.js");
const { DevOpsClient } = require("./src/client.js");
const { configureCoreTools } = require("./src/tools/core.js");
const { configureWorkTools } = require("./src/tools/work.js");
const { configureWorkItemTools } = require("./src/tools/work-items.js");
const { configureTestPlanTools } = require("./src/tools/test-plans.js");
const { version } = require("./package.json");

const DOMAIN_TOOLS = {
  core: configureCoreTools,
  work: configureWorkTools,
  "work-items": configureWorkItemTools,
  "test-plans": configureTestPlanTools,
};

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[devops-mcp-adapter] ${error.message}`);
    process.exit(1);
  }

  const server = new McpServer({ name: "devops-mcp-adapter", version });
  const ctx = { server, config, client: new DevOpsClient(config) };

  // core is always enabled: the other domains rely on it to discover projects and teams.
  for (const domain of new Set(["core", ...config.domains])) {
    DOMAIN_TOOLS[domain](ctx);
  }

  await server.connect(new StdioServerTransport());
  console.error(
    `[devops-mcp-adapter] v${version} connected to ${config.orgUrl} (api ${config.apiVersion}, domains: ${[...new Set(["core", ...config.domains])].join(", ")}${config.readOnly ? ", read-only" : ""})`
  );
}

main().catch((error) => {
  console.error("[devops-mcp-adapter] Fatal error:", error);
  process.exit(1);
});
