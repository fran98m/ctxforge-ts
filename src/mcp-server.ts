// src/mcp-server.ts
//
// Query-serving MCP front-end for ctxforge.
//
// This is the "second mouth" on the same brains: instead of emitting one big
// YAML bundle (the CLI, aimed at chat/local LLMs with no filesystem), it exposes
// the ranking / schema-replay / signature-extraction engines as small on-demand
// tools for an agentic client (Claude Code, etc.) that reads live files itself.
//
// Run:  npx tsx src/mcp-server.ts   (speaks MCP over stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Project } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

import { searchFiles } from "./search";
import { extractFromFile } from "./fetcher";
import { extractSchema } from "./schema";
import { compactSchema } from "./compactor";

// ─── Protect the protocol channel ────────────────────────────────────────────
// MCP over stdio uses STDOUT for JSON-RPC framing. The engine modules log
// progress with console.log — that would corrupt the stream. Route all of it to
// stderr (still visible for debugging) and leave stdout to the transport.
const toStderr = (...args: unknown[]) =>
    process.stderr.write(
        args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n"
    );
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const server = new McpServer({ name: "ctxforge", version: "1.0.0" });

// ─── find_files ──────────────────────────────────────────────────────────────
server.registerTool(
    "find_files",
    {
        title: "Rank code files by relevance",
        description:
            "TF-IDF + import-graph ranking over a TypeScript codebase. Given a plain-English feature " +
            "description, returns the top-K most relevant file paths (with scores) so you can read the " +
            "real files. Returns paths only, NOT file contents — it's a pointer, not a dump.",
        inputSchema: {
            codePath: z.string().describe("Path (absolute or relative) to the code directory to search"),
            query: z.string().describe("Plain-English description of the feature/area of interest"),
            topk: z.number().int().positive().optional().describe("Max files to return (default 8)"),
        },
    },
    async ({ codePath, query, topk }) => {
        try {
            const abs = path.resolve(codePath);
            if (!fs.existsSync(abs)) return fail(`Path not found: ${abs}`);
            const ranked = searchFiles(abs, query, topk ?? 8);
            const files = ranked.map(r => ({ relPath: r.relPath, score: Number(r.score.toFixed(2)) }));
            return text(JSON.stringify({ codePath: abs, query, count: files.length, files }, null, 2));
        } catch (e) {
            return fail(`find_files failed: ${(e as Error).message}`);
        }
    }
);

// ─── signatures ──────────────────────────────────────────────────────────────
server.registerTool(
    "signatures",
    {
        title: "Signature-only view of TS files",
        description:
            "Returns compacted signatures for TypeScript files: functions, classes, interfaces, " +
            "first-line JSDoc, and one-line body hints — WITHOUT function bodies. Provide explicit " +
            "`files`, OR provide `codePath` + `query` to auto-rank and extract the top-K. Use this " +
            "for a fast surface view before reading full source.",
        inputSchema: {
            files: z.array(z.string()).optional().describe("Explicit file paths to extract"),
            codePath: z.string().optional().describe("Code directory (used together with `query`)"),
            query: z.string().optional().describe("If set with `codePath`, ranks then extracts top-K"),
            topk: z.number().int().positive().optional().describe("Max files in query mode (default 5)"),
        },
    },
    async ({ files, codePath, query, topk }) => {
        try {
            let targets: string[];
            if (files && files.length > 0) {
                targets = files.map(f => path.resolve(f));
            } else if (codePath && query) {
                const ranked = searchFiles(path.resolve(codePath), query, topk ?? 5);
                targets = ranked.map(r => r.filePath);
            } else {
                return fail("Provide either `files`, or both `codePath` and `query`.");
            }
            if (targets.length === 0) return text("# No matching files.");

            const project = new Project();
            const out: string[] = [];
            for (const f of targets) {
                if (!fs.existsSync(f)) { out.push(`# not found: ${f}`); continue; }
                out.push(extractFromFile(project.addSourceFileAtPath(f)));
            }
            return text(out.join("\n"));
        } catch (e) {
            return fail(`signatures failed: ${(e as Error).message}`);
        }
    }
);

// ─── get_schema ──────────────────────────────────────────────────────────────
server.registerTool(
    "get_schema",
    {
        title: "Current DB schema from migration replay",
        description:
            "Replays dbmate-format SQL migrations forward to the current database state and returns a " +
            "compact YAML view (tables, columns, primary keys, foreign keys, enums, defaults). Filter " +
            "with `tables` for specific ones, `query` for search-driven selection, or omit both for the " +
            "full schema. This is deterministic — no model calls.",
        inputSchema: {
            migrationsPath: z.string().describe("Path to the directory of .sql migration files"),
            tables: z.array(z.string()).optional().describe("Explicit table names to include"),
            query: z.string().optional().describe("Search-driven table selection (plain English)"),
            topk: z.number().int().positive().optional().describe("Max tables in query mode (default 10)"),
        },
    },
    async ({ migrationsPath, tables, query, topk }) => {
        try {
            const abs = path.resolve(migrationsPath);
            if (!fs.existsSync(abs)) return fail(`Migrations path not found: ${abs}`);
            const state = extractSchema(abs);
            let yaml: string;
            if (tables && tables.length > 0) yaml = compactSchema(state, undefined, undefined, tables);
            else if (query) yaml = compactSchema(state, query, topk ?? 10);
            else yaml = compactSchema(state);
            return text(yaml);
        } catch (e) {
            return fail(`get_schema failed: ${(e as Error).message}`);
        }
    }
);

// ─── Boot ────────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("ctxforge MCP server running on stdio (tools: find_files, signatures, get_schema)");
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
