import { useEffect, useMemo, useState } from "react";
import { source } from "@source";
import type { History } from "../data/api";
import { bytes } from "../domain/format";
import { useHidden } from "../hooks";
import { bucketSpan, trafficBuckets, trafficQuery, type TrafficUnit } from "../domain/traffic";
import { savePreference, readPreference } from "../config/settings";

type PlotModule = typeof import("./TrafficPlot");
let plotModule: Promise<PlotModule> | undefined;
const loadPlot = () =>
  (plotModule ??= import("./TrafficPlot").catch((e) => {
    plotModule = undefined;
    throw e;
  }));

const units: { value: TrafficUnit; label: string; per: string }[] = [
  { value: "minute", label: "分钟", per: "每分钟" },
  { value: "hour", label: "小时", per: "每小时" },
  { value: "day", label: "天", per: "每天" },
  { value: "month", label: "月", per: "每月" },
];
const spanLabel = (unit: TrafficUnit, count: number) =>
  unit === "minute" ? "近 60 分钟" : unit === "hour" ? "近 24 小时" : unit === "day" ? `近 ${count} 天` : `近 ${count} 个月`;
const isUnit = (v: string | null): v is TrafficUnit => units.some((u) => u.value === v);

/** Traffic volume per minute, hour, day or month, as stacked download/upload bars. */
export function TrafficStats({ nodeId, historyDays }: { nodeId: number; historyDays?: number }) {
  const [unit, setUnit] = useState<TrafficUnit>(() => {
    const saved = readPreference("traffic-unit");
    return isUnit(saved) ? saved : "hour";
  });
  const [history, setHistory] = useState<History | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [tick, setTick] = useState(0),
    [Plot, setPlot] = useState<PlotModule["default"] | null>(null);
  const hidden = useHidden();
  const query = trafficQuery(unit, historyDays);

  useEffect(() => {
    let live = true;
    loadPlot().then((m) => live && setPlot(() => m.default)).catch(() => live && setError("图表暂时无法加载"));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    setError("");
    setLoading(true);
    source
      .history(nodeId, query.hours, query.points, "metrics", controller.signal)
      .then((v) => { if (!controller.signal.aborted) setHistory(v); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [nodeId, unit, query.hours, query.points, hidden, tick]);
  // Short spans keep moving: refresh them every minute while the page is visible.
  useEffect(() => {
    if (hidden || (unit !== "minute" && unit !== "hour")) return;
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [unit, hidden]);

  const buckets = useMemo(
    () => (history ? trafficBuckets(history.metrics, history.step, unit, query.count) : []),
    [history, unit, query.count],
  );
  const stats = useMemo(() => {
    const seen = buckets.filter((b) => b.total !== null);
    const rx = seen.reduce((s, b) => s + (b.rx ?? 0), 0), tx = seen.reduce((s, b) => s + (b.tx ?? 0), 0);
    const whole = seen.filter((b) => !b.partial);
    const peak = seen.reduce<(typeof seen)[number] | null>((p, b) => (!p || (b.total ?? 0) > (p.total ?? 0) ? b : p), null);
    return {
      rx, tx, peak,
      average: whole.length ? whole.reduce((s, b) => s + (b.total ?? 0), 0) / whole.length : null,
      empty: !seen.length,
    };
  }, [buckets]);
  const per = units.find((u) => u.value === unit)!.per;
  const choose = (next: TrafficUnit) => {
    if (next === unit) return;
    setHistory(null);
    setUnit(next);
    savePreference("traffic-unit", next);
  };

  return (
    <div className="traffic-stats" data-pond-avoid>
      <div className="traffic-head">
        <div>
          <h4>流量走势</h4>
          <small>{spanLabel(unit, query.count)} · {per}用量</small>
        </div>
        <div className="traffic-units" role="tablist" aria-label="统计粒度">
          {units.map((u) => (
            <button key={u.value} role="tab" aria-selected={unit === u.value} onClick={() => choose(u.value)}>
              {u.label}
            </button>
          ))}
        </div>
      </div>
      <div className="traffic-summary">
        <div><span><i className="rx" />下载</span><strong>{history ? bytes(stats.rx) : "—"}</strong></div>
        <div><span><i className="tx" />上传</span><strong>{history ? bytes(stats.tx) : "—"}</strong></div>
        <div><span>峰值</span><strong>{stats.peak ? bytes(stats.peak.total) : "—"}</strong><small>{stats.peak ? bucketSpan(unit, stats.peak) : ""}</small></div>
        <div><span>平均 · {per}</span><strong>{stats.average === null ? "—" : bytes(stats.average)}</strong></div>
      </div>
      <div className="traffic-canvas" data-pond-dim aria-busy={loading}>
        {hidden ? (
          <p className="history-message">页面隐藏，统计已暂停。</p>
        ) : error ? (
          <div className="history-message" role="alert">
            <p>{error}</p>
            <button onClick={() => setTick((n) => n + 1)}>重试 ↻</button>
          </div>
        ) : !history || !Plot ? (
          <p className="history-message">正在汇总流量…</p>
        ) : stats.empty ? (
          <p className="history-message">这段时间没有流量记录。</p>
        ) : (
          <Plot buckets={buckets} unit={unit} rxName="下载" txName="上传" />
        )}
      </div>
      <p className="traffic-note">
        由历史平均速率 × 时长估算，可能与计费读数略有出入
        {unit === "month" || unit === "day" ? `；历史保留 ${Math.max(1, Math.floor(historyDays ?? 7))} 天，更早的时段无记录` : ""}。
      </p>
    </div>
  );
}
