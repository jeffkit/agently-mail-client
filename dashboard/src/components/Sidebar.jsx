import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Mail, Users, ShieldCheck, Clock, Ban, Settings
} from 'lucide-react';
const NAV = [
  { to: '/',         icon: LayoutDashboard, label: '概览' },
  { to: '/history',  icon: Mail,            label: '邮件历史' },
  { to: '/profiles', icon: Users,           label: 'Profile 路由' },
  { to: '/acl',      icon: ShieldCheck,     label: '访问控制' },
  { to: '/queue',    icon: Clock,           label: '批处理队列' },
  { to: '/denied',   icon: Ban,             label: '拦截记录' },
];

const css = {
  nav: {
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
  },
  logo: {
    padding: '20px 20px 16px',
    borderBottom: '1px solid var(--border-subtle)',
  },
  logoTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    letterSpacing: '0.02em',
  },
  logoSub: {
    fontSize: 11,
    color: 'var(--text-dim)',
    marginTop: 2,
    fontFamily: 'var(--font-mono)',
  },
  list: {
    flex: 1,
    padding: '10px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    overflowY: 'auto',
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border-subtle)',
    fontSize: 11,
    color: 'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
  },
};

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
        boxShadow: isActive ? 'inset 2px 0 0 var(--accent)' : 'none',
      })}
    >
      <Icon size={15} strokeWidth={1.8} />
      {label}
    </NavLink>
  );
}

export function Sidebar({ pollAt }) {
  const now = pollAt ? new Date(pollAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
  return (
    <nav style={css.nav}>
      <div style={css.logo}>
        <div style={css.logoTitle}>✉ Agently Mail</div>
        <div style={css.logoSub}>email channel adapter</div>
      </div>
      <div style={css.list}>
        {NAV.map(item => <NavItem key={item.to} {...item} />)}
      </div>
      <div style={css.footer}>
        上次轮询 {now}
      </div>
    </nav>
  );
}
