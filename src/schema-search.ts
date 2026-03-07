// src/schema-search.ts
//
// Applies the same search-first philosophy as search.ts but for DB tables.
// Scores tables against query terms, propagates scores through FK relationships,
// and cross-references code search results to infer table relevance.

import { SchemaState, TableSchema, ColumnDef } from "./schema";
import { tokenizeQuery } from "./search";

// ─── Table Scoring ───────────────────────────────────────────────────────────

interface TableScore {
    tableName: string;
    table: TableSchema;
    score: number;
    matchReasons: string[]; // for debugging / transparency
}

/**
 * Scores a single table against query terms.
 *
 * Weight breakdown:
 *   - Table name match:     5.0  (same as filename in search.ts)
 *   - Column name match:    2.0  (structural relevance)
 *   - Enum value match:     3.0  (domain concept hit)
 *   - FK target match:      2.5  (relationship relevance)
 *   - Column comment match: 1.5  (semantic relevance)
 */
function scoreTable(table: TableSchema, queryTerms: string[], state: SchemaState): TableScore {
    const result: TableScore = {
        tableName: table.name,
        table,
        score: 0,
        matchReasons: [],
    };

    if (queryTerms.length === 0) return result;

    const tableName = table.name.toLowerCase();
    // Also split table name on underscores for partial matching
    // e.g., "order_items" → ["order", "items"]
    const tableNameParts = tableName.split("_").filter(p => p.length > 1);

    for (const term of queryTerms) {
        // 1. Table name (exact or partial)
        if (tableName.includes(term)) {
            result.score += 5.0;
            result.matchReasons.push(`table_name:${term}`);
        } else if (tableNameParts.some(p => p.includes(term) || term.includes(p))) {
            result.score += 3.5; // partial match is still strong
            result.matchReasons.push(`table_name_partial:${term}`);
        }

        // 2. Column names
        for (const [colName, col] of table.columns) {
            const colParts = colName.split("_").filter(p => p.length > 1);

            if (colName.includes(term)) {
                result.score += 2.0;
                result.matchReasons.push(`col:${colName}=${term}`);
            } else if (colParts.some(p => p.includes(term))) {
                result.score += 1.0;
                result.matchReasons.push(`col_partial:${colName}~${term}`);
            }

            // 3. Enum values
            if (col.enumValues) {
                for (const val of col.enumValues) {
                    if (val.toLowerCase().includes(term)) {
                        result.score += 3.0;
                        result.matchReasons.push(`enum:${colName}.${val}=${term}`);
                    }
                }
            }

            // 4. FK references (the table it points to)
            if (col.references) {
                const refTable = col.references.split("(")[0].toLowerCase();
                if (refTable.includes(term)) {
                    result.score += 2.5;
                    result.matchReasons.push(`fk:${colName}->${refTable}=${term}`);
                }
            }

            // 5. Column comments
            if (col.comment && col.comment.toLowerCase().includes(term)) {
                result.score += 1.5;
                result.matchReasons.push(`comment:${colName}="${term}"`);
            }
        }
    }

    // 6. Check standalone enum type names against query
    for (const [enumName, values] of state.enums) {
        if (enumName.includes(queryTerms.join("_")) || queryTerms.some(t => enumName.includes(t))) {
            // Check if this table uses this enum
            for (const [_, col] of table.columns) {
                if (col.dataType.toLowerCase().includes(enumName)) {
                    result.score += 2.0;
                    result.matchReasons.push(`uses_enum:${enumName}`);
                }
            }
        }
    }

    return result;
}

// ─── FK Graph Propagation ────────────────────────────────────────────────────

/**
 * Propagates scores through foreign key relationships.
 * If "orders" scores high, "order_items" (which FK→orders) gets a boost.
 * Bidirectional: parent tables also get boosted by child scores.
 */
