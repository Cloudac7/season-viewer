import {SEASONS, SEASON_ORDER} from '../data';
import type {Season} from '../types';
import {TEMPERATURE_BANDS, TEMPERATURE_LEGEND_TICKS} from './field';
import {transitionColors} from './map-status';

const NS = 'http://www.w3.org/2000/svg';
const MAP_W = 840, MAP_H = 550, HEADER = 56, GAP = 6, FOOTER = 24;

export interface MapExportOptions {
  /** The live map `<svg>`; its transient overlays are stripped before export. */
  svg: SVGSVGElement;
  layer: 'season' | 'temperature';
  date: string;
  transitions?: { from: Season; target: Season }[];
  showTransitions?: boolean;
}

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, content: string, opts: { size?: number; fill?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; spacing?: number } = {}): SVGElement {
  const node = el('text', {
    x, y,
    'font-size': opts.size ?? 11,
    fill: opts.fill ?? '#273c33',
    'font-weight': opts.weight ?? 400,
    'font-family': "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
    'text-anchor': opts.anchor ?? 'start',
    ...(opts.spacing ? { 'letter-spacing': opts.spacing } : {}),
  });
  node.textContent = content;
  return node;
}

function uniqueDirections(transitions: { from: Season; target: Season }[] = []): { from: Season; target: Season }[] {
  const seen = new Set<string>();
  const result: { from: Season; target: Season }[] = [];
  for (const direction of transitions) {
    const key = `${direction.from}-${direction.target}`;
    if (seen.has(key) || direction.from === direction.target) continue;
    seen.add(key);
    result.push(direction);
  }
  return result;
}

/** Legend rows are drawn as plain SVG so the exported image is self-contained. */
function appendLegend(out: SVGElement, top: number, options: MapExportOptions): void {
  const directions = options.layer === 'season' && options.showTransitions ? uniqueDirections(options.transitions).slice(0, 6) : [];
  if (options.layer === 'season') {
    let x = 28;
    out.appendChild(text(x, top + 12, '图例', { size: 10, fill: '#8a9b90', weight: 500 }));
    x += 42;
    for (const season of SEASON_ORDER) {
      out.appendChild(el('rect', { x, y: top + 1, width: 13, height: 13, rx: 2, fill: SEASONS[season].fill }));
      out.appendChild(text(x + 18, top + 12, SEASONS[season].name, { size: 11, fill: '#4a5d50' }));
      x += 86;
    }
    out.appendChild(el('rect', { x, y: top + 1, width: 13, height: 13, rx: 2, fill: '#a8b4ad' }));
    out.appendChild(text(x + 18, top + 12, '资料不足', { size: 11, fill: '#85938a' }));
    if (directions.length) {
      const y = top + 40;
      out.appendChild(text(28, y, '换季色阶', { size: 9, fill: '#98a29a', weight: 500 }));
      let dx = 92;
      for (const direction of directions) {
        const colors = transitionColors(direction.from, direction.target);
        out.appendChild(el('rect', { x: dx, y: y - 8, width: 10, height: 10, rx: 2, fill: colors.pending.fill }));
        out.appendChild(el('rect', { x: dx + 13, y: y - 8, width: 10, height: 10, rx: 2, fill: colors.forecast.fill }));
        out.appendChild(text(dx + 28, y + 1, `${SEASONS[direction.from].name.slice(0, 1)}→${SEASONS[direction.target].name.slice(0, 1)}`, { size: 10, fill: '#7c8a80' }));
        dx += 118;
      }
    }
    return;
  }
  // Temperature: the same 12 fixed bands and threshold labels as the on-page legend.
  out.appendChild(text(28, top + 12, '5 日滑动均温', { size: 10, fill: '#52677b', weight: 500 }));
  out.appendChild(text(128, top + 12, '分级色标 · °C', { size: 9, fill: '#8999a7' }));
  const barY = top + 22, full = MAP_W - 56, bandW = full / TEMPERATURE_BANDS.length;
  TEMPERATURE_BANDS.forEach((band, index) => {
    out.appendChild(el('rect', { x: 28 + index * bandW, y: barY, width: bandW - 1, height: 14, fill: band.fill }));
  });
  for (const tick of TEMPERATURE_LEGEND_TICKS) {
    const x = 28 + tick.position * full;
    out.appendChild(text(x, barY + 26, tick.label, {
      size: 8, fill: '#687c8b',
      anchor: tick.edge === 'start' ? 'start' : tick.edge === 'end' ? 'end' : 'middle',
    }));
  }
}

/** Compose a standalone SVG then rasterise it to a 2x PNG blob. */
export async function exportMapPng(options: MapExportOptions): Promise<Blob> {
  const directions = options.layer === 'season' && options.showTransitions ? uniqueDirections(options.transitions) : [];
  const legendH = options.layer === 'season' ? (directions.length ? 70 : 34) : 60;
  const total = HEADER + MAP_H + GAP + legendH + FOOTER;

  const out = el('svg', { xmlns: NS, viewBox: `0 0 ${MAP_W} ${total}`, width: MAP_W, height: total }) as SVGSVGElement;
  const style = el('style', {});
  style.textContent = `.province-label{font-size:9px;fill:#425368;stroke:#fff;stroke-width:1.6px;stroke-opacity:.85;paint-order:stroke}.field-province-label{font-size:9px;fill:#64715b;stroke:#fff;stroke-width:1.8px;stroke-opacity:.55;paint-order:stroke}.inset-label{fill:#8b9b7d;font-size:7px;letter-spacing:1px;text-anchor:middle}.compass path{fill:none;stroke:#7a8c6a;stroke-width:1}.compass text{font-size:9px;text-anchor:middle;fill:#8b9c7c}`;
  out.appendChild(style);
  out.appendChild(el('rect', { x: 0, y: 0, width: MAP_W, height: total, fill: '#f6f8f6' }));
  out.appendChild(text(28, 30, '四时 · 中国季节地图', { size: 20, fill: '#273c33', weight: 600, spacing: 1 }));
  out.appendChild(text(28, 50, `${options.date.replaceAll('-', ' . ')} · ${options.layer === 'season' ? '季节分布' : '滑动均温'}`, { size: 11, fill: '#6f8574' }));

  const clone = options.svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('.spatial-selected-point,.county-selected-label').forEach((node) => node.remove());
  const transform = clone.querySelector('.county-map-transform');
  if (transform) transform.removeAttribute('transform');
  const mapGroup = el('g', { transform: `translate(0 ${HEADER})` });
  mapGroup.appendChild(text(46, 22, 'TERRAIN SEASONS', { size: 9, fill: '#c1cbb8', weight: 500, spacing: 2 }));
  mapGroup.appendChild(text(46, 33, 'OPEN-METEO · ECMWF DAILY MODEL', { size: 5, fill: '#b7c1ad', spacing: 1 }));
  while (clone.firstChild) mapGroup.appendChild(clone.firstChild);
  out.appendChild(mapGroup);

  appendLegend(out, HEADER + MAP_H + GAP, options);
  out.appendChild(text(28, total - 8, 'Open-Meteo · ECMWF + Terrarium DEM · 四时 SEASON ATLAS · 模型估算，非地面实测', { size: 8, fill: '#9aa79e' }));

  const xml = new XMLSerializer().serializeToString(out);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const image = await loadImage(url);
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W * scale;
  canvas.height = Math.round(total * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建导出画布');
  context.fillStyle = '#f6f8f6';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 生成失败');
  return blob;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('导出图渲染失败'));
    image.src = src;
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
