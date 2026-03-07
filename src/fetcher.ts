// src/fetcher.ts
import { Project, Node, ClassDeclaration, FunctionDeclaration, MethodDeclaration, VariableDeclaration, SourceFile } from "ts-morph";
import * as path from "node:path";

/**
 * Equivalent to Python's _build_signature
 * Extracts just the signature without the body blocks.
 */
function buildSignature(name: string, node: FunctionDeclaration | MethodDeclaration | VariableDeclaration): string {
    // Unlike Python ast, ts-morph lets us query parameters directly!
    let params = "";
    let returnType = "any";

    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
        params = node.getParameters().map(p => p.getText()).join(", ");
        returnType = node.getReturnTypeNode()?.getText() || "void"; 
    } else if (Node.isVariableDeclaration(node)) {
        // Handle arrow functions: const foo = (args) => { ... }
        const initializer = node.getInitializer();
        if (Node.isArrowFunction(initializer)) {
            params = initializer.getParameters().map(p => p.getText()).join(", ");
            returnType = initializer.getReturnTypeNode()?.getText() || "void";
        }
    }

    return `${name}(${params}): ${returnType}`;
}

/**
 * Extracts signatures from a single SourceFile (Equivalent to Python's extract_from_file)
 */
export function extractFromFile(sourceFile: SourceFile): string {
    let output = `\n# --- ${sourceFile.getFilePath()} ---\n`;

    sourceFile.getInterfaces().forEach(iface => {
        output += iface.getText() + "\n\n";
    });

    sourceFile.getClasses().forEach(cls => {
        output += `class ${cls.getName()} {\n`;
        cls.getMethods().forEach(method => {
            const jsDocs = method.getJsDocs().map(doc => `  ${doc.getText()}`).join("\n");
            if (jsDocs) output += jsDocs + "\n";
            
            const signature = buildSignature(method.getName(), method);
            const modifiers = method.getModifiers().map(m => m.getText()).join(" ");
            output += `  ${modifiers} ${signature};\n`;
        });
        output += `}\n\n`;
    });

    sourceFile.getFunctions().forEach(func => {
        const name = func.getName() || "anonymous";
        output += `function ${buildSignature(name, func)};\n`;
    });

    sourceFile.getVariableDeclarations().forEach(varDecl => {
        const initializer = varDecl.getInitializer();
        if (Node.isArrowFunction(initializer)) {
            output += `const ${buildSignature(varDecl.getName(), varDecl)};\n`;
        }
    });

    return output;
}

// CLI Entrypoint (Equivalent to if __name__ == "__main__": in Python)
//const targetDir = process.argv[2] || "/home/fran98m/Documents/Instaleap/havok";
//extractFromDirectory(targetDir);
