import { useState } from 'react';
import { Plus, Pencil, Trash2, Star, X } from 'lucide-react';
import { useState as useApiState, useSaveProfile, useDeleteProfile } from '../hooks/useApi';

function ProfileModal({ profile, onClose }) {
  const save = useSaveProfile();
  const del  = useDeleteProfile();
  const isNew = !profile;

  const [form, setForm] = useState({
    name:         profile?.name         || '',
    trigger:      profile?.trigger      || '',
    command:      profile?.command      || '',
    args:         (profile?.args || []).join('\n'),
    workdir:      profile?.workdir      || '',
    description:  profile?.description  || '',
    timeout_ms:   profile?.timeout_ms   || '',
    system_prompt:profile?.system_prompt|| '',
  });
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  async function handleSave() {
    setError('');
    if (!form.name.trim() || !form.command.trim()) {
      setError('名称和命令不能为空');
      return;
    }
    const payload = {
      name:    form.name.trim(),
      trigger: form.trigger.trim() || form.name.trim(),
      command: form.command.trim(),
      args:    form.args.split('\n').map(s => s.trim()).filter(Boolean),
      workdir: form.workdir.trim() || null,
      description: form.description.trim() || null,
      timeout_ms:  form.timeout_ms ? parseInt(form.timeout_ms, 10) : null,
      system_prompt: form.system_prompt.trim() || null,
    };
    save.mutate(payload, { onSuccess: onClose, onError: (e) => setError(e.message) });
  }

  async function handleDelete() {
    del.mutate(profile.name, { onSuccess: onClose, onError: (e) => setError(e.message) });
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, backdropFilter: 'blur(4px)',
    }}>
      <div className="card fade-up" style={{ width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-header">
          <h3>{isNew ? '添加 Profile' : `编辑 — ${profile.name}`}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={fieldStyle}>
              <span>Profile 名称</span>
              <input className="input" value={form.name} onChange={f('name')} disabled={!isNew} placeholder="claude-code" />
            </label>
            <label style={fieldStyle}>
              <span>触发前缀（[tag]）</span>
              <input className="input" value={form.trigger} onChange={f('trigger')} placeholder="留空使用名称" />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={fieldStyle}>
              <span>命令</span>
              <input className="input" value={form.command} onChange={f('command')} placeholder="node" />
            </label>
            <label style={fieldStyle}>
              <span>超时 (ms)</span>
              <input className="input" value={form.timeout_ms} onChange={f('timeout_ms')} placeholder="默认 120000" type="number" />
            </label>
          </div>
          <label style={fieldStyle}>
            <span>参数（每行一个）</span>
            <textarea className="input" rows={3} value={form.args} onChange={f('args')} placeholder="./profiles/claude-code.js" />
          </label>
          <label style={fieldStyle}>
            <span>工作目录</span>
            <input className="input" value={form.workdir} onChange={f('workdir')} placeholder="留空使用默认" />
          </label>
          <label style={fieldStyle}>
            <span>说明</span>
            <input className="input" value={form.description} onChange={f('description')} placeholder="可选" />
          </label>
          <label style={fieldStyle}>
            <span>系统提示词</span>
            <textarea className="input" rows={3} value={form.system_prompt} onChange={f('system_prompt')} placeholder="可选" />
          </label>

          {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
            <div>
              {!isNew && (
                confirmDelete
                  ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-danger btn-sm" disabled={del.isPending} onClick={handleDelete}>确认删除</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>取消</button>
                    </div>
                  )
                  : <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}><Trash2 size={12} />删除</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>取消</button>
              <button className="btn btn-primary" disabled={save.isPending} onClick={handleSave}>
                {save.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldStyle = {
  display: 'flex', flexDirection: 'column', gap: 6,
  fontSize: 12, color: 'var(--text-dim)', fontWeight: 500,
};

export function Profiles() {
  const { data, isLoading, error } = useApiState();
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new, obj = edit

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  const profiles = data?.profiles || [];

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Profile 路由</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing(null)}>
          <Plus size={13} />添加
        </button>
      </div>

      <div className="card fade-up">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>触发前缀</th>
                <th>命令</th>
                <th>工作目录</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profiles.length === 0
                ? <tr><td colSpan={5} className="empty">未配置 Profile</td></tr>
                : profiles.map(p => (
                  <tr key={p.name}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                        {p.isDefault && <Star size={12} fill="var(--yellow)" color="var(--yellow)" />}
                        {p.name}
                      </div>
                      {p.description && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{p.description}</div>}
                    </td>
                    <td><code style={{ background: 'var(--bg)', padding: '2px 8px', borderRadius: 4, fontSize: 12, color: 'var(--accent)' }}>[{p.trigger}]</code></td>
                    <td>
                      <span className="mono" style={{ color: 'var(--text-muted)' }}>{p.command}</span>
                      {p.args?.length > 0 && (
                        <span className="mono" style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{p.args.join(' ')}</span>
                      )}
                    </td>
                    <td>
                      {p.workdir
                        ? <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.workdir}</span>
                        : <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>默认</span>}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                        <Pencil size={12} />编辑
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== undefined && (
        <ProfileModal profile={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}
