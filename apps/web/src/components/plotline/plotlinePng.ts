import type { ObservedTask } from "./observerModel";
import { routePlotlineEdges } from "./observerRouting";
import {
  OBSERVER_NODE_HEIGHT,
  OBSERVER_NODE_WIDTH,
  type ObservedPosition,
} from "./observerModel";

/** Sample the actual Plotline surface so exports follow T3's light/dark setting. */
export function isDarkPlotlineSurface(element: HTMLElement | null): boolean {
  if (!element) return true;
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return getComputedStyle(element).colorScheme.includes("dark");
  ctx.fillStyle = getComputedStyle(element).backgroundColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, alpha = 255] = ctx.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return getComputedStyle(element).colorScheme.includes("dark");
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
}

/** Render the complete DAG using its model coordinates, not the clipped viewport. */
export interface PlotlinePngInput {
  readonly title: string;
  readonly nodes: readonly ObservedPosition[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly dependencies: readonly { readonly from: string; readonly to: string }[];
  readonly width: number;
  readonly height: number;
  readonly dark: boolean;
}

const MARGIN = 32;
const HEADER_HEIGHT = 80;
const MAX_PIXELS = 32_000_000;
const MAX_DIMENSION = 12_000;

/** Keep browser canvas allocations within an explicit memory/texture budget. */
export function pngCanvasSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The DAG has no exportable area.");
  }
  const scale = Math.min(
    2,
    MAX_DIMENSION / width,
    MAX_DIMENSION / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  if (scale < 0.5) throw new Error("The DAG is too large to export as a single PNG.");
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/** Keep the download name portable across desktop and browser filesystems. */
export function plotlinePngFilename(title: string, date: Date = new Date()): string {
  const name = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "") || "dag";
  return `plotline-${name}-${date.toISOString().slice(0, 10)}.png`;
}

interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly card: string;
  readonly task: string;
  readonly subtask: string;
  readonly taskBorder: string;
  readonly subtaskBorder: string;
  readonly hierarchy: string;
  readonly dependency: string;
  readonly success: string;
  readonly warning: string;
  readonly failure: string;
}

const palette = (dark: boolean): Palette => dark
  ? {
      background: "#090b0f", foreground: "#f1f5f9", muted: "#94a3b8",
      card: "#151619", task: "#071820", subtask: "#1b132b",
      taskBorder: "#0ea5e9", subtaskBorder: "#a855f7",
      hierarchy: "#cbd5e1", dependency: "#7dd3fc", success: "#10b981",
      warning: "#f59e0b", failure: "#fb7185",
    }
  : {
      background: "#f8fafc", foreground: "#0f172a", muted: "#64748b",
      card: "#ffffff", task: "#effaff", subtask: "#f6f0ff",
      taskBorder: "#0284c7", subtaskBorder: "#9333ea",
      hierarchy: "#475569", dependency: "#0369a1", success: "#059669",
      warning: "#b45309", failure: "#e11d48",
    };

function drawRoundedCard(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, width: number, height: number,
  radius: number, fill: string, stroke: string,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function clipText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 0 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

function drawTwoLineTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const combined = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(combined).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = combined;
    }
  }
  if (current) lines.push(current);
  // A clipped two-line title keeps the exported cards at the same fixed height.
  for (let i = 0; i < Math.min(lines.length, 2); i++) {
    const value = i === 1 && lines.length > 2
      ? `${lines[i]}…` : lines[i]!;
    ctx.fillText(clipText(ctx, value, maxWidth), x, y + i * 17);
  }
}

function drawStatus(ctx: CanvasRenderingContext2D, node: ObservedTask, x: number, y: number, colors: Palette) {
  const complete = node.status === "completed";
  const failed = node.status === "failed" || node.status === "interrupted";
  const color = complete ? colors.success : failed ? colors.failure
    : node.status === "running" ? colors.dependency
      : node.status === "cancelled" ? colors.warning : colors.muted;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.stroke();
  if (complete) {
    ctx.beginPath();
    ctx.moveTo(x - 2.5, y);
    ctx.lineTo(x - 0.5, y + 2);
    ctx.lineTo(x + 3, y - 2);
    ctx.stroke();
  }
}

