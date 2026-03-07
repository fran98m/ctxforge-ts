import { describe, it, expect } from "vitest";
import { tokenizeQuery, searchFiles } from "../search";
import * as path from "node:path";

// ─── tokenizeQuery ──────────────────────────────────────────────────────────

describe("tokenizeQuery", () => {
    it("returns empty array for empty string", () => {
        expect(tokenizeQuery("")).toEqual([]);
    });

    it("removes stop words", () => {
        const tokens = tokenizeQuery("the order is in the cart");
        expect(tokens).not.toContain("the");
        expect(tokens).not.toContain("is");
        expect(tokens).not.toContain("in");
    });

    it("lowercases all tokens", () => {
        const tokens = tokenizeQuery("OrderService PaymentGateway");
        for (const t of tokens) {
            expect(t).toBe(t.toLowerCase());
        }
    });

    it("splits camelCase into separate terms", () => {
        const tokens = tokenizeQuery("orderService");
        expect(tokens).toContain("order");
        expect(tokens).toContain("service");
        // also keeps the full compound token
        expect(tokens).toContain("orderservice");
    });

    it("splits snake_case into separate terms", () => {
        const tokens = tokenizeQuery("order_service");
        expect(tokens).toContain("order");
        expect(tokens).toContain("service");
    });

    it("strips -ing suffix (stemming)", () => {
        const tokens = tokenizeQuery("processing");
        expect(tokens).toContain("process");
    });

    it("strips -ies suffix and adds y (stemming)", () => {
        const tokens = tokenizeQuery("deliveries");
        expect(tokens).toContain("delivery");
    });

    it("strips trailing -s (stemming)", () => {
        const tokens = tokenizeQuery("orders");
        expect(tokens).toContain("order");
    });

    it("does not strip -ss endings", () => {
        const tokens = tokenizeQuery("process");
        // "process" should not become "proces"
        expect(tokens).toContain("process");
    });

    it("deduplicates tokens", () => {
        const tokens = tokenizeQuery("order order order");
        const orderCount = tokens.filter(t => t === "order").length;
        expect(orderCount).toBe(1);
    });

    it("filters out single-character tokens", () => {
        const tokens = tokenizeQuery("a b c order");
        expect(tokens.every(t => t.length > 1)).toBe(true);
    });

    it("handles complex mixed queries", () => {
        const tokens = tokenizeQuery("user authentication and session management");
        expect(tokens).toContain("user");
        expect(tokens).toContain("authentication");
        expect(tokens).toContain("session");
        expect(tokens).toContain("management");
        // "and" is a stop word
        expect(tokens).not.toContain("and");
    });
});

// ─── searchFiles ────────────────────────────────────────────────────────────

describe("searchFiles", () => {
    const dummyCodePath = path.resolve(__dirname, "../../dummycode");

    it("returns results for a matching query", () => {
        const results = searchFiles(dummyCodePath, "auth session token", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty array for unrelated query", () => {
        const results = searchFiles(dummyCodePath, "zzz_nonexistent_xyz_12345", 5);
        expect(results).toEqual([]);
    });

    it("respects topK limit", () => {
        const results = searchFiles(dummyCodePath, "auth session", 1);
        expect(results.length).toBeLessThanOrEqual(1);
    });

    it("results have filePath, relPath, and score", () => {
        const results = searchFiles(dummyCodePath, "auth", 5);
        if (results.length > 0) {
            const first = results[0];
            expect(first).toHaveProperty("filePath");
            expect(first).toHaveProperty("relPath");
            expect(first).toHaveProperty("score");
            expect(first.score).toBeGreaterThan(0);
        }
    });

    it("results are sorted by score descending", () => {
        const results = searchFiles(dummyCodePath, "auth session", 10);
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });
});
