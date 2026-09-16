// scripts/mcp-matrix.ts — exercises the MCP server across a matrix of dynamic
// parameter combinations + edge cases, and prints a PASS/FAIL table.
//
// Usage: npx tsx scripts/mcp-matrix.ts <codePath> <migrationsPath>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CODE = process.argv[2];
const MIGR = process.argv[3];
if (!CODE || !MIGR) { console.error("need <codePath> <migrationsPath>"); process.exit(1); }

function textOf(res: any): string {
    return (res.content ?? []).map((c: any) => c.text ?? "").join("\n");
}
function isErr(res: any): boolean { return res.isError === true; }
function tableCount(yaml: string): number {
    // count top-level "  <name>:" table keys under schema: (2-space indent, not enums/cols)
    return (yaml.match(/^  (?!enums:)\w+:$/gm) ?? []).length;
}
function fileCount(json: string): number {
    try { return JSON.parse(json).count ?? -1; } catch { return -1; }
}

type Case = {
    name: string;
    tool: string;
    args: Record<string, unknown>;
    expect: (res: any, txt: string) => boolean; // true = pass
};

const cases: Case[] = [
    // ── find_files: dynamic query + topk ──
    { name: "find topk=1", tool: "find_files", args: { codePath: CODE, query: "job assignment", topk: 1 },
      expect: (_r, t) => fileCount(t) === 1 },
    { name: "find topk=10", tool: "find_files", args: { codePath: CODE, query: "job assignment", topk: 10 },
      expect: (_r, t) => fileCount(t) === 10 },
    { name: "find topk omitted (default 8)", tool: "find_files", args: { codePath: CODE, query: "route optimization" },
      expect: (_r, t) => fileCount(t) === 8 },
    { name: "find nonsense query → 0 or few", tool: "find_files", args: { codePath: CODE, query: "zzzqxvbnm nothing", topk: 5 },
      expect: (_r, t) => fileCount(t) >= 0 },
    { name: "find topk larger than corpus", tool: "find_files", args: { codePath: CODE, query: "the", topk: 100000 },
      expect: (_r, t) => fileCount(t) >= 0 },

    // ── signatures: query-mode vs explicit-files vs bad input ──
    { name: "sig query-mode", tool: "signatures", args: { codePath: CODE, query: "slot capacity", topk: 2 },
      expect: (_r, t) => t.length > 0 && !t.startsWith("Provide either") },
    { name: "sig missing args → error", tool: "signatures", args: { topk: 3 },
      expect: (r) => isErr(r) },
    { name: "sig nonexistent explicit file", tool: "signatures", args: { files: ["/no/such/file.ts"] },
      expect: (_r, t) => t.includes("not found") },

    // ── get_schema: all vs query vs explicit tables vs topk ──
    { name: "schema all", tool: "get_schema", args: { migrationsPath: MIGR },
      expect: (_r, t) => tableCount(t) > 5 },
    { name: "schema query topk=3", tool: "get_schema", args: { migrationsPath: MIGR, query: "task", topk: 3 },
      expect: (_r, t) => { const n = tableCount(t); return n >= 1 && n <= 3; } },
    { name: "schema explicit tables", tool: "get_schema", args: { migrationsPath: MIGR, tables: ["jobs", "tasks"] },
      expect: (_r, t) => tableCount(t) === 2 && t.includes("jobs:") && t.includes("tasks:") },
    { name: "schema nonexistent table → 0 tables", tool: "get_schema", args: { migrationsPath: MIGR, tables: ["nope_not_real"] },
      expect: (_r, t) => tableCount(t) === 0 },
    { name: "schema bad migrations path → error", tool: "get_schema", args: { migrationsPath: "/no/such/dir" },
      expect: (r) => isErr(r) },

    // ── shared: bad codePath ──
    { name: "find bad codePath → error", tool: "find_files", args: { codePath: "/no/such/dir", query: "x" },
      expect: (r) => isErr(r) },
];

async function main() {
    const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp-server.ts"] });
    const client = new Client({ name: "matrix", version: "1.0.0" });
    await client.connect(transport);

    let pass = 0;
    const rows: string[] = [];
    for (const c of cases) {
        let ok = false, detail = "";
        try {
            const res = await client.callTool({ name: c.tool, arguments: c.args as any });
            const txt = textOf(res);
            ok = c.expect(res, txt);
            detail = isErr(res) ? "isError" : txt.split("\n")[0].slice(0, 48);
        } catch (e) {
            detail = "THREW: " + (e as Error).message.slice(0, 40);
            ok = false; // an uncaught throw is always a fail — server should return isError instead
        }
        if (ok) pass++;
        rows.push(`  ${ok ? "✅" : "❌"}  ${c.name.padEnd(34)} │ ${detail}`);
    }

    console.log(`\nDynamic parameter matrix — ${cases.length} cases\n`);
    console.log(rows.join("\n"));
    console.log(`\n${pass}/${cases.length} passed`);
    await client.close();
    if (pass !== cases.length) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
