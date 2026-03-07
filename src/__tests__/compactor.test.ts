import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    compactSchema,
    compactCode,
    compactAllCode,
    compactFull,
    writeCompactedOutput,
} from "../compactor";
import { SchemaState, TableSchema, ColumnDef } from "../schema";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

// ─── compactSchema ──────────────────────────────────────────────────────────

describe("compactSchema", () => {
    const usersTable = makeTable("users", [
        makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true, nullable: false }),
        makeColumn({ name: "email", dataType: "VARCHAR(255)", isUnique: true }),
    ]);

    const ordersTable = makeTable("orders", [
        makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true, nullable: false }),
        makeColumn({ name: "user_id", dataType: "UUID", references: "users(id)" }),
        makeColumn({ name: "total", dataType: "DECIMAL(10,2)" }),
    ]);

    it("dumps all tables when no query or filter provided", () => {
        const state = makeState([usersTable, ordersTable]);
        const yaml = compactSchema(state);
        expect(yaml).toContain("schema:");
        expect(yaml).toContain("users:");
        expect(yaml).toContain("orders:");
    });

    it("filters by explicit table names", () => {
        const state = makeState([usersTable, ordersTable]);
        const yaml = compactSchema(state, undefined, undefined, ["users"]);
        expect(yaml).toContain("users:");
        expect(yaml).not.toContain("orders:");
    });

    it("includes column details", () => {
        const state = makeState([usersTable]);
        const yaml = compactSchema(state);
        expect(yaml).toContain("id:");
        expect(yaml).toContain("UUID");
        expect(yaml).toContain("email:");
    });

    it("includes FK references in output", () => {
        const state = makeState([usersTable, ordersTable]);
        const yaml = compactSchema(state);
        expect(yaml).toContain("-> users(id)");
    });

    it("includes primary key info", () => {
        const state = makeState([usersTable]);
        const yaml = compactSchema(state);
        expect(yaml).toContain("pk:");
        expect(yaml).toContain("id");
    });

    it("includes enums when tables use them", () => {
        const enums = new Map<string, string[]>();
        enums.set("order_status", ["pending", "active", "cancelled"]);

        const tableWithEnum = makeTable("orders", [
            makeColumn({ name: "id", dataType: "UUID", isPrimaryKey: true }),
            makeColumn({ name: "status", dataType: "ENUM(order_status)", enumValues: ["pending", "active", "cancelled"] }),
        ]);

        const state = makeState([tableWithEnum], enums);
        const yaml = compactSchema(state);
        expect(yaml).toContain("enums:");
        expect(yaml).toContain("order_status");
    });
});

// ─── compactCode ────────────────────────────────────────────────────────────

describe("compactCode", () => {
    const dummyCodePath = path.resolve(__dirname, "../../dummycode");

    it("returns matching files for a relevant query", () => {
        const { yaml, fileNames } = compactCode(dummyCodePath, "auth session token", 5);
        expect(yaml).toContain("code:");
        expect(fileNames.length).toBeGreaterThan(0);
    });

    it("returns 'no relevant files' for unrelated query", () => {
        const { yaml, fileNames } = compactCode(dummyCodePath, "zzz_nonexistent_xyz_12345", 5);
        expect(yaml).toContain("no relevant files found");
        expect(fileNames).toEqual([]);
    });
});

// ─── compactAllCode ─────────────────────────────────────────────────────────

describe("compactAllCode", () => {
    const dummyCodePath = path.resolve(__dirname, "../../dummycode");

    it("extracts all TS files with structure", () => {
        const { yaml, fileNames } = compactAllCode(dummyCodePath);
        expect(yaml).toContain("code:");
        expect(fileNames.length).toBeGreaterThan(0);
        // auth.ts has an interface, class, and arrow function
        expect(fileNames).toContain("auth.ts");
    });

    it("includes interfaces and classes in output", () => {
        const { yaml } = compactAllCode(dummyCodePath);
        expect(yaml).toContain("Session");
        expect(yaml).toContain("AuthService");
    });
});

// ─── compactFull ────────────────────────────────────────────────────────────

describe("compactFull", () => {
    it("generates code-only bundle with allCode flag", () => {
        const dummyCodePath = path.resolve(__dirname, "../../dummycode");
        const { content } = compactFull({
            includeCode: true,
            includeSchema: false,
            codePath: dummyCodePath,
            allCode: true,
            showTokens: false,
        });

        expect(content).toContain("# Context Bundle");
        expect(content).toContain("code:");
        expect(content).toContain("AuthService");
        expect(content).not.toContain("schema:");
    });

    it("generates header with query when provided", () => {
        const dummyCodePath = path.resolve(__dirname, "../../dummycode");
        const { content } = compactFull({
            includeCode: true,
            includeSchema: false,
            codePath: dummyCodePath,
            query: "auth session",
            showTokens: false,
        });

        expect(content).toContain("# Query: auth session");
    });

    it("omits query from header when not provided", () => {
        const dummyCodePath = path.resolve(__dirname, "../../dummycode");
        const { content } = compactFull({
            includeCode: true,
            includeSchema: false,
            codePath: dummyCodePath,
            allCode: true,
            showTokens: false,
        });

        expect(content).not.toContain("# Query:");
    });

    it("includes schema section when schema options provided", () => {
        // Create temp migrations dir
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxforge-compact-test-"));
        fs.writeFileSync(
            path.join(tmpDir, "001.sql"),
            `-- migrate:up\nCREATE TABLE users (id UUID PRIMARY KEY NOT NULL);\n-- migrate:down`,
            "utf-8"
        );

        const dummyCodePath = path.resolve(__dirname, "../../dummycode");
        const { content } = compactFull({
            includeCode: true,
            includeSchema: true,
            codePath: dummyCodePath,
            migrationsPath: tmpDir,
            allCode: true,
            allSchema: true,
            showTokens: false,
        });

        expect(content).toContain("code:");
        expect(content).toContain("schema:");
        expect(content).toContain("users:");

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns token report when showTokens is true", () => {
        const dummyCodePath = path.resolve(__dirname, "../../dummycode");
        const { tokenReport } = compactFull({
            includeCode: true,
            includeSchema: false,
            codePath: dummyCodePath,
            allCode: true,
            showTokens: true,
        });

        expect(tokenReport).toBeDefined();
        expect(tokenReport!.total).toBeGreaterThan(0);
    });
});

// ─── writeCompactedOutput ───────────────────────────────────────────────────

describe("writeCompactedOutput", () => {
    let tmpFile: string;

    beforeEach(() => {
        tmpFile = path.join(os.tmpdir(), `ctxforge-test-output-${Date.now()}.yml`);
    });

    afterEach(() => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    });

    it("writes content to the specified path", () => {
        const content = "# Test content\ncode:\n  test: value";
        writeCompactedOutput(content, tmpFile);
        expect(fs.existsSync(tmpFile)).toBe(true);
        expect(fs.readFileSync(tmpFile, "utf-8")).toBe(content);
    });

    it("returns the output path", () => {
        const result = writeCompactedOutput("test", tmpFile);
        expect(result).toBe(tmpFile);
    });
});
