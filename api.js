const axios = require("axios");

/**
 * DevOpsAPI Class
 * Establishes a connection to Azure DevOps and provides methods to interact with Work Items.
 */
class DevOpsAPI {
  /**
   * Initializes the DevOps API client reading configuration from environment variables.
   * Required environment variables: AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_API_VERSION, AZURE_DEVOPS_PAT
   * @throws {Error} If any required environment variable is missing.
   */
  constructor() {
    const urlOrCollection = process.env.AZURE_DEVOPS_ORG_URL;
    if (!urlOrCollection) {
      throw new Error("Missing AZURE_DEVOPS_ORG_URL environment variable");
    }

    this.baseUrl = urlOrCollection.endsWith("/")
      ? urlOrCollection.slice(0, -1)
      : urlOrCollection;

    const defaultProject = process.env.AZURE_DEVOPS_PROJECT;
    if (!defaultProject) {
      throw new Error("Missing AZURE_DEVOPS_PROJECT environment variable");
    }
    this.defaultProject = defaultProject;

    const apiVersion = process.env.AZURE_DEVOPS_API_VERSION;
    if (!apiVersion) {
      throw new Error("Missing AZURE_DEVOPS_API_VERSION environment variable");
    }
    this.apiVersion = apiVersion;

    const pat = process.env.AZURE_DEVOPS_PAT;
    if (!pat) {
      throw new Error("Missing AZURE_DEVOPS_PAT environment variable");
    }

    const base64Pat = Buffer.from(`:${pat}`).toString("base64");

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Basic ${base64Pat}`,
      },
    });
  }

  // ==========================================
  // CRUD Operations for Work Items
  // ==========================================

  /**
   * Creates a new work item in Azure DevOps.
   * @param {string} type - The work item type (e.g., "Task", "User Story", "Bug").
   * @param {Object} [systemFields={}] - Standard system fields (e.g., Title, AssignedTo, Tags).
   * @param {Object} [customFields={}] - Custom fields specific to the project or organization.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The created work item data.
   */
  async createWorkItem(
    type,
    systemFields = {},
    customFields = {},
    project = this.defaultProject
  ) {
    if (!project) throw new Error("Project name is required.");
    try {
      const patchDoc = [];

      // Add system fields (e.g., Title, AssignedTo, Tags)
      Object.entries(systemFields).forEach(([fieldName, value]) => {
        if (value !== null && value !== undefined && value !== "") {
          patchDoc.push({
            op: "add",
            path: `/fields/System.${fieldName}`,
            value: value,
          });
        }
      });

      // Add any dynamic custom fields provided
      Object.entries(customFields).forEach(([fieldPath, value]) => {
        if (value !== null && value !== undefined && value !== "") {
          patchDoc.push({
            op: "add",
            path: `/fields/${fieldPath}`,
            value: value,
          });
        }
      });

      const url = `/${project}/_apis/wit/workitems/$${type}?api-version=${this.apiVersion}`;
      const response = await this.client.post(url, patchDoc, {
        headers: {
          "Content-Type": "application/json-patch+json",
        },
      });
      return response.data;
    } catch (error) {
      console.error(
        `Error creating ${type}:`,
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Create Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Retrieves full details for a specific work item by its ID.
   * @param {number|string} id - The ID of the work item.
   * @param {string} [project=this.defaultProject] - The project name.
   * @param {Array<string>} [fields=null] - Optional array of specific field names to retrieve.
   * @returns {Promise<Object>} The requested work item data.
   */
  async getWorkItem(id, project = this.defaultProject, fields = null) {
    if (!id) throw new Error("Work item ID is required.");
    try {
      let queryParams = `api-version=${this.apiVersion}`;
      if (fields && Array.isArray(fields) && fields.length > 0) {
        queryParams += `&fields=${fields.join(',')}`;
      } else {
        queryParams += `&$expand=all`;
      }
      const url = `/${project ? project + '/' : ''}_apis/wit/workitems/${id}?${queryParams}`;
      const response = await this.client.get(url);
      return response.data;
    } catch (error) {
      console.error(
        "Error fetching work item:",
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Get Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Updates specific fields of an existing work item without dealing with raw JSON-PATCH syntax.
   * Internally translates the objects to JSON-PATCH instructions.
   * @param {number|string} id - The ID of the work item to update.
   * @param {Object} [systemFields={}] - Standard system fields to update.
   * @param {Object} [customFields={}] - Custom fields to update.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The updated work item data.
   */
  async updateWorkItemFields(id, systemFields = {}, customFields = {}, project = this.defaultProject) {
    if (!id) throw new Error("Work item ID is required.");
    try {
      const patchDoc = [];

      Object.entries(systemFields).forEach(([fieldName, value]) => {
        if (value !== null && value !== undefined && value !== "") {
          patchDoc.push({ op: "add", path: `/fields/System.${fieldName}`, value });
        }
      });

      Object.entries(customFields).forEach(([fieldPath, value]) => {
        if (value !== null && value !== undefined && value !== "") {
          patchDoc.push({ op: "add", path: `/fields/${fieldPath}`, value });
        }
      });

      return await this.updateWorkItem(id, patchDoc, project);
    } catch (error) {
       // rely on updateWorkItem to log details
       throw error;
    }
  }

  /**
   * Updates an existing work item using a raw JSON-PATCH array.
   * @param {number|string} id - The ID of the work item to update.
   * @param {Array<Object>} updates - Array of JSON-PATCH operations (e.g., [{ op: "add", path: "/fields/...", value: "..." }]).
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The updated work item data.
   */
  async updateWorkItem(id, updates, project = this.defaultProject) {
    try {
      // updates parameter should be an array of patch operations
      const url = `/${project ? project + '/' : ''}_apis/wit/workitems/${id}?api-version=${this.apiVersion}`;
      const response = await this.client.patch(url, updates, {
        headers: {
          "Content-Type": "application/json-patch+json",
        },
      });
      return response.data;
    } catch (error) {
      console.error(
        "Error updating work item:",
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Update Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Deletes a work item by its ID.
   * @param {number|string} id - The ID of the work item to delete.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The deletion response.
   */
  async deleteWorkItem(id, project = this.defaultProject) {
    if (!id) throw new Error("Work item ID is required.");
    try {
      const url = `/${project ? project + '/' : ''}_apis/wit/workitems/${id}?api-version=${this.apiVersion}`;
      const response = await this.client.delete(url);
      return response.data;
    } catch (error) {
      console.error(
        "Error deleting work item:",
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Delete Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  // ==========================================
  // Additional / Utility Methods
  // ==========================================

  /**
   * Executes a raw WIQL (Work Item Query Language) query to search for work items.
   * @param {string} query - The WIQL query string.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} Results of the WIQL query including matched work item identifiers.
   */
  async runWiqlQuery(query, project = this.defaultProject) {
    if (!project) throw new Error("Project name is required.");
    try {
      const url = `/${project}/_apis/wit/wiql?api-version=${this.apiVersion}`;
      const response = await this.client.post(
        url,
        { query },
        {
          headers: { "Content-Type": "application/json" },
        },
      );
      return response.data;
    } catch (error) {
      console.error(
        "Error executing WIQL query:",
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `WIQL Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Retrieves concise details for multiple work items by their IDs.
   * Often used in conjunction with runWiqlQuery.
   * @param {Array<number>} ids - An array of work item IDs.
   * @param {Array<string>} [fields=null] - Optional array of specific field names to retrieve.
   * @returns {Promise<Array<Object>>} List of basic details for the requested work items.
   */
  async listWorkItems(ids, fields = null) {
    if (!ids || ids.length === 0) return [];
    try {
      const idList = ids.join(",");
      let queryParams = `api-version=${this.apiVersion}`;
      if (fields && Array.isArray(fields) && fields.length > 0) {
        queryParams += `&fields=${fields.join(',')}`;
      } else {
        queryParams += `&$expand=all`;
      }
      const url = `/_apis/wit/workitems?ids=${idList}&${queryParams}`;
      const response = await this.client.get(url);
      return response.data.value;
    } catch (error) {
      console.error(
        "Error fetching work items details:",
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Details Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Establishes a relationship link between two work items.
   * @param {number|string} sourceId - The source work item ID.
   * @param {number|string} targetId - The target work item ID to link to.
   * @param {string} [linkType="Child"] - The type of link (e.g., "Child", "Parent", "Related"). Default is "Child".
   * @returns {Promise<Object>} Results containing the newly added relations.
   */
  async linkWorkItems(sourceId, targetId, linkType = "Child") {
    try {
      // Azure DevOps uses relation link types.
      // Child = System.LinkTypes.Hierarchy-Forward
      // Parent = System.LinkTypes.Hierarchy-Reverse
      // Related = System.LinkTypes.Related
      let relType;
      const t = linkType.toLowerCase();
      if (t === "parent") {
        relType = "System.LinkTypes.Hierarchy-Reverse";
      } else if (t === "related") {
        relType = "System.LinkTypes.Related";
      } else {
        relType = "System.LinkTypes.Hierarchy-Forward";
      }

      const patchDoc = [
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: relType,
            url: `${this.baseUrl}/_apis/wit/workitems/${targetId}`,
          },
        },
      ];

      const url = `/_apis/wit/workitems/${sourceId}?api-version=${this.apiVersion}`;
      const response = await this.client.patch(url, patchDoc, {
        headers: {
          "Content-Type": "application/json-patch+json",
        },
      });
      return response.data;
    } catch (error) {
      console.error(
        `Error linking work items (${sourceId} -> ${targetId}):`,
        error.response?.data?.message || error.message,
      );
      throw new Error(
        `Link Error: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Convenience method to create a new "Task" work item and immediately link it as a child to a parent item.
   * @param {number|string} parentId - The ID of the parent item (e.g., User Story, Feature).
   * @param {Object} [systemFields={}] - Standard system fields for the new task.
   * @param {Object} [customFields={}] - Custom fields for the new task.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The new created and linked child task data.
   */
  async createChildTask(
    parentId,
    systemFields = {},
    customFields = {},
    project = this.defaultProject
  ) {
    if (!project) throw new Error("Project name is required.");
    // First create the task
    const newTask = await this.createWorkItem(
      "Task",
      systemFields,
      customFields,
      project
    );
    // Then link it to the parent (sourceId: new task, targetId: parent HU/FT as Parent)
    // Or link parent to child (sourceId: parent HU/FT, targetId: new task as Child)
    // Let's do parent adding child to its relations:
    await this.linkWorkItems(parentId, newTask.id, "Child");
    return newTask;
  }

  /**
   * Utility to add hours to a specific task by incrementing its Completed Work field.
   * If no hours are currently logged, it assigns the new hours.
   * Fetches only the necessary field to optimize response time.
   * @param {number|string} workItemId - The ID of the work item.
   * @param {number} hoursToAdd - The hours to add to the existing total.
   * @param {string} [project=this.defaultProject] - The project name.
   * @returns {Promise<Object>} The updated work item data and previous hours.
   */
  async addHours(workItemId, hoursToAdd, project = this.defaultProject) {
    const fieldName = "Microsoft.VSTS.Scheduling.CompletedWork";
    // Fetch only the CompletedWork field to optimize response time
    const itemDetails = await this.listWorkItems([workItemId], [fieldName]);
    
    if (!itemDetails || itemDetails.length === 0) {
      throw new Error(`Work Item ${workItemId} not found.`);
    }

    const item = itemDetails[0];
    // If it doesn't have hours, this defaults to 0 and just assigns the new hours
    const currentHours = item.fields[fieldName] || 0;
    const newHours = currentHours + hoursToAdd;

    const patchDoc = [{
      op: "add",
      path: `/fields/${fieldName}`,
      value: newHours
    }];

    const updateResult = await this.updateWorkItem(workItemId, patchDoc, project);
    return {
      currentHours,
      newHours,
      updateResult
    };
  }
}

module.exports = DevOpsAPI;