function propagateFKScores(scores: Map<string, TableScore>, state: SchemaState): void {
    const fkBoost = 0.35;
    const boosts = new Map<string, number>();

    for (const [tableName, tableScore] of scores) {
        if (tableScore.score === 0) continue;

        const table = state.tables.get(tableName);
        if (!table) continue;

        for (const [_, col] of table.columns) {
            if (!col.references) continue;

            const refTable = col.references.split("(")[0].toLowerCase();
            const currentBoost = boosts.get(refTable) || 0;
            boosts.set(refTable, currentBoost + tableScore.score * fkBoost);

            // Reverse boost: if the referenced table scored, boost this table too
            const refScore = scores.get(refTable);
            if (refScore && refScore.score > 0) {
                const reverseBoost = boosts.get(tableName) || 0;
                boosts.set(tableName, reverseBoost + refScore.score * fkBoost * 0.5);
            }
        }
    }

    // Apply boosts
    for (const [tableName, boost] of boosts) {
        const existing = scores.get(tableName);
        if (existing) {
            existing.score += boost;
            existing.matchReasons.push(`fk_propagation:+${boost.toFixed(2)}`);
        }
    }
}

// ─── Code Cross-Reference ────────────────────────────────────────────────────

/**
 * Cross-references code search results with table names.
 * If OrderService.ts scored high in code search, "orders" table gets boosted.
 *
 * Matching heuristics:
 *   - Class/file name contains table name (OrderService → orders)upports a central public repository called Conan Center, and can also host private repositories.
 *   - Table name contains class name root (user_profiles → User class)
 *   - Singularize/pluralize matching (users ↔ User)
 */
export function crossReferenceCodeToSchema(
    codeFileNames: string[],
    scores: Map<string, TableScore>,
    codeBoost: number = 2.0
): void {
    // Extract meaningful terms from code file names
    const codeTerms = new Set<string>();

    for (const fileName of codeFileNames) {
        // "order.service.ts" → ["order", "service"]
        // "OrderService.ts" → ["order", "service"]
        const base = fileName
            .replace(/\.(ts|js|tsx|jsx)$/, "")
            .replace(/\./g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase();

        for (const part of base.split(/\s+/)) {
            if (part.length > 2) {
                codeTerms.add(part);
                // Basic depluralize
                if (part.endsWith("s") && part.length > 3) codeTerms.add(part.slice(0, -1));
            }
        }
    }

    for (const [tableName, tableScore] of scores) {
        const tableTerms = tableName.split("_").filter(p => p.length > 1);
        const singular = tableName.endsWith("s") ? tableName.slice(0, -1) : tableName;

        for (const codeTerm of codeTerms) {
            if (
                tableName.includes(codeTerm) ||
                codeTerm.includes(singular) ||
                tableTerms.some(t => t === codeTerm || codeTerm.includes(t))
            ) {
                tableScore.score += codeBoost;
                tableScore.matchReasons.push(`code_xref:${codeTerm}`);
                break; // one match per table is enough
            }
        }
    }
}

// ─── Main Search Entry Point ─────────────────────────────────────────────────

export interface SchemaSearchResult {
    tableName: string;
    table: TableSchema;
    score: number;
    matchReasons: string[];
}

/**
 * Searches schema for tables relevant to the query.
 * Optionally cross-references with code search results.
 *
 * @param state - Schema state from migration replay
 * @param query - User's search query
 * @param topK - Max tables to return
 * @param codeFileNames - Optional: file names from code search (for cross-ref boost)
 */
export function searchSchema(
    state: SchemaState,
    query: string,
    topK: number = 10,
    codeFileNames?: string[]
): SchemaSearchResult[] {
    const queryTerms = tokenizeQuery(query);

    console.log(`\n# Schema search terms: [${queryTerms.join(", ")}]`);
    console.log(`# Searching across ${state.tables.size} tables...`);

    // Phase 1: Score all tables
    const scores = new Map<string, TableScore>();
    for (const [name, table] of state.tables) {
        scores.set(name, scoreTable(table, queryTerms, state));
    }

    // Phase 2: FK propagation
    propagateFKScores(scores, state);

    // Phase 3: Code cross-reference (if available)
    if (codeFileNames && codeFileNames.length > 0) {
        crossReferenceCodeToSchema(codeFileNames, scores);
    }

    // Phase 4: Rank and return top K
    const ranked = Array.from(scores.values())
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    console.log(`# Found ${ranked.length} relevant tables:\n`);
    for (const r of ranked) {
        console.log(`  [Score: ${r.score.toFixed(2)}] ${r.tableName} (${r.matchReasons.join(", ")})`);
    }

    return ranked.map(r => ({
        tableName: r.tableName,
        table: r.table,
        score: r.score,
        matchReasons: r.matchReasons,
    }));
}
