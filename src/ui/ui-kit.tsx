import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** The header every card shares: an icon tile, the h3 title, a one-line hint and optional controls. */
export function CardTitle({
  icon,
  title,
  sub,
  children,
}: {
  icon: IconName;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="card-title">
      <span className="card-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="card-title-text">
        <h3>{title}</h3>
        {sub ? <p className="card-sub">{sub}</p> : null}
      </div>
      {children ? <div className="card-title-actions">{children}</div> : null}
    </header>
  );
}
