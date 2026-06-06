# Pointe — Lessons

Durable, dated lessons from building and operating Pointe. Append-only;
newest entries at the top.

2026-06-06 — AI dependency outage; graceful-failure verified under real conditions. During the S10 a11y pass the Anthropic API returned 400 (org out of API credits). The graceful-failure path (Fix 06) held in the wild: the host saw an "AI unavailable" banner, voting continued uninterrupted, AA-1 held (voters saw nothing), no broken state persisted, and the feature restored cleanly the moment credits were refilled. Most systems claim graceful dependency-failure handling; this one was tested by an actual outage and held. Datapoint, not hypothetical.
