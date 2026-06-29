import { useState as useApiState } from '../hooks/useApi';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

export function BatchQueue() {
  const { data, isLoading, error } = useApiState();

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  const entries = (data?.batch?.entries || []).filter(e => e.status === 'queued');

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>批处理队列</h1>
        <span className="badge badge-yellow">{entries.length} 封待处理</span>
      </div>

      <div className="card fade-up">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发件人</th>
                <th>主题</th>
                <th>预览</th>
                <th>进入队列时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0
                ? <tr><td colSpan={5} className="empty">批处理队列为空</td></tr>
                : entries.map(e => (
                  <tr key={e.message_id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{e.from_name || e.from_email}</div>
                      {e.from_name && <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>{e.from_email}</div>}
                    </td>
                    <td>{e.subject || '(无主题)'}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 240 }}>
                      {e.body_snippet || '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(e.queued_at)}</td>
                    <td><span className="badge badge-yellow">等待决策</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {entries.length > 0 && (
        <div style={{ padding: '14px 20px', background: 'var(--bg-panel)', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)' }}>
          💡 向管理员邮件地址发送批处理摘要回复来处理这些邮件，格式如"第1封帮我回复，其余跳过"
        </div>
      )}
    </div>
  );
}
