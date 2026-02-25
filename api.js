const axios = require('axios');

class DevOpsAPI {
    constructor() {
        const urlOrCollection = process.env.AZURE_DEVOPS_ORG_URL || "https://devops.softgic.co/DevOps_SE";
        this.baseUrl = urlOrCollection.endsWith('/') ? urlOrCollection.slice(0, -1) : urlOrCollection;
        
        this.defaultProject = process.env.AZURE_DEVOPS_PROJECT;

        const pat = process.env.AZURE_DEVOPS_PAT;
        if (!pat) {
            console.error("Missing AZURE_DEVOPS_PAT environment variable");
            process.exit(1);
        }

        const base64Pat = Buffer.from(`:${pat}`).toString('base64');

        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Authorization': `Basic ${base64Pat}`
            }
        });
    }

    async runWiqlQuery(query, project = this.defaultProject) {
        if (!project) throw new Error("Project name is required.");
        try {
            const url = `/${project}/_apis/wit/wiql?api-version=2.0`;
            const response = await this.client.post(url, { query }, {
                headers: { 'Content-Type': 'application/json' }
            });
            return response.data;
        } catch (error) {
            console.error("Error executing WIQL query:", error.response?.data?.message || error.message);
            throw new Error(`WIQL Error: ${error.response?.data?.message || error.message}`);
        }
    }

    async getWorkItemsDetails(ids) {
        if (!ids || ids.length === 0) return [];
        try {
            const idList = ids.join(',');
            const url = `/_apis/wit/workitems?ids=${idList}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags,Microsoft.VSTS.Scheduling.CompletedWork,Microsoft.VSTS.Scheduling.OriginalEstimate&api-version=2.0`;
            const response = await this.client.get(url);
            return response.data.value;
        } catch (error) {
            console.error("Error fetching work items details:", error.response?.data?.message || error.message);
            throw new Error(`Details Error: ${error.response?.data?.message || error.message}`);
        }
    }

    async createWorkItem(type, title, assignedTo, tags, project = this.defaultProject) {
        if (!project) throw new Error("Project name is required.");
        try {
            const patchDoc = [
                {
                    "op": "add",
                    "path": "/fields/System.Title",
                    "value": title
                }
            ];

            if (assignedTo) {
                patchDoc.push({
                    "op": "add",
                    "path": "/fields/System.AssignedTo",
                    "value": assignedTo
                });
            }

            if (tags) {
                patchDoc.push({
                    "op": "add",
                    "path": "/fields/System.Tags",
                    "value": tags
                });
            }

            const url = `/${project}/_apis/wit/workitems/$${type}?api-version=2.0`;
            const response = await this.client.post(url, patchDoc, {
                headers: {
                    'Content-Type': 'application/json-patch+json'
                }
            });
            return response.data;
        } catch (error) {
            console.error(`Error creating ${type}:`, error.response?.data?.message || error.message);
            throw new Error(`Create Error: ${error.response?.data?.message || error.message}`);
        }
    }

    async updateWorkItem(id, updates) {
        try {
            // updates parameter should be an array of patch operations
            const url = `/_apis/wit/workitems/${id}?api-version=2.0`;
            const response = await this.client.patch(url, updates, {
                headers: {
                    'Content-Type': 'application/json-patch+json'
                }
            });
            return response.data;
        } catch (error) {
            console.error("Error updating work item:", error.response?.data?.message || error.message);
            throw new Error(`Update Error: ${error.response?.data?.message || error.message}`);
        }
    }

    async linkWorkItems(sourceId, targetId, linkType = "Child") {
        try {
            // Azure DevOps uses relation link types.
            // Child = System.LinkTypes.Hierarchy-Forward
            // Parent = System.LinkTypes.Hierarchy-Reverse
            const relType = linkType.toLowerCase() === "parent" 
                ? "System.LinkTypes.Hierarchy-Reverse" 
                : "System.LinkTypes.Hierarchy-Forward";

            const patchDoc = [
                {
                    "op": "add",
                    "path": "/relations/-",
                    "value": {
                        "rel": relType,
                        "url": `${this.baseUrl}/_apis/wit/workItems/${targetId}`
                    }
                }
            ];

            const url = `/_apis/wit/workitems/${sourceId}?api-version=2.0`;
            const response = await this.client.patch(url, patchDoc, {
                headers: {
                    'Content-Type': 'application/json-patch+json'
                }
            });
            return response.data;
        } catch (error) {
            console.error(`Error linking work items (${sourceId} -> ${targetId}):`, error.response?.data?.message || error.message);
            throw new Error(`Link Error: ${error.response?.data?.message || error.message}`);
        }
    }

    async createChildTask(parentId, title, assignedTo, tags, project = this.defaultProject) {
        if (!project) throw new Error("Project name is required.");
        // First create the task
        const newTask = await this.createWorkItem("Task", title, assignedTo, tags, project);
        // Then link it to the parent (sourceId: new task, targetId: parent HU/FT as Parent)
        // Or link parent to child (sourceId: parent HU/FT, targetId: new task as Child)
        // Let's do parent adding child to its relations:
        await this.linkWorkItems(parentId, newTask.id, "Child");
        return newTask;
    }

    // Helper for finding daily tasks

    async getCurrentUserDailyTasks(email, project = this.defaultProject) {
        if (!project) throw new Error("Project name is required.");
        // Date formatting: Get today in YYYY-MM-DD format (UTC or local simple match)
        const today = new Date().toISOString().split('T')[0];
        
        let query = `
            SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.CompletedWork] 
            FROM WorkItems 
            WHERE [System.TeamProject] = '${project}' 
            AND [System.AssignedTo] CONTAINS '${email}' 
            AND [System.ChangedDate] >= '${today}'
            AND [System.State] <> 'Removed'
            AND [System.State] <> 'Obsolete'
        `;
        
        const wiqlResult = await this.runWiqlQuery(query);
        const ids = wiqlResult.workItems.map(item => item.id);
        
        if (ids.length === 0) return [];

        return await this.getWorkItemsDetails(ids);
    }
}

module.exports = DevOpsAPI;
