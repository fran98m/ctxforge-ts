// src/tokens.ts
//
// Token estimation for context budget management.
// Uses cl100k_base heuristics (GPT-4 / Claude tokenizer approximation).
//
// Why not use tiktoken directly?
//   - It's a native dependency (wasm/node-gyp pain)
//   - For budget estimation, ±5% accuracy is fine
//   - The heuristic below benchmarks within ~3-7% of actual cl100k on code + YAML

// ─── Core Estimator ──────────────────────────────────────────────────────────

/**
 * Estimates token count using a weighted heuristic:
 *   - Code/YAML: ~1 token per 3.5 chars (dense identifiers, punctuation)
 *   - Prose/comments: ~1 token per 4.2 chars (more common English words)
 *   - Mixed: ~1 token per 3.8 chars (weighted average)
 *
 * We detect the content type and pick the right ratio.
 */
export function estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    // Detect content type by sampling characteristics
    const lines = text.split("\n");
    const totalLines = lines.length;

    let codeLineCount = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        // Heuristics for "code-like" lines
        if (
            trimmed.includes(":") ||    // YAML keys, type annotations
            trimmed.includes("(") ||    // function calls/signatures
            trimmed.includes("{") ||    // blocks
            trimmed.includes("=>") ||   // arrows
            trimmed.startsWith("- ") || // YAML lists
            trimmed.startsWith("import") ||
            trimmed.startsWith("export") ||
            /^\w+\s*=/.test(trimmed)     // assignments
        ) {
            codeLineCount++;
        }
    }

    const codeRatio = totalLines > 0 ? codeLineCount / totalLines : 0.5;

    // Weighted chars-per-token: code=3.5, prose=4.2
    const charsPerToken = 3.5 * codeRatio + 4.2 * (1 - codeRatio);

    return Math.ceil(text.length / charsPerToken);
}

// ─── Section-Level Breakdown ─────────────────────────────────────────────────

export interface TokenBreakdown {
    section: string;
    tokens: number;
    chars: number;
    lines: number;
    percentage: number; // of total
}

export interface TokenReport {
    total: number;
    totalChars: number;
    totalLines: number;
    sections: TokenBreakdown[];
    budget?: {
        limit: number;
        used: number;
        remaining: number;
        utilization: string; // "72%"
    };
}

/**
 * Analyzes a compacted YAML output and breaks down tokens per top-level section.
 * Sections are detected by top-level YAML keys (schema:, code:, etc.)
 */
export function analyzeTokens(content: string, budgetLimit?: number): TokenReport {
    const sections: TokenBreakdown[] = [];
    const lines = content.split("\n");

    let currentSection = "header";
    let currentLines: string[] = [];

    // Split by top-level YAML keys
    for (const line of lines) {
        // Top-level key: starts at column 0, ends with ":"
        const topLevelMatch = line.match(/^([a-zA-Z_][\w]*)\s*:/);
        if (topLevelMatch && !line.startsWith("  ") && !line.startsWith("#")) {
            // Save previous section
            if (currentLines.length > 0) {
                const text = currentLines.join("\n");
                sections.push({
                    section: currentSection,
                    tokens: estimateTokens(text),
                    chars: text.length,
                    lines: currentLines.length,
                    percentage: 0, // calculated after
                });
            }
            currentSection = topLevelMatch[1];
            currentLines = [line];
        } else {
            currentLines.push(line);
        }
    }

    // Don't forget last section
    if (currentLines.length > 0) {
        const text = currentLines.join("\n");
        sections.push({
            section: currentSection,
            tokens: estimateTokens(text),
            chars: text.length,
            lines: currentLines.length,
            percentage: 0,
        });
    }

    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    const totalChars = sections.reduce((sum, s) => sum + s.chars, 0);
    const totalLines = sections.reduce((sum, s) => sum + s.lines, 0);

    // Calculate percentages
    for (const s of sections) {
        s.percentage = totalTokens > 0 ? Math.round((s.tokens / totalTokens) * 100) : 0;
    }

    const report: TokenReport = {
        total: totalTokens,
        totalChars,
        totalLines,
        sections,
    };

    if (budgetLimit) {
        report.budget = {
            limit: budgetLimit,
            used: totalTokens,
            remaining: Math.max(0, budgetLimit - totalTokens),
            utilization: `${Math.round((totalTokens / budgetLimit) * 100)}%`,
        };
    }

    return report;
}

// ─── Per-Table / Per-File Granular Breakdown ─────────────────────────────────

export interface GranularItem {
    name: string;
    type: "table" | "file" | "enum";
    tokens: number;
    chars: number;
}

