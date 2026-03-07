// src/schema.ts
//
// Parses dbmate SQL migrations in order and builds the current schema state.
// Handles: CREATE TABLE, ALTER TABLE (ADD/DROP/MODIFY/RENAME COLUMN),
//          CREATE TYPE ... AS ENUM, CHECK constraints, DROP TABLE.
//
// dbmate format:
//   filename: 20230101120000_create_orders.sql
//   sections: "-- migrate:up" (forward) / "-- migrate:down" (rollback)

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ColumnDef {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue?: string;
    isPrimaryKey: boolean;
    isUnique: boolean;
    enumValues?: string[];   // detected from CHECK or TYPE
    references?: string;     // e.g. "users(id)"
    comment?: string;        // inline SQL comment
}

export interface TableSchema {
    name: string;
    columns: Map<string, ColumnDef>;
    primaryKey: string[];
    indexes: string[];       // raw index definitions
    partitionBy?: string;
    enumTypes: Map<string, string[]>; // type_name -> values (shared across tables)
}

export interface SchemaState {
    tables: Map<string, TableSchema>;
    enums: Map<string, string[]>; // standalone CREATE TYPE enums
}

// ─── Migration File Discovery ────────────────────────────────────────────────

/**
 * Finds all .sql files in a directory, sorted lexicographically.
 * dbmate timestamps (20230101120000_) guarantee correct order.
 */
export function discoverMigrations(migrationsDir: string): string[] {
    if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }

    return fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .sort()  // lexicographic = chronological for dbmate timestamps
        .map(f => path.join(migrationsDir, f));
}

// ─── SQL Section Extractor ───────────────────────────────────────────────────

/**
 * Extracts only the "-- migrate:up" section from a dbmate file.
 * Everything between "-- migrate:up" and "-- migrate:down" (or EOF).
 */
function extractUpSection(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let inUp = false;
    const upLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed === "-- migrate:up") {
            inUp = true;
            continue;
        }
        if (trimmed === "-- migrate:down") {
            break; // stop at rollback section
        }
        if (inUp) {
            upLines.push(line);
        }
    }

    return upLines.join("\n");
}

// ─── SQL Parsers ─────────────────────────────────────────────────────────────

/**
 * Parses a CREATE TYPE ... AS ENUM (...) statement.
 * Handles: CREATE TYPE order_status AS ENUM ('active', 'cancelled', 'pending');
 */
