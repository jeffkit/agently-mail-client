import { useState as useApiState } from '../hooks/useApi';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

export function DeniedLog() {
  const { data, isLoading, error } = useApiState();

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  const entries = data?.denied?.entries || [];

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>拦截记录</h1>
        <span className="badge badge-red">{data?.denied?.unreported ?? 0} 条未上报</span>
      </div>

      <div className="card fade-up">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发件人</th>
                <th>主题</th>
                <th>拦截时间</th>
                <th>原因</th>
                <th>上报</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0
                ? <tr><td colSpan={5} className="empty">无拦截记录</td></tr>
                : entries.slice().reverse().map((e, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{e.from_name || e.from_email}</div>
                      {e.from_name && <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>{e.from_email}</div>}
                    </td>
                    <td>{e.subject || '(无主题)'}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(e.received_at)}</td>
                    <td><span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.reason || '—'}</span></td>
                    <td>{e.reported
                      ? <span className="badge badge-green">已上报</span>
                      : <span className="badge badge-yellow">未上报</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
