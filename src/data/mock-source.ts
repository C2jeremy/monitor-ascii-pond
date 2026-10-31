// 本地开发用的模拟数据源：`npm run dev:mock` 时通过 vite alias 替换 @source。
// 不会进入正式构建。
import { parseConfig } from "../config/settings";
import { normalizeNodes } from "../domain/nodes";
import type { History, MetricPoint, PingPoint } from "./api";
import type { Source } from "./types";

const GB = 1024 ** 3;
const TB = 1024 ** 4;
const MB = 1024 ** 2;

type Seed = {
  name: string;
  group: string;
  country: string;
  online?: boolean;
  noMetrics?: boolean;
  cores: number;
  mem: number;
  disk: number;
  load: number; // 基准 CPU 百分比
  net: number; // 基准速率 B/s
  limit?: number;
  used?: number;
  price?: number;
  currency?: string;
  cycle?: string;
  expires?: number | null;
  remark?: string;
  os?: string;
};

const seeds: Seed[] = [
  { name: "HK-Tsuen-Wan-01", group: "亚洲", country: "HK", cores: 4, mem: 8 * GB, disk: 80 * GB, load: 23, net: 4.2 * MB, limit: 2 * TB, used: 0.62 * TB, price: 12.5, currency: "$", cycle: "月付", expires: 18, remark: "主力反代节点" },
  { name: "Tokyo-Linode-NRT", group: "亚洲", country: "JP", cores: 2, mem: 4 * GB, disk: 50 * GB, load: 61, net: 1.1 * MB, limit: 1 * TB, used: 0.91 * TB, price: 10, currency: "$", cycle: "月付", expires: 3 },
  { name: "SG-DigitalOcean", group: "亚洲", country: "SG", cores: 1, mem: 2 * GB, disk: 25 * GB, load: 8, net: 230 * 1024, limit: 1 * TB, used: 0.12 * TB, price: 6, currency: "$", cycle: "月付", expires: 47 },
  { name: "Seoul-Oracle-ARM", group: "亚洲", country: "KR", cores: 4, mem: 24 * GB, disk: 200 * GB, load: 3, net: 80 * 1024, price: 0, cycle: "免费", expires: null, remark: "甲骨文永久免费，别删" },
  { name: "LA-CN2-GIA", group: "北美", country: "US", cores: 2, mem: 2 * GB, disk: 40 * GB, load: 41, net: 9.8 * MB, limit: 1.5 * TB, used: 1.38 * TB, price: 299, currency: "¥", cycle: "年付", expires: 120 },
  { name: "NYC-Vultr-HighFreq", group: "北美", country: "US", cores: 1, mem: 1 * GB, disk: 32 * GB, load: 88, net: 600 * 1024, limit: 2 * TB, used: 0.33 * TB, price: 6, currency: "$", cycle: "月付", expires: -2 },
  { name: "Toronto-OVH", group: "北美", country: "CA", online: false, cores: 2, mem: 4 * GB, disk: 80 * GB, load: 0, net: 0, price: 5.5, currency: "€", cycle: "月付", expires: 9 },
  { name: "Frankfurt-Hetzner-CX32", group: "欧洲", country: "DE", cores: 4, mem: 8 * GB, disk: 160 * GB, load: 35, net: 2.6 * MB, limit: 20 * TB, used: 3.1 * TB, price: 6.8, currency: "€", cycle: "月付", expires: 25, os: "Debian GNU/Linux 12" },
  { name: "London-Contabo", group: "欧洲", country: "GB", cores: 6, mem: 16 * GB, disk: 400 * GB, load: 17, net: 1.4 * MB, limit: 32 * TB, used: 1.2 * TB, price: 8.99, currency: "€", cycle: "月付", expires: 60 },
  { name: "Amsterdam-Backup", group: "欧洲", country: "NL", noMetrics: true, cores: 1, mem: 1 * GB, disk: 500 * GB, load: 0, net: 0, price: 3, currency: "€", cycle: "月付", expires: 200, remark: "冷备份存储" },
  { name: "Shanghai-Aliyun-ECS", group: "国内", country: "CN", cores: 2, mem: 4 * GB, disk: 40 * GB, load: 52, net: 3.3 * MB, limit: 500 * GB, used: 210 * GB, price: 99, currency: "¥", cycle: "年付", expires: 31 },
  { name: "Home-NAS-Beijing", group: "国内", country: "CN", online: false, cores: 4, mem: 16 * GB, disk: 8 * TB, load: 0, net: 0 },
];

