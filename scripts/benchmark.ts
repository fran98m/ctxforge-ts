// scripts/benchmark.ts
//
// Compares raw token cost vs compact YAML output.
// Run: npx tsx scripts/benchmark.ts <code_path> [migrations_path]
//
// This is NOT a feature — it's a curiosity tool to see how much
// compression the context builder actually achieves.

import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { extractSchema } from "../src/schema";
import { compactFull, compactAllCode, compactSchema } from "../src/compactor";
import { estimateTokens } from "../src/tokens";

// ─── Raw Measurement ─────────────────────────────────────────────────────────

interface RawStats {
    label: string;
    fileCount: number;
    totalChars: number;
    totalLines: number;
    totalTokens: number;
    breakdown: { file: string; chars: number; tokens: number }[];
}

/**
 * Measures the raw token cost of reading every TS file as-is.
 * This is what you'd pay if you just cat'd every file into the context.
 */
function measureRawCode(codePath: string): RawStats {
    const project = new Project();
    project.addSourceFilesAtPaths(path.join(codePath, "**/*.ts"));

    const breakdown: { file: string; chars: number; tokens: number }[] = [];
    let totalChars = 0;
    let totalLines = 0;
    let totalTokens = 0;
    let fileCount = 0;

    for (const sourceFile of project.getSourceFiles()) {
        const relPath = path.relative(codePath, sourceFile.getFilePath());
        if (relPath.includes(".test.") || relPath.includes(".spec.")) continue;
        if (relPath.includes("node_modules")) continue;

        const text = sourceFile.getFullText();
        const chars = text.length;
        const lines = text.split("\n").length;
        const tokens = estimateTokens(text);

        breakdown.push({ file: relPath, chars, tokens });
        totalChars += chars;
        totalLines += lines;
        totalTokens += tokens;
        fileCount++;
    }

    breakdown.sort((a, b) => b.tokens - a.tokens);

    return {
        label: "Raw TypeScript Files",
        fileCount,
        totalChars,
        totalLines,
        totalTokens,
        breakdown,
    };
}

/**
 * Measures the raw token cost of reading every SQL migration as-is.
 */
function measureRawMigrations(migrationsDir: string): RawStats {
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .sort();

    const breakdown: { file: string; chars: number; tokens: number }[] = [];
    let totalChars = 0;
    let totalLines = 0;
    let totalTokens = 0;

    for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const text = fs.readFileSync(filePath, "utf-8");
        const chars = text.length;
        const lines = text.split("\n").length;
        const tokens = estimateTokens(text);

        breakdown.push({ file, chars, tokens });
        totalChars += chars;
        totalLines += lines;
        totalTokens += tokens;
    }

    breakdown.sort((a, b) => b.tokens - a.tokens);

    return {
        label: "Raw SQL Migrations",
        fileCount: files.length,
        totalChars,
        totalLines,
        totalTokens,
        breakdown,
    };
}

// ─── Compact Measurement ─────────────────────────────────────────────────────

interface CompactStats {
    label: string;
    totalChars: number;
    totalLines: number;
    totalTokens: number;
}

function measureCompactCode(codePath: string): CompactStats {
    const { yaml } = compactAllCode(codePath);
    return {
        label: "Compact Code YAML",
        totalChars: yaml.length,
        totalLines: yaml.split("\n").length,
        totalTokens: estimateTokens(yaml),
    };
}

