// ------------------------------------------------------------------ outils MCP
export const RO = { readOnlyHint: true, openWorldHint: false };

export const WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const DE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const str = (description) => ({ type: "string", description });

export const int = (description) => ({ type: "integer", description });

export const strList = (description) => ({ type: "array", items: { type: "string" }, description });
