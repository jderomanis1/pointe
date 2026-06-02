import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <div className="max-w-xl mx-auto px-6 py-24 text-center">
        <h1 className="font-serif text-display text-text">Not found</h1>
        <p className="text-text-secondary text-body mt-3">
          That page doesn&apos;t exist. Room URLs look like
          {' '}<span className="font-mono text-text">apt-sparrow-16</span>.
        </p>
        <p className="mt-6">
          <Link to="/" className="text-accent font-medium">Create a room →</Link>
        </p>
      </div>
    </main>
  );
}
