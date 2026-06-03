// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
import { SPLIT_MAX_CHILDREN } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { applyChange, initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'active', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    ...overrides,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(
  id: string, orderIndex: number, text: string,
  state: Story['state'] = 'pending', extra: Partial<Story> = {},
): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0, ...extra };
}

function seed(snap: RoomSnapshot) {
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snap);
  useRoomStore.getState().setConnection('connected');
}

function renderShell(send = vi.fn()) {
  render(
    <MemoryRouter>
      <RoomClientProvider send={send}>
        <RoomShell slug={SLUG} />
      </RoomClientProvider>
    </MemoryRouter>,
  );
  return send;
}

beforeEach(() => {
  useRoomStore.setState(initialState);
});

// ---- Reducer: story_split ----

describe('reducer — story_split', () => {
  it('parent → split (terminal), children inserted, sorted by orderIndex', () => {
    const seeded = {
      ...initialState,
      stories: [
        story('s-1', 100, 'A', 'pending'),
        story('s-parent', 200, 'P', 'active'),
        story('s-3', 300, 'C', 'pending'),
      ],
    };
    const next = applyChange(seeded, {
      kind: 'story_split',
      parentId: 's-parent',
      children: [
        story('c1', 220, 'P1'),
        story('c2', 240, 'P2'),
        story('c3', 260, 'P3'),
      ],
    });

    expect(next.stories.find((s) => s.id === 's-parent')!.state).toBe('split');
    // Children inserted between parent and s-3.
    const ids = next.stories.map((s) => s.id);
    expect(ids).toEqual(['s-1', 's-parent', 'c1', 'c2', 'c3', 's-3']);
    expect(next.stories.find((s) => s.id === 'c1')!.state).toBe('pending');
  });

  it('splitting the active story drops it from focus (no active||revealed left)', () => {
    const seeded = {
      ...initialState,
      stories: [story('s-parent', 100, 'P', 'active')],
    };
    const next = applyChange(seeded, {
      kind: 'story_split', parentId: 's-parent',
      children: [story('c1', 200, 'P1'), story('c2', 300, 'P2')],
    });
    expect(next.stories.find((s) => s.state === 'active' || s.state === 'revealed')).toBeUndefined();
  });
});

// ---- UI: queue Split control + form ----

describe('Split — queue pending row (host only)', () => {
  it('host on a pending row sees Split; toggling shows the form', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Huge story')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    const btn = screen.getByRole('button', { name: 'Split' });
    await userEvent.click(btn);
    // Form appears with the minimum number of child inputs.
    expect(screen.getByLabelText('Child 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Child 2')).toBeInTheDocument();
  });

  it('non-host does NOT see Split', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Huge story')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument();
  });
});

// ---- SplitForm behavior ----

describe('SplitForm', () => {
  function openForm() {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Huge story')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = vi.fn();
    renderShell(send);
    return send;
  }

  it('submit disabled until ≥2 non-empty children', async () => {
    const send = openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    const submit = screen.getByRole('button', { name: /^Split into / });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Child 1'), 'first');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Child 2'), 'second');
    expect(submit).not.toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });

  it('submitting sends SPLIT_STORY { storyId, children: [{text}, ...] } with trimmed non-empty texts', async () => {
    const send = openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    await userEvent.type(screen.getByLabelText('Child 1'), '  Alpha  ');
    await userEvent.type(screen.getByLabelText('Child 2'), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /^Split into / }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('SPLIT_STORY', {
      storyId: 's-1',
      children: [{ text: 'Alpha' }, { text: 'Beta' }],
    });
  });

  it('Add another grows the form up to the MAX cap', async () => {
    openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    const addBtn = screen.getByRole('button', { name: /Add another/ });
    // Click until we reach the cap.
    for (let i = 2; i < SPLIT_MAX_CHILDREN; i++) {
      await userEvent.click(addBtn);
    }
    expect(screen.getByLabelText(`Child ${SPLIT_MAX_CHILDREN}`)).toBeInTheDocument();
    // At the cap, Add another is disabled.
    expect(addBtn).toBeDisabled();
  });

  it('remove buttons disabled at the minimum; enabled above; remove drops a row', async () => {
    openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    // At minimum (2): both remove buttons disabled.
    const removes2 = screen.getAllByRole('button', { name: /Remove child/ });
    for (const r of removes2) expect(r).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /Add another/ }));
    const removes3 = screen.getAllByRole('button', { name: /Remove child/ });
    expect(removes3.every((r) => !(r as HTMLButtonElement).disabled)).toBe(true);

    await userEvent.click(removes3[1]); // Remove child 2
    expect(screen.queryByLabelText('Child 3')).not.toBeInTheDocument();
  });

  it('SI-04: HTML in child text is escaped (no real <img> in the DOM after submit prep)', async () => {
    openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    await userEvent.type(screen.getByLabelText('Child 1'), '<img src=x onerror=alert(1)>');
    await userEvent.type(screen.getByLabelText('Child 2'), 'fine');
    // The typed string is held in form state and rendered as input value.
    // No real <img> materializes anywhere on the page.
    expect(document.querySelector('img')).toBeNull();
  });
});

// ---- VotingStage Split trigger ----

describe('Split — active stage (host only)', () => {
  it('host on the active stage sees Split; toggling opens the inline form', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Active story', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    // There may be multiple Split buttons (queue + stage); the stage one
    // appears in the stage section.
    const stageHeading = screen.getByRole('heading', { name: 'Active story' });
    const stage = stageHeading.closest('section')!;
    const splitBtn = within(stage).getByRole('button', { name: 'Split' });
    await userEvent.click(splitBtn);
    expect(within(stage).getByLabelText('Child 1')).toBeInTheDocument();
  });
});

// ---- Split parent display ----

describe('Split parent row', () => {
  it('renders the split badge in the queue with no host actions', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [
        story('s-parent', 100, 'P', 'split'),
        story('s-c1', 150, 'P1', 'pending'),
      ],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    const lis = screen.getAllByRole('listitem');
    const parentRow = lis.find((li) => li.textContent?.startsWith('P'))!;
    expect(within(parentRow).getByText('split')).toBeInTheDocument();
    expect(within(parentRow).queryByRole('button', { name: 'Split' })).not.toBeInTheDocument();
    expect(within(parentRow).queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(within(parentRow).queryByRole('button', { name: 'Open voting' })).not.toBeInTheDocument();
  });
});
