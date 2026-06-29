import { Mail, Users, Clock, Ban, Activity, Wifi } from 'lucide-react';
import { useState as useApiState } from '../hooks/useApi';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

function StatCard({ icon: Icon, value, label, color = 'var(--accent)' }) {
  return (
    <div className="card fade-up" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color }}>
            {value ?? '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, fontWeight: 500 }}>
            {label}
          </div>
        </div>
        <div style={{
          width: 36, height: 36,
          borderRadius: 10,
          background: `${color}1a`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={16} color={color} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}

function RecentRow({ entry }) {
  const { replied, retries, last_error, from_name, from_email, subject, added_at } = entry;
  const status = replied
    ? (retries > 0 ? 'retry' : 'ok')
    : (retries > 0 ? 'failed' : 'queued');
  const badges = {
    ok:     { label: '已回复',     cls: 'badge-green' },
    retry:  { label: '重试后回复', cls: 'badge-yellow' },
    failed: { label: '失败',       cls: 'badge-red' },
    queued: { label: '等待中',     cls: 'badge-gray' },
  };
  const b = badges[status];
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 500 }}>{from_name || from_email}</div>
        {from_name && <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{from_email}</div>}
      </td>
      <td>
        <div>{subject || '(无主题)'}</div>
        {last_error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 3 }}>{last_error.slice(0, 80)}</div>}
      </td>
      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmt(added_at)}</td>
      <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
    </tr>
  );
}

export function Overview() {
  const { data, isLoading, error, dataUpdatedAt } = useApiState();

  if (isLoading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
      <div className="spinner" />
    </div>
  );
  if (error) return (
    <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>
      加载失败：{error.message}
    </div>
  );

  const { profiles = [], pending = {}, batch = {}, denied = {}, lastPollAt } = data;
  const recent = (pending.entries || []).slice(-5).reverse();

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>概览</h1>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Wifi size={12} />
          更新于 {fmt(new Date(dataUpdatedAt).toISOString())}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatCard icon={Users}    value={profiles.length}         label="已加载 Profile" color="var(--accent)" />
        <StatCard icon={Mail}     value={pending.queued ?? 0}     label="待重试邮件"      color="var(--yellow)" />
        <StatCard icon={Clock}    value={batch.queued ?? 0}       label="批处理队列"      color="var(--green)" />
        <StatCard icon={Ban}      value={denied.unreported ?? 0}  label="未上报拦截"      color="var(--red)" />
      </div>

      {/* Recent mails */}
      <div className="card fade-up" style={{ animationDelay: '0.05s' }}>
        <div className="card-header">
          <h3><Activity size={13} />最近处理记录</h3>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>最近 {recent.length} 条</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发件人</th>
                <th>主题</th>
                <th>时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0
                ? <tr><td colSpan={4} className="empty">暂无记录</td></tr>
                : recent.map(e => <RecentRow key={e.message_id} entry={e} />)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
