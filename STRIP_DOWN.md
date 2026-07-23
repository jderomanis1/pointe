# STRIP_DOWN.md — v1.0 Feature Hit List

Features that exceed pointingpoker.com scope. They remain **fully functional** in the
codebase and are **not restyled** during the v1.0 Paper & Press reskin. This file is the
input document for the v1.0 strip-down effort that follows.

---

## 1. Confidence Picker

A 1–5 dot confidence rating per vote. pointingpoker.com has no confidence mechanism.

**Files:**
- `apps/web/src/components/room/ConfidencePicker.tsx` — the component
- `apps/web/src/components/room/CastPanel.tsx` — imports and renders it
- `apps/web/src/components/room/VoterSeats.tsx` — `ConfidenceDots` sub-component in revealed mode
- `apps/worker/src/room.ts` — `confidence` field on `Vote` type
- `packages/shared/src/types.ts` — `Vote.confidence` field

---

## 2. AI Estimate Suggestions (CERU)

AI-generated estimate reference surfaced to host during voting, optionally shared to voters.

**Files:**
- `apps/web/src/components/room/HostAiSection.tsx` — host's Ask AI panel
- `apps/web/src/components/room/AiSuggestionPanel.tsx` — four-dimension display panel
- `apps/web/src/components/room/VotingStage.tsx` — renders both panels conditionally
- `apps/worker/src/ai.ts` — Anthropic API integration
- `packages/shared/src/types.ts` — `Story.ai`, `AiSuggestion` type
- WS message: `SHARE_AI` (host → worker → voters)

---

## 3. Async Voting Window

Host opens a timed window; voters cast asynchronously; auto-reveal on close.

**Files:**
- `apps/web/src/components/room/AsyncOpenPanel.tsx` — host's "Open async window" affordance
- `apps/web/src/components/room/AsyncVoterView.tsx` — voter's async one-at-a-time flow
- `apps/web/src/components/room/AsyncHostMonitorView.tsx` — host's countdown + vote-count monitor
- `apps/web/src/components/room/RoomShell.tsx` — `showAsyncVoterView` / `showAsyncHostView` branches
- `apps/web/src/pages/CreatePage.tsx` — sync vs. async mode selector (`ModeOption`)
- `apps/worker/src/room.ts` — async window state machine
- `packages/shared/src/types.ts` — `Room.mode`, `Room.asyncWindow`

---

## 4. Async Review Screens

Post-async-close host review: agreed/discuss buckets, Accept all, Discuss live.

**Files:**
- `apps/web/src/components/room/ReviewHostScreen.tsx`
- `apps/web/src/components/room/ReviewVoterScreen.tsx`
- `apps/web/src/components/room/RoomShell.tsx` — `showReviewHost` / `showReviewVoter` branches
- `packages/shared/src/types.ts` — `Room.state === 'review'`

---

## 5. Multi-Story Queue

Multiple stories tracked per session; host advances through a queue.

**Files:**
- `apps/web/src/components/room/StoryQueue.tsx` — the queue list with host actions
- `apps/web/src/components/room/AddStory.tsx` — add-story form
- `apps/web/src/components/room/RoomShell.tsx` — `addStorySlot` / `persistentAddStorySlot` props
- `packages/shared/src/types.ts` — `Story[]` array on room state
- `apps/worker/src/room.ts` — ADD_STORY, SKIP_STORY, story ordering

---

## 6. Story Splitting

Host splits an active story into sub-stories during or after voting.

**Files:**
- `apps/web/src/components/room/SplitForm.tsx`
- `apps/web/src/components/room/VotingStage.tsx` — `splitOpen` toggle + renders SplitForm
- `apps/worker/src/room.ts` — SPLIT_STORY handler

---

## 7. Story External References

Jira/Linear/etc. ticket ID and URL attached to a story.

**Files:**
- `apps/web/src/components/room/StoryExternalRef.tsx`
- `apps/web/src/components/room/VotingStage.tsx` — renders `<StoryExternalRef story={story} />`
- `packages/shared/src/types.ts` — `Story.externalRef`

---

## 8. Commit Estimate Step

Post-reveal host flow: pick final value (defaults to median), formally commit it.

**Files:**
- `apps/web/src/components/room/CommitPanel.tsx`
- `apps/web/src/components/room/VotingStage.tsx` — renders CommitPanel when `isHost && revealed`
- `apps/worker/src/room.ts` — COMMIT_STORY handler
- `packages/shared/src/types.ts` — `Story.state === 'committed'`, `Story.finalEstimate`

---

## 9. Host Transfer & Replaced Notice

Host vacancy detection, claim-host flow, and "you were replaced" dismissible notice.

**Files:**
- `apps/web/src/components/room/HostVacantBanner.tsx` — amber "Claim host" banner
- `apps/web/src/components/room/ReplacedNotice.tsx` — dismissible replaced-as-host notice
- `apps/web/src/components/room/RoomShell.tsx` — renders both banners
- `apps/web/src/store/types.ts` — `RoomStore.replacedByHostName`
- `apps/web/src/store/reducer.ts` — `applyHostReclaimed`, `applyHostVacant`, `dismissReplacedNotice`
- `apps/web/src/ws/client.ts` — HOST_VACANT, HOST_RECLAIMED message handlers
- `apps/worker/src/room.ts` — host-vacancy state machine
- `packages/shared/src/types.ts` — `Room.state === 'host_vacant'`

---

*Generated during v1.0 Paper & Press reskin. Do not restyle any component listed above.*
