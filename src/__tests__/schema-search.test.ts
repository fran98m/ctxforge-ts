import { describe, it, expect } from "vitest";
import { searchSchema, crossReferenceCodeToSchema } from "../schema-search";
import { SchemaState, TableSchema, ColumnDef } from "../schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeColumn(overrides: Partial<ColumnDef> & { name: string }): ColumnDef {
    return {
        dataType: "VARCHAR(255)",
        nullable: true,
        isPrimaryKey: false,
        isUnique: false,
        ...overrides,
    };
}

function makeTable(name: string, columns: ColumnDef[]): TableSchema {
    const colMap = new Map<string, ColumnDef>();
    for (const col of columns) colMap.set(col.name, col);
    return {
        name,
        columns: colMap,
        primaryKey: columns.filter(c => c.isPrimaryKey).map(c => c.name),
        indexes: [],
        enumTypes: new Map(),
    };
}

function makeState(tables: TableSchema[], enums?: Map<string, string[]>): SchemaState {
    const tableMap = new Map<string, TableSchema>();
    for (const t of tables) tableMap.set(t.name, t);
    return { tables: tableMap, enums: enums || new Map() };
}

// ─── searchSchema ───────────────────────────────────────────────────────────

describe("searchSchema", () => {
    const usersTable = makeTable("users", [
        makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        makeColumn({ name: "email", dataType: "VARCHAR(255)" }),
        makeColumn({ name: "name", dataType: "VARCHAR(255)" }),
    ]);

    const ordersTable = makeTable("orders", [
        makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        makeColumn({ name: "user_id", dataType: "UUID", references: "users(id)" }),
        makeColumn({ name: "total", dataType: "DECIMAL(10,2)" }),
        makeColumn({ name: "status", dataType: "VARCHAR(50)" }),
    ]);

    const productsTable = makeTable("products", [
        makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        makeColumn({ name: "sku", dataType: "VARCHAR(50)" }),
        makeColumn({ name: "price", dataType: "DECIMAL(10,2)" }),
    ]);

    it("returns tables matching the query by name", () => {
        const state = makeState([usersTable, ordersTable, productsTable]);
        const results = searchSchema(state, "users", 10);
        const names = results.map(r => r.tableName);
        expect(names).toContain("users");
    });

    it("returns tables matching by column name", () => {
        const state = makeState([usersTable, ordersTable, productsTable]);
        const results = searchSchema(state, "email", 10);
        const names = results.map(r => r.tableName);
        expect(names).toContain("users");
    });

    it("returns empty for completely unrelated query", () => {
        const state = makeState([usersTable, ordersTable]);
        const results = searchSchema(state, "zzz_nonexistent_xyz", 10);
        expect(results).toEqual([]);
    });

    it("respects topK limit", () => {
        const state = makeState([usersTable, ordersTable, productsTable]);
        const results = searchSchema(state, "id", 1); // all have "id"
        expect(results.length).toBeLessThanOrEqual(1);
    });

    it("results are sorted by score descending", () => {
        const state = makeState([usersTable, ordersTable, productsTable]);
        const results = searchSchema(state, "user order", 10);
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });

    it("includes match reasons for transparency", () => {
        const state = makeState([usersTable]);
        const results = searchSchema(state, "users", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].matchReasons.length).toBeGreaterThan(0);
    });

    it("boosts tables through FK propagation", () => {
        // orders FK → users. Searching "order" should boost users via FK propagation
        const state = makeState([usersTable, ordersTable]);
        const results = searchSchema(state, "order", 10);
        const names = results.map(r => r.tableName);
        // Both should appear — orders directly, users via FK boost
        expect(names).toContain("orders");
        // users gets boosted because orders FK→users
        expect(names).toContain("users");
    });
});

// ─── crossReferenceCodeToSchema ─────────────────────────────────────────────

describe("crossReferenceCodeToSchema", () => {
    it("boosts table score when code file name matches table name", () => {
        const ordersTable = makeTable("orders", [
            makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        ]);

        const scores = new Map<string, any>();
        scores.set("orders", {
            tableName: "orders",
            table: ordersTable,
            score: 0,
            matchReasons: [],
        });

        crossReferenceCodeToSchema(["OrderService.ts"], scores);

        expect(scores.get("orders")!.score).toBeGreaterThan(0);
        expect(scores.get("orders")!.matchReasons.some((r: string) => r.startsWith("code_xref:"))).toBe(true);
    });

    it("handles camelCase file names", () => {
        const usersTable = makeTable("users", [
            makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        ]);

        const scores = new Map<string, any>();
        scores.set("users", {
            tableName: "users",
            table: usersTable,
            score: 0,
            matchReasons: [],
        });

        crossReferenceCodeToSchema(["UserProfileService.ts"], scores);
        expect(scores.get("users")!.score).toBeGreaterThan(0);
    });

    it("does not boost unrelated tables", () => {
        const productsTable = makeTable("products", [
            makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
        ]);

        const scores = new Map<string, any>();
        scores.set("products", {
            tableName: "products",
            table: productsTable,
            score: 0,
            matchReasons: [],
        });

        crossReferenceCodeToSchema(["AuthService.ts"], scores);
        expect(scores.get("products")!.score).toBe(0);
    });
});
