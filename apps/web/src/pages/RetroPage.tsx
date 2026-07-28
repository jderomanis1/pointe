import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import type {
  RetroClientMessage,
  RetroColumn,
  RetroMode,
  RetroNote,
  RetroRole,
  RetroServerMessage,
  RetroSnapshot,
} from '@pointe/shared';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { buildRetroWsUrl, getRetro } from '../lib/api';
import type { RetroNavState } from './RetroHomePage';

const COLUMN_META: Record<RetroColumn, { label: string; title: string; prompt: string; accent: string }> = {
  start: {
    label: 'Start',
    title: 'Ideas worth trying',
    prompt: 'What could make the next sprint better?',
    accent: '#2E9E8F',
  },
  stop: {
    label: 'Stop',
    title: 'Friction to remove',
    prompt: 'What is slowing the team down?',
    accent: '#D75B55',
  },
  continue: {
    label: 'Continue',
    title: 'What is working',
    prompt: 'What should the team protect?',
    accent: '#B77A00',
  },
};

type Probe =
  | { kind: 'loading' }
  | { kind: 'found'; state: 'open' | 'closed' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

type ConnectionParams = {
  participantId?: string;
  displayName?: string;
  role: 'participant' | 'observer';
};

type StoredResume = {
  participantId: string;
  displayName: string;
  role: RetroRole;
};

export function RetroPage({ slug }: { slug: string }) {
  const location = useLocation();
  const navState = (location.state as RetroNavState | null) ?? null;
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' });
  const [connection, setConnection] = useState<ConnectionParams | null>(() => {
    if (navState?.participantId) {
      return {
        participantId: navState.participantId,
        displayName: navState.displayName,
        role: 'participant',
      };
    }
    const stored = readResume(slug);
    return stored
      ? {
          participantId: stored.participantId,
          displayName: stored.displayName,
          role: stored.role === 'observer' ? 'observer' : 'participant',
        }
      : null;
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await getRetro(slug);
      if (!alive) return;
      if (result.ok) setProbe({ kind: 'found', state: result.data.state });
      else if (result.status === 404) setProbe({ kind: 'not_found' });
      else setProbe({ kind: 'error', message: result.error.message });
    })();
    return () => { alive = false; };
  }, [slug]);

  if (probe.kind === 'loading') {
    return <RetroShell><StatusCard>Opening retrospective <RoomCode slug={slug} />…</StatusCard></RetroShell>;
  }
  if (probe.kind === 'not_found') {
    return (
      <RetroShell>
        <StatusCard>
          <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Board unavailable</p>
          <h1 className="mt-3 font-serif text-5xl leading-none">No retrospective is open here.</h1>
          <p className="mt-4 leading-7 text-text-secondary">Check the invitation or start a fresh Start · Stop · Continue board.</p>
          <Link to="/retro" className="mt-7 inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-bold text-accent-ink shadow-card">
            Create a retrospective
          </Link>
        </StatusCard>
      </RetroShell>
    );
  }
  if (probe.kind === 'error') {
    return <RetroShell><StatusCard>Could not reach Pointe: {probe.message}</StatusCard></RetroShell>;
  }
  if (!connection) {
    return (
      <RetroJoinForm
        slug={slug}
        closed={probe.state === 'closed'}
        onJoin={setConnection}
      />
    );
  }

  return (
    <RetroConnected
      slug={slug}
      params={connection}
      onReset={() => {
        sessionStorage.removeItem(resumeKey(slug));
        setConnection(null);
      }}
    />
  );
}

function RetroConnected({ slug, params, onReset }: { slug: string; params: ConnectionParams; onReset: () => void }) {
  const client = useRetroSocket(slug, params);

  if (!client.snapshot) {
    return (
      <RetroShell>
        <StatusCard>
          <p>{client.status === 'connected' ? 'Joining' : 'Connecting to'} <RoomCode slug={slug} />…</p>
          {client.error ? (
            <div className="mt-5 rounded-[14px] bg-error-surface p-4 text-sm text-error-on">
              <p>{client.error}</p>
              <button type="button" className="mt-3 font-bold underline" onClick={onReset}>Join with a different name</button>
            </div>
          ) : null}
        </StatusCard>
      </RetroShell>
    );
  }

  return (
    <RetroBoard
      snapshot={client.snapshot}
      send={client.send}
      connectionStatus={client.status}
      error={client.error}
    />
  );
}

