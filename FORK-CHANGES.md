# Changes in this fork

This fork (torsteinvestre/open-instinct) runs as **Sunshine**. It is based on
[mariagorskikh/open-instinct](https://github.com/mariagorskikh/open-instinct) at commit `79a144a`.
This page lists what the fork adds, so each change can be found, understood and removed.

## Tagged changes

Newer changes carry a tag in a code comment on every line or block they add. Search the
repository for the tag to find all of it.

### `[sunshine:reply-guard]`: one reply per run

**Problem.** A run (an incoming message or a scheduled job) could text the same person twice:
once with a tool (`send_message`, `notify_owner`, `ask_owner`) and once with the final reply.
Seen live: a reminder arrived twice ("TIMER!!!" twice), or followed by a report ("I sent
Torstein the reminder ...").

**Upstream already had the fix for one case.** For agent-to-agent tasks, `runtime.ts` sets
`repliedViaTool` when the model answers with `reply_instinct` and then skips the final reply.

**What the fork adds.** The same rule for text threads and scheduled jobs:

- Tools declare who they text with `ToolMeta.replyTarget` (`"current"` or `"owner"`).
  `send_message`, `notify_owner` and `ask_owner` declare it, and `send_file` when it has a caption
  (seen live: the PDF, its caption, then "Sent: a one-page packing list ..."). A file without a
  caption leaves the final reply as its message.
- When a tool reached the run's own audience (the thread being answered, or the owner from a
  scheduled job or the owner's private text thread), `repliedViaTool` is set and the final reply
  is not sent. It is written to the audit log instead (`policy` entry with `replyGuard`).
- Texts to anyone else, files, a contact's request relayed to the owner, and the dashboard chat
  are unchanged.
- Prompt lines tell the model the same, not to send "on it" progress notes with a tool, and to
  put what it wants to say about a file in the caption.

**Files.** `packages/core/src/types.ts`, `runtime.ts`, `prompt.ts`, `core-tools.ts`,
`packages/inkbox/src/tools.ts`, and tests in `packages/core/test` and `packages/inkbox/test`.

**To remove.** Revert its commits (`git log --grep "reply-guard"` finds them), or delete every
tagged block. The tests tagged the same way go with it.

**A new tool that texts the owner or the current conversation** must declare `replyTarget`,
or the double message comes back for it. The tests list which tools declare it, so a new one
shows up there.

### `[sunshine:silent-reply]`: the stay-quiet word

**Problem.** A scheduled run stays silent only if its final reply is empty. Seen live: "in 2 minutes,
check if it's raining and only text me if it is" texted "I'm not sending Torstein a message. The
current Oslo reading says ..." on a dry day, because any reply text is delivered.

**What the fork adds,** copied from OpenClaw's `NO_REPLY` convention:

- A final reply that is exactly `NO_REPLY` (any case, surrounding spaces ignored) is not sent. It is
  written to the audit log instead (`policy` entry with `silentReply`).
- Only scheduled runs are told about the word. A person who texts gets an answer, as in OpenClaw,
  where direct chats never get the guidance.
- The word alone is never texted in a thread either, in case it slips out there.
- The word must be the whole reply: "It's raining. NO_REPLY" is still sent. A2A replies and the
  dashboard chat are unchanged.

**Files.** `packages/core/src/prompt.ts` (`SILENT_REPLY` and one scheduled-run line),
`packages/core/src/runtime.ts` (`runScheduled`, `deliver`, `isSilentReply`), and tests in
`packages/core/test`.

**To remove.** Revert its commit (`git log --grep "silent-reply"` finds it), or delete every tagged
block. Scheduled runs then fall back to upstream's empty reply.

**The coming watcher** relies on this: most of its checks should end in `NO_REPLY`.

### `[sunshine:watcher]`: the news watch (in progress, off by default)

**Goal.** Sunshine texts its owner when something genuinely worth knowing happens in their
interests, and otherwise stays silent. Plan: `~/sunshine-ops/WATCHER-PLAN.md` (private notes).
Principle: code for facts and fences, reasoning for taste.

**What is built (stage 1, code only).**

- `packages/watcher` (new package): a written picture of the owner's interests plus searches
  (`watcher.json` in the data dir); Google News RSS per search (last day, repeats skipped by link
  and wording); a relevance sieve on Jev (`TYPESAFE_API_KEY`, one yes/no question per headline,
  generous on purpose, never judges importance; without a key or when Jev fails the newest few go
  through unsieved); seven owner-only tools: `watch_profile`, `watch_profile_update`, `watch_scan`,
  `watch_send`, `watch_keep`, `watch_later`, `watch_settings`.
- `watch_send` is the only door: quiet hours (the owner's own, default 22:00-08:00, in their
  timezone), a hidden limit of 6 a day, never the same link twice. Refusals are logged.
- `watch_settings` turns the checks on (default 09:00 and 18:00, owner's timezone) as ordinary
  schedules marked `toolRepliesOnly`.
- Core: `ScheduleEntry.toolRepliesOnly`. Such a job's final reply is never texted; it is logged as
  the job's note on what it decided (`runtime.ts`, `runScheduled`).
- Server: the tools are registered only when `INSTINCT_WATCHER=1` (`boot.ts`). Unset, nothing changes.
- Both Dockerfiles copy the new package's manifest (the gateway image installs the server package).

**Not built yet.** The `news-watch` skill (the playbook the scheduled runs follow), the one-time
interest question in onboarding, and the gateway passing `TYPESAFE_API_KEY` and `INSTINCT_WATCHER`.

**To remove.** Delete `packages/watcher`, and every block tagged `[sunshine:watcher]` (`boot.ts`,
`server/package.json`, `types.ts`, `runtime.ts`, both Dockerfiles, tests), then `pnpm install`.

### `[sunshine:timezone]`: agents get the owner's timezone

**Problem.** Agents created by the gateway ran in UTC: the gateway never passed
`INSTINCT_OWNER_TIMEZONE`, so core fell back to the server's zone. Relative timers were right, but
times in texts were 2 hours off in Norway and clock-time reminders ("every day at 8") fired late.
Upstream's own `instinct deploy` already passes the timezone; only the gateway missed it.

**What the fork adds.**

- The signup form has a hidden `timezone` field that the browser fills
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Nothing visible changes.
- The gateway keeps it only if it is a real IANA zone. `UTC` and `Etc/*` count as unknown, since
  privacy modes report UTC. Otherwise it falls back to the picked country's single zone (NO, SE, GB).
  The US and "Other" get no fallback. A bad value never fails a signup.
- The zone is saved on the user record and sent to the new agent as `INSTINCT_OWNER_TIMEZONE`.

**Existing agents are not changed by this.** Core reads the env var only on first boot; after that,
`/data/config.json` wins. Change `owner.timezone` there and restart the agent.

**Files.** `packages/gateway/src/validate.ts` (`placeTimezone`, `signupTimezone`, country zones),
`pages.ts` (hidden field and script), `server.ts`, `store.ts`, `provision.ts`, and tests in
`packages/gateway/test`.

**To remove.** Revert its commit (`git log --grep "timezone"`), or delete every tagged block. New
agents then run in UTC again.

## Earlier changes (not tagged; find them by commit)

Ordered from most to least likely to cause trouble. `git show <commit>` shows a change in full;
`git revert <commit>` undoes it.

### Phone numbers (`80b36b5`)
- **What:** adds the `libphonenumber-js` library (pinned 1.13.14) and replaces the old rule that
  read any ten-digit number as American. Numbers written the local way are read as the owner's
  country. The three copies of the phone rule now share one function.
- **Where:** `packages/core/package.json`, `pnpm-lock.yaml`, `core/src/principal.ts`
  (`normalizePhone`, `parsePhone`, `phoneCountryOf`), `core/src/contacts.ts`, `core/src/config.ts`,
  `core/src/runtime.ts` (group threads), `network/src/lookup.ts`, `inkbox/src/tools.ts`,
  `server/src/boot.ts`, `cli/src/commands/invite.ts`.
- **If it breaks:** the owner or a contact is treated as a stranger, or a text goes to a wrong number.

### Signup: country, picked handles, repeat signups (`f5edfbb`, `ba288a7`)
- **What:** the country picker; handles like `sunshine-anna-k3f9` picked by the gateway; a repeat
  signup recognized by phone alone (restarts a failed setup, reveals nothing about the record).
- **Where:** `packages/gateway/src/validate.ts`, `gateway/src/server.ts`, `gateway/src/main.ts`.
- **If it breaks:** friends cannot sign up, see "does not look like a phone number", get a second
  agent, or stay at "Setting up".

### Settings for new agents (`ba288a7`)
- **What:** `GATEWAY_BRAND_NAME`, `GATEWAY_HANDLE_PREFIX`, `INSTINCT_AGENT_DESKTOP`, `INSTINCT_MODEL`.
  New agents get the brand as their name, the chosen model, and the desktop setting.
- **Where:** `packages/gateway/src/main.ts`, `gateway/src/provision.ts`, `gateway/src/brand.ts` (new).
- **If it breaks:** new agents fail to be created at Maritime, or run the wrong model or name.

### Schedule list wording (`704d137`)
- **What:** finished one-time jobs read "done, already sent at ...". Only the list text changed.
- **Where:** `packages/core/src/core-tools.ts` (`schedule_list`).
- **If it breaks:** the agent misreads its reminders. Low risk.

### Contact card, switched off (`08d5728`, `f82b1bd`)
- **What:** a "save to contacts" step with a sun picture. Off unless `GATEWAY_AGENT_NUMBER` is set.
- **Where:** `packages/gateway/src/contact.ts` (new), the `/connect/:id/contact.vcf` route in
  `gateway/src/server.ts`, the save step in `gateway/src/pages.ts`.
- **If it breaks:** nothing while it is off.

### Page design (`ba288a7`, `08d5728`, `f82b1bd`)
- **What:** minimal signup and connect pages, always dark, top-left sunlight, sun mark,
  animations (off with Reduce Motion), flags, one "Connect to Sunshine" button.
- **Where:** `packages/gateway/src/pages.ts`.
- **If it breaks:** only how the two web pages look or behave; the agent is not affected.

### Docs
- Gateway README, `docs/ARCHITECTURE.md`, `docs/DEPLOY-MARITIME.md`, this file. No effect on behavior.

## Outside the code

- **Railway** runs the gateway image `ghcr.io/torsteinvestre/open-instinct-gateway:latest`; its
  variables set the brand, prefix, country, model, invite code and keys. `INSTINCT_AGENT_IMAGE`
  decides which agent version new signups get.
- **Maritime** agents run `ghcr.io/torsteinvestre/open-instinct-agent:latest`. Existing agents
  keep their version until redeployed (`POST /api/deploy`, source `docker`); `/data` survives.
- **GitHub Actions** rebuild both images on every push to this fork's `main`.

## Known upstream issues not fixed here yet

- `instinct dev --tunnel` logs a harmless "409 already delivers" when restarted.
