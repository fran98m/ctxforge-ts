import { describe, it, expect } from "vitest";
import { extractFromFile } from "../fetcher";
import { Project } from "ts-morph";
import * as path from "node:path";

// ─── extractFromFile ────────────────────────────────────────────────────────

describe("extractFromFile", () => {
    const dummyPath = path.resolve(__dirname, "../../dummycode/auth.ts");

    function getSourceFile() {
        const project = new Project();
        return project.addSourceFileAtPath(dummyPath);
    }

    it("extracts interface signatures", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        expect(output).toContain("Session");
        expect(output).toContain("userId");
        expect(output).toContain("token");
        expect(output).toContain("expiresAt");
    });

    it("extracts class name and methods", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        expect(output).toContain("class AuthService");
        expect(output).toContain("validateToken");
    });

    it("extracts arrow function signatures", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        expect(output).toContain("loginUser");
    });

    it("includes method parameters and return types", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        // validateToken(token: string, bypassCache: boolean = false): Promise<Session | null>
        expect(output).toContain("token: string");
        expect(output).toContain("Promise");
    });

    it("strips function bodies (only signatures)", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        // The actual implementation detail should be stripped
        expect(output).not.toContain("Implementation details we want to strip out");
        expect(output).not.toContain("More implementation details");
    });

    it("includes file path in output", () => {
        const sf = getSourceFile();
        const output = extractFromFile(sf);
        expect(output).toContain("auth.ts");
    });
});

// ─── extractFromFile with inline project ────────────────────────────────────

describe("extractFromFile - inline source", () => {
    it("handles a file with only functions", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sf = project.createSourceFile("utils.ts", `
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(x: number, y: number): number {
    return x * y;
}
`);
        const output = extractFromFile(sf);
        expect(output).toContain("add(a: number, b: number): number");
        expect(output).toContain("multiply(x: number, y: number): number");
    });

    it("handles a file with no exportable structure", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sf = project.createSourceFile("empty.ts", `
const x = 42;
console.log(x);
`);
        const output = extractFromFile(sf);
        // Should still have the file path header but minimal content
        expect(output).toContain("empty.ts");
    });

    it("handles a file with interfaces only", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sf = project.createSourceFile("types.ts", `
export interface User {
    id: string;
    name: string;
    age: number;
}

export interface Product {
    sku: string;
    price: number;
}
`);
        const output = extractFromFile(sf);
        expect(output).toContain("interface User");
        expect(output).toContain("interface Product");
        expect(output).toContain("id: string");
        expect(output).toContain("sku: string");
    });
});
