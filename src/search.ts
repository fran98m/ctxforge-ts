// src/search.ts
import { Project, SourceFile, Node, SyntaxKind } from "ts-morph";
import * as path from "node:path";

// 1. Stop words (Same as your Python list)
const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "in", "on", "at", "to",
    "for", "of", "with", "by", "from", "as", "and", "or", "if", "while", "this",
    "that", "it", "feature", "implement", "add", "want", "create", "make"
]);

/**
 * Equivalent to Python's tokenize_query()
 */
export function tokenizeQuery(query: string): string[] {
    // Split on non-alphanumeric (keeping case for camelCase detection)
    const rawTokens = query.split(/[^a-zA-Z0-9_]+/);
    const uniqueTokens = new Set<string>();

    for (const rawToken of rawTokens) {
        if (!rawToken) continue;

        // Split camelCase BEFORE lowercasing, then snake_case
        const parts = rawToken.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").split(" ");
        for (const part of parts) {
            const p = part.toLowerCase();
            if (p.length > 1 && !STOP_WORDS.has(p)) uniqueTokens.add(p);
        }
        // Also add the full token (lowercased) for compound matching
        const full = rawToken.toLowerCase();
        if (full.length > 1 && !STOP_WORDS.has(full)) uniqueTokens.add(full);
    }

    // Basic suffix stripping (stemming) just like the Python version
    const stemmed = Array.from(uniqueTokens).map(t => {
        if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
        if (t.endsWith("ies") && t.length > 5) return t.slice(0, -3) + "y";
        if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss")) return t.slice(0, -1);
        return t;
    });

    return Array.from(new Set(stemmed));
}

/**
 * Equivalent to Python's extract_searchable_surface + score_file
 */
function scoreFile(sourceFile: SourceFile, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0.0;

    let score = 0.0;
    
    // 1. Filename terms (Weight: 5.0)
    const fileName = sourceFile.getBaseNameWithoutExtension().toLowerCase();
    
    // 2. Identifiers (Classes, Interfaces, Functions, Enums, TypeAliases) (Weight: 3.0)
    const identifiers: string[] = [];
    sourceFile.getClasses().forEach(c => identifiers.push(c.getName() || ""));
    sourceFile.getInterfaces().forEach(i => identifiers.push(i.getName() || ""));
    sourceFile.getFunctions().forEach(f => identifiers.push(f.getName() || ""));
    sourceFile.getEnums().forEach(e => identifiers.push(e.getName() || ""));
    sourceFile.getTypeAliases().forEach(t => identifiers.push(t.getName() || ""));
    
    const identifierBlob = identifiers.join(" ").toLowerCase();

    // 3. JSDoc Comments (Weight: 2.0)
    // We grab all JSDoc blocks in the file
    const jsDocs = sourceFile.getDescendantsOfKind(SyntaxKind.JSDoc)
        .map(doc => doc.getText()).join(" ").toLowerCase();

    for (const term of queryTerms) {
        if (fileName.includes(term)) score += 5.0;
        if (identifierBlob.includes(term)) score += 3.0;
        if (jsDocs.includes(term)) score += 2.0;
    }

    return score;
}

/**
 * Search pipeline (Equivalent to Python's search_files)
 */
export function searchFiles(targetPath: string, query: string, topK: number = 5) {
    const project = new Project();
    project.addSourceFilesAtPaths(path.join(targetPath, "**/*.ts"));
    const sourceFiles = project.getSourceFiles();

    const queryTerms = tokenizeQuery(query);
    console.log(`\n# Query Terms: [${queryTerms.join(", ")}]`);

    const fileScores = new Map<SourceFile, number>();

    // Phase 1: Score all files directly
    for (const file of sourceFiles) {
        // Skip tests for relevancy matching unless explicitly asked, just like Python
        if (file.getFilePath().includes(".test.ts") || file.getFilePath().includes(".spec.ts")) {
            continue; 
        }

        const score = scoreFile(file, queryTerms);
        if (score > 0) {
            fileScores.set(file, score);
        }
    }

// Phase 2: Bidirectional Import Graph Propagation
    const propagatedScores = new Map<SourceFile, number>();
    const boostDown = 0.2; // Importer boosts Imported (helper functions)
    const boostUp = 0.4;   // Imported boosts Importer (consumers of core models)

    // We must iterate over ALL source files to catch low-scoring files that import high-scoring ones
    for (const file of sourceFiles) {
        if (file.getFilePath().includes(".test.ts") || file.getFilePath().includes(".spec.ts")) {
            continue; 
        }

    const imports = file.getImportDeclarations();
        for (const imp of imports) {
            const importedFile = imp.getModuleSpecifierSourceFile(); 
            if (!importedFile) continue;

            // 1. Flow DOWN (Consumer -> Dependency)
            const importerScore = fileScores.get(file) || 0;
            if (importerScore > 0) {
                const current = propagatedScores.get(importedFile) || 0;
                propagatedScores.set(importedFile, current + (importerScore * boostDown));
            }

            // 2. Flow UP (Dependency -> Consumer) - THIS FIXES THE "MISSING 10%"
            const importedScore = fileScores.get(importedFile) || 0;
            if (importedScore > 0) {
                const current = propagatedScores.get(file) || 0;
                propagatedScores.set(file, current + (importedScore * boostUp));
            }
        }
    }

    // Apply propagated boosts
    for (const [file, boost] of propagatedScores.entries()) {
        const currentScore = fileScores.get(file) || 0;
        fileScores.set(file, currentScore + boost);
    }

    // Phase 3: Sort and return Top K
    const rankedFiles = Array.from(fileScores.entries())
        .sort((a, b) => b[1] - a[1]) // Sort descending
        .slice(0, topK);

    console.log(`\n# Top ${rankedFiles.length} Relevant Files:\n`);
    for (const [file, score] of rankedFiles) {
        // We get the relative path for cleaner output
        const relPath = path.relative(targetPath, file.getFilePath());
        console.log(`[Score: ${score.toFixed(2)}] -> ${relPath}`);
    }
    
    // RETURN the data instead of just logging it!
    return rankedFiles.map(([file, score]) => ({
        filePath: file.getFilePath(),
        relPath: path.relative(targetPath, file.getFilePath()),
        score
    }));
}

// CLI Entrypoint
//const targetDir = process.argv[2];
//const query = process.argv[3];

//if (!targetDir || !query) {
//    console.error("Usage: npm run search <path> <query>");
//    process.exit(1);
//}

//searchFiles(targetDir, query);
