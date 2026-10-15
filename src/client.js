const axios = require("axios");

const enc = encodeURIComponent;

/** Used when the server version cannot be detected. */
const FALLBACK_API_VERSION = "6.0";

/**
 * Resources that are still "preview" in the 6.0 REST API.
 * The number is the resource revision appended as `<base>-preview.<n>`.
 * Azure DevOps accepts older preview revisions on newer servers, so these keep working on 7.x.
 * Any other resource that turns out to be preview is retried automatically with `-preview`.
 */
const PREVIEW = {
  connectionData: 1,
  identityPicker: 1,
  workItemTypeStates: 1,
  comments: 3,
  teamsMine: 3,
  iterationWorkItems: 1,
  testPlans: 1,
  testSuites: 1,
  suiteTestCases: 2,
};

class DevOpsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DevOpsError";
    this.status = status;
  }
}

/**
 * Thin REST client for Azure DevOps Server / Services.
 * Every call is scoped by the project (and team) passed per request, so a single
 * PAT can work across every project it has access to.
 */
class DevOpsClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.orgUrl;
    // Fixed by configuration, or detected from the server on the first request.
    this.apiVersion = config.apiVersion || null;
    this.apiVersionSource = config.apiVersion ? "configured" : null;
    this.defaultProject = config.defaultProject;
    this.fieldCatalog = null;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeoutMs,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`,
        Accept: "application/json",
      },
      // Azure DevOps returns 203 + HTML login page when the PAT is rejected.
      validateStatus: (status) => status >= 200 && status < 300 && status !== 203,
    });
  }

  /** Returns the api-version for a resource, adding the preview suffix when needed. */
  version(previewRevision) {
    return previewRevision ? `${this.apiVersion}-preview.${previewRevision}` : this.apiVersion;
  }

  /**
   * Resolves the api-version once: the configured one, or the highest *released* (non-preview)
   * version the server reports through its location service (OPTIONS /_apis/<area>).
   * Azure DevOps Server 2020 → 6.0, Server 2022 → 7.0, Azure DevOps Services → 7.1.
   */
  async ensureApiVersion() {
    if (this.apiVersion) return this.apiVersion;
    if (!this.detecting) {
      this.detecting = this.detectApiVersion().then((detected) => {
        this.apiVersion = detected.version;
        this.apiVersionSource = detected.source;
        console.error(`[azure-devops-server-mcp] api-version ${detected.version} (${detected.source})`);
        return detected.version;
      });
    }
    return this.detecting;
  }

  async detectApiVersion() {
    try {
      const response = await this.http.request({ method: "OPTIONS", url: "/_apis/wit" });
      const released = (response.data?.value || [])
        .map((resource) => resource.releasedVersion)
        .filter((v) => v && v !== "0.0")
        .sort(compareVersions);
      if (released.length) return { version: released[released.length - 1], source: "detected from the server" };
    } catch (error) {
      // An invalid PAT or URL fails here too; the real request will report it with a clear message.
      if (error.response?.status === 401 || error.response?.status === 203) throw toDevOpsError(error, "OPTIONS", "/_apis/wit");
    }
    return { version: FALLBACK_API_VERSION, source: "detection failed, using fallback" };
  }

  /**
   * Performs a request and returns `{ data, headers }`.
   * @param {string} method - HTTP verb.
   * @param {string} path - Path relative to the collection URL (already encoded).
   * @param {Object} [options]
   * @param {Object} [options.query] - Query string parameters (undefined values are skipped).
   * @param {*} [options.body] - Request body.
   * @param {number} [options.preview] - Preview revision of the resource (see PREVIEW).
   * @param {boolean} [options.patch] - Send the body as application/json-patch+json.
   */
  async request(method, path, { query = {}, body, preview, patch = false } = {}) {
    await this.ensureApiVersion();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.append(key, String(value));
    }

    const send = (apiVersion) => {
      params.set("api-version", apiVersion);
      return this.http.request({
        method,
        url: `${path}?${params.toString()}`,
        data: body,
        headers: body !== undefined ? { "Content-Type": patch ? "application/json-patch+json" : "application/json" } : undefined,
      });
    };

    try {
      let response;
      try {
        response = await send(this.version(preview));
      } catch (error) {
        // The resource is still preview in this server version: retry once with "-preview".
        if (preview || error.response?.data?.typeKey !== "VssInvalidPreviewVersionException") throw error;
        response = await send(`${this.apiVersion}-preview`);
      }
      return { data: response.data, headers: response.headers };
    } catch (error) {
      throw toDevOpsError(error, method, path);
    }
  }

  async get(path, options) {
    return (await this.request("GET", path, options)).data;
  }

  async post(path, body, options = {}) {
    return (await this.request("POST", path, { ...options, body })).data;
  }

  async patch(path, body, options = {}) {
    return (await this.request("PATCH", path, { ...options, body })).data;
  }

  async delete(path, options) {
    return (await this.request("DELETE", path, options)).data;
  }

  // ==========================================
  // Path helpers
  // ==========================================

  /** Returns the explicit project, the default one, or throws when the call needs a project. */
  requireProject(project) {
    const resolved = project || this.defaultProject;
    if (!resolved) {
      throw new DevOpsError("A project is required for this operation. Pass 'project' (use core action 'list_projects' to see the projects your PAT can access).");
    }
    return resolved;
  }

  projectPath(project) {
    return `/${enc(project)}`;
  }

  teamPath(project, team) {
    return team ? `/${enc(project)}/${enc(team)}` : `/${enc(project)}`;
  }

  workItemApiUrl(id) {
    return `${this.baseUrl}/_apis/wit/workItems/${id}`;
  }

  workItemWebUrl(id, project) {
    return project ? `${this.baseUrl}/${enc(project)}/_workitems/edit/${id}` : `${this.baseUrl}/_workitems/edit/${id}`;
  }

  // ==========================================
  // Fields
  // ==========================================

  /** Loads (once) every field defined in the collection, indexed by reference name and display name. */
  async getFieldCatalog() {
    if (!this.fieldCatalog) {
      const data = await this.get("/_apis/wit/fields");
      const byKey = new Map();
      for (const field of data.value || []) {
        byKey.set(field.referenceName.toLowerCase(), field);
        if (!byKey.has(field.name.toLowerCase())) byKey.set(field.name.toLowerCase(), field);
      }
      this.fieldCatalog = { fields: data.value || [], byKey };
    }
    return this.fieldCatalog;
  }

  /**
   * Resolves a field given its reference name ("Microsoft.VSTS.Scheduling.CompletedWork")
   * or its display name ("Completed Work") to the reference name.
   */
  async resolveFieldName(name) {
    const { fields, byKey } = await this.getFieldCatalog();
    const match = byKey.get(String(name).trim().toLowerCase());
    if (match) return match.referenceName;
    // Reference names not present in the catalog are left for the server to validate.
    if (/^[\w-]+(\.[\w-]+)+$/.test(String(name).trim())) return String(name).trim();

    const needle = String(name).toLowerCase();
    const suggestions = fields
      .filter((f) => f.name.toLowerCase().includes(needle) || f.referenceName.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((f) => `${f.name} (${f.referenceName})`);
    throw new DevOpsError(
      `Unknown field '${name}'.` +
        (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Use wit_work_item action 'get_type' to list the fields of a work item type.")
    );
  }

  /**
   * Converts a `{ fieldName: value }` map into JSON-PATCH operations.
   * `null` removes the field (update only); field names are resolved with resolveFieldName.
   */
  async buildFieldOperations(fields = {}, { allowRemove = false } = {}) {
    const ops = [];
    for (const [name, value] of Object.entries(fields || {})) {
      if (value === undefined) continue;
      const referenceName = await this.resolveFieldName(name);
      if (value === null) {
        if (!allowRemove) continue;
        ops.push({ op: "remove", path: `/fields/${referenceName}` });
      } else {
        ops.push({ op: "add", path: `/fields/${referenceName}`, value });
      }
    }
    return ops;
  }

  // ==========================================
  // Work items
  // ==========================================

  /**
   * Fetches work items by ID (any project) in chunks of 200.
   * @param {Array<number>} ids
   * @param {Object} [options]
   * @param {Array<string>} [options.fields] - Field names; when present relations cannot be expanded.
   * @param {string} [options.expand] - None | Relations | Fields | Links | All.
   */
  async getWorkItems(ids, { fields, expand } = {}) {
    const unique = [...new Set(ids.map(Number))].filter(Boolean);
    let resolvedFields = fields && fields.length ? await Promise.all(fields.map((f) => this.resolveFieldName(f))) : undefined;
    // The project is needed to build the web URL of each item.
    if (resolvedFields && !resolvedFields.includes("System.TeamProject")) resolvedFields = [...resolvedFields, "System.TeamProject"];
    const result = [];
    for (let i = 0; i < unique.length; i += 200) {
      const body = { ids: unique.slice(i, i + 200), errorPolicy: "Omit" };
      if (resolvedFields) body.fields = resolvedFields;
      else if (expand) body.$expand = expand;
      const data = await this.post("/_apis/wit/workitemsbatch", body);
      result.push(...(data.value || []).filter(Boolean));
    }
    // Keep the caller's order (WIQL order matters).
    const byId = new Map(result.map((wi) => [wi.id, wi]));
    return unique.map((id) => byId.get(id)).filter(Boolean);
  }

  async getWorkItem(id, { fields, expand = "Relations" } = {}) {
    const [item] = await this.getWorkItems([id], { fields, expand: fields ? undefined : expand });
    if (!item) throw new DevOpsError(`Work item ${id} not found or not accessible with this PAT.`, 404);
    return item;
  }

  /** Returns the project a work item belongs to (explicit project wins). */
  async projectOfWorkItem(id, project) {
    if (project) return project;
    const item = await this.getWorkItem(id, { fields: ["System.TeamProject"] });
    return item.fields["System.TeamProject"];
  }

  async createWorkItem(project, type, operations, { validateOnly } = {}) {
    return this.post(`${this.projectPath(project)}/_apis/wit/workitems/$${enc(type)}`, operations, {
      patch: true,
      query: { validateOnly: validateOnly ? "true" : undefined },
    });
  }

  async updateWorkItem(id, operations, { validateOnly } = {}) {
    return this.patch(`/_apis/wit/workitems/${id}`, operations, {
      patch: true,
      query: { validateOnly: validateOnly ? "true" : undefined },
    });
  }

  /** Runs WIQL at team, project or collection level (collection level = every project the PAT can see). */
  async runWiql(wiql, { project, team, top } = {}) {
    const prefix = project ? this.teamPath(project, team) : "";
    return this.post(`${prefix}/_apis/wit/wiql`, { query: wiql }, { query: { $top: top } });
  }
}

function compareVersions(a, b) {
  const [aMajor, aMinor = 0] = a.split(".").map(Number);
  const [bMajor, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function toDevOpsError(error, method, path) {
  const status = error.response?.status;
  const data = error.response?.data;
  const serverMessage = (data && typeof data === "object" && (data.message || data.value?.Message)) || null;

  let hint = "";
  if (status === 203 || status === 401) hint = " Check that AZURE_DEVOPS_PAT is valid and has not expired.";
  else if (status === 403) hint = " The PAT does not have permission for this resource (check its scopes and your project permissions).";
  else if (status === 404) hint = " Resource not found: check the project/team names and IDs.";
  else if (!status && error.code) hint = ` Network error (${error.code}). Check AZURE_DEVOPS_ORG_URL and connectivity (VPN / certificates: NODE_EXTRA_CA_CERTS).`;

  // Work item rule errors only name the first field in the message; list all of them.
  const ruleErrors = data?.customProperties?.RuleValidationErrors;
  if (Array.isArray(ruleErrors) && ruleErrors.length) {
    hint += ` Fields with errors: ${ruleErrors.map((e) => `${e.fieldReferenceName} (${e.fieldStatusFlags})`).join("; ")}.`;
  }

  const where = `${method} ${path.split("?")[0]}`;
  const message = serverMessage || error.message;
  const error_ = new DevOpsError(`${status ? `[HTTP ${status}] ` : ""}${message}${hint} (${where})`, status);
  error_.ruleErrors = ruleErrors;
  return error_;
}

module.exports = { DevOpsClient, DevOpsError, PREVIEW, FALLBACK_API_VERSION, enc };
