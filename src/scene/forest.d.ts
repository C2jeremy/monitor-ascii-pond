import type { PondInstance } from "../vendor/ascii-pond/pond.js";
export function mount(
  canvas: HTMLCanvasElement,
  options?: {
    theme?: "light" | "dark";
    paused?: boolean;
    feed?: boolean;
    maxFps?: number;
    maxDpr?: number;
  },
): PondInstance;
