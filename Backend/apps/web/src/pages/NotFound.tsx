import { Link } from 'react-router-dom';
import { Button, EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <div style={{ maxWidth: 520, margin: '12vh auto', padding: '0 var(--s5)' }}>
      <EmptyState
        icon="explore_off"
        title="That page does not exist"
        action={
          <Link to="/">
            <Button variant="primary">Go to your dashboard</Button>
          </Link>
        }
      >
        The link may be out of date, or the record may have been removed.
      </EmptyState>
    </div>
  );
}
