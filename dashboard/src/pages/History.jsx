import { Trash2 } from 'lucide-react';
import { useState as useApiState, useDiscardPending } from '../hooks/useApi';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

function StatusBadge({ entry }) {
  const { replied, retries } = entry;
  if (replied && retries > 0) return <span className="badge badge-yellow">重试后回复</span>;
  if (replied)                return <span className="badge badge-green">已回复</span>;
  if (retries > 0)            return <span className="badge badge-red">失败</span>;
  return                             <span className="badge badge-gray">等待中</span>;
}

export function History() {
  const { data, isLoading, error } = useApiState();
  const discard = useDiscardPending();
  const [confirming, setConfirming] = useState(null);

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  const entries = (data?.pending?.entries || []).slice().reverse();

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>邮件历史</h1>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>共 {entries.length} 条</span>
      </div>

      <div className="card fade-up">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发件人</th>
                <th>主题</th>
                <th>接收时间</th>
                <th>回复时间</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0
                ? <tr><td colSpan={6} className="empty">暂无历史记录</td></tr>
                : entries.map(e => (
                  <tr key={e.message_id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{e.from_name || e.from_email}</div>
                      {e.from_name && <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>{e.from_email}</div>}
                    </td>
                    <td>
                      <div style={{ maxWidth: 280 }}>{e.subject || '(无主题)'}</div>
                      {e.last_error && (
                        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 3, maxWidth: 280 }}>
                          {e.last_error.slice(0, 100)}
                        </div>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(e.added_at)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(e.replied_at)}</td>
                    <td><StatusBadge entry={e} /></td>
                    <td>
                      {!e.replied && (
                        confirming === e.message_id
                          ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-danger btn-sm"
                                disabled={discard.isPending}
                                onClick={() => discard.mutate({ message_id: e.message_id }, { onSuccess: () => setConfirming(null) })}>
                                确认丢弃
                              </button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>取消</button>
                            </div>
                          )
                          : (
                            <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(e.message_id)}>
                              <Trash2 size={12} />丢弃
                            </button>
                          )
                      )}
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

// Need to import useState from React (not named conflict)
import { useState } from 'react';
