import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '@/lib/api';
import { fill, useDict } from '@/i18n';
import { INCIDENTS } from '@/i18n/dict/incidents';
import { useIncidentText } from './IncidentsPage';
import { EChart } from '@/components/EChart';
import { Card, CardHeader, Input, PageHeader, Spinner } from '@/components/ui';

export function IncidentReportPage() {
  const t = useDict(INCIDENTS).report;
  const tx = useIncidentText();
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const { data } = useQuery({ queryKey: ['incident-report', month], queryFn: () => api.incidentReport(month) });

  const byDay = useMemo(
    () => ({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 40, right: 16, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: data?.byDay.map((d) => d.day) ?? [] },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        { name: t.series.new, type: 'bar', stack: 's', data: data?.byDay.map((d) => d.new), itemStyle: { color: '#dc2626' } },
        { name: t.series.assigned, type: 'bar', stack: 's', data: data?.byDay.map((d) => d.assigned), itemStyle: { color: '#ea580c' } },
        { name: t.series.deferred, type: 'bar', stack: 's', data: data?.byDay.map((d) => d.deferred), itemStyle: { color: '#94a3b8' } },
        { name: t.series.done, type: 'bar', stack: 's', data: data?.byDay.map((d) => d.done), itemStyle: { color: '#16a34a' } },
        { name: t.series.total, type: 'line', data: data?.byDay.map((d) => d.new + d.assigned + d.deferred + d.done), itemStyle: { color: '#2563eb' } },
      ],
    }),
    [data, t],
  );
  const pie = (rec: Record<string, number> | undefined, label: (k: string) => string) => ({
    tooltip: { trigger: 'item' },
    series: [{ type: 'pie', radius: ['40%', '70%'], data: Object.entries(rec ?? {}).map(([name, value]) => ({ name: label(name), value })), label: { fontSize: 11 } }],
  });

  return (
    <div className="p-4">
      <PageHeader title={t.title} actions={<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />} />
      {!data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card className="p-4"><div className="text-xs text-subtle">{t.total}</div><div className="text-2xl font-semibold">{data.total}</div></Card>
            <Card className="p-4"><div className="text-xs text-subtle">{t.done}</div><div className="text-2xl font-semibold text-st-on">{data.byDay.reduce((s, d) => s + d.done, 0)}</div></Card>
            <Card className="p-4"><div className="text-xs text-subtle">{t.avgTime}</div><div className="text-2xl font-semibold">{fill(t.hours, { n: data.avgResolveHours.toFixed(1) })}</div></Card>
            <Card className="p-4"><div className="text-xs text-subtle">{t.overdue}</div><div className="text-2xl font-semibold text-st-offline">{data.overdue}</div></Card>
          </div>
          <Card>
            <CardHeader title={fill(t.byDay, { month: dayjs(month).format('MM/YYYY') })} />
            <div className="p-2"><EChart option={byDay} height={320} /></div>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card><CardHeader title={t.byArea} /><div className="p-2"><EChart option={pie(data.byDistrict, tx.area)} height={260} /></div></Card>
            <Card><CardHeader title={t.byCategory} /><div className="p-2"><EChart option={pie(data.byCategory, tx.category)} height={260} /></div></Card>
          </div>
        </div>
      )}
    </div>
  );
}
