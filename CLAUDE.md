# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Prospecter is an automated WhatsApp prospecting message sender. It drives the Evolution API (v2.3.7, Baileys) running in Docker. A single Node process serves a vanilla-JS panel (`public/`), a REST API, the Evolution webhook receiver, and the background send worker. UI text, logs, and code comments are in Portuguese (pt-BR); keep them that way.

## Commands

```bash
docker compose up -d --build        # full stack: postgres, redis, evolution, app (needs .env, copy from .env.example)
npm run infra:up                    # only postgres/redis/evolution, for running the app on the host
npm run dev                         # app on host with --watch (reads .env)
npm test                            # node:test, all test/**/*.test.ts
node --test test/phone.test.ts      # single test file
node --test --test-name-pattern="spintax" "test/**/*.test.ts"   # single test by name
npm run typecheck                   # tsc --noEmit
docker compose up -d --build app    # rebuild/restart only the app after code changes
```

## TypeScript without a build step

Node 24 runs `.ts` files directly using native type stripping. There is no compile step and no `dist/`. As a result:
- Relative imports must use the `.ts` extension (`import { sql } from './db.ts'`).
- Only erasable syntax is allowed (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Use `import type` for type-only imports (`verbatimModuleSyntax`).
- The Dockerfile copies `src/` and runs `node src/server.ts`.

## Architecture

- **`src/server.ts`**: startup order is migrate, then static files and routes, then listen, then `syncWebhooks()` (with retries, since Evolution boots slowly), then `startWorker()`. `PANEL_PASSWORD` enables Basic Auth (user `admin`) on everything except `/webhook/*` and `/health`.
- **`src/db.ts`**: postgres.js client. `migrate()` calls `runMigrations()` (`src/migrations.ts`, no config import so scripts can use it), which applies `src/migrations/*.sql` in filename order and tracks them in `schema_migrations`. To change the schema, add a new numbered file; never edit an applied one.
- **Database location:** `APP_DATABASE_URL` (external Postgres, currently Neon) takes precedence over `DATABASE_URL` both on the host and in compose; Evolution keeps its own DB in the compose Postgres. `scripts/copy-db.ts <from> <to>` migrates the target and upserts every table by primary key in one transaction, preserving ids and resetting sequences; it is re-runnable. Add new tables to its `TABLES` list in FK order.
- **WhatsApp conversation mirror (`src/wa-sync.ts`):** `syncWhatsApp()` pulls `/chat/findContacts` and every page of `/chat/findMessages` for each instance into `wa_contacts`/`wa_messages`, then fills `phone` on `@lid` rows and links `contact_id` via `phone_key = ANY(contacts.phone_keys)`. It runs 20s after startup, every 30 min, and on `POST /api/whatsapp/sync`; the webhook also records every `messages.upsert` item (both directions) before the reply handling. Row mapping is the pure `src/wa-map.ts` (also home of `extractText`/`senderPhone`). In sent messages `pushName` is our own name, so it is dropped.
- **Conversation export:** `GET /api/whatsapp/export` downloads the mirror as JSON (pt-BR keys), grouped per client by the pure `groupByClient()` in `src/wa-export.ts`: by `contact_id` when linked (so a contact's several numbers merge), otherwise by conversation key (`phone_key`, or `instance:jid`). No params exports everything; `q` reuses the panel's conversation filter (`findConversations()` in `routes.ts`) and also pulls the matched contacts' other conversations; `key` exports one conversation. Groups are excluded.
- **Read-only access for other systems:**
  - Schema `leitura` (migration 007) has the views `numeros`, `conversas` and `mensagens` over `wa_messages`/`contacts`/`instances`. The views use owner rights, so they must never expose `access_token`.
  - Role `prospecter_leitura` is created by `scripts/create-reader.ts`, which writes its URL to `.env.leitura` (gitignored). It only has `USAGE`/`SELECT` on `leitura` and connects with `default_transaction_read_only`.
  - `instances.display_phone` holds the number for Evolution instances too. `rememberPhones()` fills it from `ownerJid` whenever Evolution is fetched.
  - Changing the views means adding a new migration. Default privileges cover new views, so the role doesn't need to be recreated.
- **`src/worker.ts`**: polling dispatcher that ticks every 3s. For each `running` campaign inside its time window, it picks an available instance and claims one `pending` message with `FOR UPDATE SKIP LOCKED`. An instance is available when it is connected (`open`), enabled, not busy, past its random delay, and under its daily limit. Sends run concurrently across instances but one at a time per instance. Per-instance pacing (`nextAvailableAt`, `busy`) is kept **in memory**, so this assumes a single app process. On startup, `sending` rows are reset to `pending`. Failed sends retry up to 3 attempts, then the message is marked `failed`. A campaign is set to `done` when nothing is left pending or sending.
- **Random send times (`campaigns.random_times`, default on):**
  - For each (instance, campaign, day), `slotsFor()` draws `daily_limit - sentToday` random times between now and the end of the window (`planSlots`, spaced at least `delay_min_s` apart).
  - An instance is a candidate only once its next slot is due. A slot is consumed only when a send was actually attempted; skipped, invalid, and blocked messages keep the slot for the next contact.
  - Plans live in memory and are redrawn when the day, daily limit, window, or `delay_min_s` changes, and after a restart.
- **Send-time validation:** `renderChecked()` in `template.ts` is the single gate. If any `{{var}}` used in the template is empty for the contact, or `{`/`}` remains in the final text, the message becomes `blocked` and is never sent. `validateTemplate()` rejects malformed markup on campaign save. `POST /campaigns/:id/start` runs `checkCampaign()` over the whole queue and returns 409 unless `force` is sent; the panel asks the user to confirm. Test sends and the real-contact preview use the same check.
- **`waitingReasons()` in `src/worker.ts`** explains to the panel why a running campaign isn't sending (outside the window, no connected number, daily limit reached, waiting for the delay). It must mirror the availability rules in `tick()`, so change both together.
- **`src/webhook.ts`**: handles `messages.upsert` and `connection.update`. Evolution authenticates with the `x-prospecter-token` header, which is set per instance by `evolution.setWebhook`. The sender's phone may arrive as an `@lid` JID; the real number comes from `key.remoteJidAlt` or `key.senderPn`. Replies set `contacts.last_reply_at` and `messages.replied_at`. Opt-out keywords (`src/optout.ts`, short messages only) set `opted_out_at` and mark that contact's pending messages as `skipped`.
- **`src/instances.ts`**: merges Evolution's `fetchInstances` with the local `instances` table (daily limit, enabled). Connection state is cached for 15s and also updated from the webhook. Instances created directly in Evolution are auto-registered locally.
- **`src/evolution.ts`**: thin `fetch` client for the Evolution REST API (auth via `apikey` header). Errors become `EvolutionError`, which the server maps to HTTP 502.

- **Two kinds of number (`instances.provider`):** `evolution` (Baileys via QR, free-text spintax) and `cloud` (Meta Cloud API in Coexistence/Coex, approved templates only). A campaign has one `provider`, and the worker only uses numbers with that provider. For `cloud`, a number must also belong to the same WABA as `campaigns.cloud_template.waba_id`. Connection is checked by `isConnected()` in `instances.ts`: Evolution state for QR numbers, `cloud_status = 'connected'` for Coex numbers. Use it in both `tick()` and `waitingReasons()`.
- **Cloud API (Coex):**
  - The app doesn't do onboarding (Embedded Signup needs a Tech Provider). `POST /api/instances/cloud` registers an already-connected number from its phone_number_id, WABA id and system-user token (`instances.access_token`, never sent to the panel).
  - `src/cloud.ts` is the Graph client; `CloudError.code` is Meta's error code.
  - `src/cloud-map.ts` is pure: `renderCloud()` is the send-time gate for templates, like `renderChecked`. Each template variable maps to an expression in our template syntax. It also has `classifyCloudError()` and `parseCloudWebhook()`.
  - Send errors:
    - 131026 → `invalid`.
    - 131049 → `failed`, not retried.
    - 132xxx → pauses the campaign.
    - Account errors (190, 131042…) → `cloud_status = 'error'`; the message is requeued without spending an attempt.
  - There is no "has WhatsApp?" check and no alt-phone fallback.
- **Meta webhook (`/webhook/meta`):**
  - The route lives in its own Fastify scope with a raw-buffer JSON parser so `x-hub-signature-256` (HMAC with `META_APP_SECRET`) can be checked.
  - Payloads are stored in `cloud_events` and answered with 200 right away. `src/cloud-webhook.ts` processes them every 5s, up to 5 attempts.
  - Every Cloud API message goes into `wa_messages` with an `origin`: `api`, `app` (smb_message_echoes), `history` or `contact`. The worker records its own API sends, since Meta doesn't echo them.
  - Live inbound messages go through `handleReply()` in `webhook.ts`, which is shared with Evolution. They are deduped by wamid, and echoes never count as replies.
  - Safety stops:
    - `account_update` PARTNER_REMOVED → `disconnected`.
    - Quality FLAGGED/DOWNGRADE → `enabled = false`.
    - Template PAUSED/DISABLED → pauses the campaigns that use it.
  - The history sync (`smb_app_data`) can only be requested once (`history_sync_at`).
- **`src/watchtower.ts`**: MCP client (`@modelcontextprotocol/sdk`, Streamable HTTP) for the WatchTower CRM. It supports two auth modes:
  - **OAuth** (default): `DbOAuthProvider` persists the client registration, tokens, PKCE verifier, and state in the `kv` table. `auth()` captures the authorization URL in `redirectToAuthorization`, and the panel opens it in a popup. The browser returns to `PUBLIC_URL/integrations/watchtower/callback`.
  - **Static Bearer token**, when `WATCHTOWER_MCP_TOKEN` is set.

  `callTool()` parses the first text block as JSON; WatchTower appends extra blocks such as "Empresa: ...". It reconnects once if the session drops, and injects `empresaId` only when one has been chosen in settings (only needed when the connection reaches more than one company).
- **WatchTower write-back goes through `watchtower_outbox`**, never inline:
  - The worker enqueues a `note` after each sent message and, with `moveTrigger = 'send'` (default), a `move`.
  - With `moveTrigger = 'reply'`, the webhook enqueues the `move` on a contact's *first* non-opt-out reply instead. `enqueueMovesForSent()` (at startup and on settings save) backfills moves for prospects already sent to; it is idempotent and only runs in send mode. Legacy settings with `moveOnReply` map to `moveEnabled`.
  - `processOutbox` (every 10s) calls `anotar_no_prospecto`, or `obter_prospecto` followed by `mover_prospecto`. A move is applied only if the prospect is still in `fromStageId`, so prospects that already advanced never regress.
  - Auth errors leave items pending without spending attempts.

  Moving a prospect can trigger WatchTower automations (`cadastrar_cliente`, `criar_orcamento`). The panel warns about this, and `ensureDefaultStages` only auto-picks a target stage that has no automations.
- **CNAE filter:** Receita-sourced prospects carry `origem` text, and "secundário" in it means the target CNAE is only secondary (usually consultancies, not accounting firms). `matchesCnae()` drives the import filter, which defaults to `principal`. `POST /campaigns/:id/watchtower-prune` removes non-matching *pending* messages (with `dryRun`) and backfills `{{origem}}` on contacts.
- **`src/watchtower-map.ts`**: pure mapping from prospect to `ContactInput`. `cidade` is the text after " - " in the folder name. `scripts/mock-watchtower.ts` is a fake MCP server (token `mock-token`) for end-to-end tests without real CRM data.

### Data model notes

- `contacts.phone_key` (from the primary phone) is the unique dedupe key. For Brazilian numbers it is country code + area code + last 8 digits, so numbers with and without the mobile 9th digit collide on purpose.
- Contacts can have several numbers. `phone` is the primary (mobiles sort first in `parsePhoneList`), `alt_phones` holds the rest, and `phone_keys` holds the keys of all of them. Match inbound messages with `phoneKey(x) = ANY(phone_keys)`. The worker sends to the first number that has WhatsApp and records it in `messages.to_phone`.
- `contacts.wt_prospect_id` links a contact to its WatchTower prospect.
- `messages` has one row per (campaign, contact). Statuses: `pending | sending | sent | failed | invalid | skipped | blocked`. `blocked` means it failed `renderChecked`; "retry" requeues both `failed` and `blocked`. `invalid` means the number has no WhatsApp; it is checked via `/chat/whatsappNumbers` right before sending.
- `campaigns.instances = '{}'` means "use all enabled instances".
- The daily limit counts `sent` and `sending` messages per instance for the current day in `TZ` (default `America/Sao_Paulo`).

### Pure modules (unit-tested, no DB/env imports)

`phone.ts`, `wa-map.ts`, `wa-export.ts`, `cloud-map.ts`, `template.ts` (`{{var}}` placeholders plus nested `{a|b}` spintax; variable names are lowercased, stripped of accents, and spaces become `_`), `csv.ts` (detects `,` or `;`, handles quotes, also accepts a plain phone-per-line list), `schedule.ts`, and `optout.ts`. `config.ts` throws on import if required env vars are missing, so keep new testable logic out of modules that import `config`/`db`.

## Networking gotchas

- `EVOLUTION_URL` is the address the app uses to reach Evolution. `WEBHOOK_URL` is the address Evolution uses to reach the app. Inside compose these are `http://evolution:8080` and `http://app:3000/webhook/evolution`, overridden in `docker-compose.yml`. When the app runs on the host, `WEBHOOK_URL` must be `http://host.docker.internal:3000/webhook/evolution`.
- Webhook URLs are pushed to every instance at app startup, so restarting the app with a new `WEBHOOK_URL` fixes stale webhooks.
- In Git Bash on Windows, `curl -d` with accented characters sends broken (non-UTF-8) bytes. Test such payloads with Node `fetch` instead.
- postgres.js: pass JSON parameters with `sql.json(value)`. Writing `${JSON.stringify(x)}::jsonb` double-encodes the value into a JSON string.
- The app container reads `.env` through `env_file`, so after editing `.env` run `docker compose up -d app` to recreate it. A plain restart keeps the old variables.
