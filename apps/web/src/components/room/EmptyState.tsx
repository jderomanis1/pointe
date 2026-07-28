import { useState, type ReactNode } from 'react';
import { Check, Link2, Plus, Users } from 'lucide-react';
import type { DeckType } from '@pointe/shared';
import { Button } from '../Button';
import { Badge } from '../Badge';
import { PointeToast } from './PointeToast';

const DECKS: Record<Exclude<DeckType, 'custom'>, string[]> = {
  fibonacci: ['1', '2', '3', '5', '8', '13', '21'],
  modFibonacci: ['0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL'],
  powers2: ['1', '2', '4', '8', '16', '32', '64'],
};

function deckValues(deck: DeckType, customDeck?: string[]): string[] {
  if (deck === 'custom') return customDeck ?? [];
  return DECKS[deck];
}

function deckLabel(deck: DeckType): string {
  switch (deck) {
    case 'fibonacci': return 'Fibonacci';
    case 'modFibonacci': return 'Modified Fibonacci';
    case 'tshirt': return 'T-shirt';
    case 'powers2': return 'Powers of 2';
    case 'custom': return 'Custom';
  }
}

export function ShareLink({ slug }: { slug: string }) {
  const [toast, setToast] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined' ? `${window.location.origin}/${slug}` : `/${slug}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setToast(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard denied. The visible URL remains selectable.
    }
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-2">
        <Button
          variant="secondary"
          size="md"
          onClick={copy}
          leftIcon={copied ? <Check size={16} /> : <Link2 size={16} />}
          className="w-full"
        >
          {copied ? 'Invite Link Copied' : 'Copy Invite Link'}
        </Button>
        <code className="block max-w-full select-all overflow-hidden text-ellipsis whitespace-nowrap rounded-[10px] bg-fill px-3 py-2 font-mono text-caption text-text-secondary">
          {url}
        </code>
      </div>
      {toast && (
        <PointeToast message="URL COPIED TO CLIPBOARD" onDismiss={() => setToast(false)} />
      )}
    </>
  );
}

export function EmptyState({
  slug, deck, customDeck, isHost, addStorySlot,
}: {
  slug: string;
  deck: DeckType;
  customDeck?: string[];
  isHost: boolean;
  addStorySlot?: ReactNode;
}) {
  const values = deckValues(deck, customDeck);

  if (!isHost) {
    return (
      <section className="relative overflow-hidden rounded-[28px] border border-hairline bg-surface/95 p-6 text-center shadow-pop sm:p-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-52 opacity-70"
          style={{ background: 'radial-gradient(circle at 50% 0%, rgba(255,138,61,.18), transparent 58%)' }}
        />
        <div className="relative mx-auto grid size-16 place-items-center rounded-full border border-hairline bg-accent-tint text-accent-text shadow-card">
          <Users size={28} aria-hidden="true" />
        </div>
        <h1 className="relative mt-5 font-serif text-[clamp(2.4rem,7vw,4rem)] leading-none tracking-[-.035em] text-text">
          Waiting for the host
        </h1>
        <p className="relative mx-auto mt-4 max-w-xl text-body leading-7 text-text-secondary">
          Pull up a chair. You’re at the table, and the first story will appear as soon as the host starts the round.
        </p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-2" aria-label={`${deckLabel(deck)} deck`}>
          {values.slice(0, 8).map((v) => (
            <span key={v} className="grid h-14 w-10 place-items-center rounded-[9px] border border-hairline bg-surface font-bold text-text shadow-card">
              {v}
            </span>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-[30px] border border-hairline bg-surface/95 p-5 shadow-pop sm:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-70"
        style={{
          background:
            'radial-gradient(circle at 10% 0%, rgba(255,138,61,.18), transparent 40%), radial-gradient(circle at 90% 0%, rgba(46,158,143,.13), transparent 36%)',
        }}
      />

      <div className="relative max-w-3xl">
        <p className="text-meta font-extrabold uppercase tracking-[.14em] text-accent-text">The table is open</p>
        <h1 className="mt-3 font-serif text-[clamp(2.8rem,7vw,5rem)] leading-[.92] tracking-[-.04em] text-text">
          Your room is ready.
        </h1>
        <p className="mt-4 max-w-2xl text-body leading-7 text-text-secondary">
          Add the first story, share one link, and the team can start estimating with no accounts or setup.
        </p>
      </div>

      <div className="relative mt-8 grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
        <section className="rounded-[22px] border border-hairline bg-bg/45 p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-accent text-accent-ink">
              <Plus size={18} />
            </span>
            <div>
              <h2 className="font-bold text-text">Add your first story</h2>
              <p className="text-caption text-text-secondary">A title is enough. You can add more after the round begins.</p>
            </div>
          </div>
          {addStorySlot ?? <p className="text-text-muted text-meta">Story input unavailable.</p>}
        </section>

        <section className="rounded-[22px] border border-hairline bg-bg/45 p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-[#2E9E8F] text-white">
              <Link2 size={17} />
            </span>
            <div>
              <h2 className="font-bold text-text">Invite the team</h2>
              <p className="text-caption text-text-secondary">Anyone with the link can join.</p>
            </div>
          </div>
          <ShareLink slug={slug} />
        </section>
      </div>

      <div className="relative mt-5 flex flex-wrap items-center gap-2 rounded-[18px] border border-hairline bg-surface px-4 py-3">
        <Badge variant="neutral">{deckLabel(deck)}</Badge>
        <span className="mr-1 text-caption font-semibold text-text-secondary">Cards:</span>
        {values.map((v) => (
          <span key={v} className="grid min-h-8 min-w-8 place-items-center rounded-[8px] border border-hairline bg-fill px-2 font-mono text-caption font-bold text-text">
            {v}
          </span>
        ))}
      </div>
    </section>
  );
}
