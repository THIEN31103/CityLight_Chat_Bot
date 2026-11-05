import { createBrowserRouter, Navigate } from 'react-router-dom';
import type { Permission } from '@citylight/shared';
import { AppShell } from './components/layout/AppShell';
import { RequireAuth, RequirePerm } from './components/layout/guards';
import { LoginPage } from './pages/LoginPage';
import { MapPage } from './pages/map/MapPage';
import { AlarmsPage } from './pages/AlarmsPage';
import { IncidentsPage } from './pages/incidents/IncidentsPage';
import { IncidentDetailPage } from './pages/incidents/IncidentDetailPage';
import { IncidentReportPage } from './pages/incidents/IncidentReportPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { DimmingPage } from './pages/DimmingPage';
import { BatchesPage } from './pages/BatchesPage';
import { ReportsPage } from './pages/ReportsPage';
import { ActivityLogPage } from './pages/logs/ActivityLogPage';
import { SyncLogPage } from './pages/logs/SyncLogPage';
import { AccountPage } from './pages/AccountPage';
import { AdminPage } from './pages/admin/AdminPage';
import { SystemPage } from './pages/SystemPage';
import { HelpPage } from './pages/HelpPage';
import { ForbiddenPage, NotFoundPage } from './pages/ErrorPages';

const guard = (perm: Permission, el: React.ReactNode) => <RequirePerm perm={perm}>{el}</RequirePerm>;

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: guard('map.view', <MapPage />) },
      { path: 'alarms', element: guard('alarm.view', <AlarmsPage />) },
      { path: 'incidents', element: guard('incident.view', <IncidentsPage />) },
      { path: 'incidents/report', element: guard('incident.view', <IncidentReportPage />) },
      { path: 'incidents/:id', element: guard('incident.view', <IncidentDetailPage />) },
      { path: 'schedules', element: guard('schedule.manage', <SchedulesPage />) },
      { path: 'dimming', element: guard('dimming.manage', <DimmingPage />) },
      { path: 'batches', element: guard('batch.run', <BatchesPage />) },
      { path: 'reports', element: guard('map.view', <ReportsPage />) },
      { path: 'logs/activity', element: guard('log.view', <ActivityLogPage />) },
      { path: 'logs/sync', element: guard('log.view', <SyncLogPage />) },
      { path: 'account', element: <AccountPage /> },
      { path: 'admin', element: <Navigate to="/admin/users" replace /> },
      // AdminPage shows each account the tabs it may use
      { path: 'admin/:tab', element: <AdminPage /> },
      { path: 'system', element: guard('system.view', <SystemPage />) },
      { path: 'help', element: <HelpPage /> },
      { path: '403', element: <ForbiddenPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  // Matches Vite `base` so routes work when the app is served under a sub-path (GitLab Pages).
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
});
