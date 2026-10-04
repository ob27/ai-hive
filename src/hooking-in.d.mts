export type HookingTool = { id: string; name: string; how: string; flag: string; gets: string; status: string };
export const TOOLS: HookingTool[];
export const EVENT_RULES: [string, string][];
export function rawApiSnippets(o: { base: string; key: string; name?: string; sid?: string; project?: string }): { curl: string; python: string; node: string; buzz: string; heartbeat: string };
