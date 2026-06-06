# Pointe

> Planning poker that respects your team's time and judgment.

[pointe.team](https://pointe.team) · Free, open-source, and MIT-licensed.

## What's Pointe?

Pointe is an open-source planning poker tool for teams who care more about good estimates than fast ceremony. It's free forever, requires no accounts for basic use, and ships no telemetry. The goal is simple: help a team surface honest, well-reasoned estimates instead of rushing to a number everyone can live with.

## Why Pointe?

Most planning poker tools optimize for ceremony over judgment. They reveal everyone's number at once, which creates anchoring effects — the loudest or most senior estimate quietly pulls the rest toward it. They offer no way to dig into outliers without putting someone on the spot in front of the team. And they treat confidence as binary, when the uncertainty teams actually feel is the most useful signal in the room. Pointe is an attempt to fix those three things deliberately.

## Three Differentiators

These describe the product Pointe is being built toward. The foundation is live; the features below are in active development and framed as design intent, not shipped behavior.

### Anti-anchoring AI (CERU reasoning)

Pointe is designed around CERU — Complexity, Effort, Risk, Unknowns, — a deliberate sequence that surfaces genuine thinking before social dynamics shape the consensus. Voters commit both their estimate and their reasoning privately before anything is revealed. The AI's role is to question assumptions in that reasoning, not to suggest a different number.

### Async outlier discussion

When estimates diverge significantly, Pointe is designed to route the high and low estimators into a private discussion thread rather than asking them to defend themselves in front of the group. This is meant to protect junior voices and unconventional perspectives — the ones that, often enough, turn out to be right.

### Confidence dimension

Pointe captures a confidence value alongside the point estimate. A 5 with high confidence is a meaningfully different signal than a 5 with low confidence, and the consensus model is designed to treat them differently. False certainty is the most common failure mode in estimation; making confidence explicit is meant to prevent it rather than paper over it.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite 8
- **Backend:** Cloudflare Workers + Durable Objects (SQLite-backed)
- **Infrastructure:** Cloudflare edge network (250+ global locations)
- **AI:** Anthropic Claude API (for CERU reasoning)
- **Cost:** $0/month at current scale (Cloudflare Workers free tier)

## Architecture

Pointe is a pnpm monorepo deployed as two cooperating Cloudflare Workers.

```
pointe/
├── apps/
│   ├── web/         # React app — served at pointe.team
│   └── worker/      # API + Durable Objects — served at pointe.team/api/*
├── packages/
│   └── shared/      # Shared types (grows with the product)
└── .github/
    └── workflows/   # CI (lint + typecheck) and deploy pipelines
```

Two Workers run in production. `pointe-web` serves the React app at [pointe.team](https://pointe.team); `pointe-worker` handles API requests at `pointe.team/api/*`. Cloudflare Workers Routes do path-based routing between them, so both share a single origin with no CORS overhead. Each room's state is isolated in its own Durable Object instance with SQLite storage — one authoritative, strongly consistent actor per room, rather than a shared database the whole app contends over.

## Status

**Active development — Phase 2, January 2026.**

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | Complete | Vision spec, design system, user flows, data model, implementation plan |
| Phase 2 Sprint S0 | Complete | Foundation infrastructure (monorepo, CI/CD, deployment) |
| Phase 2 Sprint S1 | Next | Backend core (Durable Objects, room state, REST API) |
| Phase 2 Sprints S2–S11 | Planned | Voting flow, AI integration, design polish, launch |

The current landing page is a placeholder while feature development is in progress. Subscribe to the GitHub repo for updates.

## Local Development

Prerequisites: Node 20+ and pnpm 10+.

```bash
git clone https://github.com/jderomanis1/pointe.git
cd pointe
pnpm install

# Run the web app (http://localhost:5173)
pnpm -F @pointe/web dev

# Run the API worker (http://localhost:8787)
pnpm -F @pointe/worker dev

# Quality checks (also enforced in CI)
pnpm typecheck
pnpm lint
```

## Project Principles

- Free and ad-free forever — funded by sponsorship, not advertising.
- No accounts required for basic use.
- No telemetry, no data harvesting.
- Open-source under the MIT license.

## Contributing

Contributions are welcome. Pointe is a solo project right now, so the most useful things are real-world feedback and focused pull requests.

- **Issues:** [GitHub Issues](https://github.com/jderomanis1/pointe/issues)
- **Feedback:** [feedback@pointe.team](mailto:feedback@pointe.team)
- **Sponsorship:** [Venmo @dero85254](https://venmo.com/dero85254) — keeps Pointe free and ad-free.

Please keep pull requests small and focused, and include a short description of intent. Lint and typecheck rules are enforced by CI, so run `pnpm lint` and `pnpm typecheck` before opening one.

## License

[MIT](LICENSE).

---

Built by Joe DeRomanis — feedback welcome. [github.com/jderomanis1](https://github.com/jderomanis1)
