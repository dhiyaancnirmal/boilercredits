# BoilerCredits

A faster way to search Purdue's transfer credit catalog. Live at [dhiyaan.me/boilercredits](https://www.dhiyaan.me/boilercredits).

## Stack

Cloudflare Workers, Hono, D1, Preact, Vite, TypeScript

## Dev

```
cp .dev.vars.example .dev.vars
pnpm install
pnpm dev
```

Frontend on `localhost:5174`, API on `localhost:8787`.

## Deploy

```
pnpm build && pnpm deploy
```

Not affiliated with Purdue University.