const started = Date.now();
const wave = (i: number, t: number, period: number) =>
  Math.sin(t / period + i * 1.7) * 0.5 + 0.5;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function rawNodes() {
  const t = (Date.now() - started) / 1000;
  return seeds.map((s, i) => {
    const online = s.online !== false;
    const cpu = clamp(s.load * (0.7 + 0.6 * wave(i, t, 7)) + Math.random() * 4, 0, 100);
    const memRatio = clamp(0.35 + (i % 5) * 0.12 + 0.04 * wave(i, t, 13), 0, 0.98);
    const diskRatio = clamp(0.2 + ((i * 7) % 9) * 0.09, 0, 0.97);
    const rx = s.net * (0.4 + wave(i, t, 3));
    const tx = s.net * 0.35 * (0.4 + wave(i + 3, t, 4));
    return {
      id: i + 1,
      name: s.name,
      sort: i,
      online,
      group: s.group,
      country: s.country,
      public_remark: s.remark ?? "",
      os: s.os ?? "Ubuntu 24.04.1 LTS",
      kernel: "6.8.0-45-generic",
      arch: i % 4 === 3 ? "aarch64" : "x86_64",
      virt: i % 3 === 0 ? "kvm" : "xen",
      cpu_name: i % 4 === 3 ? "Neoverse-N1" : "AMD EPYC 7B13",
      agent_version: "1.4.2",
      cpu_cores: s.cores,
      mem_total: s.mem,
      disk_total: s.disk,
      swap_total: 1 * GB,
      price: s.price,
      currency: s.currency ?? "",
      billing_cycle: s.cycle ?? "",
      traffic_mode: "sum",
      traffic_limit: s.limit,
      total_rx: 40 * TB * (i + 1) * 0.01,
      total_tx: 12 * TB * (i + 1) * 0.01,
      month_rx: s.used !== undefined ? s.used * 0.72 : 30 * GB * (i + 1),
      month_tx: s.used !== undefined ? s.used * 0.28 : 9 * GB * (i + 1),
      month_start: "2026-10-01",
      traffic_reset_day: 1,
      expires_in: s.expires,
      last_seen_ago: online ? 1 : 3600 * (i + 2),
      metrics:
        !online || s.noMetrics
          ? null
          : {
              cpu,
              mem_used: s.mem * memRatio,
              mem_total: s.mem,
              disk_used: s.disk * diskRatio,
              disk_total: s.disk,
              net_rx: rx,
              net_tx: tx,
              uptime: 86400 * (3 + i * 11) + t,
              swap_used: 0.1 * GB,
              swap_total: 1 * GB,
              load: [cpu / 25, cpu / 30, cpu / 35].map((v) => +v.toFixed(2)),
              tcp: 40 + i * 13,
              udp: 5 + i,
              procs: 110 + i * 7,
            },
    };
  });
}

function mockHistory(
  id: number,
  hours: number,
  points: number,
  series: "metrics" | "ping",
): History {
  const seed = seeds[id - 1] ?? seeds[0];
  const now = Math.floor(Date.now() / 1000);
  const n = Math.max(60, Math.min(1440, Math.round(points)));
  const step = Math.round((hours * 3600) / n);
  const metrics: MetricPoint[] = [];
  const ping: PingPoint[] = [];
  const probes = { "1": "上海电信", "2": "广州联通", "3": "北京移动" };
  for (let k = 0; k < n; k++) {
    const ts = now - (n - k) * step;
    // 制造一段断点
    if (k > n * 0.62 && k < n * 0.66) continue;
    if (series === "metrics") {
      const cpu = clamp(seed.load * (0.6 + 0.8 * wave(id, ts, 900)) + Math.random() * 6, 0, 100);
      const rx = seed.net * (0.3 + wave(id, ts, 1800) + Math.random() * 0.3);
      const tx = rx * 0.3;
      metrics.push({
        ts,
        cpu,
        cpu_max: Math.min(100, cpu * 1.3),
        mem_used: seed.mem * (0.4 + 0.1 * wave(id, ts, 3600)),
        disk_used: seed.disk * 0.45,
        swap_used: 0.1 * GB,
        net_rx: rx,
        net_tx: tx,
        net_rx_max: rx * 1.6,
        net_tx_max: tx * 1.6,
      });
    } else {
      for (const [task, base] of [[1, 38], [2, 52], [3, 71]] as const) {
        const spike = Math.random() < 0.02;
        const lost = Math.random() < 0.01;
        const latency = lost
          ? null
          : base + 8 * wave(task, ts, 1200) + Math.random() * 5 + (spike ? 120 : 0);
        ping.push({
          ts,
          task_id: task,
          latency,
          band: latency === null ? undefined : [latency * 0.9, latency * 1.25],
          loss: lost ? 1 : 0,
        });
      }
    }
  }
  return {
    metrics,
    ping,
    probes,
    loss: series === "ping" ? { "1": 0.4, "2": 1.2, "3": 2.8 } : {},
    step,
  };
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export const source: Source = {
  demo: true,
  async loadSite() {
    return {
      site_name: "锦鲤池塘",
      authed: false,
      public_page: true,
      history_days: 30,
    };
  },
  async loadConfig() {
    return parseConfig({});
  },
  subscribe(notify) {
    const push = () =>
      notify({
        nodes: normalizeNodes(rawNodes()),
        state: "live",
        error: "",
        closed: false,
      });
    push();
    const timer = setInterval(push, 2000);
    return () => clearInterval(timer);
  },
  async history(id, hours, points, series, signal) {
    await delay(150, signal);
    return mockHistory(id, hours, points, series);
  },
};
