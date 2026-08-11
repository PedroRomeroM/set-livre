import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const serverBoundaryImports = new Set(["pg", "server-only"]);

function isVisualBoundaryPath(filename) {
  const normalizedFilename = filename.replaceAll("\\", "/");
  return (
    /(?:^|\/)components(?:\/|$)/.test(normalizedFilename) ||
    /(?:^|\/)packages\/ui(?:\/|$)/.test(normalizedFilename)
  );
}

function isClientBoundary(sourceCode) {
  return sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      (statement.directive === "use client" ||
        (statement.expression.type === "Literal" && statement.expression.value === "use client")),
  );
}

function isRestrictedBoundaryImport(moduleName) {
  const normalizedModuleName = moduleName.replaceAll("\\", "/");
  return (
    [...serverBoundaryImports].some(
      (packageName) =>
        normalizedModuleName === packageName || normalizedModuleName.startsWith(`${packageName}/`),
    ) || /(?:^|\/)server(?:\/|$)/.test(normalizedModuleName)
  );
}

const visualBoundaryPlugin = {
  rules: {
    "no-server-imports": {
      meta: {
        type: "problem",
        docs: {
          description: "Impede imports server-only em Client Components e bordas visuais.",
        },
        schema: [],
        messages: {
          restricted:
            'A borda visual não pode importar "{{moduleName}}"; mova o acesso server-only para uma fronteira de leitura/comando.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        if (!isClientBoundary(sourceCode) && !isVisualBoundaryPath(context.filename)) {
          return {};
        }

        function checkImport(node, source) {
          if (typeof source.value !== "string" || !isRestrictedBoundaryImport(source.value)) {
            return;
          }
          context.report({
            node,
            messageId: "restricted",
            data: { moduleName: source.value },
          });
        }

        return {
          ExportAllDeclaration(node) {
            checkImport(node, node.source);
          },
          ExportNamedDeclaration(node) {
            if (node.source !== null) {
              checkImport(node, node.source);
            }
          },
          ImportDeclaration(node) {
            checkImport(node, node.source);
          },
          ImportExpression(node) {
            checkImport(node, node.source);
          },
        };
      },
    },
  },
};

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "no-console": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "set-livre-boundaries": visualBoundaryPlugin,
    },
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.tests.json",
          "./apps/backoffice/tsconfig.json",
          "./packages/contracts/tsconfig.json",
          "./packages/ui/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "set-livre-boundaries/no-server-imports": "error",
    },
  },
  globalIgnores([
    ".next/**",
    "apps/*/.next/**",
    ".artifacts/**",
    "**/next-env.d.ts",
    "coverage/**",
    "node_modules/**",
    "supabase/.branches/**",
    "supabase/.temp/**",
    "supabase/schema.generated.sql",
  ]),
]);
