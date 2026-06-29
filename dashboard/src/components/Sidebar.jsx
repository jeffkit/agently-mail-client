import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Mail, Users, ShieldCheck, Clock, Ban, Sun, Moon,
} from 'lucide-react';
import { useMe } from '../hooks/useApi';

const NAV = [
  { to: '/',         icon: LayoutDashboard, label: '概览' },
  { to: '/history',  icon: Mail,            label: '邮件历史' },
  { to: '/profiles', icon: Users,           label: 'Profile 路由' },
  { to: '/acl',      icon: ShieldCheck,     label: '访问控制' },
  { to: '/queue',    icon: Clock,           label: '批处理队列' },
  { to: '/denied',   icon: Ban,             label: '拦截记录' },
];

function NavItem({ to, icon: Icon, label }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        color: isActive ? 'var(--text)' : 'var(--text-muted)',
        background: isActive ? 'var(--bg-hover)' : 'transparent',
        textDecoration: 'none',
        transition: 'all 0.1s',
        borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
        paddingLeft: isActive ? 10 : 12,
      })}
    >
      <Icon size={15} strokeWidth={1.8} />
      {label}
    </NavLink>
  );
}

function AccountBadge() {
  const { data, isLoading } = useMe();
  const primary = data?.aliases?.find(a => a.is_primary) || data?.aliases?.[0];

  if (isLoading) return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ height: 12, width: 100, background: 'var(--border)', borderRadius: 4 }} />
    </div>
  );

  if (!primary) return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-dim)' }}>
      未登录账号
    </div>
  );

  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--accent), #7c3aed)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0,
        letterSpacing: '-0.02em',
      }}>
        {(primary.name || primary.email || '?')[0].toUpperCase()}
      </div>
      <div style={{ overflow: 'hidden' }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {primary.name || primary.email}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {primary.email}
        </div>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  );
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('agently-theme', next);
  };
  return (
    <button
      onClick={toggle}
      className="btn btn-ghost btn-sm"
      title={theme === 'light' ? '切换暗色模式' : '切换亮色模式'}
      style={{ padding: '4px 8px', flexShrink: 0 }}
    >
      {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}

export function Sidebar({ pollAt }) {
  const now = pollAt
    ? new Date(pollAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <nav style={{
      width: 'var(--sidebar-w)',
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      position: 'sticky',
      top: 0,
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Logo */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>✉</span>
          Agently Mail
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>
          EMAIL CHANNEL ADAPTER
        </div>
      </div>

      {/* Account info */}
      <AccountBadge />

      {/* Navigation */}
      <div style={{ flex: 1, padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
        {NAV.map(item => <NavItem key={item.to} {...item} />)}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 16px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 11,
        color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}>
        <span>上次轮询 {now}</span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