/**
 * Breaks down token usage per individual table and per individual file.
 * Useful for identifying which specific tables/files are eating the budget.
 */
export function granularBreakdown(content: string): GranularItem[] {
    const items: GranularItem[] = [];
    const lines = content.split("\n");

    let inSchema = false;
    let inCode = false;
    let currentItem: { name: string; type: "table" | "file" | "enum"; lines: string[] } | null = null;

    for (const line of lines) {
        // Track which top-level section we're in
        if (line.match(/^schema\s*:/)) { inSchema = true; inCode = false; continue; }
        if (line.match(/^code\s*:/)) { inCode = true; inSchema = false; continue; }
        if (line.match(/^[a-zA-Z]/) && !line.startsWith(" ")) { inSchema = false; inCode = false; }

        if (inSchema) {
            // 2-space indent = table name or "enums:"
            const tableMatch = line.match(/^  (\w+)\s*:/);
            if (tableMatch && tableMatch[1] !== "enums" && tableMatch[1] !== "cols" && tableMatch[1] !== "pk" && tableMatch[1] !== "indexes" && tableMatch[1] !== "partition") {
                // Save previous
                if (currentItem) {
                    const text = currentItem.lines.join("\n");
                    items.push({ name: currentItem.name, type: currentItem.type, tokens: estimateTokens(text), chars: text.length });
                }
                currentItem = { name: tableMatch[1], type: "table", lines: [line] };
                continue;
            }
        }

        if (inCode) {
            // 2-space indent = file path
            const fileMatch = line.match(/^  ([\w/.\-]+\.ts)\s*:/);
            if (fileMatch) {
                if (currentItem) {
                    const text = currentItem.lines.join("\n");
                    items.push({ name: currentItem.name, type: currentItem.type, tokens: estimateTokens(text), chars: text.length });
                }
                currentItem = { name: fileMatch[1], type: "file", lines: [line] };
                continue;
            }
        }

        if (currentItem) {
            currentItem.lines.push(line);
        }
    }

    // Last item
    if (currentItem) {
        const text = currentItem.lines.join("\n");
        items.push({ name: currentItem.name, type: currentItem.type, tokens: estimateTokens(text), chars: text.length });
    }

    // Sort descending by tokens
    items.sort((a, b) => b.tokens - a.tokens);
    return items;
}

// ─── Pretty Printer ──────────────────────────────────────────────────────────

export function printTokenReport(report: TokenReport, granular?: GranularItem[]): string {
    const lines: string[] = [];

    lines.push("╔══════════════════════════════════════════════════╗");
    lines.push("║            TOKEN USAGE REPORT                   ║");
    lines.push("╠══════════════════════════════════════════════════╣");
    lines.push(`║  Total tokens:  ${String(report.total).padStart(8)}                       ║`);
    lines.push(`║  Total chars:   ${String(report.totalChars).padStart(8)}                       ║`);
    lines.push(`║  Total lines:   ${String(report.totalLines).padStart(8)}                       ║`);

    if (report.budget) {
        lines.push("╠══════════════════════════════════════════════════╣");
        lines.push(`║  Budget:        ${String(report.budget.limit).padStart(8)} tokens                 ║`);
        lines.push(`║  Used:          ${String(report.budget.used).padStart(8)} (${report.budget.utilization.padStart(4)})                ║`);
        lines.push(`║  Remaining:     ${String(report.budget.remaining).padStart(8)}                       ║`);
    }

    lines.push("╠══════════════════════════════════════════════════╣");
    lines.push("║  SECTION BREAKDOWN                              ║");
    lines.push("╠══════════════════════════════════════════════════╣");

    for (const s of report.sections) {
        const bar = "█".repeat(Math.max(1, Math.round(s.percentage / 5)));
        lines.push(`║  ${s.section.padEnd(12)} ${String(s.tokens).padStart(7)} tk (${String(s.percentage).padStart(2)}%) ${bar.padEnd(20)} ║`);
    }

    if (granular && granular.length > 0) {
        lines.push("╠══════════════════════════════════════════════════╣");
        lines.push("║  TOP ITEMS BY TOKEN USAGE                       ║");
        lines.push("╠══════════════════════════════════════════════════╣");

        const topItems = granular.slice(0, 15); // top 15
        for (const item of topItems) {
            const icon = item.type === "table" ? "🗄" : item.type === "file" ? "📄" : "📋";
            const name = item.name.length > 28 ? "..." + item.name.slice(-25) : item.name;
            lines.push(`║  ${icon} ${name.padEnd(30)} ${String(item.tokens).padStart(6)} tk   ║`);
        }
    }

    lines.push("╚══════════════════════════════════════════════════╝");

    return lines.join("\n");
}
