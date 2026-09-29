import { Link, useLocation } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';

/**
 * An address that matches nothing.
 *
 * This used to redirect to the dashboard, which made a mistyped or stale link
 * indistinguishable from a working one: the address bar was quietly rewritten to "/" and
 * the dashboard appeared, so nobody learned that the link they followed was wrong. Saying
 * so costs one screen and saves the person guessing why their bookmark "works" but shows
 * something else.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div>
      <PageHeader title="That page does not exist" description="The address did not match anything in the console." />
      <EmptyState
        title={pathname}
        description={
          'Nothing in this product is served from that address. If you followed a link from '
          + 'somewhere else it may be out of date, and if you typed it, check the spelling.'
        }
        action={<Link to="/" className="btn-primary btn-sm">Go to the dashboard</Link>}
      />
    </div>
  );
}
