// Bounded scrollback buffer.
//
// Holds the last ~SCROLLBACK_BYTES chars of PTY output for replay when a new
// subscriber attaches. A naive `s += data; s = s.slice(-LIMIT)` is O(n) per
// write and quadratic over the session lifetime when output is bursty
// (Claude's TUI redraws can dump many KB per tick). This implementation keeps
// a chunk array and only joins when `read()` is called.
//
// Trim policy: drop oldest chunks whole until the remainder is at or under
// the limit. This means the *effective* buffer can sit anywhere between
// (limit - longest-chunk) and `limit` chars — acceptable for terminal replay
// where chunk boundaries are arbitrary anyway.

export class ScrollbackBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  constructor(private readonly limit: number) {}

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.length;
    }
    // A single chunk larger than `limit` is left as-is rather than sliced —
    // PTY writes are short enough in practice that this branch is unreached;
    // slicing it would create a new allocation every write and defeat the
    // point of the chunk array.
  }

  read(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0]!;
    const joined = this.chunks.join('');
    // Collapse to a single chunk so subsequent reads of an unchanged buffer
    // are O(1) and so future appends don't repeatedly re-join.
    this.chunks = [joined];
    return joined;
  }

  get length(): number {
    return this.bytes;
  }
}
