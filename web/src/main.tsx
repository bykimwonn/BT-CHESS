import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './app/ToastProvider';
import { ThemeProvider } from './app/ThemeProvider';
import { AuthProvider } from './app/AuthProvider';
import { SocketProvider } from './app/SocketProvider';
import { App } from './app/App';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
    mutations: { retry: 0 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');

// StrictMode is intentionally not used: double-mounting Web Workers and
// authenticated WebSocket connections would create misleading reconnections.
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <ThemeProvider>
        <AuthProvider>
          <SocketProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </SocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </ToastProvider>
  </QueryClientProvider>,
);