function RetroJoinForm({ slug, closed, onJoin }: {
  slug: string;
  closed: boolean;
  onJoin: (params: ConnectionParams) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'participant' | 'observer'>('participant');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    if (displayName.length < 1 || displayName.length > 60) {
      setError('Choose a name between 1 and 60 characters.');
      return;
    }
    onJoin({ displayName, role });
  }

  return (
    <RetroShell>
      <section className="rounded-[26px] border border-hairline bg-surface p-5 shadow-pop sm:p-8">
        <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">You&apos;re invited</p>
        <h1 className="mt-3 font-serif text-5xl leading-none tracking-[-.035em]">Join the retrospective.</h1>
        <p className="mt-3 text-sm text-text-secondary">Room <RoomCode slug={slug} /></p>
        {closed ? (
          <div className="mt-5 rounded-[14px] border border-warning bg-warning-surface p-4 text-sm text-warning-on">
            This retrospective is closed. You can still join to review and export the final board.
          </div>
        ) : null}
        <form onSubmit={submit} className="mt-7 flex flex-col gap-5">
          <Input
            id="retro-join-name"
            label="Your name"
            placeholder="e.g. Jordan"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error ?? undefined}
            autoFocus
          />
          <fieldset>
            <legend className="mb-2 text-meta font-bold uppercase tracking-[.1em] text-text-secondary">How will you join?</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <RoleChoice
                checked={role === 'participant'}
                onChange={() => setRole('participant')}
                title="Participant"
                body="Add, edit, and move your notes."
              />
              <RoleChoice
                checked={role === 'observer'}
                onChange={() => setRole('observer')}
                title="Observer"
                body="Follow the board without adding notes."
              />
            </div>
          </fieldset>
          <Button type="submit">Join retrospective</Button>
        </form>
      </section>
    </RetroShell>
  );
}

function RoleChoice({ checked, onChange, title, body }: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label className={checked
      ? 'cursor-pointer rounded-[16px] border border-accent bg-accent-tint p-4 shadow-card'
      : 'cursor-pointer rounded-[16px] border border-hairline bg-surface p-4 hover:border-text-muted'}>
      <input className="sr-only" type="radio" name="retro-role" checked={checked} onChange={onChange} />
      <span className="block font-bold text-text">{title}</span>
      <span className="mt-1 block text-caption leading-5 text-text-secondary">{body}</span>
    </label>
  );
}