function measureCompactSchema(migrationsDir: string): CompactStats {
    const state = extractSchema(migrationsDir);
    const yaml = compactSchema(state);
    return {
        label: "Compact Schema YAML",
        totalChars: yaml.length,
        totalLines: yaml.split("\n").length,
        totalTokens: estimateTokens(yaml),
    };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function bar(ratio: number, width: number = 40): string {
    const filled = Math.round(ratio * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatNum(n: number): string {
    return n.toLocaleString();
}

function printComparison(raw: RawStats, compact: CompactStats) {
    const ratio = compact.totalTokens / raw.totalTokens;
    const savings = 1 - ratio;
    const compressionX = (raw.totalTokens / compact.totalTokens).toFixed(1);

    console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│  ${raw.label.padEnd(58)}│`);
    console.log(`├─────────────────────────────────────────────────────────────┤`);
    console.log(`│                                                             │`);
    console.log(`│  RAW (just cat every file into context):                    │`);
    console.log(`│    Files:    ${String(raw.fileCount).padStart(8)}                                    │`);
    console.log(`│    Chars:    ${formatNum(raw.totalChars).padStart(8)}                                    │`);
    console.log(`│    Lines:    ${formatNum(raw.totalLines).padStart(8)}                                    │`);
    console.log(`│    Tokens:   ${formatNum(raw.totalTokens).padStart(8)}                                    │`);
    console.log(`│                                                             │`);
    console.log(`│  COMPACT (signatures/schema only, as YAML):                 │`);
    console.log(`│    Chars:    ${formatNum(compact.totalChars).padStart(8)}                                    │`);
    console.log(`│    Lines:    ${formatNum(compact.totalLines).padStart(8)}                                    │`);
    console.log(`│    Tokens:   ${formatNum(compact.totalTokens).padStart(8)}                                    │`);
    console.log(`│                                                             │`);
    console.log(`│  COMPRESSION:                                               │`);
    console.log(`│    Ratio:    ${compressionX}x smaller                                │`);
    console.log(`│    Savings:  ${(savings * 100).toFixed(1)}%                                        │`);
    console.log(`│                                                             │`);
    console.log(`│    Raw:     ${bar(1, 45)} │`);
    console.log(`│    Compact: ${bar(ratio, 45)} │`);
    console.log(`│                                                             │`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);
}

function printTopFiles(raw: RawStats, topN: number = 10) {
    console.log(`\n  Top ${topN} most expensive files (raw):`);
    console.log(`  ${"─".repeat(56)}`);
    for (const item of raw.breakdown.slice(0, topN)) {
        const name = item.file.length > 38 ? "..." + item.file.slice(-35) : item.file;
        console.log(`  ${name.padEnd(40)} ${formatNum(item.tokens).padStart(7)} tk`);
    }
}

function printSummary(
    rawCode: RawStats,
    compactCode: CompactStats,
    rawMigrations?: RawStats,
    compactSchema?: CompactStats
) {
    const totalRaw = rawCode.totalTokens + (rawMigrations?.totalTokens || 0);
    const totalCompact = compactCode.totalTokens + (compactSchema?.totalTokens || 0);
    const overallRatio = totalRaw / totalCompact;
    const overallSavings = ((1 - totalCompact / totalRaw) * 100).toFixed(1);

    console.log(`\n╔═════════════════════════════════════════════════════════════╗`);
    console.log(`║                    OVERALL SUMMARY                          ║`);
    console.log(`╠═════════════════════════════════════════════════════════════╣`);
    console.log(`║                                                             ║`);
    console.log(`║  Raw total:       ${formatNum(totalRaw).padStart(10)} tokens                      ║`);
    console.log(`║  Compact total:   ${formatNum(totalCompact).padStart(10)} tokens                      ║`);
    console.log(`║  Compression:     ${overallRatio.toFixed(1).padStart(10)}x                            ║`);
    console.log(`║  Token savings:   ${overallSavings.padStart(9)}%                            ║`);
    console.log(`║                                                             ║`);

    if (rawMigrations && compactSchema) {
        const codeRatio = (rawCode.totalTokens / compactCode.totalTokens).toFixed(1);
        const schemaRatio = (rawMigrations.totalTokens / compactSchema.totalTokens).toFixed(1);
        console.log(`║  By category:                                               ║`);
        console.log(`║    Code:   ${formatNum(rawCode.totalTokens).padStart(8)} → ${formatNum(compactCode.totalTokens).padStart(8)}  (${codeRatio}x)              ║`);
        console.log(`║    Schema: ${formatNum(rawMigrations.totalTokens).padStart(8)} → ${formatNum(compactSchema.totalTokens).padStart(8)}  (${schemaRatio}x)              ║`);
        console.log(`║                                                             ║`);
    }

    // Context window fitting guide
    const windows = [
        { name: "Claude Sonnet (200k)", tokens: 200000 },
        { name: "GPT-4o (128k)", tokens: 128000 },
        { name: "Practical limit (~8k)", tokens: 8000 },
    ];

    console.log(`║  Would it fit?                                              ║`);
    for (const w of windows) {
        const rawFits = totalRaw <= w.tokens ? "✅" : "❌";
        const compactFits = totalCompact <= w.tokens ? "✅" : "❌";
        console.log(`║    ${w.name.padEnd(24)} Raw: ${rawFits}  Compact: ${compactFits}        ║`);
    }

    console.log(`║                                                             ║`);
    console.log(`║  Even with compact YAML, you likely need search for code.   ║`);
    console.log(`║  Use: full --all-schema --topk N to stay within budget.     ║`);
    console.log(`║                                                             ║`);
    console.log(`╚═════════════════════════════════════════════════════════════╝`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const codePath = process.argv[2];
const migrationsDir = process.argv[3];

if (!codePath) {
    console.log("Usage: npx tsx scripts/benchmark.ts <code_path> [migrations_path]");
    process.exit(1);
}

console.log("🔬 Running benchmark...\n");
console.log(`Code path:       ${codePath}`);
if (migrationsDir) console.log(`Migrations path: ${migrationsDir}`);

// Measure raw
console.log("\n⏱  Measuring raw file sizes...");
const rawCode = measureRawCode(codePath);

let rawMigrations: RawStats | undefined;
if (migrationsDir) {
    rawMigrations = measureRawMigrations(migrationsDir);
}

// Measure compact
console.log("⏱  Running compactor...");
const compCode = measureCompactCode(codePath);

let compSchema: CompactStats | undefined;
if (migrationsDir) {
    compSchema = measureCompactSchema(migrationsDir);
}

// Display results
printComparison(rawCode, compCode);
printTopFiles(rawCode);

if (rawMigrations && compSchema) {
    printComparison(rawMigrations, compSchema);
}

printSummary(rawCode, compCode, rawMigrations, compSchema);