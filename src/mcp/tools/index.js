import { MEMORIES_TOOLS } from "./memories.js";
import { PROJECTS_TOOLS } from "./projects.js";
import { FILES_TOOLS } from "./files.js";

// Ordre d'exposition dans tools/list.
export const TOOLS = { ...MEMORIES_TOOLS, ...PROJECTS_TOOLS, ...FILES_TOOLS };
