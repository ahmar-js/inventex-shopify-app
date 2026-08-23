import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import ts from "typescript";

const source = await readFile(
  new URL("../app/services/collection-sort.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const sorting = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const status = (value, ignored = false) => ({ status: value, ignored });

test("mixed stock moves OOS last without scrambling base order", () => {
  const result = sorting.sortCollectionProducts({
    currentOrder: ["A", "B", "C", "D", "E"],
    baseOrder: ["A", "B", "C", "D", "E"],
    availability: {
      A: status("inStock"),
      B: status("soldOut"),
      C: status("inStock"),
      D: status("continueSelling"),
      E: status("soldOut"),
    },
  });

  assert.deepEqual(result.targetOrder, ["A", "C", "D", "B", "E"]);
  assert.deepEqual(result.oosOriginalIndices, { B: 1, E: 4 });
});

test("restocked product returns to its saved base index", () => {
  const soldOut = sorting.sortCollectionProducts({
    currentOrder: ["A", "B", "C", "D"],
    baseOrder: ["A", "B", "C", "D"],
    availability: {
      A: status("inStock"),
      B: status("soldOut"),
      C: status("inStock"),
      D: status("inStock"),
    },
  });
  const restocked = sorting.sortCollectionProducts({
    currentOrder: soldOut.targetOrder,
    baseOrder: soldOut.baseOrder,
    availability: {
      A: status("inStock"),
      B: status("inStock"),
      C: status("inStock"),
      D: status("inStock"),
    },
    previousOosOriginalIndices: soldOut.oosOriginalIndices,
  });

  assert.deepEqual(soldOut.targetOrder, ["A", "C", "D", "B"]);
  assert.equal(restocked.oosOriginalIndices.B, 1);
  assert.deepEqual(restocked.targetOrder, ["A", "B", "C", "D"]);
});

test("ignored sold-out products stay in the in-stock group", () => {
  const result = sorting.sortCollectionProducts({
    currentOrder: ["ignored", "stock", "oos"],
    baseOrder: ["ignored", "stock", "oos"],
    availability: {
      ignored: status("soldOut", true),
      stock: status("inStock"),
      oos: status("soldOut"),
    },
  });
  assert.deepEqual(result.targetOrder, ["ignored", "stock", "oos"]);
});

test("300+ products produce complete sequential move chunks", () => {
  const current = Array.from({ length: 320 }, (_, index) => `product-${index}`);
  const target = [...current].reverse();
  const moves = sorting.buildSequentialMoves(current, target);
  const chunks = sorting.chunkCollectionMoves(moves);
  const applied = [...current];

  for (const chunk of chunks) {
    assert.ok(chunk.length <= 250);
    for (const move of chunk) {
      const from = applied.indexOf(move.id);
      applied.splice(from, 1);
      applied.splice(Number(move.newPosition), 0, move.id);
    }
  }

  assert.ok(chunks.length > 1);
  assert.deepEqual(applied, target);
});

test("debounce grows from 30 minutes to 24 hours by collection size", () => {
  assert.equal(sorting.collectionSortDelayMs(50), 30 * 60_000);
  assert.equal(sorting.collectionSortDelayMs(300), 60 * 60_000);
  assert.equal(sorting.collectionSortDelayMs(10_000), 24 * 60 * 60_000);
});
