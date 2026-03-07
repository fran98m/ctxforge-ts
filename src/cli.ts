// src/cli.ts
import { searchFiles, tokenizeQuery } from "./search";
import { extractFromFile } from "./fetcher";
import { extractSchema, printSchemaState } from "./schema";
import { searchSchema } from "./schema-search";
import { compactFull, compactSchema, compactCode, compactAllCode, writeCompactedOutput } from "./compactor";
import { estimateTokens, analyzeTokens, granularBreakdown, printTokenReport } from "./tokens";
import { Project } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

// ─── Output Path Builder ─────────────────────────────────────────────────────

/**
 * Generates an output file path like: results/context_bundle_<slug>_<date>.<ext>
 *   - slug: derived from query or "full" / "dump" / "schema" etc.
 *   - date: YYYYMMDD_HHmmss
 *   - ext: yml, txt, etc.
 * Ensures the results/ directory exists.
 */
function buildOutputPath(prefix: string, ext: string, query?: string): string {
    const resultsDir = path.join(process.cwd(), "results");
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    let slug = "";
    if (query) {
        slug = query
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")  // non-alnum → underscore
            .replace(/^_|_$/g, "")         // trim leading/trailing _
            .slice(0, 40);                  // cap length
    }

    const name = slug
        ? `${prefix}_${slug}_${datePart}.${ext}`
        : `${prefix}_${datePart}.${ext}`;

    return path.join(resultsDir, name);
}

// ─── Flag Parser ─────────────────────────────────────────────────────────────

const allArgs = process.argv.slice(2);
const command = allArgs[0];

const positionalArgs: string[] = [];
const flags = new Map<string, string>();
const boolFlags = new Set<string>();

for (let i = 1; i < allArgs.length; i++) {
    if (allArgs[i].startsWith("--")) {
        const flagName = allArgs[i];
        // Check if next arg looks like a value (doesn't start with --)
        if (i + 1 < allArgs.length && !allArgs[i + 1].startsWith("--")) {
            flags.set(flagName, allArgs[i + 1]);
            i++;
        } else {
            // Boolean flag (like --all)
            boolFlags.add(flagName);
        }
    } else {
        positionalArgs.push(allArgs[i]);
    }
}

