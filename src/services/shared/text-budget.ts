/**
 * @fileoverview Text from several concurrent reads held under one shared
 * character budget. Each read's chunks are held while the running total fits;
 * the first chunk that would pass the budget drops everything held, and from
 * then on every read only counts characters. The holder never keeps more than
 * the budget, while still measuring each read to its end.
 * @module services/shared/text-budget
 */

/** One keyed read: the chunks held for it, and every character it has seen. */
interface Read {
  length: number;
  parts: string[];
}

/** Held text and measured length for several keyed reads, under one shared character budget. */
export class TextBudget {
  private readonly budget: number;
  private readonly reads = new Map<string, Read>();
  private held = 0;
  private over = false;

  /** `budget` is the most characters held across every read at once. */
  constructor(budget: number) {
    this.budget = budget;
  }

  /** Characters held across every read right now. */
  get heldChars(): number {
    return this.held;
  }

  /** Whether a chunk has passed the budget: nothing is held, and reads only count from then on. */
  get overBudget(): boolean {
    return this.over;
  }

  /** Count `chunk` toward `key`'s read, holding it while the shared total stays within the budget. */
  add(key: string, chunk: string): void {
    const read = this.readOf(key);
    read.length += chunk.length;
    if (this.over) return;
    if (this.held + chunk.length > this.budget) {
      this.over = true;
      for (const r of this.reads.values()) r.parts.length = 0;
      this.held = 0;
      return;
    }
    read.parts.push(chunk);
    this.held += chunk.length;
  }

  /** Forget `key`'s read (one that failed), returning its held characters to the budget. */
  release(key: string): void {
    const read = this.reads.get(key);
    if (!read) return;
    this.held -= read.parts.reduce((n, p) => n + p.length, 0);
    this.reads.delete(key);
  }

  /** `key`'s held text: the whole read while within the budget, empty once over it. */
  text(key: string): string {
    return this.reads.get(key)?.parts.join('') ?? '';
  }

  /** Characters `key`'s read has seen, held or not. */
  length(key: string): number {
    return this.reads.get(key)?.length ?? 0;
  }

  private readOf(key: string): Read {
    let read = this.reads.get(key);
    if (!read) {
      read = { length: 0, parts: [] };
      this.reads.set(key, read);
    }
    return read;
  }
}
