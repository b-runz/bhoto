/**
 * Justified rows, Flickr-style: fill each row to the container width while
 * keeping every tile's true aspect ratio and giving the row one shared
 * height. Pure maths -- no DOM, no storage -- so it is directly testable.
 */

export interface PlacedTile {
  w: number;
  h: number;
  /** Index into the aspect list handed in. */
  index: number;
}

export interface Row {
  height: number;
  tiles: PlacedTile[];
}

export interface JustifyOptions {
  /** Height a row aims for before breaking. */
  target?: number;
  /** Space between tiles in a row. */
  gap?: number;
}

/** Fallback for a tile whose dimensions we have not measured yet. */
export const DEFAULT_ASPECT = 3 / 2;

export function justify(
  aspects: readonly number[],
  containerWidth: number,
  options: JustifyOptions = {},
): Row[] {
  const target = options.target ?? 200;
  const gap = options.gap ?? 4;

  if (containerWidth <= 0 || aspects.length === 0) return [];

  const rows: Row[] = [];
  let run: number[] = [];
  let sum = 0;

  const heightFor = (n: number, aspectSum: number) =>
    (containerWidth - gap * (n - 1)) / aspectSum;

  for (let i = 0; i < aspects.length; i++) {
    const aspect = safeAspect(aspects[i]);
    const withHeight = heightFor(run.length + 1, sum + aspect);

    // Adding tiles only ever shrinks the row. Once we drop past the target,
    // decide whether stopping before or after this tile lands closer to it.
    if (run.length > 0 && withHeight < target) {
      const withoutHeight = heightFor(run.length, sum);
      if (Math.abs(withoutHeight - target) <= Math.abs(withHeight - target)) {
        rows.push(buildRow(run, i - run.length, withoutHeight));
        run = [];
        sum = 0;
      }
    }

    run.push(aspect);
    sum += aspect;

    if (heightFor(run.length, sum) <= target) {
      rows.push(buildRow(run, i - run.length + 1, heightFor(run.length, sum)));
      run = [];
      sum = 0;
    }
  }

  // Trailing tiles: hold the target height rather than stretching a stray
  // photo across the full width, but never overflow the container.
  if (run.length > 0) {
    const height = Math.min(target, heightFor(run.length, sum));
    rows.push(buildRow(run, aspects.length - run.length, height));
  }

  return rows;
}

function buildRow(aspects: number[], startIndex: number, height: number): Row {
  return {
    height,
    tiles: aspects.map((aspect, n) => ({
      w: aspect * height,
      h: height,
      index: startIndex + n,
    })),
  };
}

/** Unmeasured or nonsense dimensions fall back to 3:2. */
function safeAspect(aspect: number | undefined): number {
  return typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
    ? aspect
    : DEFAULT_ASPECT;
}
