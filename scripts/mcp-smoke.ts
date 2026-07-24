// scripts/mcp-smoke.ts — spawns the ctxforge MCP server over stdio and exercises each tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// args: <codePath> <query> [migrationsDir] [schemaQuery]
const CODE_PATH = process.argv[2] ?? "./src";
const QUERY = process.argv[3] ?? "schema migration replay";
const MIGRATIONS = process.argv[4];
const SCHEMA_QUERY = process.argv[5];

function textOf(res: any): string {
    return (res.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

async function main() {
    const transport = new StdioClientTransport({
        command: "npx",
        args: ["tsx", "src/mcp-server.ts"],
    });
    const client = new Client({ name: "smoke", version: "1.0.0" });
    await client.connect(transport);

    console.log("── tools/list ──");
    const { tools } = await client.listTools();
    console.log(tools.map(t => `  • ${t.name}: ${t.title}`).join("\n"));

    console.log(`\n── find_files(${JSON.stringify(QUERY)}) ──`);
    console.log(textOf(await client.callTool({
        name: "find_files",
        arguments: { codePath: CODE_PATH, query: QUERY, topk: 6 },
    })));

    console.log("\n── signatures(codePath+query, topk=2) ──");
    console.log(textOf(await client.callTool({
        name: "signatures",
        arguments: { codePath: CODE_PATH, query: QUERY, topk: 2 },
    })).slice(0, 1400));

    if (MIGRATIONS) {
        console.log("\n── get_schema(all) ──");
        console.log(textOf(await client.callTool({
            name: "get_schema",
            arguments: { migrationsPath: MIGRATIONS },
        })).slice(0, 2000));

        if (SCHEMA_QUERY) {
            console.log(`\n── get_schema(query=${JSON.stringify(SCHEMA_QUERY)}) ──`);
            console.log(textOf(await client.callTool({
                name: "get_schema",
                arguments: { migrationsPath: MIGRATIONS, query: SCHEMA_QUERY, topk: 4 },
            })));
        }
    }

    await client.close();
    console.log("\n✅ smoke test complete");
}

main().catch(err => { console.error(err); process.exit(1); });
