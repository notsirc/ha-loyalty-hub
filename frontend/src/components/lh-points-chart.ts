import { LitElement, css, html, nothing, svg } from "lit";
import { property } from "lit/decorators.js";
import { formatNumber, type Translate } from "../i18n";
import type { PointsEntry } from "../types";
import { defineElement, formatDate } from "../util";

/** §15.5 points_history: entries of the last 12 months, oldest first (valid dates only). */
export function recentPoints(history: PointsEntry[] | undefined, now = new Date()): PointsEntry[] {
  if (!Array.isArray(history)) return [];
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const p = (n: number) => String(n).padStart(2, "0");
  const fromIso = `${from.getFullYear()}-${p(from.getMonth() + 1)}-${p(from.getDate())}`;
  return history
    .filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(e.points) && e.date >= fromIso)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 12, b: 12 };

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

/**
 * Small line chart of the points (SVG, no libraries). Shows nothing with fewer than 2 entries.
 * Each point has a <title> with date and value (hover / long press).
 */
export class LhPointsChart extends LitElement {
  @property({ attribute: false }) entries: PointsEntry[] = [];
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";

  static override styles = css`
    :host { display: block; color: var(--primary-color); width: 100%; max-width: 360px; }
    svg { display: block; width: 100%; height: auto; overflow: visible; }
    .axis { display: flex; justify-content: space-between; font-size: 0.75em; color: var(--secondary-text-color); gap: 8px; }
    .range { font-size: 0.8em; color: var(--secondary-text-color); margin-bottom: 4px; }
    .grid { stroke: var(--divider-color); stroke-width: 1; }
    .line { fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
    .area { fill: currentColor; opacity: 0.12; }
    .dot { fill: var(--card-background-color, #fff); stroke: currentColor; stroke-width: 2; }
  `;

  protected override render() {
    const e = this.entries;
    if (!this.t || !e || e.length < 2) return nothing;
    const x0 = dayNumber(e[0].date);
    const x1 = dayNumber(e[e.length - 1].date);
    const values = e.map((v) => v.points);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spanX = Math.max(1, x1 - x0);
    const spanY = max - min || 1;
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const pts = e.map((v) => {
      const x = PAD.l + ((dayNumber(v.date) - x0) / spanX) * innerW;
      const y = max === min ? PAD.t + innerH / 2 : PAD.t + (1 - (v.points - min) / spanY) * innerH;
      return { x, y, v };
    });
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - PAD.b} L${pts[0].x.toFixed(1)},${H - PAD.b} Z`;
    const first = formatDate(e[0].date, this.language);
    const last = formatDate(e[e.length - 1].date, this.language);
    const label = this.t("tiles_points_chart_label", {
      from: first, to: last, min: formatNumber(min, this.language), max: formatNumber(max, this.language),
    });
    return html`
      <div class="range">${this.t("tiles_points_range", { min: formatNumber(min, this.language), max: formatNumber(max, this.language) })}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label=${label}>
        ${svg`<line class="grid" x1=${PAD.l} x2=${W - PAD.r} y1=${PAD.t} y2=${PAD.t}></line>
          <line class="grid" x1=${PAD.l} x2=${W - PAD.r} y1=${H - PAD.b} y2=${H - PAD.b}></line>
          <path class="area" d=${area}></path>
          <path class="line" d=${line}></path>
          ${pts.length <= 40 ? pts.map((p) => svg`<circle class="dot" cx=${p.x.toFixed(1)} cy=${p.y.toFixed(1)} r="3.5">
            <title>${formatDate(p.v.date, this.language)}: ${this.t("points", { count: p.v.points })}</title></circle>`) : nothing}`}
      </svg>
      <div class="axis"><span>${first}</span><span>${last}</span></div>
    `;
  }
}

defineElement("lh-points-chart", LhPointsChart);

declare global {
  interface HTMLElementTagNameMap { "lh-points-chart": LhPointsChart }
}
