import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractSchema, discoverMigrations, printSchemaState } from "../schema";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function createMigration(filename: string, content: string) {
    fs.writeFileSync(path.join(tmpDir, filename), content, "utf-8");
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxforge-schema-test-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── discoverMigrations ─────────────────────────────────────────────────────

describe("discoverMigrations", () => {
    it("throws on non-existent directory", () => {
        expect(() => discoverMigrations("/nonexistent/path/xyz123")).toThrow();
    });

    it("returns empty array for directory with no .sql files", () => {
        const result = discoverMigrations(tmpDir);
        expect(result).toEqual([]);
    });

    it("discovers .sql files sorted lexicographically", () => {
        createMigration("20230201_b.sql", "-- migrate:up\n-- migrate:down");
        createMigration("20230101_a.sql", "-- migrate:up\n-- migrate:down");
        createMigration("20230301_c.sql", "-- migrate:up\n-- migrate:down");

        const files = discoverMigrations(tmpDir);
        expect(files).toHaveLength(3);
        expect(files[0]).toContain("20230101_a.sql");
        expect(files[1]).toContain("20230201_b.sql");
        expect(files[2]).toContain("20230301_c.sql");
    });

    it("ignores non-sql files", () => {
        createMigration("readme.md", "# Not SQL");
        createMigration("20230101_a.sql", "-- migrate:up\n-- migrate:down");

        const files = discoverMigrations(tmpDir);
        expect(files).toHaveLength(1);
    });
});

// ─── extractSchema: CREATE TABLE ────────────────────────────────────────────

describe("extractSchema - CREATE TABLE", () => {
    it("parses a simple CREATE TABLE", () => {
        createMigration("001_create_users.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE
);
-- migrate:down
DROP TABLE users;
`);

        const state = extractSchema(tmpDir);
        expect(state.tables.has("users")).toBe(true);

        const users = state.tables.get("users")!;
        expect(users.columns.has("id")).toBe(true);
        expect(users.columns.has("name")).toBe(true);
        expect(users.columns.has("email")).toBe(true);

        const idCol = users.columns.get("id")!;
        expect(idCol.dataType).toBe("UUID");
        expect(idCol.isPrimaryKey).toBe(true);
        expect(idCol.nullable).toBe(false);

        const emailCol = users.columns.get("email")!;
        expect(emailCol.isUnique).toBe(true);
    });

    it("parses table with DEFAULT values", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE orders (
    id UUID PRIMARY KEY NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' NOT NULL,
    total DECIMAL(10,2) DEFAULT 0
);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const orders = state.tables.get("orders")!;
        const status = orders.columns.get("status")!;
        expect(status.defaultValue).toBe("pending");
    });

    it("parses inline REFERENCES (foreign keys)", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
CREATE TABLE orders (
    id UUID PRIMARY KEY NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL
);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const orders = state.tables.get("orders")!;
        const userId = orders.columns.get("user_id")!;
        expect(userId.references).toBe("users(id)");
    });

    it("parses table-level PRIMARY KEY", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE order_items (
    order_id UUID NOT NULL,
    product_id UUID NOT NULL,
    quantity INT NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const table = state.tables.get("order_items")!;
        expect(table.primaryKey).toContain("order_id");
        expect(table.primaryKey).toContain("product_id");
    });
});

// ─── extractSchema: CREATE TYPE ... AS ENUM ─────────────────────────────────

describe("extractSchema - ENUM", () => {
    it("parses CREATE TYPE AS ENUM", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TYPE order_status AS ENUM ('pending', 'active', 'cancelled');
CREATE TABLE orders (
    id UUID PRIMARY KEY NOT NULL,
    status order_status NOT NULL
);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        expect(state.enums.has("order_status")).toBe(true);
        expect(state.enums.get("order_status")).toEqual(["pending", "active", "cancelled"]);

        const orders = state.tables.get("orders")!;
        const status = orders.columns.get("status")!;
        expect(status.dataType).toBe("ENUM(order_status)");
        expect(status.enumValues).toEqual(["pending", "active", "cancelled"]);
    });
});

// ─── extractSchema: ALTER TABLE ─────────────────────────────────────────────

describe("extractSchema - ALTER TABLE", () => {
    it("handles ADD COLUMN", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE;
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.columns.has("email")).toBe(true);
        expect(users.columns.get("email")!.isUnique).toBe(true);
    });

    it("handles DROP COLUMN", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    temp_col VARCHAR(50)
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
ALTER TABLE users DROP COLUMN temp_col;
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.columns.has("temp_col")).toBe(false);
    });

    it("handles RENAME COLUMN", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    name VARCHAR(255)
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
ALTER TABLE users RENAME COLUMN name TO full_name;
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.columns.has("name")).toBe(false);
        expect(users.columns.has("full_name")).toBe(true);
    });

    it("handles ALTER COLUMN SET NOT NULL", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    email VARCHAR(255)
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.columns.get("email")!.nullable).toBe(false);
    });
});

// ─── extractSchema: DROP TABLE ──────────────────────────────────────────────

describe("extractSchema - DROP TABLE", () => {
    it("removes a table from state", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE temp_table (
    id UUID PRIMARY KEY NOT NULL
);
-- migrate:down
`);
        createMigration("002.sql", `
-- migrate:up
DROP TABLE temp_table;
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        expect(state.tables.has("temp_table")).toBe(false);
    });
});

// ─── extractSchema: CREATE INDEX ────────────────────────────────────────────

describe("extractSchema - CREATE INDEX", () => {
    it("captures indexes on tables", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    email VARCHAR(255)
);
CREATE INDEX ON users (email);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.indexes.length).toBeGreaterThanOrEqual(1);
        expect(users.indexes[0]).toContain("email");
    });

    it("captures UNIQUE indexes", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    email VARCHAR(255)
);
CREATE UNIQUE INDEX idx_email ON users (email);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.indexes[0]).toContain("UNIQUE");
    });
});

// ─── extractSchema: migrate:up section isolation ────────────────────────────

describe("extractSchema - section isolation", () => {
    it("only processes migrate:up section, ignores migrate:down", () => {
        createMigration("001.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL
);
-- migrate:down
DROP TABLE users;
CREATE TABLE should_not_exist (
    id UUID PRIMARY KEY NOT NULL
);
`);

        const state = extractSchema(tmpDir);
        expect(state.tables.has("users")).toBe(true);
        expect(state.tables.has("should_not_exist")).toBe(false);
    });
});

// ─── extractSchema: multiple migrations apply in order ──────────────────────

describe("extractSchema - migration ordering", () => {
    it("applies migrations in chronological order", () => {
        createMigration("20230101_create.sql", `
-- migrate:up
CREATE TABLE users (
    id UUID PRIMARY KEY NOT NULL,
    name VARCHAR(100)
);
-- migrate:down
`);
        createMigration("20230201_modify.sql", `
-- migrate:up
ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL;
-- migrate:down
`);
        createMigration("20230301_index.sql", `
-- migrate:up
CREATE INDEX ON users (email);
-- migrate:down
`);

        const state = extractSchema(tmpDir);
        const users = state.tables.get("users")!;
        expect(users.columns.has("id")).toBe(true);
        expect(users.columns.has("name")).toBe(true);
        expect(users.columns.has("email")).toBe(true);
        expect(users.indexes.length).toBeGreaterThanOrEqual(1);
    });
});