function getFlag(name: string): string | undefined {
    return flags.get(`--${name}`);
}
function hasFlag(name: string): boolean {
    return boolFlags.has(`--${name}`);
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * CONTEXT: Search-driven code extraction (original behavior)
 */
function cmdContext(codePath: string, query: string) {
    const topK = parseInt(getFlag("topk") || "5");
    const rankedFiles = searchFiles(codePath, query, topK);

    if (rankedFiles.length === 0) {
        console.log(`# No files relevant to: "${query}"`);
        return;
    }

    const terms = tokenizeQuery(query);
    let output = `# Query: ${query}\n`;
    output += `# Terms: [${terms.join(", ")}]\n`;
    output += `# Generated at: ${new Date().toLocaleString()}\n`;
    output += `# Relevant files: ${rankedFiles.length} scored\n`;

    const project = new Project();
    for (const fileData of rankedFiles) {
        project.addSourceFileAtPath(fileData.filePath);
    }

    for (const sourceFile of project.getSourceFiles()) {
        output += extractFromFile(sourceFile) + "\n";
    }

    const outPath = buildOutputPath("context", "txt", query);
    fs.writeFileSync(outPath, output, "utf-8");

    const tokens = estimateTokens(output);
    console.log(`\n✅ Saved to: ${outPath}`);
    console.log(`📊 ~${tokens} tokens`);
}

/**
 * MAP: Domain entity map (original behavior)
 */
function cmdMap(codePath: string) {
    let output = `# Domain Map for: ${codePath}\n`;
    output += `# Generated at: ${new Date().toLocaleString()}\n\n`;
    const project = new Project();
    project.addSourceFilesAtPaths(path.join(codePath, "**/*.ts"));

    let totalFiles = 0;
    let totalEntities = 0;

    for (const sourceFile of project.getSourceFiles()) {
        const relPath = path.relative(codePath, sourceFile.getFilePath());
        if (relPath.includes(".test.") || relPath.includes(".spec.")) continue;

        const interfaces = sourceFile.getInterfaces().map(i => i.getName());
        const classes = sourceFile.getClasses().map(c => c.getName());

        if (interfaces.length === 0 && classes.length === 0) continue;

        output += `📁 ${relPath}\n`;
        if (interfaces.length > 0) output += `   Interfaces: ${interfaces.join(", ")}\n`;
        if (classes.length > 0) output += `   Classes:    ${classes.join(", ")}\n`;
        output += `\n`;

        totalFiles++;
        totalEntities += interfaces.length + classes.length;
    }

    output += `# Summary: Found ${totalEntities} entities across ${totalFiles} files.\n`;

    const outPath = buildOutputPath("domain_map", "txt");
    fs.writeFileSync(outPath, output, "utf-8");

    const tokens = estimateTokens(output);
    console.log(`\n✅ Saved to: ${outPath}`);
    console.log(`📊 ~${tokens} tokens`);
}

/**
 * SCHEMA: DB schema extraction
 *   --all          → dump every table (small codebases)
 *   --query "..."  → search-driven (huge codebases)
 *   --tables x,y   → explicit filter
 */
function cmdSchema(migrationsDir: string) {
    const dumpAll = hasFlag("all");
    const query = getFlag("query");
    const tablesFlag = getFlag("tables");
    const tables = tablesFlag ? tablesFlag.split(",").map(t => t.trim()) : undefined;
    const topKTables = parseInt(getFlag("topk") || "10");
    const budget = getFlag("budget") ? parseInt(getFlag("budget")!) : undefined;

    const state = extractSchema(migrationsDir);

    let yaml: string;

    if (dumpAll || (!query && !tables)) {
        // Full dump — every table
        yaml = compactSchema(state);
        console.log(`\n# Mode: FULL DUMP (${state.tables.size} tables)`);
    } else if (tables) {
        // Explicit filter
        yaml = compactSchema(state, undefined, undefined, tables);
        console.log(`\n# Mode: EXPLICIT FILTER (${tables.length} tables requested)`);
    } else {
        // Search-driven
        yaml = compactSchema(state, query!, topKTables);
        console.log(`\n# Mode: SEARCH-DRIVEN (query: "${query}")`);
    }

    const outPath = buildOutputPath("schema", "yml", query);
    writeCompactedOutput(yaml, outPath);

    const report = analyzeTokens(yaml, budget);
    const granular = granularBreakdown(yaml);
    console.log("\n" + printTokenReport(report, granular));

    console.log(`👉 Drag and drop the schema bundle into chat!`);
}

/**
 * FULL: Code + Schema merged into one YAML
 *   --all          → dump all code + all tables (no query needed)
 *   --all-schema   → dump all tables, SEARCH code (recommended for your case)
 *   --all-code     → dump all code, SEARCH tables
 *   (default)      → search-driven both sides
 *
 * Code-only mode: omit migrations path to extract just code — no DB needed.
 */
function cmdFull(codePath: string, migrationsDir: string | undefined, query: string | undefined) {
    const dumpAll = hasFlag("all");
    const dumpAllSchema = hasFlag("all-schema") || dumpAll;
    const dumpAllCode = hasFlag("all-code") || dumpAll;
    const topK = parseInt(getFlag("topk") || "5");
    const topKTables = parseInt(getFlag("topk-tables") || "10");
    const tablesFlag = getFlag("tables");
    const tables = tablesFlag ? tablesFlag.split(",").map(t => t.trim()) : undefined;
    const budget = getFlag("budget") ? parseInt(getFlag("budget")!) : undefined;

    // If no query and not dumping all, there's nothing to search
    if (!query && !dumpAllCode && !dumpAll) {
        console.error("Error: A query is required unless --all or --all-code is set.");
        process.exit(1);
    }

    // Log the mode for each side independently
    const codeMode = dumpAllCode ? "FULL DUMP" : `SEARCH (topk=${topK})`;
    const schemaMode = !migrationsDir ? "SKIPPED (no migrations path)" : dumpAllSchema ? "FULL DUMP" : `SEARCH (topk=${topKTables})`;
    if (query) console.log(`\n# Query: "${query}"`);
    else console.log(`\n# Mode: FULL REPO DUMP (no query)`);
    console.log(`# Code:   ${codeMode}`);
    console.log(`# Schema: ${schemaMode}`);

    const { content, tokenReport } = compactFull({
        includeCode: true,
        includeSchema: !!migrationsDir,
        codePath,
        migrationsPath: migrationsDir,
        query,  // may be undefined when --all is used
        topK: dumpAllCode ? 999 : topK,
        topKTables: dumpAllSchema ? 999 : topKTables,
        allSchema: dumpAllSchema,  // tells compactor to skip table search
        allCode: dumpAllCode,      // tells compactor to skip code search
        tables,
        tokenBudget: budget,
        showTokens: true,
    });

    const outPath = buildOutputPath("context_bundle", "yml", query);
    writeCompactedOutput(content, outPath);

    console.log(`👉 Drag and drop the bundle into chat!`);
}

/**
 * DUMP: Full codebase dump — no search, just extract everything.
 * Shortcut for small codebases where search overhead isn't worth it.
 * Delegates to compactFull with both --all flags set.
 */
function cmdDump(codePath: string, migrationsDir?: string) {
    const budget = getFlag("budget") ? parseInt(getFlag("budget")!) : undefined;

    console.log(`\n# Mode: FULL DUMP`);
    console.log(`# Code:   ALL files`);
    if (migrationsDir) console.log(`# Schema: ALL tables`);

    const { content } = compactFull({
        includeCode: true,
        includeSchema: !!migrationsDir,
        codePath,
        migrationsPath: migrationsDir,
        allCode: true,
        allSchema: true,
        tokenBudget: budget,
        showTokens: true,
    });

    const outPath = buildOutputPath("context_bundle", "yml", "dump");
    writeCompactedOutput(content, outPath);

    console.log(`👉 Drag and drop the bundle into chat!`);
}

/**
 * TOKENS: Analyze any file's token usage (standalone)
 */
function cmdTokens(filePath: string) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const budget = getFlag("budget") ? parseInt(getFlag("budget")!) : undefined;

    const report = analyzeTokens(content, budget);
    const granular = granularBreakdown(content);
    console.log(printTokenReport(report, granular));
}

