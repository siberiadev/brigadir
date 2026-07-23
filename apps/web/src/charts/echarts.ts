import { computed, type ComputedRef } from 'vue';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import type { MetricsGranularity, TimeBucketedSeries } from '@brigadir/contracts';
import { useTheme } from '../composables/useTheme';

/**
 * Tree-shaken ECharts registration (feature 029, R1). Only the pieces the
 * metrics charts use are pulled in via `echarts/core` — a bar/line/stacked-area
 * set with grid, tooltip and legend on the canvas renderer — so the bundle
 * carries none of the full `echarts` package. `<v-chart>` (vue-echarts) is
 * imported per-component from the `vue-echarts` default export.
 */
use([CanvasRenderer, BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent]);

/**
 * Categorical palette for non-semantic series (executors, sources, roles,
 * workspaces, token types). Deliberately NOT the brand `--el-color-*` set — the
 * amber primary is reserved for semantic single-series lines — but a neutral,
 * theme-agnostic ramp that reads on both light and dark grids. Centralised here
 * (never hardcoded in components) per the branding convention.
 */
export const CHART_PALETTE = [
  '#f59e0b', // amber (brand primary — first category)
  '#3b82f6', // blue
  '#10b981', // emerald
  '#a855f7', // violet
  '#ef4444', // red
  '#14b8a6', // teal
  '#ec4899', // pink
  '#84cc16', // lime
  '#6366f1', // indigo
  '#64748b', // slate (also the __unknown__ tone)
] as const;

/**
 * Run-status → Element Plus color role, mirroring `RunStatusTag`'s map so a
 * status looks the same on a chart as on a tag. Resolved to the live
 * `--el-color-*` value at option-build time.
 */
export const STATUS_COLOR_ROLE: Record<string, ChartThemeColorKey> = {
  succeeded: 'success',
  running: 'primary',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'info',
  superseded: 'info',
  awaiting_human: 'warning',
  queued: 'info',
};

export type ChartThemeColorKey = 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface ChartTheme {
  text: string;
  textSecondary: string;
  axisLine: string;
  splitLine: string;
  tooltipBg: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  palette: readonly string[];
}

/** Read a CSS custom property off <html>, falling back when unresolved (jsdom). */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Live chart theme derived from the app's `--el-*` variables. Recomputes when
 * the color mode flips (the dependency on `mode.value`) so charts re-skin with
 * the rest of the UI. Semantic colors come straight from the brand vars
 * (branding convention — no hardcoded brand hex in components).
 */
export function useChartTheme(): ComputedRef<ChartTheme> {
  const { mode } = useTheme();
  return computed<ChartTheme>(() => {
    void mode.value; // re-read CSS vars whenever the theme toggles
    return {
      text: cssVar('--el-text-color-primary', '#303133'),
      textSecondary: cssVar('--el-text-color-secondary', '#909399'),
      axisLine: cssVar('--el-border-color', '#dcdfe6'),
      splitLine: cssVar('--el-border-color-lighter', '#ebeef5'),
      tooltipBg: cssVar('--el-bg-color-overlay', '#ffffff'),
      primary: cssVar('--el-color-primary', '#f59e0b'),
      success: cssVar('--el-color-success', '#16a34a'),
      warning: cssVar('--el-color-warning', '#ea580c'),
      danger: cssVar('--el-color-danger', '#dc2626'),
      info: cssVar('--el-color-info', '#64748b'),
      palette: CHART_PALETTE,
    };
  });
}

/**
 * Base ECharts option scaffold shared by every metrics chart — grid insets,
 * theme-aware axes/tooltip/legend and the time-bucket category x-axis. Callers
 * spread this and add `series` (+ any y-axis overrides).
 */
export function baseTimeOption(
  theme: ChartTheme,
  bucketLabels: string[],
): Record<string, unknown> {
  return {
    color: theme.palette,
    grid: { top: 32, right: 16, bottom: 28, left: 48, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.splitLine,
      textStyle: { color: theme.text },
    },
    legend: { type: 'scroll', textStyle: { color: theme.textSecondary }, top: 0 },
    xAxis: {
      type: 'category',
      data: bucketLabels,
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.textSecondary },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisLabel: { color: theme.textSecondary },
      splitLine: { lineStyle: { color: theme.splitLine } },
    },
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO bucket start → short axis label: `HH:00` (hour) or `MM-DD` (day), UTC. */
export function formatBucketLabel(iso: string, granularity: MetricsGranularity): string {
  const d = new Date(iso);
  return granularity === 'hour'
    ? `${pad(d.getUTCHours())}:00`
    : `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface TimeSeriesOpts {
  /** Series key → legend name (defaults to the raw key). */
  labelFn?: (key: string) => string;
  /** Series key → explicit color (else the categorical palette). */
  colorFn?: (key: string) => string | undefined;
  /** Stack the series (stacked bar / stacked area). */
  stack?: boolean;
  /** Fill under lines (area). */
  area?: boolean;
  /** y-axis is a 0..1 ratio rendered as %. */
  percent?: boolean;
}

/**
 * Build an ECharts option from a `TimeBucketedSeries` — the shared line/bar
 * renderer for every metrics timeline. Points are coerced with Number() so
 * money strings plot as values.
 */
export function timeSeriesOption(
  theme: ChartTheme,
  tb: TimeBucketedSeries,
  type: 'line' | 'bar',
  opts: TimeSeriesOpts = {},
): Record<string, unknown> {
  const labels = tb.buckets.map((iso) => formatBucketLabel(iso, tb.granularity));
  const base = baseTimeOption(theme, labels);
  const series = tb.series.map((s) => {
    const color = opts.colorFn?.(s.key);
    return {
      // Prefer the series' own label (e.g. workspace name), else the labelFn.
      name: s.label ?? (opts.labelFn ? opts.labelFn(s.key) : s.key),
      type,
      ...(type === 'line' ? { smooth: true, showSymbol: false } : {}),
      ...(opts.stack ? { stack: 'total' } : {}),
      ...(opts.area ? { areaStyle: {} } : {}),
      ...(color ? { itemStyle: { color }, lineStyle: { color } } : {}),
      data: (s.points ?? []).map((p) => Number(p)),
    };
  });
  const option: Record<string, unknown> = { ...base, series };
  if (opts.percent) {
    option.yAxis = {
      ...(base.yAxis as Record<string, unknown>),
      max: 1,
      min: 0,
      axisLabel: { color: theme.textSecondary, formatter: (v: number) => `${Math.round(v * 100)}%` },
    };
    option.tooltip = {
      ...(base.tooltip as Record<string, unknown>),
      valueFormatter: (v: number) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`),
    };
  }
  return option;
}

/**
 * Build a simple horizontal category bar (non-time), used for the top-N
 * workspaces-by-cost chart. `values` align with `categories`.
 */
export function categoryBarOption(
  theme: ChartTheme,
  categories: string[],
  values: number[],
): Record<string, unknown> {
  return {
    color: theme.palette,
    grid: { top: 16, right: 24, bottom: 24, left: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.splitLine,
      textStyle: { color: theme.text },
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: theme.textSecondary },
      splitLine: { lineStyle: { color: theme.splitLine } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: categories,
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.textSecondary },
    },
    series: [{ type: 'bar', data: values, itemStyle: { color: theme.primary } }],
  };
}

/** True when every series of a timeline is all-zeros/empty (drives the empty state). */
export function isSeriesEmpty(tb: TimeBucketedSeries | undefined): boolean {
  if (!tb || tb.series.length === 0) return true;
  return tb.series.every((s) => s.points.every((p) => Number(p) === 0));
}
