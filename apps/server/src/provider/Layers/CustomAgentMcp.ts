import type { CustomAgentSettings } from "@t3tools/contracts";

const disabledCustomAgentMcp = () => ({
  ok: false,
  error: "MCP is disabled for this CustomAgent instance.",
});

export function makeCustomAgentMcp(settings: CustomAgentSettings) {
  return {
    listServers: async () =>
      settings.mcpEnabled ? { ok: true, servers: [] } : disabledCustomAgentMcp(),
    listTools: async (_server?: string) =>
      settings.mcpEnabled ? { ok: true, tools: [] } : disabledCustomAgentMcp(),
    callTool: async (_server: string, _tool: string, _args: unknown) =>
      settings.mcpEnabled
        ? { ok: false, error: "No MCP client runtime is configured in this server process." }
        : disabledCustomAgentMcp(),
    classifyRisk: (_server: string, _tool: string, _args: unknown) => "network" as const,
  };
}
