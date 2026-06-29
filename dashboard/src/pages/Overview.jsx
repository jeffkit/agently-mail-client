import { Mail, Users, Clock, Ban, Activity, Wifi, Gauge, ShieldAlert } from 'lucide-react';
import { useState as useApiState, useMe } from '../hooks/useApi';

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

function QuotaCell({ label, value, unit }) {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>
        {value ?? '—'}{unit && value != null ? ` ${unit}` : ''}
      </div>
    </div>
  );
}

function RateLimitCard({ rateLimit, me }) {
  const rl = rateLimit || { enabled: true, capacity: 8, available: 8, recent: 0, waiting: false };
  const pct = rl.capacity > 0 ? (rl.available / rl.capacity) * 100 : 100;
  const barColor = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
  const quota = me?.rate_limits || {};
  return (
    <div className="card fade-up" style={{ animationDelay: '0.03s' }}>
      <div className="card-header">
        <h3><Gauge size={13} />限频与可用额度</h3>
        <span className={`badge ${rl.waiting ? 'badge-yellow' : 'badge-green'}`}>
          {rl.waiting ? '节流等待中' : '正常'}
        </span>
      </div>
      <div className="card-body">
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)' }}>本进程 RPM 令牌桶</span>
            <span className="mono" style={{ color: 'var(--text)' }}>
              {rl.available}/{rl.capacity} 可用 · 近60s {rl.recent} 次
            </span>
          </div>
          <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: barColor, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            自限流 {rl.capacity} req/min（服务端硬上限 10 req/min，预留余量避免 429）
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <QuotaCell label="请求/分钟" value={quota.requests_per_minute} />
          <QuotaCell label="请求/小时" value={quota.requests_per_hour} />
          <QuotaCell label="日发送额度" value={quota.daily_send_quota} unit="封" />
        </div>
      </div>
    </div>
  );
}

export function Overview() {
  const { data, isLoading, error, dataUpdatedAt } = useApiState();
  const { data: me } = useMe();

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

  const { profiles = [], pending = {}, batch = {}, denied = {}, lastPollAt, acl } = data;
  const recent = (pending.entries || []).slice(-5).reverse();

  // 安全警告：未配置 ACL（open access）时显示醒目横幅
  const allowedSenders = acl?.static?.allowedSenders;
  const isOpenAccess = !allowedSenders || allowedSenders.length === 0;

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* 安全警告横幅 */}
      {isOpenAccess && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '14px 18px', borderRadius: 10,
          background: 'rgba(220, 38, 38, 0.08)',
          border: '1px solid rgba(220, 38, 38, 0.3)',
        }}>
          <ShieldAlert size={18} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 13, marginBottom: 4 }}>
              安全警告：未配置 ACL，所有发件人均可触发 AI CLI
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              未找到 <code style={{ fontFamily: 'monospace', background: 'var(--bg-hover)', padding: '1px 5px', borderRadius: 3 }}>email-acl.yaml</code> 或
              {' '}<code style={{ fontFamily: 'monospace', background: 'var(--bg-hover)', padding: '1px 5px', borderRadius: 3 }}>allowed_senders</code> 为空。
              任意人发送邮件即可调用配置的 AI Profile（可能包含危险执行权限）。
              请配置 <code style={{ fontFamily: 'monospace', background: 'var(--bg-hover)', padding: '1px 5px', borderRadius: 3 }}>allowed_senders</code> 白名单后重启 Bridge。
            </div>
          </div>
        </div>
      )}

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

      {/* Rate limit & quota */}
      <RateLimitCard rateLimit={data?.rateLimit} me={me} />

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
