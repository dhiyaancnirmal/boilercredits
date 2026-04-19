# AGENTS.md

## Project

Boilercredits. Web/API project for Boilercredits.

Stack: Preact + Vite + Hono + Cloudflare Workers + TypeScript + Zod
Monorepo: no

## Conventions

- Use TypeScript throughout.
- Package manager: pnpm.
- Prefer `pnpm typecheck`, `pnpm test`, and `pnpm build` for validation.
- Keep Worker/API code separated from client UI code.
- Do not add dependencies without recording the reason in `.context/decisions.log`.

## Architecture

The app has a Vite/Preact frontend and a Cloudflare Worker API using Hono. Wrangler owns local Worker execution and deployment. Read `package.json`, `vite.config.ts`, and Worker entry files for the current boundaries.

## Current Focus

See `.context/state.md` for active tasks and project state.
See `.context/decisions.log` for recent architectural decisions.

## Agent Rules

1. Read `.context/state.md` before starting work.
2. Read the latest 3-5 entries in `.context/decisions.log` when architecture or dependencies matter.
3. Do not refactor code unrelated to your current task.
4. Keep changes small and atomic.
5. If you make an architectural decision or add a dependency, append it to `.context/decisions.log`.
6. Before ending a meaningful session, update `.context/state.md` with what you did and what is next.
7. If something is confusing or ambiguous, say so. Do not guess at intent.