function parseCreateEnum(sql: string, state: SchemaState): boolean {
    const enumRegex = /CREATE\s+TYPE\s+(?:(?:"[^"]+"|[\w.]+)\.)?("?(\w+)"?)\s+AS\s+ENUM\s*\(([^)]+)\)/i;
    const match = sql.match(enumRegex);
    if (!match) return false;

    const typeName = match[2].toLowerCase();
    const values = match[3]
        .split(",")
        .map(v => v.trim().replace(/^'|'$/g, ""))
        .filter(v => v.length > 0);

    state.enums.set(typeName, values);
    return true;
}

/**
 * Parses column definition from inside a CREATE TABLE body.
 * Returns null for non-column lines (constraints, etc.)
 */
function parseColumnDef(line: string, state: SchemaState): ColumnDef | null {
    // Clean up and skip pure constraint lines
    const trimmed = line.trim().replace(/,$/, "");
    const upper = trimmed.toUpperCase();

    // Skip constraint-only lines
    if (upper.startsWith("CONSTRAINT") ||
        upper.startsWith("PRIMARY KEY") ||
        upper.startsWith("UNIQUE") ||
        upper.startsWith("FOREIGN KEY") ||
        upper.startsWith("CHECK") ||
        upper.startsWith("INDEX") ||
        upper.startsWith("EXCLUDE") ||
        trimmed === ")" || trimmed === ");") {
        return null;
    }

    // Match: column_name TYPE [modifiers...]
    // Handle quoted identifiers too: "column_name"
    const colRegex = /^"?(\w+)"?\s+(.+)/;
    const match = trimmed.match(colRegex);
    if (!match) return null;

    const name = match[1].toLowerCase();
    const rest = match[2];

    // Skip if "name" is actually a keyword that starts a constraint
    const nameUpper = name.toUpperCase();
    if (["constraint", "primary", "unique", "foreign", "check", "index", "exclude"].includes(nameUpper.toLowerCase())) {
        return null;
    }

    // Extract the data type (first word or parameterized type like DECIMAL(10,2))
    const typeMatch = rest.match(/^(\w+(?:\s*\([^)]*\))?(?:\s+varying\s*\([^)]*\))?(?:\s+precision)?(?:\[\])?)/i);
    const rawType = typeMatch ? typeMatch[1].toUpperCase() : rest.split(/\s+/)[0].toUpperCase();

    const col: ColumnDef = {
        name,
        dataType: rawType,
        nullable: !upper.includes("NOT NULL"),
        isPrimaryKey: upper.includes("PRIMARY KEY"),
        isUnique: upper.includes("UNIQUE"),
    };

    // Extract DEFAULT value
    const defaultMatch = rest.match(/DEFAULT\s+('(?:[^']*)'|[\w().]+)/i);
    if (defaultMatch) {
        col.defaultValue = defaultMatch[1].replace(/^'|'$/g, "");
    }

    // Extract REFERENCES (inline FK)
    const refMatch = rest.match(/REFERENCES\s+("?\w+"?)\s*\(\s*("?\w+"?)\s*\)/i);
    if (refMatch) {
        col.references = `${refMatch[1].replace(/"/g, "")}(${refMatch[2].replace(/"/g, "")})`;
    }

    // Detect enum values from inline CHECK constraint
    // e.g., CHECK (status IN ('active', 'cancelled'))
    const checkMatch = rest.match(/CHECK\s*\(\s*\w+\s+IN\s*\(([^)]+)\)\s*\)/i);
    if (checkMatch) {
        col.enumValues = checkMatch[1]
            .split(",")
            .map(v => v.trim().replace(/^'|'$/g, ""))
            .filter(v => v.length > 0);
    }

    // Detect if column type references a known enum
    const typeClean = rawType.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (state.enums.has(typeClean)) {
        col.enumValues = state.enums.get(typeClean);
        col.dataType = `ENUM(${typeClean})`; // normalize for output
    }

    // Extract inline SQL comment: -- comment text
    const commentMatch = rest.match(/--\s*(.+)$/);
    if (commentMatch) {
        col.comment = commentMatch[1].trim();
    }

    return col;
}

/**
 * Parses CREATE TABLE, including column defs, PKs, and table-level constraints.
 */
function parseCreateTable(sql: string, state: SchemaState): boolean {
    // Match CREATE TABLE (optional IF NOT EXISTS, optional schema prefix)
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[\w]+)\.)?("?(\w+)"?)\s*\(([\s\S]*)\)/i;
    const match = sql.match(tableRegex);
    if (!match) return false;

    const tableName = match[2].toLowerCase();
    const body = match[3];

    const table: TableSchema = {
        name: tableName,
        columns: new Map(),
        primaryKey: [],
        indexes: [],
        enumTypes: new Map(),
    };

    // Split body into lines, respecting that some columns span multiple lines
    const lines = body.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    for (const line of lines) {
        const upper = line.toUpperCase().replace(/,$/, "").trim();

        // Table-level PRIMARY KEY
        const pkMatch = upper.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/);
        if (pkMatch) {
            table.primaryKey = pkMatch[1]
                .split(",")
                .map(c => c.trim().replace(/"/g, "").toLowerCase());
            continue;
        }

        // Table-level CHECK constraint (for enum detection)
        const checkMatch = line.match(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]+)\)\s*\)/i);
        if (checkMatch) {
            const colName = checkMatch[1].toLowerCase();
            const values = checkMatch[2]
                .split(",")
                .map(v => v.trim().replace(/^'|'$/g, ""))
                .filter(v => v.length > 0);
            const col = table.columns.get(colName);
            if (col) col.enumValues = values;
            continue;
        }

        // Column definition
        const col = parseColumnDef(line, state);
        if (col) {
            table.columns.set(col.name, col);
            if (col.isPrimaryKey) table.primaryKey.push(col.name);
        }
    }

    // Detect PARTITION BY (outside the column body)
    const partitionMatch = sql.match(/PARTITION\s+BY\s+(\w+\s*\([^)]+\))/i);
    if (partitionMatch) {
        table.partitionBy = partitionMatch[1];
    }

    state.tables.set(tableName, table);
    return true;
}

/**
 * Handles ALTER TABLE statements:
 *   ADD COLUMN, DROP COLUMN, ALTER COLUMN / MODIFY COLUMN,
 *   RENAME COLUMN, ADD CONSTRAINT, SET DEFAULT, etc.
 */
