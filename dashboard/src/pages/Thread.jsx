import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Send, AlertCircle } from 'lucide-react';
import { useThread, useReply } from '../hooks/useApi';
import { sanitizeHtml } from '../utils/sanitize';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

function addrLabel(a) {
  if (!a) return '—';
  if (typeof a === 'string') return a;
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function MessageBubble({ rec }) {
  const isIn = rec.direction === 'in';
  const bodyHtml = sanitizeHtml(rec.body_html || rec.body_text || '');
  return (
    <div style={{ display: 'flex', justifyContent: isIn ? 'flex-start' : 'flex-end', marginBottom: 18 }}>
      <div style={{
        maxWidth: '78%',
        background: isIn ? 'var(--bg-card)' : 'var(--accent-dim)',
        border: `1px solid ${isIn ? 'var(--border)' : 'var(--accent)'}`,
        borderRadius: 12,
        padding: '14px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {isIn ? (rec.from?.name || rec.from?.email || '发件人') : '我'}
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
              {isIn ? rec.from?.email : (rec.to?.[0]?.email || '')}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmt(rec.created_at || rec.sent_at)}</div>
        </div>
        {rec.subject && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
            主题：{rec.subject}
          </div>
        )}
        <div
          className="mail-body"
          dangerouslySetInnerHTML={{ __html: bodyHtml || '<p style="color:var(--text-dim)">(无正文)</p>' }}
        />
        {rec.source === 'dashboard' && (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8, textAlign: 'right' }}>via 管理台</div>
        )}
      </div>
    </div>
  );
}

export function Thread() {
  const { threadRoot } = useParams();
  const root = decodeURIComponent(threadRoot || '');
  const { data, isLoading, error, refetch } = useThread(root);
  const reply = useReply();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [replyAll, setReplyAll] = useState(false);
  const [sendErr, setSendErr] = useState('');

  const items = data?.items || [];
  const lastIncoming = [...items].reverse().find((r) => r.direction === 'in');

  async function handleReply() {
    setSendErr('');
    if (!draft.trim()) { setSendErr('请输入回复内容'); return; }
    if (!lastIncoming) { setSendErr('没有可回复的收件'); return; }
    const html = draftToHtml(draft);
    reply.mutate(
      { message_id: lastIncoming.message_id, body: html, replyAll },
      {
        onSuccess: () => { setDraft(''); setTimeout(() => refetch(), 400); navigate('/inbox'); },
        onError: (e) => setSendErr(e.message),
      },
    );
  }

  if (isLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (error) return <div style={{ padding: 40, color: 'var(--red)', textAlign: 'center' }}>加载失败：{error.message}</div>;

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link to="/inbox" className="btn btn-ghost btn-sm"><ArrowLeft size={13} />返回</Link>
        <h1 style={{ fontSize: 18, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {items[0]?.subject || '(无主题)'}
        </h1>
        <span className="badge badge-gray">{items.length} 封</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 16px' }}>
        {items.length === 0
          ? <div className="empty" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>该会话暂无归档记录</div>
          : items.map((rec, i) => <MessageBubble key={(rec.message_id || '') + i} rec={rec} />)}
      </div>

      {/* Reply box */}
      {lastIncoming && (
        <div className="card" style={{ flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>回复给</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{addrLabel(lastIncoming.from)}</span>
            <label style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} />
              回复全部
            </label>
          </div>
          <div style={{ padding: 12 }}>
            <textarea
              className="input"
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="输入回复内容（支持 Markdown，将以 HTML 发送）…"
            />
            {sendErr && (
              <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertCircle size={12} />{sendErr}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={handleReply} disabled={reply.isPending}>
                <Send size={13} />{reply.isPending ? '发送中…' : '发送回复'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minimal markdown → HTML for the reply draft (paragraphs + line breaks + basic formatting). */
function draftToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = (md || '').split('\n');
  const html = lines.map((line) => {
    let s = esc(line);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s.length ? `<p>${s}</p>` : '<br/>';
  }).join('');
  return html;
}
