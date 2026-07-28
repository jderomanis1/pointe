import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { createRetro } from '../lib/api';
import { isRoomSlug } from '../lib/slug';

export type RetroNavState = {
  participantId: string;
  displayName: string;
  role: 'facilitator';
};

type Action = 'create' | 'join';

export function RetroHomePage() {
  const navigate = useNavigate();
  const [action, setAction] = useState<Action>('create');
  const [name, setName] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const facilitatorName = name.trim();
    if (facilitatorName.length < 1 || facilitatorName.length > 60) {
      setError('Choose a name between 1 and 60 characters.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await createRetro({ facilitatorName });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.message || 'Could not create the retrospective.');
      return;
    }
    const navState: RetroNavState = {
      participantId: result.data.participantId,
      displayName: facilitatorName,
      role: 'facilitator',
    };
    navigate(`/retro/${result.data.slug}`, { state: navState });
  }

  function join(e: FormEvent) {
    e.preventDefault();
    const slug = retroSlugFromReference(reference);
    if (!slug) {
      setError('Enter a valid retrospective link or code, such as calm-fox-42.');
      return;
    }
    setError(null);
    navigate(`/retro/${slug}`);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text font-sans">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[620px] opacity-70"
        style={{
          background:
            'radial-gradient(circle at 12% 8%, rgba(46,158,143,.18), transparent 34%), radial-gradient(circle at 86% 16%, rgba(255,138,61,.18), transparent 32%)',
        }}
      />

      <header className="relative mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Link to="/" className="inline-flex items-center gap-3" aria-label="Pointe home">
          <RetroMark />
          <span>
            <span className="block font-serif text-3xl leading-none tracking-[-.03em]">Pointe Retro</span>
            <span className="mt-1 block text-[10px] font-bold uppercase tracking-[.18em] text-text-muted">Turn reflection into action</span>
          </span>
        </Link>
        <Link
          to="/"
          className="rounded-full border border-hairline bg-surface px-4 py-2 text-sm font-bold shadow-card transition-transform hover:-translate-y-0.5"
        >
          Planning poker
        </Link>
      </header>

      <section className="relative mx-auto grid w-full max-w-7xl gap-12 px-5 pb-20 pt-12 sm:px-8 lg:grid-cols-[1.08fr_.92fr] lg:items-center lg:gap-16 lg:px-10 lg:pb-28 lg:pt-20">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface/90 px-3 py-1.5 text-meta font-semibold text-text-secondary shadow-card">
            Start · Stop · Continue, without the awkward silence
          </div>
          <h1 className="mt-7 max-w-3xl font-serif text-[clamp(3.2rem,7vw,6.5rem)] leading-[.89] tracking-[-.045em]">
            Make the retro feel worth the calendar invite.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
            Give every teammate space to think independently, then move into a focused review that turns observations into a useful conversation. No account, template setup, or installation.
          </p>

          <div className="mt-9 grid max-w-2xl gap-3 sm:grid-cols-3">
            <Promise title="Think first" body="Entry mode protects independent reflection before the group discussion." />
            <Promise title="Review together" body="Move through the board, mark topics discussed, and see progress." />
            <Promise title="Leave with a record" body="Export the board as a clean Markdown summary for the team." />
          </div>
        </div>

        <section className="rounded-[28px] border border-hairline bg-surface p-3 shadow-[0_22px_70px_rgba(72,41,19,.16)] sm:p-4">
          <div className="grid grid-cols-2 rounded-[18px] bg-fill p-1.5" role="tablist" aria-label="Retrospective action">
            <ActionTab active={action === 'create'} onClick={() => { setAction('create'); setError(null); }}>
              Start a retro
            </ActionTab>
            <ActionTab active={action === 'join'} onClick={() => { setAction('join'); setError(null); }}>
              Join a retro
            </ActionTab>
          </div>

          <div className="p-3 sm:p-5">
            {action === 'create' ? (
              <form className="flex min-h-[410px] flex-col justify-center gap-5" onSubmit={create}>
                <div>
                  <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Create a shared board</p>
                  <h2 className="mt-2 font-serif text-4xl leading-none tracking-[-.03em]">Facilitate, do not administer.</h2>
                  <p className="mt-3 text-sm leading-6 text-text-secondary">You will control entry, review, discussed topics, export, and closure.</p>
                </div>
                <Input
                  id="facilitator-name"
                  label="Your name"
                  placeholder="e.g. Maya"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  error={error ?? undefined}
                  helper={error ? undefined : 'Shown to the room as facilitator.'}
                  disabled={submitting}
                  autoFocus
                />
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating Retro…' : 'Create Retrospective'}
                </Button>
                <p className="text-center text-caption font-semibold text-text-muted">Free · private by default · no participant accounts</p>
              </form>
            ) : (
              <form className="flex min-h-[410px] flex-col justify-center gap-5" onSubmit={join}>
                <div>
                  <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Join your team</p>
                  <h2 className="mt-2 font-serif text-4xl leading-none tracking-[-.03em]">One link, then straight to reflection.</h2>
                  <p className="mt-3 text-sm leading-6 text-text-secondary">Paste the full invitation or enter the room code. Choose participant or observer on the next screen.</p>
                </div>
                <Input
                  id="retro-reference"
                  label="Retro link or code"
                  placeholder="calm-fox-42"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  error={error ?? undefined}
                  helper={error ? undefined : 'Example: pointe.team/retro/calm-fox-42'}
                  autoFocus
                />
                <Button type="submit">Join Retrospective</Button>
              </form>
            )}
          </div>
        </section>
      </section>

      <section className="border-y border-hairline bg-surface/70">
        <div className="mx-auto grid max-w-7xl gap-px border-x border-hairline bg-hairline sm:grid-cols-3">
          <ColumnPreview label="Start" title="Ideas worth trying" example="Add a mid-sprint product check-in before work drifts." />
          <ColumnPreview label="Stop" title="Friction to remove" example="Stop carrying unclear acceptance criteria into planning." />
          <ColumnPreview label="Continue" title="What is working" example="Keep pairing engineering and QA before refinement." />
        </div>
      </section>

      <footer className="relative mx-auto flex w-full max-w-7xl flex-col gap-3 px-5 py-8 text-sm text-text-secondary sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <span>Pointe Retro · built for honest, useful team reflection</span>
        <Link className="font-bold text-text hover:text-accent-text" to="/">Estimate stories with Pointe →</Link>
      </footer>
    </main>
  );
}

