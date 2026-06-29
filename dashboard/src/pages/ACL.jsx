import { useState } from 'react';
import { Plus, Trash2, ShieldCheck, ShieldOff, RotateCcw } from 'lucide-react';
import { useState as useApiState, useAclMutation } from '../hooks/useApi';

function Chip({ label, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 99, padding: '3px 10px',
      fontSize: 12, fontFamily: 'var(--font-mono)',
      color: 'var(--text-muted)',
    }}>
      {label}
      {onRemove && (
        <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 1, padding: 0 }}>
          <Trash2 size={10} />
        </button>
      )}
    </span>
  );
}

function ChipGroup({ title, items, emptyText }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items?.length
          ? items.map(a => <Chip key={a} label={a} />)
          : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{emptyText || '（无）'}</span>}
      </div>
    </div>
  );
}

function AclControl() {
  const mut = useAclMutation();
  const [addr, setAddr] = useState('');
  const [msg, setMsg] = useState('');

  async function act(action) {
    if (!addr.trim()) { setMsg('请输入邮箱或域名'); return; }
    setMsg('');
    mut.mutate({ action, address: addr.trim() }, {
      onSuccess: (r) => { setMsg(r.message || '操作成功'); setAddr(''); },
      onError: (e) => setMsg('错误：' + e.message),
    });
  }

  return (
    <div style={{ padding: '16px 20px', background: 'var(--bg-panel)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>动态 ACL 管理</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input" style={{ flex: 1, minWidth: 220 }}
          placeholder="user@example.com 或 @example.com"
          value={addr} onChange={e => setAddr(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && act('allow')}
        />
        <button className="btn btn-primary btn-sm" disabled={mut.isPending} onClick={() => act('allow')}>
          <ShieldCheck size={13} />允许
        </button>
        <button className="btn btn-ghost btn-sm" disabled={mut.isPending} onClick={() => act('deny')}
          style={{ borderColor: 'rgba(255,91,91,0.3)', color: 'var(--red)' }}>
          <ShieldOff size={13} />拒绝
        </button>
        <button className="btn btn-ghost btn-sm" disabled={mut.isPending} onClick={() => act('reset')}>
          <RotateCcw size={13} />重置
        </button>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12, color: msg.startsWith('错误') ? 'var(--red)' : 'var(--green)' }}>{msg}</div>}
    </div>
  );
}

export function ACL() {
  const { data, isLoading, error } = useApiState();

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  const acl = data?.acl || { static: {}, dynamic: {} };
  const s = acl.static;
  const d = acl.dynamic;

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>访问控制</h1>
        <span className="badge badge-blue">{s.denyAction || 'silent'} 模式</span>
      </div>

      <AclControl />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card fade-up card-body">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>静态配置（email-acl.yaml）</div>
          <ChipGroup title="管理员" items={s.adminSenders} emptyText="未配置" />
          <ChipGroup title="即时回复" items={s.instantReplySenders} />
          <ChipGroup title="静态白名单" items={s.allowedSenders} />
          <ChipGroup title="静态黑名单" items={s.deniedSenders} />
        </div>
        <div className="card fade-up card-body" style={{ animationDelay: '0.05s' }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 16, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>动态配置（运行时）</div>
          <ChipGroup title="动态白名单" items={d.allowed} />
          <ChipGroup title="动态黑名单" items={d.denied} />
        </div>
      </div>
    </div>
  );
}
