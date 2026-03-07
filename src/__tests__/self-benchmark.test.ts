import { describe, it, expect } from "vitest";
import { compactFull, compactCode, compactAllCode } from "../compactor";
import { tokenizeQuery, searchFiles } from "../search";
import { estimateTokens } from "../tokens";
import { Project } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

// ─── Test ctxforge against its own codebase ─────────────────────────────────

const SRC_PATH = path.resolve(__dirname, "..");

// Helper: measure raw token cost of every file in src/
function rawTokenCost(): number {
    const project = new Project();
    project.addSourceFilesAtPaths(path.join(SRC_PATH, "**/*.ts"));
    let total = 0;
    for (const sf of project.getSourceFiles()) {
        const rel = path.relative(SRC_PATH, sf.getFilePath());
        if (rel.includes(".test.") || rel.includes(".spec.") || rel.includes("__tests__")) continue;
        total += estimateTokens(sf.getFullText());
    }
    return total;
}

// ─── Compression effectiveness ──────────────────────────────────────────────

describe("self-benchmark: compression", () => {
    it("compact YAML uses significantly fewer tokens than raw source", () => {
        const raw = rawTokenCost();
        const { yaml } = compactAllCode(SRC_PATH);
        const compact = estimateTokens(yaml);

        const ratio = raw / compact;
        console.log(`  Raw: ${raw} tokens → Compact: ${compact} tokens (${ratio.toFixed(1)}x compression)`);

        // Must achieve at least 2x compression on our own codebase
        expect(ratio).toBeGreaterThan(2);
    });

    it("full bundle (--all, code only) stays under 4k tokens for our small codebase", () => {
        const { content, tokenReport } = compactFull({
            includeCode: true,
            includeSchema: false,
            codePath: SRC_PATH,
            allCode: true,
            showTokens: false,
        });

        const tokens = estimateTokens(content);
        console.log(`  Full bundle: ${tokens} tokens`);
        // Our src/ is small — should fit easily in a practical context window
        expect(tokens).toBeLessThan(4000);
    });
});

// ─── Search relevance: does the right file come back for known queries? ─────

describe("self-benchmark: search relevance", () => {
    const testCases: { query: string; mustInclude: string[]; mustNotInclude?: string[] }[] = [
        {
            query: "token estimation budget",
            mustInclude: ["tokens.ts"],
            mustNotInclude: ["schema.ts"],
        },
        {
            query: "SQL migration parsing CREATE TABLE ALTER",
            mustInclude: ["schema.ts"],
        },
        {
            query: "search ranking score file",
            mustInclude: ["search.ts"],
        },
        {
            query: "YAML compaction code schema bundle",
            mustInclude: ["compactor.ts"],
        },
        {
            query: "schema table scoring FK propagation",
            mustInclude: ["schema-search.ts"],
        },
        {
            query: "CLI command full dump context",
            mustInclude: ["cli.ts"],
        },
        {
            query: "extract signature interface class function",
            mustInclude: ["fetcher.ts"],
        },
    ];

    for (const { query, mustInclude, mustNotInclude } of testCases) {
        it(`"${query}" → finds ${mustInclude.join(", ")}`, () => {
            const results = searchFiles(SRC_PATH, query, 5);
            const foundFiles = results.map(r => path.basename(r.filePath));

            for (const expected of mustInclude) {
                expect(foundFiles).toContain(expected);
            }

            if (mustNotInclude) {
                for (const excluded of mustNotInclude) {
                    // If it appears, it should be ranked lower than the expected files
                    const expectedIdx = foundFiles.indexOf(mustInclude[0]);
                    const excludedIdx = foundFiles.indexOf(excluded);
                    if (excludedIdx !== -1) {
                        expect(excludedIdx).toBeGreaterThan(expectedIdx);
                    }
                }
            }
        });
    }

    it("top result has highest score (ranking correctness)", () => {
        const results = searchFiles(SRC_PATH, "token estimation", 10);
        expect(results.length).toBeGreaterThan(0);
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });
});

