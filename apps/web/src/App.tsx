import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import { SignIn } from './pages/SignIn';
import { Register } from './pages/Register';
import { Dashboard } from './pages/Dashboard';
import { Analyze } from './pages/Analyze';
import { Results } from './pages/Results';
import { AnalysisDetail } from './pages/AnalysisDetail';
import { SampleDetail } from './pages/SampleDetail';
import { Settings } from './pages/Settings';
import { AdminOverview } from './pages/admin/AdminOverview';
import { Models } from './pages/admin/Models';
import { Laboratories, LaboratoryDetail } from './pages/admin/Laboratories';
import { NotFound } from './pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Retrying a 4xx just repeats the same refusal. Only transient
        // failures are worth a second attempt.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  // Not a 403 page: someone without admin rights has no use for one, and
  // sending them to their own dashboard is more useful than a dead end.
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function RedirectHome() {
  const { user, loading, isAdmin } = useAuth();
  if (loading) return <Spinner label="Loading…" />;
  if (!user) return <Navigate to="/sign-in" replace />;
  return <Navigate to={isAdmin ? '/admin' : '/dashboard'} replace />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<RedirectHome />} />
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/register" element={<Register />} />

            <Route
              element={
                <RequireAuth>
                  <AppShell area="technician" />
                </RequireAuth>
              }
            >
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/analyze" element={<Analyze />} />
              <Route path="/results" element={<Results />} />
              <Route path="/analyses/:analysisId" element={<AnalysisDetail />} />
              <Route path="/samples/:sampleId" element={<SampleDetail />} />
              <Route path="/settings" element={<Settings />} />
            </Route>

            <Route
              element={
                <RequireAuth>
                  <RequireAdmin>
                    <AppShell area="admin" />
                  </RequireAdmin>
                </RequireAuth>
              }
            >
              <Route path="/admin" element={<AdminOverview />} />
              <Route path="/admin/models" element={<Models />} />
              <Route path="/admin/laboratories" element={<Laboratories />} />
              <Route
                path="/admin/laboratories/:laboratoryId"
                element={<LaboratoryDetail />}
              />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
