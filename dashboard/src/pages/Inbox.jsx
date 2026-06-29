import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search, Inbox as InboxIcon, Send, DownloadCloud, AlertCircle } from 'lucide-react';
import { useMessages, useSync } from '../hooks/useApi';
import { htmlToText } from '../utils/sanitize';

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

function fmtShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function Inbox() {
  const [dir, setDir] = useState('all'); // all | in | out
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const { data, isLoading, error, refetch, isFetching } = useMessages({ dir, q });
  const sync = useSync();
  const [syncMsg, setSyncMsg] = useState('');
  const navigate = useNavigate();

  const items = data?.items || [];

  function doSearch(e) {
    e.preventDefault();
    setQ(searchInput.trim());
  }

  async function handleSync(source) {
    const label = { pending: '处理日志', inbox: '服务器收件箱', sent: '已发送' }[source] || source;
    setSyncMsg(`正在从${label}同步…`);
    sync.mutate(
      { source, limit: 8 },
      {
        onSuccess: (d) => {
          if (d.quotaExhausted) {
            setSyncMsg(`已同步 ${d.archived} 封，API 配额暂满，还剩 ${d.remaining} 封待下次同步`);
          } else if (d.remaining > 0) {
            setSyncMsg(`已同步 ${d.archived} 封，还剩 ${d.remaining} 封——点击再次同步继续`);
          } else {
            setSyncMsg(`完成：同步 ${d.archived} 封，无剩余${d.failed.length ? `（${d.failed.length} 封失败）` : ''}`);
          }
          setTimeout(() => refetch(), 300);
        },
        onError: (e) => setSyncMsg('同步失败：' + e.message),
      },
    );
  }

  return (
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>收件箱</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{data?.total ?? 0} 封已归档</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            title="手动刷新（不自动轮询，避免占用 API 配额）"
          >
            <RefreshCw size={13} className={isFetching ? 'spin' : ''} />刷新
          </button>
        </div>
      </div>

      {/* Toolbar: folder tabs + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {[
            { k: 'all', label: '全部' },
            { k: 'in', label: '收件' },
            { k: 'out', label: '已发送' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setDir(t.k)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                border: 'none', borderRadius: 6,
                background: dir === t.k ? 'var(--accent)' : 'transparent',
                color: dir === t.k ? '#fff' : 'var(--text-muted)',
                transition: 'all 0.15s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <form onSubmit={doSearch} style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-dim)' }} />
            <input
              className="input"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索主题 / 发件人…"
              style={{ paddingLeft: 30 }}
            />
          </div>
          <button className="btn btn-ghost btn-sm" type="submit">搜索</button>
          {q && <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setQ(''); setSearchInput(''); }}>清除</button>}
        </form>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => handleSync('pending')}
          disabled={sync.isPending}
          title="把处理日志里已记录的邮件逐封拉取正文并归档（受 API 配额限制）"
        >
          <DownloadCloud size={13} />同步历史
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => handleSync('inbox')}
          disabled={sync.isPending}
          title="从服务器拉取最近 30 封收件箱邮件，未归档的逐封读取归档（受 API 配额限制）"
        >
          <DownloadCloud size={13} />拉取最近
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => handleSync('sent')}
          disabled={sync.isPending}
          title="从已发送文件夹拉取最近 30 封回复，未归档的逐封读取并按 references 并入对应会话"
        >
          <DownloadCloud size={13} />同步已发送
        </button>
      </div>

      {syncMsg && (
        <div style={{
          fontSize: 12, color: syncMsg.startsWith('同步失败') ? 'var(--red)' : 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <AlertCircle size={12} />{syncMsg}
        </div>
      )}

      <div className="card fade-up">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>发件人 / 收件人</th>
                <th>主题</th>
                <th>往来</th>
                <th style={{ width: 120 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? <tr><td colSpan={5} className="empty">加载中…</td></tr>
                : error
                  ? <tr><td colSpan={5} className="empty" style={{ color: 'var(--red)' }}>加载失败：{error.message}</td></tr>
                  : items.length === 0
                    ? <tr><td colSpan={5} className="empty">暂无邮件。新邮件会在 bridge 处理后自动归档；旧邮件点开后会 live 拉取并缓存。</td></tr>
                    : items.map((t) => {
                        const isIn = t.last_from;
                        return (
                          <tr
                            key={t.thread_root}
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/inbox/${encodeURIComponent(t.thread_root)}`)}
                          >
                            <td>
                              {isIn
                                ? <InboxIcon size={14} color="var(--accent)" />
                                : <Send size={14} color="var(--green)" />}
                            </td>
                            <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {isIn
                                ? (isIn.name || isIn.email || '—')
                                : (t.last_to?.[0]?.name || t.last_to?.[0]?.email || '收件人')}
                              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                                {isIn ? isIn.email : (t.last_to?.[0]?.email || '')}
                              </div>
                            </td>
                            <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.subject || '(无主题)'}
                              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                                {htmlToText(t.last_body_html, 120)}
                              </div>
                            </td>
                            <td>
                              <span className="badge badge-gray">{t.count} 封</span>
                              {t.incoming_count > 0 && t.incoming_count < t.count && (
                                <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>↩{t.count - t.incoming_count}</span>
                              )}
                            </td>
                            <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtShort(t.last_at)}</td>
                          </tr>
                        );
                      })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        列表来自本地归档（{fmt(data?.updatedAt || new Date().toISOString())}）。仅未归档邮件点开时才会向服务器拉取一次。
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } } .spin { animation: spin 0.8s linear infinite }`}</style>
    </div>
  );
}
