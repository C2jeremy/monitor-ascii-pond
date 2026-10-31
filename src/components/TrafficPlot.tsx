import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { bytes } from "../domain/format";
import { bucketLabel, bucketSpan, type TrafficBucket, type TrafficUnit } from "../domain/traffic";

export type TrafficPlotProps = {
  buckets: TrafficBucket[];
  unit: TrafficUnit;
  rxName: string;
  txName: string;
};

function TrafficTip({ active, payload, unit }: { active?: boolean; payload?: { payload: TrafficBucket }[]; unit: TrafficUnit }) {
  const b = active ? payload?.[0]?.payload : undefined;
  if (!b) return null;
  return (
    <div className="traffic-tip">
      <b>{bucketSpan(unit, b)}{b.partial ? " · 进行中" : ""}</b>
      {b.total === null ? (
        <span>无记录</span>
      ) : (
        <>
          <span><i className="rx" />下载 {bytes(b.rx)}</span>
          <span><i className="tx" />上传 {bytes(b.tx)}</span>
          <span className="sum">合计 {bytes(b.total)}</span>
        </>
      )}
    </div>
  );
}

/** Round axis steps in the unit the largest bar is read in (1, 2, 2.5 or 5 × 10ⁿ KB/MB/GB…). */
function niceTicks(max: number) {
  if (!(max > 0)) return [0, 1];
  const scale = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const raw = max / scale / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((k) => k * mag >= raw) ?? 10) * mag * scale;
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

export default function TrafficPlot({ buckets, unit, rxName, txName }: TrafficPlotProps) {
  const many = buckets.length > 30;
  const ticks = niceTicks(Math.max(0, ...buckets.map((b) => b.total ?? 0)));
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <BarChart data={buckets} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={many ? "18%" : "28%"} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="2 5" />
        <XAxis
          dataKey="ts"
          tickFormatter={(ts) => bucketLabel(unit, Number(ts))}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
          interval="preserveStartEnd"
          minTickGap={unit === "month" ? 8 : 28}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
        />
        <YAxis
          width={62}
          ticks={ticks}
          domain={[0, ticks[ticks.length - 1]]}
          tickFormatter={(v) => (v ? bytes(Number(v)) : "0")}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
        />
        <Tooltip
          cursor={{ fill: "var(--traffic-cursor)" }}
          content={<TrafficTip unit={unit} />}
          isAnimationActive={false}
        />
        {(["rx", "tx"] as const).map((key) => (
          <Bar
            key={key}
            dataKey={key}
            name={key === "rx" ? rxName : txName}
            stackId="t"
            fill={`var(--traffic-${key})`}
            radius={key === "tx" ? [2, 2, 0, 0] : undefined}
            isAnimationActive={false}
          >
            {/* The bucket still filling is drawn lighter. */}
            {buckets.map((b) => <Cell key={b.ts} fillOpacity={b.partial ? 0.5 : 1} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
