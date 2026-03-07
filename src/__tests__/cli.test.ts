import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(__dirname, "../..");
const CLI = `npx tsx ${path.join(ROOT, "src/cli.ts")}`;
const DUMMY_CODE = path.join(ROOT, "dummycode");
const RESULTS_DIR = path.join(ROOT, "results");

function run(args: string): string {
    try {
        return execSync(`${CLI} ${args}`, {
            cwd: ROOT,
            encoding: "utf-8",
            timeout: 30000,
        });
    } catch (e: any) {
        // Return stderr+stdout even on non-zero exit
        return (e.stdout || "") + (e.stderr || "");
    }
}

/** Find the most recently created file in results/ matching a prefix and date pattern */
function latestResult(prefix: string, ext: string): string | undefined {
    if (!fs.existsSync(RESULTS_DIR)) return undefined;
    // Match files like prefix_YYYYMMDD_HHmmss.ext or prefix_slug_YYYYMMDD_HHmmss.ext
    const pattern = new RegExp(`^${prefix}.*\\d{8}_\\d{6}\\.${ext}$`);
    const files = fs.readdirSync(RESULTS_DIR)
        .filter(f => pattern.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files[0] ? path.join(RESULTS_DIR, files[0].name) : undefined;
}

// ─── CLI Help / Usage ───────────────────────────────────────────────────────

describe("CLI - usage", () => {
    it("prints usage on no arguments", () => {
        const output = run("");
        expect(output).toContain("CONTEXT BUILDER CLI");
    });

    it("prints usage on unknown command", () => {
        const output = run("nonexistent");
        expect(output).toContain("CONTEXT BUILDER CLI");
    });
});

// ─── CLI - full command ─────────────────────────────────────────────────────

describe("CLI - full command", () => {
    it("full <code> --all dumps all code to results/", () => {
        const output = run(`full ${DUMMY_CODE} --all`);
        expect(output).toContain("FULL REPO DUMP");
        expect(output).toContain("Code:   FULL DUMP");
        expect(output).toContain("Schema: SKIPPED");
        expect(output).toContain("results/");

        const bundle = latestResult("context_bundle", "yml");
        expect(bundle).toBeDefined();
        const content = fs.readFileSync(bundle!, "utf-8");
        expect(content).toContain("code:");
        expect(content).toContain("AuthService");
    });

    it("full <code> <query> saves with query slug in filename", () => {
        const output = run(`full ${DUMMY_CODE} "auth session"`);
        expect(output).toContain('Query: "auth session"');
        expect(output).toContain("results/");
        expect(output).toContain("auth_session");
    });

    it("full <code> requires query without --all", () => {
        const output = run(`full ${DUMMY_CODE}`);
        expect(output).toContain("query is required");
    });
});

// ─── CLI - dump command ─────────────────────────────────────────────────────

describe("CLI - dump command", () => {
    it("dump <code> saves to results/", () => {
        const output = run(`dump ${DUMMY_CODE}`);
        expect(output).toContain("FULL DUMP");
        expect(output).toContain("results/");

        const bundle = latestResult("context_bundle_dump", "yml");
        expect(bundle).toBeDefined();
        const content = fs.readFileSync(bundle!, "utf-8");
        expect(content).toContain("code:");
    });
});

// ─── CLI - context command ──────────────────────────────────────────────────

describe("CLI - context command", () => {
    it("context <code> <query> saves to results/", () => {
        const output = run(`context ${DUMMY_CODE} "auth session"`);
        expect(output).toContain("Saved to:");
        expect(output).toContain("results/");
    });

    it("context with no args prints usage", () => {
        const output = run("context");
        expect(output).toContain("CONTEXT BUILDER CLI");
    });
});

// ─── CLI - map command ──────────────────────────────────────────────────────

describe("CLI - map command", () => {
    it("map <code> saves to results/", () => {
        const output = run(`map ${DUMMY_CODE}`);
        expect(output).toContain("Saved to:");
        expect(output).toContain("results/");

        const mapFile = latestResult("domain_map", "txt");
        expect(mapFile).toBeDefined();
        const content = fs.readFileSync(mapFile!, "utf-8");
        expect(content).toContain("AuthService");
    });
});

// ─── CLI - tokens command ───────────────────────────────────────────────────

describe("CLI - tokens command", () => {
    it("analyzes a file's token usage", () => {
        // Use any result file that exists
        const bundle = latestResult("context_bundle", "yml");
        const target = bundle || path.join(ROOT, "context_bundle.yml");
        if (!fs.existsSync(target)) {
            fs.writeFileSync(target, "code:\\n  test: value\\n", "utf-8");
        }
        const output = run(`tokens ${target}`);
        expect(output).toContain("TOKEN USAGE REPORT");
    });

    it("errors on non-existent file", () => {
        const output = run("tokens /nonexistent/file.yml");
        expect(output).toContain("File not found");
    });
});
