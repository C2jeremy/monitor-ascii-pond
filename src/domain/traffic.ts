// Traffic volume per calendar bucket, derived from the metric history.
//
// The history API gives average rates (B/s) per sample. A sample's volume is its rate times the
// time it covers: `minutes` when the hub reports how many minutes were aggregated, else the step.
// Buckets follow the viewer's local clock (minute, hour, day, month), so "today" means today.
import type { MetricPoint } from "../data/api";

export type TrafficUnit = "minute" | "hour" | "day" | "month";
export type TrafficBucket = {
  /** Bucket start, unix seconds. */
  ts: number;
  /** Bucket end, unix seconds (exclusive). */
  end: number;
  rx: number | null;
  tx: number | null;
  /** Bytes per bucket for rx + tx; null when nothing was recorded. */
  total: number | null;
  /** The bucket that contains "now" is still filling. */
  partial: boolean;
};

/** How much history to ask for, and at what resolution, for each unit. */
export function trafficQuery(unit: TrafficUnit, historyDays = 7) {
  const days = Math.max(1, Math.min(365, Math.floor(historyDays)));
  switch (unit) {
    case "minute":
      return { hours: 1, points: 60, count: 60 };
    case "hour":
      return { hours: 24, points: 1440, count: 24 };
    case "day": {
      const span = Math.min(30, days);
      return { hours: span * 24, points: Math.min(1440, span * 48), count: span };
    }
    case "month":
      return { hours: days * 24, points: 1440, count: Math.max(1, Math.min(12, Math.ceil(days / 30) + 1)) };
  }
}

function floorTo(unit: TrafficUnit, d: Date) {
  const x = new Date(d);
  if (unit === "minute") x.setSeconds(0, 0);
  else if (unit === "hour") x.setMinutes(0, 0, 0);
  else if (unit === "day") x.setHours(0, 0, 0, 0);
  else { x.setDate(1); x.setHours(0, 0, 0, 0); }
  return x;
}
function shift(unit: TrafficUnit, d: Date, n: number) {
  const x = new Date(d);
  if (unit === "minute") x.setMinutes(x.getMinutes() + n);
  else if (unit === "hour") x.setHours(x.getHours() + n);
  else if (unit === "day") x.setDate(x.getDate() + n);
  else x.setMonth(x.getMonth() + n);
  return x;
}

export function trafficBuckets(
  metrics: MetricPoint[],
  step: number | undefined,
  unit: TrafficUnit,
  count: number,
  now = new Date(),
): TrafficBucket[] {
  const current = floorTo(unit, now);
  const buckets: TrafficBucket[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const start = shift(unit, current, -k);
    buckets.push({
      ts: start.getTime() / 1000,
      end: shift(unit, start, 1).getTime() / 1000,
      rx: null,
      tx: null,
      total: null,
      partial: k === 0,
    });
  }
  if (!buckets.length) return buckets;
  // Fall back to the spacing between samples when the response has no step.
  const gaps = metrics.slice(1).map((p, i) => p.ts - metrics[i].ts).filter((g) => g > 0).sort((a, b) => a - b);
  const spacing = step && step > 0 ? step : gaps.length ? gaps[gaps.length >> 1] : 60;
  const first = buckets[0].ts, last = buckets[buckets.length - 1].end;
  let b = 0;
  for (const p of metrics) {
    if (p.ts < first || p.ts >= last) continue;
    if (p.net_rx == null && p.net_tx == null) continue;
    while (b < buckets.length - 1 && p.ts >= buckets[b].end) b++;
    while (b > 0 && p.ts < buckets[b].ts) b--;
    const bucket = buckets[b];
    const cover = Math.min(spacing, p.minutes && p.minutes > 0 ? p.minutes * 60 : spacing);
    bucket.rx = (bucket.rx ?? 0) + Math.max(0, p.net_rx ?? 0) * cover;
    bucket.tx = (bucket.tx ?? 0) + Math.max(0, p.net_tx ?? 0) * cover;
    bucket.total = bucket.rx + bucket.tx;
  }
  return buckets;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Short axis label for a bucket start. */
export function bucketLabel(unit: TrafficUnit, ts: number) {
  const d = new Date(ts * 1000);
  if (unit === "minute") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (unit === "hour") return `${pad(d.getHours())}:00`;
  if (unit === "day") return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear() % 100}年${d.getMonth() + 1}月`;
}
/** Full label for the tooltip: the span the bucket covers. */
export function bucketSpan(unit: TrafficUnit, b: TrafficBucket) {
  const d = new Date(b.ts * 1000), e = new Date(b.end * 1000);
  const day = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (unit === "minute") return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (unit === "hour") return `${day} ${pad(d.getHours())}:00 – ${pad(e.getHours())}:00`;
  if (unit === "day") return `${d.getFullYear()}年${day}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
