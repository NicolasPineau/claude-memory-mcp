import { MEMORIES_TOOLS } from "./memories.js";
import { PROJECTS_TOOLS } from "./projects.js";
import { TASKS_TOOLS } from "./tasks.js";
import { GROUPS_TOOLS } from "./groups.js";
import { FILES_TOOLS } from "./files.js";

// Ordre d'exposition dans tools/list.
export const TOOLS = { ...MEMORIES_TOOLS, ...PROJECTS_TOOLS, ...TASKS_TOOLS, ...GROUPS_TOOLS, ...FILES_TOOLS };
