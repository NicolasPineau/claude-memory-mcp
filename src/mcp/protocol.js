import { INSTRUCTIONS, VERSION } from "../config.js";
import { ensureSchema } from "../db/schema.js";
import { TOOLS } from "./tools/index.js";

// ------------------------------------------------------------------ protocole MCP (JSON-RPC, Streamable HTTP sans état)
export const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export async function handleRpc(msg, env, ctx) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return err(-32600, "Requête invalide");
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "memoire", title: "Mémoire partagée", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case "tools/call": {
      const tool = TOOLS[params.name];
      if (!tool) return err(-32602, `Outil inconnu : ${params.name}`);
      try {
        await ensureSchema(env.DB);
        const text = await tool.run(env.DB, params.arguments || {}, ctx);
        return ok({ content: [{ type: "text", text }], isError: /^Erreur/.test(text) });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Erreur interne : ${e.message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return err(-32601, `Méthode inconnue : ${method}`);
  }
}
