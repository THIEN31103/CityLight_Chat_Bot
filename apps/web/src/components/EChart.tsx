import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { useUi } from '@/stores/session';

/** Thin ECharts wrapper that follows the light/dark theme and resizes with its container. */
export function EChart({ option, height = 280, onReady }: { option: echarts.EChartsCoreOption; height?: number; onReady?: (c: echarts.ECharts) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    if (!el.current) return;
    chart.current = echarts.init(el.current, theme === 'dark' ? 'dark' : undefined, { renderer: 'canvas' });
    onReady?.(chart.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    chart.current?.setOption({ backgroundColor: 'transparent', ...option }, { notMerge: true });
  }, [option, theme]);

  return <div ref={el} style={{ height, width: '100%' }} />;
}
