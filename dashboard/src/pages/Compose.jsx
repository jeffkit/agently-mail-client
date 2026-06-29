import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, AlertCircle } from 'lucide-react';
import { useSend } from '../hooks/useApi';

const fieldStyle = {
  display: 'flex', flexDirection: 'column', gap: 6,
  fontSize: 12, color: 'var(--text-dim)', fontWeight: 500,
};

function parseList(val) {
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function draftToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = (md || '').split('\n');
  return lines.map((line) => {
    let s = esc(line);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s.length ? `<p>${s}</p>` : '<br/>';
  }).join('');
}

export function Compose() {
  const send = useSend();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    to: '', cc: '', bcc: '', subject: '', body: '',
  });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const f = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  async function handleSend() {
    setError('');
    const to = parseList(form.to);
    if (to.length === 0) { setError('收件人不能为空'); return; }
    if (!form.subject.trim()) { setError('主题不能为空'); return; }
    if (!form.body.trim()) { setError('正文不能为空'); return; }
    const payload = {
      to,
      cc: parseList(form.cc),
      bcc: parseList(form.bcc),
      subject: form.subject.trim(),
      body: draftToHtml(form.body),
      bodyFormat: 'html',
    };
    send.mutate(payload, {
      onSuccess: () => {
        setDone(true);
        setTimeout(() => navigate('/inbox'), 800);
      },
      onError: (e) => setError(e.message),
    });
  }

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>写邮件</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/inbox')}>取消</button>
      </div>

      <div className="card fade-up">
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={fieldStyle}>
            <span>收件人（逗号分隔）</span>
            <input className="input" value={form.to} onChange={f('to')} placeholder="alice@example.com, bob@example.com" />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={fieldStyle}>
              <span>抄送</span>
              <input className="input" value={form.cc} onChange={f('cc')} placeholder="可选" />
            </label>
            <label style={fieldStyle}>
              <span>密送</span>
              <input className="input" value={form.bcc} onChange={f('bcc')} placeholder="可选" />
            </label>
          </div>
          <label style={fieldStyle}>
            <span>主题</span>
            <input className="input" value={form.subject} onChange={f('subject')} placeholder="邮件主题" />
          </label>
          <label style={fieldStyle}>
            <span>正文（Markdown，将以 HTML 发送）</span>
            <textarea
              className="input"
              rows={12}
              value={form.body}
              onChange={f('body')}
              placeholder="在这里输入正文…&#10;支持 **粗体**、*斜体*、`代码` 和空行分段。"
            />
          </label>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertCircle size={12} />{error}
            </div>
          )}
          {done && (
            <div style={{ fontSize: 12, color: 'var(--green)' }}>✓ 已发送，即将返回收件箱…</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={handleSend} disabled={send.isPending}>
              <Send size={13} />{send.isPending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        注意：发送邮件会真实发出并消耗 API 配额（每次约 2 次请求）。若提示配额紧张请稍后重试。
      </div>
    </div>
  );
}