function parseAlterTable(sql: string, state: SchemaState): boolean {
    const alterRegex = /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS\s+)?(?:(?:"[^"]+"|[\w]+)\.)?)?("?(\w+)"?)\s+([\s\S]+)/i;
    const match = sql.match(alterRegex);
    if (!match) return false;

    const tableName = match[2].toLowerCase();
    const action = match[3].trim();
    const table = state.tables.get(tableName);
    if (!table) return false; // table not yet created, skip

    const upper = action.toUpperCase();

    // ADD COLUMN
    if (upper.startsWith("ADD COLUMN") || upper.match(/^ADD\s+"?\w+"?\s+\w/)) {
        const colText = action.replace(/^ADD\s+(?:COLUMN\s+)?/i, "");
        const col = parseColumnDef(colText, state);
        if (col) {
            table.columns.set(col.name, col);
        }
        return true;
    }

    // DROP COLUMN
    if (upper.startsWith("DROP COLUMN") || upper.match(/^DROP\s+"?\w+"?\s*[;,]?$/)) {
        const dropMatch = action.match(/DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/i);
        if (dropMatch) {
            table.columns.delete(dropMatch[1].toLowerCase());
        }
        return true;
    }

    // RENAME COLUMN
    if (upper.includes("RENAME COLUMN") || upper.includes("RENAME")) {
        const renameMatch = action.match(/RENAME\s+(?:COLUMN\s+)?"?(\w+)"?\s+TO\s+"?(\w+)"?/i);
        if (renameMatch) {
            const oldName = renameMatch[1].toLowerCase();
            const newName = renameMatch[2].toLowerCase();
            const col = table.columns.get(oldName);
            if (col) {
                col.name = newName;
                table.columns.delete(oldName);
                table.columns.set(newName, col);
            }
        }
        return true;
    }

    // ALTER COLUMN / MODIFY COLUMN (type change, nullability, default)
    if (upper.startsWith("ALTER COLUMN") || upper.startsWith("MODIFY COLUMN") || upper.startsWith("MODIFY ")) {
        const modMatch = action.match(/(?:ALTER|MODIFY)\s+(?:COLUMN\s+)?"?(\w+)"?\s+([\s\S]+)/i);
        if (modMatch) {
            const colName = modMatch[1].toLowerCase();
            const modification = modMatch[2].trim().toUpperCase();
            const col = table.columns.get(colName);
            if (col) {
                // SET NOT NULL / DROP NOT NULL
                if (modification.includes("SET NOT NULL")) col.nullable = false;
                if (modification.includes("DROP NOT NULL")) col.nullable = true;

                // SET DEFAULT / DROP DEFAULT
                const defMatch = modMatch[2].match(/SET\s+DEFAULT\s+('(?:[^']*)'|[\w().]+)/i);
                if (defMatch) col.defaultValue = defMatch[1].replace(/^'|'$/g, "");
                if (modification.includes("DROP DEFAULT")) col.defaultValue = undefined;

                // TYPE change
                const typeMatch = modMatch[2].match(/(?:SET\s+DATA\s+)?TYPE\s+(\w+(?:\s*\([^)]*\))?)/i);
                if (typeMatch) col.dataType = typeMatch[1].toUpperCase();
            }
        }
        return true;
    }

    // ADD CONSTRAINT (for enum CHECK constraints added later)
    if (upper.startsWith("ADD CONSTRAINT")) {
        const checkMatch = action.match(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]+)\)\s*\)/i);
        if (checkMatch) {
            const colName = checkMatch[1].toLowerCase();
            const values = checkMatch[2]
                .split(",")
                .map(v => v.trim().replace(/^'|'$/g, ""))
                .filter(v => v.length > 0);
            const col = table.columns.get(colName);
            if (col) col.enumValues = values;
        }
        return true;
    }

    return false;
}

/**
 * Handles DROP TABLE.
 */
function parseDropTable(sql: string, state: SchemaState): boolean {
    const dropRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(?:"[^"]+"|[\w]+)\.)?("?(\w+)"?)/i;
    const match = sql.match(dropRegex);
    if (!match) return false;

    state.tables.delete(match[2].toLowerCase());
    return true;
}

// ─── CREATE INDEX parser (bonus: captures indexes) ───────────────────────────

