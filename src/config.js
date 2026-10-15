const ALL_DOMAINS = ["core", "work", "work-items", "test-plans"];

/**
 * Reads and validates the server configuration from environment variables.
 *
 * Required: AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PAT
 * Optional: AZURE_DEVOPS_PROJECT (default project, only a fallback),
 *           AZURE_DEVOPS_API_VERSION (default: detected from the server),
 *           AZURE_DEVOPS_READONLY ("true" registers only read tools),
 *           AZURE_DEVOPS_DOMAINS (comma separated subset of ALL_DOMAINS),
 *           AZURE_DEVOPS_TIMEOUT_MS (default 30000)
 * @returns {Object} The normalized configuration.
 * @throws {Error} If a required variable is missing or a value is invalid.
 */
function loadConfig(env = process.env) {
  const errors = [];

  const orgUrl = (env.AZURE_DEVOPS_ORG_URL || "").trim().replace(/\/+$/, "");
  if (!orgUrl) errors.push("AZURE_DEVOPS_ORG_URL is required (e.g. https://devops.company.com/DefaultCollection)");

  const pat = (env.AZURE_DEVOPS_PAT || "").trim();
  if (!pat) errors.push("AZURE_DEVOPS_PAT is required");

  // Empty or "auto": detected from the server on the first request.
  let apiVersion = (env.AZURE_DEVOPS_API_VERSION || "").trim();
  if (apiVersion.toLowerCase() === "auto") apiVersion = "";
  if (apiVersion && !/^\d+\.\d+$/.test(apiVersion)) {
    errors.push(`AZURE_DEVOPS_API_VERSION must look like "6.0" or "7.1", or be "auto" (got "${apiVersion}")`);
  }

  let domains = ALL_DOMAINS;
  if (env.AZURE_DEVOPS_DOMAINS && env.AZURE_DEVOPS_DOMAINS.trim().toLowerCase() !== "all") {
    domains = env.AZURE_DEVOPS_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const unknown = domains.filter((d) => !ALL_DOMAINS.includes(d));
    if (unknown.length) errors.push(`Unknown AZURE_DEVOPS_DOMAINS: ${unknown.join(", ")}. Valid: ${ALL_DOMAINS.join(", ")}`);
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }

  return {
    orgUrl,
    pat,
    apiVersion: apiVersion || null,
    defaultProject: (env.AZURE_DEVOPS_PROJECT || "").trim() || null,
    readOnly: /^(1|true|yes)$/i.test(env.AZURE_DEVOPS_READONLY || ""),
    domains,
    timeoutMs: Number(env.AZURE_DEVOPS_TIMEOUT_MS) || 30000,
  };
}

module.exports = { loadConfig, ALL_DOMAINS };
