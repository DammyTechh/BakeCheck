/**
 * The frame every signed-in screen sits in.
 *
 * A single top bar rather than a sidebar: this app has six destinations, and
 * a technician works through one task at a time with the sample in front of
 * them. A persistent sidebar would spend horizontal space on navigation that
 * the result screen wants for the colour ladder.
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon } from './ui';
import './AppShell.css';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const TECHNICIAN_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/analyze', label: 'Analyse', icon: 'science' },
  { to: '/results', label: 'Results', icon: 'lab_profile' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'monitoring' },
  { to: '/admin/models', label: 'Models', icon: 'model_training' },
  { to: '/admin/laboratories', label: 'Laboratories', icon: 'apartment' },
];

export function AppShell({ area }: { area: 'technician' | 'admin' }) {
  const { user, signOut, isAdmin } = useAuth();
  const navigate = useNavigate();
  const items = area === 'admin' ? ADMIN_NAV : TECHNICIAN_NAV;

  async function handleSignOut() {
    await signOut();
    navigate('/sign-in', { replace: true });
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell-bar">
        <div className="shell-bar-inner">
          <div className="shell-brand">
            <img
              src="/brand/bakecheck-logo.png"
              alt="BakeCheck"
              className="shell-logo"
              width={118}
              height={22}
            />
            {area === 'admin' ? <span className="shell-area">Admin</span> : null}
          </div>

          <nav className="shell-nav" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/admin'}
                className={({ isActive }) =>
                  `shell-link ${isActive ? 'is-active' : ''}`
                }
              >
                <Icon name={item.icon} className="icon-sm" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="shell-end">
            {isAdmin ? (
              <NavLink
                to={area === 'admin' ? '/dashboard' : '/admin'}
                className="shell-switch"
              >
                {area === 'admin' ? 'Technician view' : 'Admin'}
              </NavLink>
            ) : null}
            <span className="shell-user" title={user?.email}>
              {user?.fullName}
            </span>
            <button className="shell-signout" onClick={handleSignOut} type="button">
              <Icon name="logout" className="icon-sm" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="shell-main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

/** Page heading with optional actions and breadcrumb. */
export function PageHead({
  title,
  description,
  breadcrumb,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumb?: { label: string; to: string }[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="pagehead">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="crumbs" aria-label="Breadcrumb">
          {breadcrumb.map((c) => (
            <NavLink key={c.to} to={c.to} className="crumb">
              {c.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
      <div className="pagehead-row">
        <div>
          <h1>{title}</h1>
          {description ? <p className="pagehead-desc">{description}</p> : null}
        </div>
        {actions ? <div className="pagehead-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
