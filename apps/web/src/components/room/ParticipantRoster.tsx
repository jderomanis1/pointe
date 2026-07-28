import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

const AVATAR_TONES = [
  'border-[#F07C2A] bg-[#F07C2A]/10 text-[#9F3B00]',
  'border-[#2E9E8F] bg-[#2E9E8F]/10 text-[#17665D]',
  'border-[#E04F4F] bg-[#E04F4F]/10 text-[#8D3030]',
  'border-[#3C9E5D] bg-[#3C9E5D]/10 text-[#246D3B]',
  'border-[#C28A18] bg-[#FFC24B]/15 text-[#755000]',
];

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function toneFor(id: string): string {
  const score = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
  return AVATAR_TONES[score % AVATAR_TONES.length];
}

export function ParticipantRoster({ storyId }: { storyId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[storyId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[storyId]);

  const all = Object.values(voters).filter((v) => v.connectionState !== 'left');
  const seated = all
    .filter((v) => v.role !== 'spectator')
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const spectators = all.filter((v) => v.role === 'spectator');

  if (all.length === 0) return null;

  return (
    <section aria-label="People at the table" className="flex flex-col gap-4">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-6 sm:gap-x-7">
        {seated.map((v) => {
          const isMe = v.id === me?.voterId;
          const voted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
          const offline = v.connectionState !== 'connected';

          return (
            <li
              key={v.id}
              data-testid={`seat-${v.id}`}
              data-voted={voted ? 'true' : 'false'}
              className={cn('flex min-w-[76px] flex-col items-center gap-2 text-center', offline && 'opacity-55')}
            >
              <div
                role="img"
                aria-label={voted ? `${v.displayName} is ready` : `${v.displayName} is thinking`}
                className={cn(
                  'grid h-[72px] w-[52px] place-items-center rounded-[11px] border-2 transition-all duration-200',
                  voted
                    ? 'border-[#D97820] shadow-[0_7px_16px_rgba(190,120,40,.22)]'
                    : 'border-dashed border-hairline bg-bg/35',
                )}
                style={voted ? {
                  background:
                    'repeating-linear-gradient(45deg, #F5A54A, #F5A54A 6px, #F8B96B 6px, #F8B96B 12px)',
                } : undefined}
              >
                {!voted ? <span className="text-sm font-black text-text-muted">…</span> : null}
              </div>

              <div className="flex items-center gap-2">
                <span className={cn('grid size-9 place-items-center rounded-full border-2 text-xs font-extrabold', toneFor(v.id))}>
                  {initials(v.displayName)}
                </span>
                <span className="min-w-0 text-left">
                  <span className="block max-w-28 truncate text-sm font-bold text-text">
                    {v.displayName}{isMe ? ' (you)' : ''}
                  </span>
                  <span className={voted ? 'block text-caption font-bold text-success-on' : 'block text-caption font-semibold text-text-muted'}>
                    {voted ? 'ready!' : 'thinking…'}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {spectators.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2 text-caption text-text-secondary">
          <span className="font-bold">Watching:</span>
          {spectators.map((v) => (
            <span
              key={v.id}
              data-testid={`seat-${v.id}`}
              data-voted="false"
              className="rounded-full border border-hairline bg-fill px-3 py-1 font-semibold"
            >
              <span className="sr-only">[OBS]</span>
              {v.displayName}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