function RetroMark() {
  return (
    <span className="grid size-11 grid-cols-2 gap-1 rounded-[13px] border-2 border-text bg-surface p-1.5 shadow-card" aria-hidden="true">
      <span className="rounded-[4px] bg-[#2E9E8F]" />
      <span className="rounded-[4px] bg-[#E04F4F]" />
      <span className="col-span-2 rounded-[4px] bg-[#F2B94B]" />
    </span>
  );
}

function ActionTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={active
        ? 'min-h-11 rounded-[14px] bg-surface px-3 text-sm font-bold text-text shadow-card'
        : 'min-h-11 rounded-[14px] px-3 text-sm font-bold text-text-secondary hover:text-text'}
    >
      {children}
    </button>
  );
}

function Promise({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[18px] border border-hairline bg-surface/80 p-4 shadow-card">
      <p className="font-bold text-text">{title}</p>
      <p className="mt-2 text-caption leading-5 text-text-secondary">{body}</p>
    </div>
  );
}

function ColumnPreview({ label, title, example }: { label: string; title: string; example: string }) {
  return (
    <article className="bg-surface p-6 sm:p-8">
      <p className="text-meta font-black uppercase tracking-[.14em] text-accent-text">{label}</p>
      <h2 className="mt-3 text-xl font-bold">{title}</h2>
      <div className="mt-5 rotate-[-1deg] rounded-[14px] border border-hairline bg-bg p-4 text-sm leading-6 text-text-secondary shadow-card">
        {example}
      </div>
    </article>
  );
}

function retroSlugFromReference(reference: string): string | null {
  const trimmed = reference.trim().toLowerCase();
  if (!trimmed) return null;
  let candidate = trimmed;
  try {
    const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    if (url.hostname.includes('.') || trimmed.includes('/')) {
      candidate = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    }
  } catch {
    candidate = trimmed;
  }
  candidate = candidate.split(/[?#]/)[0] ?? '';
  return isRoomSlug(candidate) ? candidate : null;
}
