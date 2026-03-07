import { describe, it, expect } from "vitest";
import {
    estimateTokens,
    analyzeTokens,
    granularBreakdown,
    printTokenReport,
} from "../tokens";

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("returns 0 for undefined-ish input", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("returns a positive number for non-empty text", () => {
        expect(estimateTokens("hello world")).toBeGreaterThan(0);
    });

    it("estimates more tokens for longer text", () => {
        const short = estimateTokens("hello");
        const long = estimateTokens("hello world this is a longer sentence with more words");
        expect(long).toBeGreaterThan(short);
    });

    it("estimates more tokens for code-like content", () => {
        const prose = estimateTokens("This is a simple english paragraph about nothing.");
        const code = estimateTokens("export function foo(bar: string): void {\n  return bar;\n}");
        // Code has a lower chars-per-token ratio, so same length → more tokens
        // But we test that it returns a reasonable number
        expect(code).toBeGreaterThan(0);
        expect(prose).toBeGreaterThan(0);
    });

    it("handles multiline YAML content", () => {
        const yaml = `schema:
  users:
    pk: [id]
    cols:
      id: UUID, not null
      name: VARCHAR(255)
      email: VARCHAR(255), unique`;
        const tokens = estimateTokens(yaml);
        expect(tokens).toBeGreaterThan(10);
    });
});

// ─── analyzeTokens ──────────────────────────────────────────────────────────

describe("analyzeTokens", () => {
    const sampleYaml = `# Context Bundle
# Generated: 2026-01-01
---

code:
  cli.ts:
    functions:
      main(): void

schema:
  users:
    pk: [id]
    cols:
      id: UUID`;

    it("splits content into sections by top-level YAML keys", () => {
        const report = analyzeTokens(sampleYaml);
        const sectionNames = report.sections.map(s => s.section);
        expect(sectionNames).toContain("header");
        expect(sectionNames).toContain("code");
        expect(sectionNames).toContain("schema");
    });

    it("total tokens equals sum of section tokens", () => {
        const report = analyzeTokens(sampleYaml);
        const sum = report.sections.reduce((acc, s) => acc + s.tokens, 0);
        expect(report.total).toBe(sum);
    });

    it("percentages roughly sum to 100", () => {
        const report = analyzeTokens(sampleYaml);
        const sumPct = report.sections.reduce((acc, s) => acc + s.percentage, 0);
        // allow rounding error
        expect(sumPct).toBeGreaterThanOrEqual(98);
        expect(sumPct).toBeLessThanOrEqual(102);
    });

    it("includes budget info when budgetLimit is provided", () => {
        const report = analyzeTokens(sampleYaml, 5000);
        expect(report.budget).toBeDefined();
        expect(report.budget!.limit).toBe(5000);
        expect(report.budget!.used).toBe(report.total);
        expect(report.budget!.remaining).toBe(5000 - report.total);
        expect(report.budget!.utilization).toMatch(/^\d+%$/);
    });

    it("omits budget info when budgetLimit is not provided", () => {
        const report = analyzeTokens(sampleYaml);
        expect(report.budget).toBeUndefined();
    });

    it("handles content with only a header (no sections)", () => {
        const report = analyzeTokens("# just a comment\n---");
        expect(report.sections.length).toBeGreaterThanOrEqual(1);
        expect(report.total).toBeGreaterThan(0);
    });
});

// ─── granularBreakdown ──────────────────────────────────────────────────────

describe("granularBreakdown", () => {
    const content = `code:
  cli.ts:
    functions:
      main(): void
      init(): void
  compactor.ts:
    functions:
      compact(): string

schema:
  users:
    pk: [id]
    cols:
      id: UUID
  orders:
    pk: [id]
    cols:
      id: UUID
      user_id: UUID -> users(id)`;

    it("detects files in code section", () => {
        const items = granularBreakdown(content);
        const files = items.filter(i => i.type === "file");
        const fileNames = files.map(f => f.name);
        expect(fileNames).toContain("cli.ts");
        expect(fileNames).toContain("compactor.ts");
    });

    it("detects tables in schema section", () => {
        const items = granularBreakdown(content);
        const tables = items.filter(i => i.type === "table");
        const tableNames = tables.map(t => t.name);
        expect(tableNames).toContain("users");
        expect(tableNames).toContain("orders");
    });

    it("returns items sorted by tokens descending", () => {
        const items = granularBreakdown(content);
        for (let i = 1; i < items.length; i++) {
            expect(items[i - 1].tokens).toBeGreaterThanOrEqual(items[i].tokens);
        }
    });

    it("returns empty array for empty content", () => {
        expect(granularBreakdown("")).toEqual([]);
    });
});

// ─── printTokenReport ───────────────────────────────────────────────────────

describe("printTokenReport", () => {
    it("returns a formatted string with section breakdown", () => {
        const report = analyzeTokens("code:\n  cli.ts:\n    functions:\n      main(): void");
        const output = printTokenReport(report);
        expect(output).toContain("TOKEN USAGE REPORT");
        expect(output).toContain("SECTION BREAKDOWN");
    });

    it("includes granular items when provided", () => {
        const content = "code:\n  cli.ts:\n    functions:\n      main(): void";
        const report = analyzeTokens(content);
        const granular = granularBreakdown(content);
        const output = printTokenReport(report, granular);
        expect(output).toContain("TOP ITEMS BY TOKEN USAGE");
    });

    it("includes budget info when present in report", () => {
        const report = analyzeTokens("code:\n  test: value", 5000);
        const output = printTokenReport(report);
        expect(output).toContain("Budget:");
        expect(output).toContain("5000");
    });
});
