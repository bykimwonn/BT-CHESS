import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="container section"><span className="loading" /> Checking your session…</div>;
  if (!user) return <Navigate to={`/auth?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (admin && user.role !== 'admin') {
    return (
      <div className="container section">
        <div className="alert alert-danger"><strong>Administrator access required.</strong> This area is protected by role-based access control.</div>
      </div>
    );
  }
  return <>{children}</>;
}