function parseCreateIndex(sql: string, state: SchemaState): boolean {
    const idxRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\s+)?ON\s+(?:(?:"[^"]+"|[\w]+)\.)?("?(\w+)"?)\s*\(([^)]+)\)/i;
    const match = sql.match(idxRegex);
    if (!match) return false;

    const tableName = match[2].toLowerCase();
    const table = state.tables.get(tableName);
    if (table) {
        const cols = match[3].split(",").map(c => c.trim().replace(/"/g, "").toLowerCase());
        const isUnique = sql.toUpperCase().includes("UNIQUE INDEX");
        table.indexes.push(`${isUnique ? "UNIQUE " : ""}(${cols.join(", ")})`);
    }
    return true;
}

// ─── COMMENT ON parser (captures column/table comments) ──────────────────────

function parseComment(sql: string, state: SchemaState): boolean {
    // COMMENT ON COLUMN table.column IS 'text';
    const colComment = sql.match(/COMMENT\s+ON\s+COLUMN\s+(?:(?:"[^"]+"|[\w]+)\.)?("?\w+"?)\.("?\w+"?)\s+IS\s+'([^']*)'/i);
    if (colComment) {
        const tableName = colComment[1].replace(/"/g, "").toLowerCase();
        const colName = colComment[2].replace(/"/g, "").toLowerCase();
        const table = state.tables.get(tableName);
        if (table) {
            const col = table.columns.get(colName);
            if (col) col.comment = colComment[3];
        }
        return true;
    }
    return false;
}

// ─── Main Replay Engine ──────────────────────────────────────────────────────

/**
 * Splits a SQL section into individual statements.
 * Handles semicolons as delimiters, ignoring those inside strings/parens.
 */
function splitStatements(sql: string): string[] {
    // Simple split on semicolons that aren't inside single quotes
    const statements: string[] = [];
    let current = "";
    let inString = false;

    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];
        if (char === "'" && sql[i - 1] !== "\\") {
            inString = !inString;
        }
        if (char === ";" && !inString) {
            const stmt = current.trim();
            if (stmt.length > 0) statements.push(stmt);
            current = "";
        } else {
            current += char;
        }
    }
    const last = current.trim();
    if (last.length > 0) statements.push(last);

    return statements;
}

/**
 * Main entry: reads all migrations, replays them, returns final schema state.
 */
export function extractSchema(migrationsDir: string): SchemaState {
    const state: SchemaState = {
        tables: new Map(),
        enums: new Map(),
    };

    const migrationFiles = discoverMigrations(migrationsDir);
    console.log(`\n# Found ${migrationFiles.length} migration files in: ${migrationsDir}`);

    for (const filePath of migrationFiles) {
        const upSQL = extractUpSection(filePath);
        const statements = splitStatements(upSQL);
        const fileName = path.basename(filePath);

        for (const stmt of statements) {
            // Strip SQL comments (but preserve inline -- comments on column defs)
            const cleaned = stmt.replace(/^--.*$/gm, "").trim();
            if (!cleaned) continue;

            // Try each parser in order of specificity
            parseCreateEnum(cleaned, state) ||
            parseDropTable(cleaned, state) ||
            parseCreateTable(cleaned, state) ||
            parseAlterTable(cleaned, state) ||
            parseCreateIndex(cleaned, state) ||
            parseComment(cleaned, state);
            // Unknown statements are silently skipped (INSERT, GRANT, etc.)
        }
    }

    console.log(`# Schema state: ${state.tables.size} tables, ${state.enums.size} enum types`);
    return state;
}

// ─── Debug / Standalone ──────────────────────────────────────────────────────

export function printSchemaState(state: SchemaState): void {
    for (const [name, table] of state.tables) {
        console.log(`\nTable: ${name}`);
        if (table.primaryKey.length > 0) console.log(`  PK: [${table.primaryKey.join(", ")}]`);
        if (table.partitionBy) console.log(`  Partition: ${table.partitionBy}`);
        for (const [_, col] of table.columns) {
            let line = `  ${col.name}: ${col.dataType}`;
            if (!col.nullable) line += ", NOT NULL";
            if (col.defaultValue) line += `, DEFAULT ${col.defaultValue}`;
            if (col.references) line += `, FK -> ${col.references}`;
            if (col.enumValues) line += ` [${col.enumValues.join(" | ")}]`;
            if (col.comment) line += ` # ${col.comment}`;
            console.log(line);
        }
        if (table.indexes.length > 0) {
            console.log(`  Indexes: ${table.indexes.join(", ")}`);
        }
    }
}
