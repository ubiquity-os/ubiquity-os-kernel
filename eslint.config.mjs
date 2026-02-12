// @ts-check
import tsEslint from "typescript-eslint";
import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import checkFile from "eslint-plugin-check-file";

export default tsEslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/*.js",
      "jest.config.ts",
      ".husky/**",
      "lib/**",
      "!lib/plugins/",
      "!lib/plugins/hello-world-plugin/**",
      "docs/**",
      // Whitelist: src, scripts, tests, lib/plugins/hello-world-plugin
      // Everything else should be ignored
      ".*",
      "*.config.*",
      "*.json",
      "*.md",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsEslint.plugin,
      "check-file": checkFile,
    },
    extends: [eslint.configs.recommended, ...tsEslint.configs.recommended, sonarjs.configs.recommended],
    languageOptions: {
      parser: tsEslint.parser,
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
      },
    },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        {
          "**/*.{js,ts}": "+([-.a-z0-9])",
        },
      ],
      "prefer-arrow-callback": [
        "warn",
        {
          allowNamedFunctions: true,
        },
      ],
      "func-style": [
        "warn",
        "declaration",
        {
          allowArrowFunctions: false,
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "constructor-super": "error",
      "no-invalid-this": "off",
      "@typescript-eslint/no-invalid-this": ["error"],
      "no-restricted-syntax": ["error", "ForInStatement"],
      "use-isnan": "error",
      "no-unneeded-ternary": "error",
      "no-nested-ternary": "error",
      "max-lines": ["error", { max: 1000 }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          ignoreRestSiblings: true,
          vars: "all",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/restrict-plus-operands": "error",
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-collection-size-mischeck": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-element-overwrite": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "interface",
          format: ["StrictPascalCase"],
          custom: {
            regex: "^I[A-Z]",
            match: false,
          },
        },
        {
          selector: "memberLike",
          modifiers: ["private"],
          format: ["strictCamelCase"],
          leadingUnderscore: "require",
        },
        {
          selector: "typeLike",
          format: ["StrictPascalCase"],
        },
        {
          selector: "typeParameter",
          format: ["StrictPascalCase"],
          prefix: ["T"],
        },
        {
          selector: "variable",
          modifiers: ["const"],
          format: ["strictCamelCase", "UPPER_CASE", "snake_case"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "variable",
          format: ["strictCamelCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "variable",
          modifiers: ["destructured"],
          format: null,
        },
        {
          selector: "variable",
          types: ["boolean"],
          format: ["StrictPascalCase"],
          prefix: [
            "is",
            "should",
            "has",
            "can",
            "did",
            "will",
            "does",
            "use",
            "allow",
            "enable",
            "disable",
            "show",
            "hide",
            "include",
            "exclude",
            "require",
            "skip",
            "force",
            "auto",
            "need",
          ],
        },
        {
          selector: "variableLike",
          format: ["strictCamelCase"],
        },
        {
          selector: ["function", "variable"],
          format: ["strictCamelCase"],
        },
      ],
    },
  }
);
