export type CollectionProductStatus = "inStock" | "continueSelling" | "soldOut";

export interface CollectionProductAvailability {
  status: CollectionProductStatus;
  ignored?: boolean;
}

export interface CollectionSortInput {
  currentOrder: string[];
  baseOrder: string[];
  availability: Record<string, CollectionProductAvailability>;
  previousOosOriginalIndices?: Record<string, number>;
}

export interface CollectionMove {
  id: string;
  newPosition: string;
}

export function sortCollectionProducts(input: CollectionSortInput) {
  const baseOrder = mergeCollectionMembership(
    input.baseOrder,
    input.currentOrder,
  );
  const oosOriginalIndices = retainCurrentIndices(
    input.previousOosOriginalIndices ?? {},
    baseOrder,
  );

  const preRestoreIndices = new Map(
    baseOrder.map((productId, index) => [productId, index]),
  );
  baseOrder.sort((left, right) => {
    const leftSaved = restockIndex(
      left,
      input.availability[left],
      oosOriginalIndices,
    );
    const rightSaved = restockIndex(
      right,
      input.availability[right],
      oosOriginalIndices,
    );
    const leftRank = leftSaved ?? preRestoreIndices.get(left) ?? 0;
    const rightRank = rightSaved ?? preRestoreIndices.get(right) ?? 0;
    return leftRank === rightRank
      ? Number(rightSaved !== undefined) - Number(leftSaved !== undefined)
      : leftRank - rightRank;
  });

  for (const [index, productId] of baseOrder.entries()) {
    const availability = input.availability[productId];
    if (
      availability?.status === "soldOut" &&
      !availability.ignored &&
      oosOriginalIndices[productId] === undefined
    ) {
      oosOriginalIndices[productId] = index;
    }
  }

  const baseIndices = new Map(
    baseOrder.map((productId, index) => [productId, index]),
  );
  const targetOrder = [...baseOrder].sort((left, right) => {
    const groupDifference =
      availabilityGroup(input.availability[left]) -
      availabilityGroup(input.availability[right]);
    return groupDifference === 0
      ? (baseIndices.get(left) ?? 0) - (baseIndices.get(right) ?? 0)
      : groupDifference;
  });

  return { targetOrder, baseOrder, oosOriginalIndices };
}

export function mergeCollectionMembership(
  baseOrder: string[],
  currentOrder: string[],
): string[] {
  const current = new Set(currentOrder);
  const merged = baseOrder.filter((id) => current.has(id));
  const included = new Set(merged);

  for (const productId of currentOrder) {
    if (included.has(productId)) continue;
    merged.push(productId);
    included.add(productId);
  }

  return merged;
}

export function buildSequentialMoves(
  currentOrder: string[],
  targetOrder: string[],
): CollectionMove[] {
  const working = [...currentOrder];
  const moves: CollectionMove[] = [];

  for (let targetIndex = 0; targetIndex < targetOrder.length; targetIndex++) {
    const productId = targetOrder[targetIndex];
    const currentIndex = working.indexOf(productId);
    if (currentIndex === -1 || currentIndex === targetIndex) continue;

    working.splice(currentIndex, 1);
    working.splice(targetIndex, 0, productId);
    moves.push({ id: productId, newPosition: String(targetIndex) });
  }

  return moves;
}

export function chunkCollectionMoves(
  moves: CollectionMove[],
  size = 250,
): CollectionMove[][] {
  const chunks: CollectionMove[][] = [];
  for (let index = 0; index < moves.length; index += size) {
    chunks.push(moves.slice(index, index + size));
  }
  return chunks;
}

export function collectionSortDelayMs(productCount: number): number {
  if (productCount < 100) return 30 * 60_000;
  if (productCount < 500) return 60 * 60_000;
  if (productCount < 2_000) return 4 * 60 * 60_000;
  if (productCount < 10_000) return 12 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function availabilityGroup(
  availability: CollectionProductAvailability | undefined,
) {
  if (!availability || availability.ignored) return 0;
  if (availability.status === "continueSelling") return 1;
  if (availability.status === "soldOut") return 2;
  return 0;
}

function retainCurrentIndices(
  previous: Record<string, number>,
  baseOrder: string[],
) {
  const current = new Set(baseOrder);
  return Object.fromEntries(
    Object.entries(previous).filter(([productId]) => current.has(productId)),
  );
}

function restockIndex(
  productId: string,
  availability: CollectionProductAvailability | undefined,
  savedIndices: Record<string, number>,
) {
  const saved = savedIndices[productId];
  if (saved === undefined) return undefined;
  return availability?.ignored || availability?.status !== "soldOut"
    ? saved
    : undefined;
}
