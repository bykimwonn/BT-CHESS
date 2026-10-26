import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function NotFoundPage() {
  return (
    <div className="container-narrow section text-center">
      <span className="eyebrow">404</span>
      <h1>This square is empty.</h1>
      <p className="hero-lead" style={{ marginInline: 'auto' }}>The page or game you requested does not exist, or you do not have permission to view it.</p>
      <div className="row-wrap" style={{ justifyContent: 'center', marginTop: '1.5rem' }}>
        <Link className="btn btn-primary" to="/play"><Icon name="board" size={17} /> Go to the lobby</Link>
        <Link className="btn" to="/">Home</Link>
        <Link className="btn btn-ghost" to="/help">Help centre</Link>
      </div>
    </div>
  );
}
