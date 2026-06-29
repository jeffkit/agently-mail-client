import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar';
import { Overview } from './pages/Overview';
import { Inbox }    from './pages/Inbox';
import { Thread }   from './pages/Thread';
import { Compose }  from './pages/Compose';
import { History }  from './pages/History';
import { Profiles } from './pages/Profiles';
import { ACL }      from './pages/ACL';
import { BatchQueue } from './pages/BatchQueue';
import { DeniedLog }  from './pages/DeniedLog';
import { useState as useApiState } from './hooks/useApi';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 2, staleTime: 5_000 } },
});

function Layout() {
  const { data } = useApiState();
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar pollAt={data?.lastPollAt} />
      <main style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        <Routes>
          <Route path="/"                 element={<Overview />} />
          <Route path="/inbox"            element={<Inbox />} />
          <Route path="/inbox/:threadRoot" element={<Thread />} />
          <Route path="/compose"          element={<Compose />} />
          <Route path="/history"          element={<History />} />
          <Route path="/profiles"         element={<Profiles />} />
          <Route path="/acl"              element={<ACL />} />
          <Route path="/queue"            element={<BatchQueue />} />
          <Route path="/denied"           element={<DeniedLog />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Layout />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
