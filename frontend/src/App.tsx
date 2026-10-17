import * as React from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { Spinner } from "@/components/kit";
import { HomePage } from "@/pages/Home";

const lazyPage = <K extends string>(loader: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  React.lazy(() => loader().then((m) => ({ default: m[name] })));

const ComparePage = lazyPage(() => import("@/pages/Compare"), "ComparePage");
const BulkPage = lazyPage(() => import("@/pages/Bulk"), "BulkPage");
const JobPage = lazyPage(() => import("@/pages/Job"), "JobPage");
const RunPage = lazyPage(() => import("@/pages/Run"), "RunPage");
const HistoryPage = lazyPage(() => import("@/pages/History"), "HistoryPage");
const BatchPage = lazyPage(() => import("@/pages/Batch"), "BatchPage");
const TemplatesPage = lazyPage(() => import("@/pages/Templates"), "TemplatesPage");
const ConnectionsPage = lazyPage(() => import("@/pages/Connections"), "ConnectionsPage");
const SqlIdePage = lazyPage(() => import("@/pages/SqlIde"), "SqlIdePage");
const DiffMergePage = lazyPage(() => import("@/pages/DiffMerge"), "DiffMergePage");
const SettingsPage = lazyPage(() => import("@/pages/Settings"), "SettingsPage");

function Fallback() {
  return (
    <div className="flex h-64 items-center justify-center text-muted-foreground">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

function LegacyRun() {
  const { runUuid } = useParams();
  return <Navigate to={`/runs/${runUuid}`} replace />;
}

export default function App() {
  return (
    <AppShell>
      <React.Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/bulk" element={<BulkPage />} />
          <Route path="/jobs/:jobId" element={<JobPage />} />
          <Route path="/runs/:runUuid" element={<RunPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/history/:runUuid" element={<LegacyRun />} />
          <Route path="/batches/:batchUuid" element={<BatchPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/sql-ide" element={<SqlIdePage />} />
          <Route path="/diff-merge" element={<DiffMergePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/file-compare" element={<Navigate to="/compare?source_kind=file&target_kind=file" replace />} />
          <Route path="/batch" element={<Navigate to="/bulk" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </React.Suspense>
    </AppShell>
  );
}
