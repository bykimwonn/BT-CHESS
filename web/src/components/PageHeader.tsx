import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string; title: string; description?: string; actions?: ReactNode;
}) {
  return (
    <header className="section-head" style={{ marginBottom: '1.75rem' }}>
      <div className="min-w-0">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 style={{ fontSize: 'clamp(2rem, 4vw, 3.1rem)', marginTop: '.35rem' }}>{title}</h1>
        {description && <p className="soft" style={{ maxWidth: '70ch' }}>{description}</p>}
      </div>
      {actions && <div className="row-wrap">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="alert alert-danger">
      <strong>Could not load this section.</strong>
      <div className="small">{message}</div>
      {retry && <button className="btn btn-sm" style={{ marginTop: '.5rem' }} onClick={retry}>Try again</button>}
    </div>
  );
}
