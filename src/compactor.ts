// src/compactor.ts
//
// Merges code context (from fetcher.ts) and DB schema (from schema.ts)
// into a single compact YAML file optimized for LLM token efficiency.
//
// KEY CHANGE: Schema extraction is now SEARCH-DRIVEN.
// Only tables relevant to the query make it into the output.

import * as fs from "node:fs";
import * as path from "node:path";
import { SchemaState, TableSchema, ColumnDef, extractSchema } from "./schema";
import { searchFiles, tokenizeQuery } from "./search";
import { searchSchema, SchemaSearchResult } from "./schema-search";
import { estimateTokens, analyzeTokens, granularBreakdown, printTokenReport, TokenReport } from "./tokens";
import { Project, SourceFile } from "ts-morph";

// ─── YAML Serializer (zero-dep, schema-aware) ───────────────────────────────

function columnToYaml(col: ColumnDef): string {
    const parts: string[] = [col.dataType];

    if (!col.nullable) parts.push("not null");
    if (col.defaultValue !== undefined) parts.push(`default ${col.defaultValue}`);
    if (col.isUnique) parts.push("unique");

    let line = `${col.name}: ${parts.join(", ")}`;

    if (col.references) line += ` -> ${col.references}`;
    if (col.enumValues && col.enumValues.length > 0) {
        line += ` [${col.enumValues.join(" | ")}]`;
    }
    if (col.comment) line += `  # ${col.comment}`;

    return line;
}

function tableToYaml(table: TableSchema, indent: string = "    "): string {
    const lines: string[] = [];

    lines.push(`  ${table.name}:`);

    if (table.primaryKey.length > 0) {
        lines.push(`${indent}pk: [${table.primaryKey.join(", ")}]`);
    }
    if (table.partitionBy) {
        lines.push(`${indent}partition: ${table.partitionBy}`);
    }
    if (table.indexes.length > 0) {
        lines.push(`${indent}indexes: [${table.indexes.join(", ")}]`);
    }

    lines.push(`${indent}cols:`);
    for (const [_, col] of table.columns) {
        lines.push(`${indent}  ${columnToYaml(col)}`);
    }

    return lines.join("\n");
}

function enumsToYaml(enums: Map<string, string[]>, relevantEnums?: Set<string>): string {
    if (enums.size === 0) return "";

    const lines: string[] = ["  enums:"];
    for (const [name, values] of enums) {
        if (relevantEnums && !relevantEnums.has(name)) continue;
        lines.push(`    ${name}: [${values.join(" | ")}]`);
    }
    return lines.length > 1 ? lines.join("\n") : "";
}

// ─── JSDoc + Body Hints (compact, LLM-friendly) ─────────────────────────────

/**
 * Extracts the first sentence of a node's JSDoc comment.
 * Returns null if no JSDoc or empty description.
 */
function getJsDocSummary(node: any): string | null {
    if (typeof node?.getJsDocs !== "function") return null;
    const docs = node.getJsDocs();
    if (docs.length === 0) return null;
    const desc: string = (docs[0].getDescription?.() ?? "").trim();
    if (!desc) return null;
    // First sentence only, collapse newlines, cap length
    const first = desc.split(/\.\s|\n\n/)[0].replace(/\s+/g, " ").trim().replace(/\.+$/, "");
    if (!first) return null;
    if (first.length <= 80) return first;
    // Truncate at last space before limit
    const cut = first.lastIndexOf(" ", 77);
    return (cut > 20 ? first.slice(0, cut) : first.slice(0, 77)) + "...";
}

/**
 * Generates a compact "action chain" from a function/method body.
 * Extracts constructors, control-flow tags, and method calls.
 * e.g. "new Project → iter → sort → slice → relative"
 */
