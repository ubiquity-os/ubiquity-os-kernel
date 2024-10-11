// @ts-check
import tsEslint from "typescript-eslint";
import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import checkFile from "eslint-plugin-check-file";

export default tsEslint.config({
  plugins: {
    "@typescript-eslint": tsEslint.plugin,
    "check-file": checkFile,
  },
  ignores: [".github/knip.ts", "**/.wrangler/**", "jest.config.ts", ".husky/**"],
  extends: [eslint.configs.recommended, ...tsEslint.configs.recommended, sonarjs.configs.recommended],
  languageOptions: {
    parser: tsEslint.parser,
    parserOptions: {
      project: ["./tsconfig.json"],
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
        format: ["strictCamelCase", "UPPER_CASE"],
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
        prefix: ["is", "should", "has", "can", "did", "will", "does"],
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
});