// ─── CLI Router ──────────────────────────────────────────────────────────────

function printUsage() {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│                    CONTEXT BUILDER CLI                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  TARGETED (search-driven, big codebases):                   │
│                                                             │
│    context <code_path> <query>        Code signatures       │
│    schema  <migrations> --query "x"   DB tables             │
│    full    <code> [migrations] <query> Both merged           │
│                                                             │
│  FULL REPO (no query needed):                               │
│                                                             │
│    full    <code_path> --all          Full repo, code only  │
│    full    <code> <migrations> --all  Full repo + all tables│
│    dump    <code_path> [migrations]   Everything, no search │
│    schema  <migrations> --all         All tables            │
│                                                             │
│  UTILITIES:                                                 │
│                                                             │
│    map     <code_path>               Domain entity map      │
│    tokens  <file_path>               Analyze token usage    │
│                                                             │
│  FLAGS:                                                     │
│    --topk N          Max code files       (default: 5)      │
│    --topk-tables N   Max tables           (default: 10)     │
│    --tables t1,t2    Explicit table list                    │
│    --budget N        Token budget for report                │
│    --all             Skip search, dump everything           │
│    --all-schema      Dump all tables, still search code     │
│    --all-code        Dump all code, still search tables     │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Examples:
  npm run cli full ./src --all                         # Full repo, code only, no DB
  npm run cli full ./src "order workflow"               # Search code, no DB
  npm run cli full ./src ./db/migrations "order" --all  # Full repo + full schema
  npm run cli full ./src ./db/migrations "order"        # Search code + schema
  npm run cli full ./src ./db/migrations "x" --all-schema --topk 8
  npm run cli dump ./src                               # Same as full --all (code only)
  npm run cli dump ./src ./db/migrations               # Dump code + schema
  npm run cli schema ./db/migrations --all             # All tables only
  npm run cli schema ./db/migrations --query "order"   # Search tables
  npm run cli context ./src "order processing"         # Code signatures only
  npm run cli tokens ./context_bundle.yml --budget 5000
`);
}

switch (command) {
    case "context": {
        const [codePath, query] = positionalArgs;
        if (!codePath || !query) { printUsage(); process.exit(1); }
        cmdContext(codePath, query);
        break;
    }
    case "map": {
        const [codePath] = positionalArgs;
        if (!codePath) { printUsage(); process.exit(1); }
        cmdMap(codePath);
        break;
    }
    case "schema": {
        const [migrationsDir] = positionalArgs;
        if (!migrationsDir) { printUsage(); process.exit(1); }
        cmdSchema(migrationsDir);
        break;
    }
    case "full": {
        // Support:
        //   full <code> <migrations> <query>   → search code + schema
        //   full <code> <query>                 → search code only (no DB)
        //   full <code> --all                   → dump full repo (no DB, no query)
        //   full <code> <migrations> --all      → dump full repo + full schema
        let codePath: string, migrationsDir: string | undefined, query: string | undefined;
        if (positionalArgs.length >= 3) {
            [codePath, migrationsDir, query] = positionalArgs;
        } else if (positionalArgs.length === 2) {
            // Could be <code> <query> or <code> <migrations> with --all
            codePath = positionalArgs[0];
            const second = positionalArgs[1];
            // If second arg is a directory, treat as migrations path
            if (fs.existsSync(second) && fs.statSync(second).isDirectory()) {
                migrationsDir = second;
                query = undefined;
            } else {
                query = second;
                migrationsDir = undefined;
            }
        } else if (positionalArgs.length === 1) {
            // full <code> --all  (code-only, full dump)
            codePath = positionalArgs[0];
            migrationsDir = undefined;
            query = undefined;
        } else {
            printUsage(); process.exit(1); break;
        }
        cmdFull(codePath!, migrationsDir, query);
        break;
    }
    case "dump": {
        const [codePath, migrationsDir] = positionalArgs;
        if (!codePath) { printUsage(); process.exit(1); }
        cmdDump(codePath, migrationsDir);
        break;
    }
    case "tokens": {
        const [filePath] = positionalArgs;
        if (!filePath) { printUsage(); process.exit(1); }
        cmdTokens(filePath);
        break;
    }
    default:
        printUsage();
        process.exit(1);
}