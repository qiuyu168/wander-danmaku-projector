export type Queued<T> = { value: T; at: number };
export class FreshQueue<T> {
  items: Queued<T>[] = [];
  expired = 0; overflow = 0;
  constructor(public capacity = 50, public maxAgeMs = 500) {}
  push(value: T, now: number) {
    this.expire(now);
    if (this.items.length >= this.capacity) { this.items.shift(); this.overflow++; }
    this.items.push({ value, at: now });
  }
  expire(now: number) {
    while (this.items.length && now - this.items[0].at >= this.maxAgeMs) { this.items.shift(); this.expired++; }
  }
  shift(now: number) { this.expire(now); return this.items.shift(); }
  clear() { this.items.length = 0; }
}
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return Math.round(sorted[Math.max(0,Math.ceil(p*sorted.length)-1)] * 100) / 100;
}