function RetroBoard({ snapshot, send, connectionStatus, error }: {
  snapshot: RetroSnapshot;
  send: (message: RetroClientMessage) => void;
  connectionStatus: 'connecting' | 'connected' | 'reconnecting';
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const isFacilitator = snapshot.you.role === 'facilitator';
  const isObserver = snapshot.you.role === 'observer';
  const readOnly = snapshot.state === 'closed' || isObserver;
  const discussedCount = snapshot.notes.filter((note) => note.discussed).length;

  async function copyInvite() {
    const link = window.location.href;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  function exportBoard() {
    const lines = [
      `# Pointe Retrospective: ${snapshot.slug}`,
      '',
      `Status: ${snapshot.state === 'closed' ? 'Closed' : 'Open'}`,
      `Exported: ${new Date().toLocaleString()}`,
      '',
    ];
    (Object.keys(COLUMN_META) as RetroColumn[]).forEach((column) => {
      const meta = COLUMN_META[column];
      lines.push(`## ${meta.label}: ${meta.title}`, '');
      const notes = snapshot.notes.filter((note) => note.column === column);
      if (notes.length === 0) lines.push('- No notes');
      notes.forEach((note) => {
        const author = note.anonymous ? 'Anonymous' : note.authorName ?? 'Team member';
        lines.push(`- [${note.discussed ? 'x' : ' '}] ${note.text} _(${author})_`);
      });
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pointe-retro-${snapshot.slug}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-bg text-text font-sans">
      <header className="sticky top-0 z-30 border-b border-hairline bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link to="/retro" className="font-serif text-3xl leading-none tracking-[-.03em]">Pointe Retro</Link>
            <span className="hidden rounded-full border border-hairline bg-surface px-3 py-1 font-mono text-caption font-bold text-text-secondary sm:inline-flex">
              {snapshot.slug}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionPill status={connectionStatus} />
            <button type="button" onClick={() => void copyInvite()} className="min-h-10 rounded-full border border-hairline bg-surface px-4 text-sm font-bold shadow-card hover:-translate-y-0.5">
              {copied ? 'Link copied' : 'Invite team'}
            </button>
            <button type="button" onClick={exportBoard} className="min-h-10 rounded-full border border-hairline bg-surface px-4 text-sm font-bold shadow-card hover:-translate-y-0.5">
              Export
            </button>
            <Link to="/" className="min-h-10 rounded-full border border-hairline bg-surface px-4 py-2 text-sm font-bold shadow-card hover:-translate-y-0.5">
              Planning poker
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        {error ? <div className="mb-4 rounded-[14px] bg-error-surface p-3 text-sm text-error-on" role="alert">{error}</div> : null}
        {snapshot.state === 'closed' ? (
          <div className="mb-5 flex flex-col gap-2 rounded-[18px] border border-warning bg-warning-surface p-4 text-warning-on sm:flex-row sm:items-center sm:justify-between">
            <strong>This retrospective is closed and read-only.</strong>
            <span className="text-sm">The final board remains available for review and export.</span>
          </div>
        ) : null}

        <section className="mb-5 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Team retrospective</p>
            <h1 className="mt-2 font-serif text-[clamp(2.5rem,5vw,4.5rem)] leading-none tracking-[-.035em]">
              {snapshot.mode === 'entry' ? 'Think independently.' : 'Review the useful themes.'}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary sm:text-base">
              {snapshot.mode === 'entry'
                ? 'Your own notes stay visible to you. Other teammates’ ideas remain covered until the facilitator opens review, reducing anchoring and groupthink.'
                : 'All notes are visible. Discuss the important patterns, mark topics complete, and capture what the team wants to carry forward.'}
            </p>
          </div>
          {isFacilitator ? (
            <FacilitatorControls
              mode={snapshot.mode}
              state={snapshot.state}
              confirmClose={confirmClose}
              setConfirmClose={setConfirmClose}
              setMode={(mode) => send({ type: 'SET_MODE', payload: { mode } })}
              close={() => send({ type: 'CLOSE_RETRO', payload: {} })}
            />
          ) : (
            <div className="rounded-[18px] border border-hairline bg-surface p-4 text-sm shadow-card">
              <p className="font-bold">{isObserver ? 'Observer mode' : 'Participant mode'}</p>
              <p className="mt-1 text-text-secondary">{snapshot.mode === 'entry' ? 'The facilitator will open review when the team is ready.' : 'Review is open.'}</p>
            </div>
          )}
        </section>

        <section className="mb-5 flex flex-col gap-4 rounded-[20px] border border-hairline bg-surface p-4 shadow-card lg:flex-row lg:items-center lg:justify-between">
          <ParticipantStrip participants={snapshot.participants} />
          <div className="min-w-[220px]">
            <div className="flex items-center justify-between text-caption font-bold text-text-secondary">
              <span>Discussion progress</span>
              <span>{discussedCount}/{snapshot.notes.length}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-fill" aria-label={`${discussedCount} of ${snapshot.notes.length} notes discussed`}>
              <div
                className="h-full rounded-full bg-success transition-all"
                style={{ width: snapshot.notes.length ? `${(discussedCount / snapshot.notes.length) * 100}%` : '0%' }}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-3" aria-label="Start Stop Continue retrospective board">
          {(Object.keys(COLUMN_META) as RetroColumn[]).map((column) => (
            <RetroColumnPanel
              key={column}
              column={column}
              notes={snapshot.notes.filter((note) => note.column === column)}
              mode={snapshot.mode}
              readOnly={readOnly}
              isFacilitator={isFacilitator}
              viewerId={snapshot.you.participantId}
              send={send}
            />
          ))}
        </section>
      </div>
    </main>
  );
}

function FacilitatorControls({ mode, state, confirmClose, setConfirmClose, setMode, close }: {
  mode: RetroMode;
  state: 'open' | 'closed';
  confirmClose: boolean;
  setConfirmClose: (value: boolean) => void;
  setMode: (mode: RetroMode) => void;
  close: () => void;
}) {
  if (state === 'closed') return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 rounded-[18px] border border-hairline bg-surface p-2 shadow-card">
      <div className="flex rounded-full bg-fill p-1" aria-label="Retrospective mode">
        <ModeButton active={mode === 'entry'} onClick={() => setMode('entry')}>Entry</ModeButton>
        <ModeButton active={mode === 'review'} onClick={() => setMode('review')}>Review</ModeButton>
      </div>
      {!confirmClose ? (
        <button type="button" onClick={() => setConfirmClose(true)} className="min-h-9 rounded-full px-3 text-sm font-bold text-error-on hover:bg-error-surface">
          Close retro
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-full bg-error-surface pl-3 text-caption font-bold text-error-on">
          Make read-only?
          <button type="button" onClick={close} className="min-h-9 rounded-full bg-error px-3 text-white">Confirm</button>
          <button type="button" onClick={() => setConfirmClose(false)} className="min-h-9 rounded-full px-3">Cancel</button>
        </div>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={active
        ? 'min-h-9 rounded-full bg-surface px-4 text-sm font-bold text-text shadow-card'
        : 'min-h-9 rounded-full px-4 text-sm font-bold text-text-secondary hover:text-text'}
    >
      {children}
    </button>
  );
}

function RetroColumnPanel({ column, notes, mode, readOnly, isFacilitator, viewerId, send }: {
  column: RetroColumn;
  notes: RetroNote[];
  mode: RetroMode;
  readOnly: boolean;
  isFacilitator: boolean;
  viewerId: string;
  send: (message: RetroClientMessage) => void;
}) {
  const meta = COLUMN_META[column];
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);

  function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: 'ADD_NOTE', payload: { column, text: trimmed, anonymous } });
    setText('');
    setAnonymous(false);
  }

  return (
    <article className="min-h-[560px] rounded-[24px] border border-hairline bg-surface p-3 shadow-card sm:p-4">
      <header className="rounded-[18px] bg-fill p-4" style={{ borderTop: `5px solid ${meta.accent}` }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-meta font-black uppercase tracking-[.14em]" style={{ color: meta.accent }}>{meta.label}</p>
            <h2 className="mt-1 text-xl font-bold">{meta.title}</h2>
          </div>
          <span className="rounded-full bg-surface px-3 py-1 text-caption font-black text-text-secondary shadow-card">{notes.length}</span>
        </div>
        <p className="mt-2 text-caption leading-5 text-text-secondary">{meta.prompt}</p>
      </header>

      {!readOnly && mode === 'entry' ? (
        <form onSubmit={add} className="mt-3 rounded-[18px] border border-hairline bg-bg p-3">
          <label className="sr-only" htmlFor={`note-${column}`}>Add a {meta.label} note</label>
          <textarea
            id={`note-${column}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder={meta.prompt}
            className="w-full resize-none rounded-[12px] border border-hairline bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-caption font-semibold text-text-secondary">
              <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
              Post anonymously
            </label>
            <button
              type="submit"
              disabled={!text.trim()}
              className="min-h-9 rounded-full bg-accent px-4 text-sm font-bold text-accent-ink shadow-card disabled:opacity-50"
            >
              Add note
            </button>
          </div>
        </form>
      ) : null}

      <div className="mt-3 flex flex-col gap-3">
        {notes.length === 0 ? (
          <div className="grid min-h-32 place-items-center rounded-[16px] border border-dashed border-hairline px-4 text-center text-sm text-text-muted">
            {mode === 'entry' ? 'A quiet column is fine. Give the team space to think.' : 'No notes in this column.'}
          </div>
        ) : null}
        {notes.map((note) => (
          <RetroNoteCard
            key={note.id}
            note={note}
            mode={mode}
            isFacilitator={isFacilitator}
            viewerId={viewerId}
            readOnly={readOnly}
            send={send}
          />
        ))}
      </div>
    </article>
  );
}

function RetroNoteCard({ note, mode, isFacilitator, viewerId, readOnly, send }: {
  note: RetroNote;
  mode: RetroMode;
  isFacilitator: boolean;
  viewerId: string;
  readOnly: boolean;
  send: (message: RetroClientMessage) => void;
}) {
  const own = note.authorId === viewerId;
  const hidden = mode === 'entry' && !own;
  const canEdit = !readOnly && (own || isFacilitator);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);

  useEffect(() => setDraft(note.text), [note.text]);

  if (hidden) {
    return (
      <div className="rounded-[16px] border border-dashed border-hairline bg-bg p-4 text-center text-sm text-text-muted">
        <span className="block text-xl" aria-hidden="true">✦</span>
        <span className="mt-1 block font-semibold">A teammate added a private entry.</span>
        <span className="mt-1 block text-caption">Content appears when review opens.</span>
      </div>
    );
  }

  function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    send({ type: 'UPDATE_NOTE', payload: { noteId: note.id, text: trimmed } });
    setEditing(false);
  }

  return (
    <div className={note.discussed
      ? 'rounded-[16px] border border-success bg-success-surface p-4 opacity-70'
      : 'rounded-[16px] border border-hairline bg-bg p-4 shadow-card'}>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={500}
            rows={4}
            className="w-full resize-none rounded-[12px] border border-hairline bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => { setEditing(false); setDraft(note.text); }} className="min-h-8 rounded-full px-3 text-caption font-bold text-text-secondary">Cancel</button>
            <button type="button" onClick={save} className="min-h-8 rounded-full bg-accent px-3 text-caption font-bold text-accent-ink">Save</button>
          </div>
        </div>
      ) : (
        <>
          <p className={note.discussed ? 'text-sm leading-6 line-through' : 'text-sm leading-6'}>{note.text}</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
            <span className="text-caption font-semibold text-text-muted">
              {note.anonymous ? 'Anonymous' : note.authorName ?? 'Team member'}
              {own ? ' · you' : ''}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-1">
              {isFacilitator && mode === 'review' && !readOnly ? (
                <button
                  type="button"
                  onClick={() => send({ type: 'TOGGLE_DISCUSSED', payload: { noteId: note.id } })}
                  className={note.discussed
                    ? 'min-h-8 rounded-full bg-success px-3 text-caption font-bold text-white'
                    : 'min-h-8 rounded-full bg-success-surface px-3 text-caption font-bold text-success-on'}
                >
                  {note.discussed ? 'Discussed' : 'Mark discussed'}
                </button>
              ) : null}
              {canEdit ? (
                <>
                  <select
                    aria-label="Move note"
                    value={note.column}
                    onChange={(event) => send({
                      type: 'MOVE_NOTE',
                      payload: { noteId: note.id, column: event.target.value as RetroColumn },
                    })}
                    className="min-h-8 rounded-full border border-hairline bg-surface px-2 text-caption font-bold"
                  >
                    <option value="start">Start</option>
                    <option value="stop">Stop</option>
                    <option value="continue">Continue</option>
                  </select>
                  <button type="button" onClick={() => setEditing(true)} className="min-h-8 rounded-full px-2 text-caption font-bold text-text-secondary hover:bg-fill">Edit</button>
                  <button
                    type="button"
                    onClick={() => send({ type: 'DELETE_NOTE', payload: { noteId: note.id } })}
                    className="min-h-8 rounded-full px-2 text-caption font-bold text-error-on hover:bg-error-surface"
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ParticipantStrip({ participants }: { participants: RetroSnapshot['participants'] }) {
  const connected = participants.filter((participant) => participant.connected);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {connected.map((participant) => (
          <div key={participant.id} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-bg py-1 pl-1 pr-3">
            <span className="grid size-8 place-items-center rounded-full bg-accent-tint text-caption font-black text-accent-text">
              {initials(participant.displayName)}
            </span>
            <span className="max-w-32 truncate text-caption font-bold">{participant.displayName}</span>
            {participant.role !== 'participant' ? (
              <span className="text-[10px] font-bold uppercase tracking-[.08em] text-text-muted">{participant.role}</span>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-2 text-caption text-text-muted">{connected.length} connected · {participants.length} joined</p>
    </div>
  );
}

function ConnectionPill({ status }: { status: 'connecting' | 'connected' | 'reconnecting' }) {
  return (
    <span className={status === 'connected'
      ? 'rounded-full bg-success-surface px-3 py-1 text-caption font-bold text-success-on'
      : 'rounded-full bg-warning-surface px-3 py-1 text-caption font-bold text-warning-on'}>
      {status === 'connected' ? 'Live' : status === 'reconnecting' ? 'Reconnecting' : 'Connecting'}
    </span>
  );
}

function RetroShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text font-sans">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-70"
        style={{ background: 'radial-gradient(circle at 14% 8%, rgba(46,158,143,.18), transparent 34%), radial-gradient(circle at 86% 16%, rgba(255,138,61,.16), transparent 28%)' }}
      />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link to="/retro" className="font-serif text-3xl leading-none tracking-[-.03em]">Pointe Retro</Link>
        <Link to="/" className="rounded-full border border-hairline bg-surface px-3 py-1.5 text-caption font-bold shadow-card">Planning poker</Link>
      </header>
      <div className="relative mx-auto flex min-h-[calc(100vh-150px)] max-w-xl items-center px-5 py-10 sm:px-8">
        <div className="w-full">{children}</div>
      </div>
    </main>
  );
}

function StatusCard({ children }: { children: ReactNode }) {
  return <div className="rounded-[24px] border border-hairline bg-surface p-6 text-text-secondary shadow-pop sm:p-8">{children}</div>;
}

function RoomCode({ slug }: { slug: string }) {
  return <span className="font-mono font-bold text-text">{slug}</span>;
}

function useRetroSocket(slug: string, params: ConnectionParams) {
  const [snapshot, setSnapshot] = useState<RetroSnapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let openedOnce = false;

    function connect() {
      if (!active) return;
      setStatus(openedOnce ? 'reconnecting' : 'connecting');
      const socket = new WebSocket(buildRetroWsUrl(slug));
      socketRef.current = socket;
      socket.onopen = () => {
        if (!active) return;
        openedOnce = true;
        setStatus('connected');
        setError(null);
        socket.send(JSON.stringify({
          type: 'JOIN',
          payload: {
            slug,
            displayName: params.displayName,
            resumeParticipantId: params.participantId,
            role: params.role,
          },
        } satisfies RetroClientMessage));
      };
      socket.onmessage = (event) => {
        if (!active) return;
        try {
          const message = JSON.parse(String(event.data)) as RetroServerMessage;
          if (message.type === 'SNAPSHOT') {
            setSnapshot(message.payload);
            const self = message.payload.participants.find((participant) => participant.id === message.payload.you.participantId);
            if (self) {
              sessionStorage.setItem(resumeKey(slug), JSON.stringify({
                participantId: self.id,
                displayName: self.displayName,
                role: self.role,
              } satisfies StoredResume));
            }
          } else if (message.type === 'ERROR') {
            setError(message.payload.message);
          }
        } catch {
          setError('Pointe received an unreadable update.');
        }
      };
      socket.onerror = () => {
        if (active) setError('The live connection was interrupted. Pointe is reconnecting.');
      };
      socket.onclose = () => {
        if (!active) return;
        setStatus('reconnecting');
        retryRef.current = window.setTimeout(connect, 1200);
      };
    }

    connect();
    return () => {
      active = false;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      socketRef.current?.close(1000, 'page leave');
      socketRef.current = null;
    };
  }, [params.displayName, params.participantId, params.role, slug]);

  const send = useCallback((message: RetroClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('The board is reconnecting. Try that action again in a moment.');
      return;
    }
    socketRef.current.send(JSON.stringify(message));
  }, []);

  return useMemo(() => ({ snapshot, status, error, send }), [snapshot, status, error, send]);
}

function resumeKey(slug: string): string {
  return `pointe_retro_${slug}`;
}

function readResume(slug: string): StoredResume | null {
  try {
    const raw = sessionStorage.getItem(resumeKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredResume;
    if (!parsed.participantId || !parsed.displayName) return null;
    return parsed;
  } catch {
    return null;
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
