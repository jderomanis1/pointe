import { useState, type ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import type { DeckType } from '@pointe/shared';
import { Button } from '../Button';
import { Badge } from '../Badge';

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
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined' ? `${window.location.origin}/${slug}` : `/${slug}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard denied — leave the URL visible so the host can copy manually.
    }
  }
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="md" onClick={copy} leftIcon={<Link2 size={16} />}>
        {copied ? 'Copied' : 'Copy room link'}
      </Button>
      <code className="font-mono text-meta text-text-secondary truncate">{url}</code>
    </div>
  );
}

export function EmptyState({
  slug, deck, customDeck, isHost, addStorySlot,
}: {
  slug: string;
  deck: DeckType;
  customDeck?: string[];
  isHost: boolean;
  /** The host's add-story control. Phase 2 fills this in with <AddStory/>. */
  addStorySlot?: ReactNode;
}) {
  if (!isHost) {
    return (
      <section className="bg-surface border border-hairline rounded-md p-8 md:p-12">
        <h2 className="font-serif text-heading text-text">Waiting for the host</h2>
        <p className="text-text-secondary text-body mt-2">
          The host hasn&apos;t added any stories yet. As soon as they do, they&apos;ll appear here.
        </p>
      </section>
    );
  }

  const values = deckValues(deck, customDeck);

  return (
    <section className="bg-surface border border-hairline rounded-md p-8 md:p-12">
      <h2 className="font-serif text-display text-text">Your room is ready.</h2>
      <p className="text-text-secondary text-body mt-3 max-w-prose">
        Two things to do next — add a story to estimate, and share the link so your team can join.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <div>
          <h3 className="text-meta text-text-secondary mb-2">1 · Add your first story</h3>
          {addStorySlot ?? (
            <p className="text-text-muted text-meta">Story input wires up in R4.v Phase 2.</p>
          )}
        </div>

        <div>
          <h3 className="text-meta text-text-secondary mb-2">2 · Share the room link</h3>
          <ShareLink slug={slug} />
        </div>

        <div>
          <h3 className="text-meta text-text-secondary mb-2">Deck</h3>
          <div className="flex items-center flex-wrap gap-2">
            <Badge variant="neutral">{deckLabel(deck)}</Badge>
            {values.map((v) => (
              <span key={v} className="font-mono text-meta text-text-secondary px-2 py-0.5 rounded-sm bg-fill">{v}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