function drawNode(ctx: CanvasRenderingContext2D, position: ObservedPosition, colors: Palette) {
  const node = position.node;
  const subtask = node.kind === "plan" && node.isSubtask === true;
  const x = position.x + (subtask ? 10 : 0);
  const width = OBSERVER_NODE_WIDTH - (subtask ? 20 : 0);
  const y = position.y;
  const height = OBSERVER_NODE_HEIGHT;
  const fill = subtask ? colors.subtask : node.kind === "plan" ? colors.task : colors.card;
  const stroke = subtask ? colors.subtaskBorder
    : node.kind === "plan" ? colors.taskBorder : colors.muted;
  drawRoundedCard(ctx, x, y, width, height, subtask ? 8 : 12, fill, stroke);
  if (subtask) {
    ctx.fillStyle = colors.subtaskBorder;
    ctx.fillRect(x + 1, y + 10, 3, height - 20);
  }

  ctx.textBaseline = "alphabetic";
  ctx.font = "600 10px Inter, system-ui, sans-serif";
  ctx.fillStyle = subtask ? colors.subtaskBorder : colors.muted;
  const label = node.kind === "run" ? "CONVERSATION" :
    subtask ? "SUB TASK" : node.kind === "plan" ? "TASK" : "SUBAGENT";
  ctx.fillText(label, x + 13, y + 22);
  // Preserve the native status text alongside its icon in the downloaded image.
  const statusWidth = ctx.measureText(node.status).width;
  const statusX = x + width - 13 - statusWidth;
  drawStatus(ctx, node, statusX - 10, y + 18, colors);
  ctx.fillStyle = node.status === "completed" ? colors.success
    : node.status === "failed" || node.status === "interrupted" ? colors.failure
      : node.status === "running" ? colors.dependency : colors.muted;
  ctx.fillText(node.status, statusX, y + 22);

  ctx.fillStyle = colors.foreground;
  ctx.font = "600 12px Inter, system-ui, sans-serif";
  drawTwoLineTitle(ctx, node.title, x + 13, y + 48, width - 26);

  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.fillStyle = colors.muted;
  ctx.fillText(clipText(ctx, node.provider ?? "Model unavailable", width - 26), x + 13, y + height - 13);
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  input: PlotlinePngInput,
  colors: Palette,
) {
  // Use exactly the live observer's obstacle-aware geometry. Never redraw
  // dependencies as straight lines through cards in the exported image.
  const routes = routePlotlineEdges(input.nodes, input.edges, input.dependencies);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const route of routes) {
    const hierarchy = route.kind === "hierarchy";
    ctx.strokeStyle = hierarchy ? colors.hierarchy : colors.dependency;
    ctx.lineWidth = hierarchy ? 2.5 : 2;
    ctx.setLineDash(hierarchy ? [] : [7, 5]);
    ctx.beginPath();
    route.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    if (hierarchy || route.points.length < 2) continue;
    const tip = route.points[route.points.length - 1]!;
    const before = route.points[route.points.length - 2]!;
    const dx = Math.sign(tip.x - before.x);
    const dy = Math.sign(tip.y - before.y);
    // Arrowhead is oriented by the final routed segment, not by node order.
    ctx.beginPath();
    ctx.moveTo(tip.x - dx * 8 - dy * 4, tip.y - dy * 8 + dx * 4);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x - dx * 8 + dy * 4, tip.y - dy * 8 - dx * 4);
    ctx.stroke();
  }
}

/** Offscreen Canvas2D avoids viewport clipping and SVG foreignObject restrictions. */
export function renderPlotlinePng(input: PlotlinePngInput): HTMLCanvasElement {
  const width = input.width + 2 * MARGIN;
  const height = input.height + HEADER_HEIGHT + 2 * MARGIN;
  const canvasSize = pngCanvasSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG canvas is unavailable.");
  const colors = palette(input.dark);
  ctx.scale(canvasSize.scale, canvasSize.scale);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = colors.foreground;
  ctx.font = "700 20px Inter, system-ui, sans-serif";
  ctx.fillText(clipText(ctx, input.title || "Plotline DAG", width - 2 * MARGIN), MARGIN, MARGIN + 18);
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = colors.muted;
  ctx.fillText(`Plotline · ${input.nodes.length} nodes · ${input.dependencies.length} dependencies`, MARGIN, MARGIN + 40);

  ctx.save();
  ctx.translate(MARGIN, MARGIN + HEADER_HEIGHT);
  drawConnections(ctx, input, colors);
  for (const position of input.nodes) drawNode(ctx, position, colors);
  ctx.restore();
  return canvas;
}

/** Trigger a browser/Electron download without persisting the DAG on a server. */
export async function downloadPlotlinePng(input: PlotlinePngInput): Promise<void> {
  const canvas = renderPlotlinePng(input);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Unable to encode the DAG as PNG."));
    }, "image/png");
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = plotlinePngFilename(input.title);
    link.style.display = "none";
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    // Allow the download handler time to resolve the blob URL.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}
