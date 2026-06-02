<div align="center">

```
  ██████╗ ██████╗ ██████╗ ███████╗    ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
 ██║     ██║   ██║██║  ██║█████╗      █████╗  ██║   ██║██████╔╝██║  ███╗█████╗
 ██║     ██║   ██║██║  ██║██╔══╝      ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
 ╚██████╗╚██████╔╝██████╔╝███████╗    ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

**A full-stack competitive programming platform** — LeetCode-style judging, real-time collaborative coding, system design challenges, and an in-browser playground. All in one monorepo.

[![Portfolio](https://img.shields.io/badge/Portfolio-tejendrasinh.vercel.app-blue?style=flat-square&logo=vercel)](https://tejendrasinh.vercel.app)
[![GitHub](https://img.shields.io/badge/GitHub-tejendrasinh51-black?style=flat-square&logo=github)](https://github.com/tejendrasinh51)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Tejendrasinh_Sisodia-blue?style=flat-square&logo=linkedin)](https://www.linkedin.com/in/tejendrasinh-sisodia-243a5a293/)
[![Email](https://img.shields.io/badge/Email-tejendrasinh51@gmail.com-red?style=flat-square&logo=gmail)](mailto:tejendrasinh51@gmail.com)

[![TypeScript](https://img.shields.io/badge/TypeScript-97%25-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![tRPC](https://img.shields.io/badge/tRPC-v11-398CCB?style=flat-square)](https://trpc.io/)
[![Turborepo](https://img.shields.io/badge/Turborepo-monorepo-EF4444?style=flat-square&logo=turborepo)](https://turbo.build/)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

---

## What is Code Forge?

Code Forge is a personal portfolio project that bundles four developer tools into a single platform:

- **Problems** — solve LeetCode-style coding challenges with a built-in multi-language judge
- **Codelets** — real-time collaborative HTML/CSS/JS coding sessions (think CodePen × Google Docs)
- **System Design** — a drag-and-drop architecture puzzle game with 10 progressive levels and live traffic simulation
- **Playground** — a quick scratchpad to run code snippets without creating a full submission

---

## Feature Highlights

### Problems
- Multi-language code execution (Python, JavaScript, Java, C++)
- Per-problem submission history and verdicts
- CodeMirror 6 editor with Vim mode support

### Codelets (Real-time Collaboration)
- Y.js CRDTs + Hocuspocus for conflict-free real-time editing
- Role-based access: owner, editor, viewer
- Invite system with request-access flow
- In-session chat backed by Y.js (persisted, replays on reconnect)
- Auto-generated preview screenshots via Puppeteer → R2 storage
- Fork, rename, archive sessions
- Mobile-responsive 4-tab layout (HTML / CSS / JS / Preview)

### System Design Game
- 10 progressively harder architecture levels
- Build systems using typed blocks on a React Flow canvas
- Client-side traffic simulation with reliability / performance / efficiency scoring
- 3-star scoring per level; empirically calibrated with a `node --test` suite

### Dashboard
- Solved-problem stats and streaks
- Contribution heatmap
- Recent submission history
- Account settings

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript (strict, no `any`) |
| Database | PostgreSQL 15 + Drizzle ORM |
| Auth | Better Auth — Google & GitHub OAuth |
| API | tRPC v11 + SuperJSON + Zod |
| Real-time | Y.js + Hocuspocus (standalone Node service) |
| Job Queue | BullMQ on Redis 7 |
| Storage | AWS S3 / Cloudflare R2 |
| UI | Tailwind CSS v4, shadcn/ui, Lucide, Motion |
| Canvas | React Flow (`@xyflow/react`) |
| Editor | CodeMirror 6 |
| Monorepo | Turborepo + pnpm workspaces |

---

## Project Structure

```
code-forge/
├── apps/
│   ├── web/                     # Next.js app — UI, tRPC server, REST endpoints
│   └── hocuspocus-server/       # Standalone Y.js collaboration WebSocket server
│
├── packages/
│   ├── api/                     # tRPC routers (problems, codelets, submissions, system-design…)
│   ├── auth/                    # Better Auth config, client hooks, middleware
│   ├── db/                      # Drizzle schemas + Postgres client
│   ├── jobs/                    # BullMQ queues and workers
│   ├── storage/                 # S3 / R2 client
│   └── validators/              # Shared Zod schemas
│
└── tooling/                     # Shared ESLint / Prettier / Tailwind / tsconfig
```

> **Dependency rule:** apps depend on packages — packages never depend on apps.

---

## Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | `^23` |
| pnpm | `^10.19.0` |
| Docker Desktop | latest |

### 1. Clone and install

```bash
git clone https://github.com/tejendrasinh51/Code-Forge.git
cd Code-Forge
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values:

```dotenv
# Generate with: openssl rand -base64 32
# On Windows PowerShell: [Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))
BETTER_AUTH_SECRET="your_generated_secret"

# Google OAuth — create at console.cloud.google.com
BETTER_AUTH_GOOGLE_ID="your_google_client_id"
BETTER_AUTH_GOOGLE_SECRET="your_google_client_secret"
```

Everything else in `.env.example` is pre-configured for local Docker development.

### 3. Start infrastructure

```bash
docker compose up -d
# Starts Postgres on :5433 and Redis on :6380
```

### 4. Apply schema and seed

```bash
pnpm db:push      # apply Drizzle schema to Postgres
pnpm db:seed      # seed initial data (optional)
pnpm auth:generate  # regenerate Better Auth types
```

### 5. Run the dev server

```bash
pnpm dev          # full stack: Next.js + Hocuspocus + file watchers
# or
pnpm dev:next     # Next.js only (if Hocuspocus is already running)
```

| Service | URL |
|---|---|
| Web app | http://localhost:3001 |
| Hocuspocus (WebSocket) | http://localhost:5000 |
| Drizzle Studio | run `pnpm db:studio` |

---

## Common Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start full dev environment |
| `pnpm build` | Build all packages via Turborepo |
| `pnpm typecheck` | TypeScript check across all packages |
| `pnpm lint` / `pnpm lint:fix` | ESLint check / autofix |
| `pnpm format:fix` | Prettier write |
| `pnpm db:push` | Push Drizzle schema to Postgres |
| `pnpm db:studio` | Open Drizzle Studio GUI |
| `pnpm db:seed` | Seed the database |
| `docker compose up -d` | Start Postgres + Redis containers |
| `docker compose down` | Stop all containers |

### System Design calibration tests

The simulation levels ship with a test suite that verifies each level stays beatable-but-hard:

```bash
pnpm -F @acme/nextjs test:calibration
```

---

## Deployment

### Next.js → Vercel

1. Import the repo in your Vercel dashboard
2. Set **Root Directory** to `apps/web`
3. Set **Install Command** to `pnpm install` and **Build Command** to `pnpm build`
4. Add all production environment variables (see `.env.production.example`)

### Hocuspocus → Railway / Fly.io

The WebSocket server must be deployed separately — Vercel does not support persistent WebSocket connections. Deploy `apps/hocuspocus-server` to Railway or Fly.io and set `NEXT_PUBLIC_SOCKET_URL` to its public URL.

### Database → Neon (free tier)

Provision a Postgres database at [neon.tech](https://neon.tech) and use the connection string as `POSTGRES_URL`.

### Redis → Upstash (free tier)

Provision a Redis database at [upstash.com](https://upstash.com) and use the connection string as `REDIS_URL`.

> See `.env.production.example` for the full list of production environment variables.

---

## Code Style

- `kebab-case` for files, `camelCase` for variables/functions, `PascalCase` for types/components
- Named exports preferred over default exports
- No `any` — use `unknown` with proper narrowing
- `async/await` everywhere; no raw promise chains
- Dark-mode first; shadcn/ui components; Tailwind v4

Full guidelines are in `.agents/` — covering code style, UI conventions, API design, and monorepo rules.

---

## Architecture Notes

**Code execution** is dispatched to an external Judge service via `JUDGE_API_URL` over tRPC. The Playground and Problem pages call `trpc.submission.create` and poll for the verdict by ID — there is no public REST API for submissions.

**Real-time collaboration** uses Y.js CRDTs for conflict-free merging. Documents are persisted as base64 in Postgres. Hocuspocus rehydrates them on room join, so sessions survive server restarts.

**Preview screenshots** are generated by Puppeteer inside the Hocuspocus server and written to R2/S3, keyed by session ID. Generation is debounced to avoid spawning Puppeteer on every keystroke.

---

## Contributing

This is a personal portfolio project but PRs and issues are welcome. Please open an issue before starting large changes.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m "feat: add your feature"`
4. Push and open a Pull Request

---

## Author

**Tejendrasinh Sisodia** — built as a full-stack portfolio project demonstrating real-time systems, monorepo architecture, and competitive programming tooling.

---

<div align="center">
  <sub>Built with Next.js · tRPC · Y.js · Drizzle · Turborepo</sub>
</div>
