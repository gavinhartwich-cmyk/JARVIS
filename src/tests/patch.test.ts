import { describe, expect, test } from "bun:test";
import { findDisallowedImports, parseFileBlocks } from "../phase1/patch";

describe("findDisallowedImports", () => {
  const allowed = new Set(["fs", "path", "uuid", "pg"]);

  test("flags a bare import for a package not in the allowed set", () => {
    const files = new Map([
      ["src/utils/greet.ts", `import { Injectable } from '@angular/core';\n`],
    ]);
    const errors = findDisallowedImports(files, allowed);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("@angular/core");
    expect(errors[0]).toContain("src/utils/greet.ts");
  });

  test("allows relative imports, node builtins, and declared dependencies", () => {
    const files = new Map([
      [
        "src/utils/greet.ts",
        `import fs from "fs";\nimport { v4 } from "uuid";\nimport { helper } from "./helper";\nimport local from "/abs/path";\n`,
      ],
    ]);
    expect(findDisallowedImports(files, allowed)).toEqual([]);
  });

  test("resolves scoped and subpath specifiers to their root package", () => {
    const allowedScoped = new Set(["@scope/pkg", "lodash"]);
    const files = new Map([
      ["a.ts", `import x from "@scope/pkg/subpath";\nimport y from "lodash/fp";\n`],
    ]);
    expect(findDisallowedImports(files, allowedScoped)).toEqual([]);
  });

  test("flags require() calls the same way as ES imports", () => {
    const files = new Map([["a.ts", `const x = require("express");\n`]]);
    const errors = findDisallowedImports(files, allowed);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("express");
  });
});

describe("parseFileBlocks", () => {
  test("parses a plain ===FILE=== block", () => {
    const text = `===FILE: src/a.ts===\nexport const x = 1;\n===END FILE===`;
    const blocks = parseFileBlocks(text);
    expect(blocks.length).toBe(1);
    expect(blocks[0].path).toBe("src/a.ts");
    expect(blocks[0].content).toBe("export const x = 1;");
  });

  test("unwraps a response the model wrapped in an extra JSON content envelope", () => {
    const inner = "===FILE: src/a.ts===\nexport const x = 1;\n===END FILE===";
    const wrapped = JSON.stringify({ content: inner, confidence: 0.9 });
    const blocks = parseFileBlocks(wrapped);
    expect(blocks.length).toBe(1);
    expect(blocks[0].path).toBe("src/a.ts");
    expect(blocks[0].content).toBe("export const x = 1;");
  });

  test("unwraps two levels of nested JSON content envelopes", () => {
    const inner = "===FILE: src/a.ts===\nexport const x = 1;\n===END FILE===";
    const wrappedOnce = JSON.stringify({ content: inner });
    const wrappedTwice = JSON.stringify({ content: wrappedOnce, confidence: 0.5 });
    const blocks = parseFileBlocks(wrappedTwice);
    expect(blocks.length).toBe(1);
    expect(blocks[0].path).toBe("src/a.ts");
  });
});