// ─── Output completeness: does the bundle capture the important structures? ──

describe("self-benchmark: output completeness", () => {
    it("full dump captures all key interfaces", () => {
        const { yaml } = compactAllCode(SRC_PATH);

        // Our codebase's core interfaces must appear
        expect(yaml).toContain("CompactOptions");
        expect(yaml).toContain("TokenReport");
        expect(yaml).toContain("TokenBreakdown");
        expect(yaml).toContain("GranularItem");
        expect(yaml).toContain("ColumnDef");
        expect(yaml).toContain("TableSchema");
        expect(yaml).toContain("SchemaState");
        expect(yaml).toContain("SchemaSearchResult");
    });

    it("full dump captures all key functions", () => {
        const { yaml } = compactAllCode(SRC_PATH);

        expect(yaml).toContain("estimateTokens");
        expect(yaml).toContain("analyzeTokens");
        expect(yaml).toContain("compactFull");
        expect(yaml).toContain("compactSchema");
        expect(yaml).toContain("compactCode");
        expect(yaml).toContain("extractSchema");
        expect(yaml).toContain("searchFiles");
        expect(yaml).toContain("tokenizeQuery");
        expect(yaml).toContain("searchSchema");
        expect(yaml).toContain("extractFromFile");
    });

    it("search-driven extraction for 'token' captures tokens.ts structures", () => {
        const { yaml } = compactCode(SRC_PATH, "token estimation budget analysis", 5);

        expect(yaml).toContain("estimateTokens");
        expect(yaml).toContain("analyzeTokens");
        expect(yaml).toContain("TokenReport");
    });

    it("search-driven extraction for 'schema' captures schema.ts structures", () => {
        const { yaml } = compactCode(SRC_PATH, "schema migration SQL table column", 5);

        expect(yaml).toContain("extractSchema");
        expect(yaml).toContain("ColumnDef");
        expect(yaml).toContain("TableSchema");
    });
});

// ─── Query tokenization quality (on our own domain terms) ───────────────────

describe("self-benchmark: tokenization quality", () => {
    it("splits domain-specific camelCase terms correctly", () => {
        const tokens = tokenizeQuery("compactAllCode writeCompactedOutput");
        expect(tokens).toContain("compact");
        expect(tokens).toContain("code");
        expect(tokens).toContain("write");
        expect(tokens).toContain("output");
    });

    it("stems common suffixes in our domain", () => {
        const tokens = tokenizeQuery("migrations parsing tokens");
        expect(tokens).toContain("migration");
        expect(tokens).toContain("pars"); // "parsing" → strip -ing
        expect(tokens).toContain("token");
    });

    it("handles snake_case from SQL domain", () => {
        const tokens = tokenizeQuery("primary_key foreign_key");
        expect(tokens).toContain("primary");
        expect(tokens).toContain("key");
        expect(tokens).toContain("foreign");
    });
});

// ─── Ranking precision: search for each module and verify it's #1 ───────────

describe("self-benchmark: precision (right file is #1)", () => {
    const precisionCases: { query: string; expected: string }[] = [
        { query: "estimateTokens analyzeTokens tokenBudget", expected: "tokens.ts" },
        { query: "extractSchema parseCreateTable migration", expected: "schema.ts" },
        { query: "searchFiles scoreFile tokenizeQuery", expected: "search.ts" },
        { query: "compactFull compactSchema compactCode YAML", expected: "compactor.ts" },
        { query: "scoreTable propagateFKScores searchSchema", expected: "schema-search.ts" },
        { query: "fetcher extractFromFile buildSignature", expected: "fetcher.ts" },
    ];

    for (const { query, expected } of precisionCases) {
        it(`#1 result for "${query}" is ${expected}`, () => {
            const results = searchFiles(SRC_PATH, query, 3);
            expect(results.length).toBeGreaterThan(0);
            const topFile = path.basename(results[0].filePath);
            expect(topFile).toBe(expected);
        });
    }
});