function summarizeBody(node: any): string | null {
    let bodyText: string | undefined;
    try {
        if (typeof node?.getBody === "function") {
            bodyText = node.getBody()?.getText();
        } else if (typeof node?.getInitializer === "function") {
            const init = node.getInitializer();
            if (typeof init?.getBody === "function") bodyText = init.getBody()?.getText();
        }
    } catch { return null; }
    if (!bodyText || bodyText.length < 20) return null;

    const SKIP = new Set([
        "log", "error", "warn", "info", "debug",
        "toString", "valueOf", "call", "apply", "bind",
        "then", "catch", "finally",
        "push", "pop", "shift", "unshift",
        "has", "get", "set", "add", "delete",
    ]);
    const seen = new Set<string>();
    const parts: string[] = [];

    // Constructors
    for (const m of bodyText.matchAll(/new\s+([A-Z]\w+)/g)) {
        if (!seen.has(m[1])) { seen.add(m[1]); parts.push(`new ${m[1]}`); }
    }

    // Control-flow / transform tags
    if (/\bfor\s*\(/.test(bodyText) || /\.forEach\s*\(/.test(bodyText)) parts.push("iter");
    if (/\.map\s*\(/.test(bodyText)) parts.push("map");
    if (/\.filter\s*\(/.test(bodyText)) parts.push("filter");
    if (/\.sort\s*\(/.test(bodyText)) parts.push("sort");
    if (/\.reduce\s*\(/.test(bodyText)) parts.push("reduce");
    if (/\bfs\.\w+/.test(bodyText)) parts.push("fs");
    if (/\.match\s*\(|\.test\s*\(|matchAll\s*\(/.test(bodyText)) parts.push("regex");

    // Method calls (deduped, skip noise, min 4 chars)
    for (const m of bodyText.matchAll(/\.([a-zA-Z_]\w*)\s*\(/g)) {
        const name = m[1];
        if (!seen.has(name) && !SKIP.has(name) && name.length >= 4 && parts.length < 8) {
            seen.add(name);
            parts.push(name);
        }
    }

    // Require ≥2 meaningful parts to emit
    if (parts.length < 2) return null;
    const chain = parts.slice(0, 8).join(" → ");
    if (chain.length <= 60) return chain;
    // Truncate at last arrow separator before limit
    const cut = chain.lastIndexOf(" → ", 57);
    return (cut > 0 ? chain.slice(0, cut) : chain.slice(0, 57)) + "...";
}

/**
 * Builds a combined comment line: "JSDoc summary | body hint"
 * jsDocNode: the node that owns the JSDoc (e.g. VariableStatement for arrow fns)
 * bodyNode:  the node whose body to summarize (defaults to jsDocNode)
 */
function buildComment(jsDocNode: any, bodyNode?: any): string | null {
    const jsdoc = getJsDocSummary(jsDocNode);
    const body = summarizeBody(bodyNode ?? jsDocNode);
    if (jsdoc && body) return `${jsdoc} | ${body}`;
    return jsdoc || body || null;
}

// ─── Code Context → YAML ─────────────────────────────────────────────────────

function sourceFileToYaml(sourceFile: SourceFile, basePath: string): string {
    const relPath = path.relative(basePath, sourceFile.getFilePath());
    const lines: string[] = [];

    lines.push(`  ${relPath}:`);

    const interfaces = sourceFile.getInterfaces();
    if (interfaces.length > 0) {
        for (const iface of interfaces) {
            const jsdoc = getJsDocSummary(iface);
            if (jsdoc) lines.push(`    # ${jsdoc}`);
            lines.push(`    interface ${iface.getName()}:`);
            for (const prop of iface.getProperties()) {
                const typeText = prop.getTypeNode()?.getText() || "any";
                const optional = prop.hasQuestionToken() ? "?" : "";
                lines.push(`      ${prop.getName()}${optional}: ${typeText}`);
            }
            for (const method of iface.getMethods()) {
                const params = method.getParameters().map(p => p.getText()).join(", ");
                const ret = method.getReturnTypeNode()?.getText() || "void";
                lines.push(`      ${method.getName()}(${params}): ${ret}`);
            }
        }
    }

    const classes = sourceFile.getClasses();
    if (classes.length > 0) {
        for (const cls of classes) {
            const clsDoc = getJsDocSummary(cls);
            if (clsDoc) lines.push(`    # ${clsDoc}`);
            const ext = cls.getExtends()?.getText();
            const impl = cls.getImplements().map(i => i.getText());
            let classLine = `    class ${cls.getName() || "anonymous"}`;
            if (ext) classLine += ` extends ${ext}`;
            if (impl.length > 0) classLine += ` implements ${impl.join(", ")}`;
            classLine += ":";
            lines.push(classLine);

            for (const prop of cls.getProperties()) {
                const mod = prop.getModifiers().map(m => m.getText()).join(" ");
                const typeText = prop.getTypeNode()?.getText() || "any";
                lines.push(`      ${mod ? mod + " " : ""}${prop.getName()}: ${typeText}`);
            }
            for (const method of cls.getMethods()) {
                const comment = buildComment(method);
                if (comment) lines.push(`      # ${comment}`);
                const mod = method.getModifiers().map(m => m.getText()).join(" ");
                const params = method.getParameters().map(p => p.getText()).join(", ");
                const ret = method.getReturnTypeNode()?.getText() || "void";
                lines.push(`      ${mod ? mod + " " : ""}${method.getName()}(${params}): ${ret}`);
            }
        }
    }

    const functions = sourceFile.getFunctions();
    const arrowFns = sourceFile.getVariableDeclarations().filter(v => {
        const init = v.getInitializer();
        return init && (init.getKindName() === "ArrowFunction" || init.getKindName() === "FunctionExpression");
    });

    if (functions.length > 0 || arrowFns.length > 0) {
        lines.push(`    functions:`);
        for (const func of functions) {
            const comment = buildComment(func);
            if (comment) lines.push(`      # ${comment}`);
            const name = func.getName() || "anonymous";
            const params = func.getParameters().map(p => p.getText()).join(", ");
            const ret = func.getReturnTypeNode()?.getText() || "void";
            const exported = func.isExported() ? "export " : "";
            lines.push(`      ${exported}${name}(${params}): ${ret}`);
        }
        for (const varDecl of arrowFns) {
            const init = varDecl.getInitializer();
            if (!init) continue;
            // JSDoc lives on VariableStatement (grandparent of VariableDeclaration)
            const stmt = varDecl.getParent()?.getParent();
            const comment = buildComment(stmt, varDecl);
            if (comment) lines.push(`      # ${comment}`);
            const params = (init as any).getParameters?.()?.map((p: any) => p.getText())?.join(", ") || "";
            const ret = (init as any).getReturnTypeNode?.()?.getText() || "void";
            const exported = varDecl.isExported() ? "export " : "";
            lines.push(`      ${exported}${varDecl.getName()}(${params}): ${ret}`);
        }
    }

    return lines.join("\n");
}

// ─── Main Compaction Functions ───────────────────────────────────────────────

export interface CompactOptions {
    includeCode: boolean;
    includeSchema: boolean;
    codePath?: string;
    migrationsPath?: string;
    query?: string;
    topK?: number;           // max code files
    topKTables?: number;     // max tables
    tables?: string[];       // explicit table filter (overrides search)
    allSchema?: boolean;     // dump all tables, ignore topKTables/query for schema
    allCode?: boolean;       // dump all code, ignore topK/query for code
    tokenBudget?: number;    // optional token budget for reporting
    showTokens?: boolean;    // print token report to console
}

/**
 * Schema compaction — SEARCH-DRIVEN.
 * Only includes tables that scored against the query.
 * Falls back to all tables if no query provided (for `schema` command with --tables).
 */
export function compactSchema(
    state: SchemaState,
    query?: string,
    topKTables?: number,
    explicitTables?: string[],
    codeFileNames?: string[]
): string {
    const lines: string[] = ["schema:"];

    let tablesToInclude: TableSchema[];

    if (explicitTables && explicitTables.length > 0) {
        tablesToInclude = explicitTables
            .map(name => state.tables.get(name))
            .filter((t): t is TableSchema => t !== undefined);
    } else if (query) {
        const results = searchSchema(state, query, topKTables || 10, codeFileNames);
        tablesToInclude = results.map(r => r.table);
    } else {
        tablesToInclude = Array.from(state.tables.values());
    }

    // Only include enums used by included tables
    const relevantEnums = new Set<string>();
    for (const table of tablesToInclude) {
        for (const [_, col] of table.columns) {
            const enumMatch = col.dataType.match(/ENUM\((\w+)\)/i);
            if (enumMatch) relevantEnums.add(enumMatch[1].toLowerCase());
        }
    }

    const enumYaml = enumsToYaml(state.enums, relevantEnums.size > 0 ? relevantEnums : undefined);
    if (enumYaml) lines.push(enumYaml);

    for (const table of tablesToInclude) {
        lines.push(tableToYaml(table));
    }

    return lines.join("\n");
}

/**
 * Code compaction — returns YAML + file names for cross-referencing with schema.
 */
export function compactCode(
    codePath: string,
    query: string,
    topK: number = 5
): { yaml: string; fileNames: string[] } {
    const rankedFiles = searchFiles(codePath, query, topK);
    if (rankedFiles.length === 0) {
        return { yaml: "code: {}  # no relevant files found", fileNames: [] };
    }

    const project = new Project();
    for (const f of rankedFiles) {
        project.addSourceFileAtPath(f.filePath);
    }

    const lines: string[] = ["code:"];
    const fileNames: string[] = [];

    for (const sourceFile of project.getSourceFiles()) {
        lines.push(sourceFileToYaml(sourceFile, codePath));
        fileNames.push(path.basename(sourceFile.getFilePath()));
    }

    return { yaml: lines.join("\n"), fileNames };
}

/**
 * Full compaction: code + schema → single YAML.
 * 
 * PIPELINE:
 *   1. Extract code (search-driven OR full dump)
 *   2. Extract schema (search-driven OR full dump)
 *   3. Cross-reference code → schema when both use search
 *   4. Run token analysis
 *
 * Flag combos:
 *   neither       → search both sides (query required)
 *   --all-schema  → dump all tables, search code (your 43-table case)
 *   --all-code    → dump all code, search tables
 *   --all         → dump everything
 */
export function compactFull(opts: CompactOptions): { content: string; tokenReport?: TokenReport } {
    const header = [
        "# Context Bundle",
        `# Generated: ${new Date().toISOString()}`,
        opts.query ? `# Query: ${opts.query}` : null,
        opts.codePath ? `# Codebase: ${opts.codePath}` : null,
        opts.migrationsPath ? `# Migrations: ${opts.migrationsPath}` : null,
        "# Format: Compact YAML (optimized for LLM token efficiency)",
        "---",
    ].filter(Boolean).join("\n");

    const sections: string[] = [header];
    let codeFileNames: string[] = [];

    // ── Code extraction ──
    if (opts.includeCode && opts.codePath) {
        if (opts.allCode) {
            // Full dump: every TS file with structure
            const codeResult = compactAllCode(opts.codePath);
            sections.push(codeResult.yaml);
            codeFileNames = codeResult.fileNames;
        } else if (opts.query) {
            // Search-driven
            const codeResult = compactCode(opts.codePath, opts.query, opts.topK || 5);
            sections.push(codeResult.yaml);
            codeFileNames = codeResult.fileNames;
        }
    }

    // ── Schema extraction ──
    if (opts.includeSchema && opts.migrationsPath) {
        const schemaState = extractSchema(opts.migrationsPath);

        if (opts.allSchema) {
            // Full dump: every table
            const schemaYaml = compactSchema(schemaState);
            sections.push(schemaYaml);
        } else {
            // Search-driven (cross-referenced with code file names)
            const schemaYaml = compactSchema(
                schemaState,
                opts.query,
                opts.topKTables || 10,
                opts.tables,
                codeFileNames
            );
            sections.push(schemaYaml);
        }
    }

    const content = sections.join("\n\n");

    // Token analysis
    let tokenReport: TokenReport | undefined;
    if (opts.showTokens !== false) {
        tokenReport = analyzeTokens(content, opts.tokenBudget);
        const granular = granularBreakdown(content);
        console.log("\n" + printTokenReport(tokenReport, granular));
    }

    return { content, tokenReport };
}

/**
 * Full code dump — no search, extracts every TS file that has structure.
 * Used by --all-code and the dump command.
 */
export function compactAllCode(codePath: string): { yaml: string; fileNames: string[] } {
    const project = new Project();
    project.addSourceFilesAtPaths(path.join(codePath, "**/*.ts"));

    const lines: string[] = ["code:"];
    const fileNames: string[] = [];

    for (const sourceFile of project.getSourceFiles()) {
        const relPath = path.relative(codePath, sourceFile.getFilePath());
        if (relPath.includes(".test.") || relPath.includes(".spec.")) continue;
        if (relPath.includes("node_modules")) continue;

        // Only include files with actual structure
        const hasStructure =
            sourceFile.getInterfaces().length > 0 ||
            sourceFile.getClasses().length > 0 ||
            sourceFile.getFunctions().length > 0 ||
            sourceFile.getVariableDeclarations().some(v => {
                const init = v.getInitializer();
                return init && (init.getKindName() === "ArrowFunction" || init.getKindName() === "FunctionExpression");
            });

        if (!hasStructure) continue;

        lines.push(sourceFileToYaml(sourceFile, codePath));
        fileNames.push(path.basename(sourceFile.getFilePath()));
    }

    return { yaml: lines.join("\n"), fileNames };
}

/**
 * Writes compacted output to a file.
 */
export function writeCompactedOutput(content: string, outputPath?: string): string {
    const outPath = outputPath || path.join(process.cwd(), "context_bundle.yml");
    fs.writeFileSync(outPath, content, "utf-8");
    console.log(`\n✅ Context bundle saved to: ${outPath}`);
    return outPath;
}