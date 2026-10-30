# Changes in this fork

This fork (torsteinvestre/open-instinct) runs as **Sunshine**. It is based on
[mariagorskikh/open-instinct](https://github.com/mariagorskikh/open-instinct) at commit `79a144a`,
with upstream merged in up to `cb3d97c` on 2026-10-23 (see [Upstream merges](#upstream-merges)).
This page lists what the fork adds, so each change can be found, understood and removed.

## Tagged changes

Every change carries a tag in a code comment on every line or block it adds (the earliest ones were
tagged afterwards, see [Earlier changes](#earlier-changes-tagged-afterwards-2026-10-15)). Search the
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

Upstream's system tasks (`runSystemTask`, merged 2026-10-15) follow the scheduled-job rule: a task
that texted the owner with a tool sends no final reply, and `NO_REPLY` is never texted from one.

**A new tool that texts the owner or the current conversation** must declare `replyTarget`,
or the double message comes back for it. The tests list which tools declare it, so a new one
shows up there.

**With upstream's echo rule** (merged 2026-10-23: a reply is dropped when it repeats the thread's last
bubble word for word and the text that caused it was queued before that bubble went out), the fork's
rules run first in `deliver` (the lone tapback, then this guard), upstream's after them; a test covers
a queued "thanks" meeting both. Known gap, not new: the echo rule only knows bubbles the runtime sent
itself, so a queued text whose answer repeats a bubble sent with `send_message` still goes out.

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

### `[sunshine:reactions]`: tapbacks that replace a message, never add one

**Problem.** Upstream's `react` tool asked for a message id the model never sees, so it was never
used. Sunshine answered "thanks" with "You're welcome!", a message that adds nothing.

**What the fork adds.**

- `react` (`packages/inkbox/src/tools.ts`) always targets the message being answered
  (`ctx.replyRef.messageId`); only `like` and `love` (no laugh, question, dislike: easy to misuse);
  at most one per message; only in the owner's own one-to-one thread.
- `alone: true` declares the tapback the whole reply (`replyTarget: "acknowledge"`): the runtime
  (`packages/core/src/runtime.ts`) then drops any text the model writes after it ("I've already
  reacted…"), but only if the run used no other tool. If it did something, or a tool failed, the
  text still goes out, so a report is never swallowed. `alone: false` lets the words through.
- One short principle in the iMessage prompt (`packages/core/src/prompt.ts`), not a flowchart: a
  tapback only where it is the most natural response, never instead of words they need; alone when
  they close something just done; with a few words for happy news, where the one plain "no" is
  offers; words for anything sad; their own tapbacks are feedback, answered briefly only when they
  show confusion or displeasure; most messages get none.
- Off switch: `config.features.tapbacks = false` (upstream's flag, unused until now) removes both
  the tool and the guidance.
- Never a tapback on their tapback (it would land on Sunshine's own message): an incoming tapback is
  marked (`replyRef.tapback`, `packages/inkbox/src/events.ts`), and the tool then sends nothing and
  says there is nothing to do, worded so the model does not apologise. Found when the time stamps
  arrived (`[sunshine:stable-cache]`); after the fence, 6 of 6 of their tapbacks got nothing back.

**Why this wording.** Three versions were compared on the same conversations with the real model.
A numbered ladder kept happy replies clean but ignored a 👎 ("their tapbacks need no reply").
A principle without the offers sentence read signals well but offered things in half the happy
replies ("car insurance?" after a driving test). Allowing "only the obvious next step" kept good
offers but still offered celebration dinners after an engagement (10 of 18). The final version
(principle plus "no offers" in happy moments) scored 75/76 with no serious mistakes: happy 23/24
with no unwanted offer, closing 14/14, signals 6/6, sad, questions and requests all in words.

**Files.** `packages/inkbox/src/tools.ts` (tool, fences, off switch), `packages/core/src/runtime.ts`
(the lone-tapback rule), `packages/core/src/types.ts` (`ReplyTarget`), `packages/core/src/prompt.ts`
(guidance), tests next to each, and the scenario test `packages/server/scenarios/reactions.mjs`
(`node scenarios/reactions.mjs [rounds] [new|old|both] [kinds]`, about $0.25 for a full run).

**To remove.** Set `features.tapbacks` to false in the agent's config to switch it off. To take it
out of the code, revert its commits (`git log --grep "sunshine:reactions"`), or delete the tagged
blocks in the files above. Upstream's tool comes back unusable as before.

### `[sunshine:watcher]`: the news watch (built, off by default)

**Goal.** Sunshine texts its owner soon after something genuinely worth knowing happens in their
interests, and otherwise stays silent. Plan and reasoning: `~/sunshine-ops/WATCHER-PLAN.md`
(private notes). Principle: code for facts and fences, reasoning for taste.

**How a check works.** Every two hours outside the owner's quiet hours by default (one scheduled job
carrying `gate: "watcher"`; the owner can ask for 2, 3, 4, 6, 8, 12 or 24 hours, never faster: an
older faster setting counts as two hours and the job follows at the next start), entirely in code,
never waking the agent:

1. Fences: off, quiet hours, a daily model-call budget.
2. Collect: Google News RSS per search, last day only, headlines already seen skipped (by link
   and wording); Jev (`TYPESAFE_API_KEY`) removes the clearly off-topic, one yes/no per headline.
   The short list holds an hour's worth (30) for every hour between checks, at most 60
   (`headlinesPerCheck`); what does not fit waits for the next check.
3. Screen (step 1): off unless `WATCHER_SCREEN_MODEL` names a model (see below).
4. Decide (step 2, Claude Sonnet 5.5): the playbook, over every short-listed headline. Tell now / keep for later / nothing, plus the
   text and a story card per story ("new", or an update to an existing card with what changed).
5. The door (code): refuses an article already told, an update with nothing changed, or a "new"
   story that reads almost like a told one (unless the model says how it differs); one retry with
   the reason, else nothing is sent. Then quiet hours and a hidden limit of 6 texts a day.
6. Write (step 3, Claude Sonnet 5.5, scheduled texts only): the chosen stories are written as
   Sunshine would text them, with its persona, its memory of the owner, the last 10 messages of
   their thread and one web search per story (the agent's own `web_search`). It introduces unknown
   names from the search, adds a personal line only where one is real, says how something is doing
   but never advises (buy/sell/hold), and tells every story it was given. It may hold the text back
   only for re-posted old news (the search clearly shows the event is over a week old) or a bad
   moment, with a reason in the journal (`stage: "write"`) and the audit (`writerHeld`). A failed
   search writes from the headline; a failed or unusable writer sends step 2's own text.

**Why the writer.** Step 2 wrote from the headline alone, in its own voice: "Since you follow XRP:",
names nobody could place, and a "news watch" the agent then disowned. Tested on real headlines
(`packages/server/scenarios/writer.mjs`): the writer's texts read like a friend's; Sonnet beat Haiku
(Haiku explained itself and forced links); of 15 test stories, 7 old ones were held back and 8
fresh ones sent, after one fix (it had second-guessed whether a story was worth telling, and held
back one search could not confirm). About 0.4-0.6 cents per text sent.

**Speaking as itself.** The skill and the tools' descriptions and results say what Sunshine does
("keeping up with the news for them", "what you looked at"), never "the news watch", and
`watch_profile` lists timing and settings last, labelled "to mention only if they ask". With the
watch on, the owner's system prompt carries a short fixed section (`NEWS_PROMPT` in
`packages/watcher/src/prompts.ts`, added in `boot.ts`): talk about what you keep an eye on and why
it fit, not how. It has to be there: asked "how did you know?", the model never opened the skill
and recited what the tools had shown it ("I check Google News every 60 minutes… a search for
'startup Norge'"). Tested with `packages/server/scenarios/voice.mjs` (the real server answering
four questions about a news text it sent): machinery talk in 3 of 4 answers before, 0 of 4 in two
runs after ("I keep an eye on Norwegian startups and AI news for you, and that story fit"). Step
2's own text no longer opens with "Since you follow X" (`packages/watcher/scenarios/wording.mjs`).

**Why every two hours, and no screen** (2026-10-15). About 25-30 new headlines arrive per hour for a
typical owner, and a decision costs about 1.3 cents fixed (instructions, story cards, thinking) plus a
little per headline: measured 1.5 cents for 11 headlines, 1.72 for 25, 2.36 for 60. Hourly that is
about $8 a month per owner, every two hours about $5.70, and slower saves less and less while news
arrives later and each list gets longer. The Haiku screen saved almost nothing (its own call cost
about the difference) and dropped the day's one story worth telling (an Oslo pre-seed round, Jev
0.96), which Sonnet picked every time it saw it, among 11, 25 or 60 headlines. A filter in front of
the decision can only lose stories, so only Jev stays there: cheap, and a mechanical question.

No new headline means no model call. A failed step 2 sends nothing and its headlines wait for the
next check. Each check leaves one `policy` audit entry (`watcher: "check"`) with counts, outcome,
note and cost, and one line in the decision journal (`watcher-journal.jsonl`) with every headline
it looked at and where its path ended (Jev, screen, or decision). In conversation the agent has
six owner-only tools: `watch_profile`, `watch_profile_update`, `watch_check` (answers "anything
new?" in its own reply), `watch_journal` ("what did you skip?"), `watch_later`, `watch_settings`.

**Where to change what.**

| To change | Where |
|---|---|
| How the decision is made, examples | `packages/watcher/src/prompts.ts` (`DECIDE_SYSTEM`; the screen's `SCREEN_SYSTEM` next to it) |
| How a news text reads, when the writer holds back | `writeSystem` in `packages/watcher/src/prompts.ts` |
| What the writer is given (persona, memory, thread, search) | `packages/server/src/watcher-writer.ts` (`WRITER_THREAD_MESSAGES`); `RESEARCH_MAX_CHARS` in `packages/watcher/src/check.ts` |
| Which models, or one step off | env `WATCHER_SCREEN_MODEL` (unset: no screen), `WATCHER_DECIDE_MODEL`, `WATCHER_WRITE_MODEL` (`off` disables a step; the writer off sends step 2's text); `boot.ts` |
| Prompt caching for the steps (off) | `modelCall` in `packages/watcher/src/models.ts`. Off on purpose: Pi caches every call for 5 minutes and storing costs 25% more, but checks run an hour apart, so it was never read back (measured: 0.56 cents a call with it, 0.475 without) |
| Haiku 5.5 description (Pi 1.0.1 lacks it) | `resolveWatcherModel` in `packages/watcher/src/models.ts` |
| How often, quiet hours (per owner) | by text to Sunshine (`watch_settings`); defaults in `store.ts` (`DEFAULT_EVERY_MINUTES`, 120) / `clock.ts`. A changed default reaches new owners only. The choices: `CHECK_INTERVALS` in `clock.ts` (2 to 24 hours); `checkCron` starts long gaps at the first full hour after quiet hours |
| How many headlines one check takes on | `headlinesPerCheck`, `HEADLINES_PER_HOUR`, `DECIDE_MAX` in `packages/watcher/src/check.ts` |
| Text limit, model budget, ask-after hours | constants at the top of `packages/watcher/src/check.ts` |
| Jev threshold, how many headlines per search | `DEFAULTS` in `packages/watcher/src/scan.ts` |
| How the short list is shared between searches | `fairShare` in `packages/watcher/src/scan.ts` |
| The decision journal (`watcher-journal.jsonl`, 7 days) | `JOURNAL_*` in `store.ts`; read by the `watch_journal` tool |
| "Reads almost like a told story" threshold | `SAME_HEADLINE_OVERLAP` in `packages/watcher/src/decide.ts` |
| How Sunshine keeps the picture, reacts to feedback | `skills/news-watch/SKILL.md` |
| The interest question in the welcome chat | `skills/onboarding/SKILL.md` (see `[sunshine:onboarding]`) |
| Test scenarios (real models, costs cents) | `packages/watcher/scenarios/` |

**Core and server pieces.** `ScheduleEntry.gate` and `RuntimeDeps.scheduleGates` (a gated job
runs plain code first; a gate that is not registered makes the job do nothing),
`ScheduleEntry.toolRepliesOnly` (a second guard: such a job's final reply is never texted),
both in `core/src/types.ts` and `runtime.ts`. `server/src/boot.ts` creates the watcher only when
`INSTINCT_WATCHER=1`; unset, the agent is unchanged. On first boot with the switch on, the
owner's checks start by themselves; with no interests after a day, it asks once.

**For friends' agents** (2026-10-15). The gateway passes `INSTINCT_WATCHER`, `TYPESAFE_API_KEY` (as a
secret), the `WATCHER_*_MODEL` settings and `MEMORY_PASS_MODEL` to every new agent when they are set on
the gateway (`AGENT_SETTINGS`, `agentExtraEnv` in `packages/gateway/src/main.ts`; nothing else of the
gateway's own settings is passed). Agents created before keep what they had: change those with
`agent-env.sh` or Maritime's dashboard.

**Not done yet.** Opening the article itself: Google News links lead to a consent page in Europe, so
the writer uses a web search instead.

**To remove.** Delete `packages/watcher` and `skills/news-watch`, and every block tagged
`[sunshine:watcher]` (`boot.ts`, `server/src/watcher-writer.ts`, `server/package.json`, `types.ts`,
`runtime.ts`, both Dockerfiles, `skills/onboarding/SKILL.md`, `skills/README.md`, tests), then
`pnpm install`.

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

### `[sunshine:relative-time]`: "in N minutes" is computed by the code

**Problem.** `schedule_create` only took an exact ISO time, so for "remind me in 5 minutes" the model
did the sum itself. Usually right (it often checked the clock with `date` first), but not always:
asked at 11:27 in a long thread, it set 11:36. OpenClaw's agent tool has the same gap; only its
command line (`parseAt`, "20m") computes relative times in code.

**What the fork adds** (`packages/core/src/core-tools.ts`).

- An `inMinutes` option: "in 5 minutes" = 5, "in 2 hours" = 120. The tool adds it to the real clock
  (`ctx.now()`). It must stand alone (not with `at` or `cron`), above 0 and at most a year.
- The result also gives the owner's clock time ("Next run: 2026-10-14T09:32:00.000Z (Wed 14 Oct,
  11:32 Europe/Oslo)"), so the model never converts zones itself. Correct across the change to
  winter time (tested for Oslo, 25 October).
- The `at` description asks for the zone (Z or an offset). A time without one is read in the
  server's zone (UTC on Maritime); the model's past calls all had one, so this stays a description,
  not a code change.

**Tested with the real model** (`packages/server/scenarios/reminders.mjs`, 14 ways of asking, 2
rounds, about $0.24 with the old tool for comparison): new 28/28 at the right time, every relative
request used `inMinutes`, every clock time had the right offset (+01:00 after 25 October), and no
reply stated a wrong time (all in 24-hour form). The old tool: 27/28 in that short, clean thread
(today's 11:36 slip did not recur there), up to a minute early in half the relative cases (seconds
dropped), "in 2 days" once set to 09:00, and some replies in 12-hour form ("2:11 PM").

**To remove.** Revert its commit (`git log --grep "relative-time"`), or delete the tagged blocks in
`core-tools.ts`, its tests in `packages/core/test/core-tools.test.ts`, and the scenario. Reminders
then work as before, with the model doing the sum.

### `[sunshine:stable-cache]`: the prompt cache holds from one message to the next

**Problem.** Measured on the live agent (2026-10-14): each message cost 13-16 cents, because about
50,000 tokens (tools, system prompt, history) were paid as a fresh cache write every time. Two things
changed the start of the request on every run: the clock in the system prompt ("# Now", to the
millisecond), and the history fold, which moved one message into the summary on every turn once a
thread passed 60 messages. Anthropic's cache only reuses an identical prefix. OpenClaw keeps the time
out of its system prompt and compacts only near the limit, for the same reason.

**What the fork adds** (on unless `config.features.stableCache` is false).

- `packages/core/src/prompt.ts`: "# Now" becomes "# Time" (the timezone only, the same all day), and
  `timeStamp()` builds the line put in front of each message: `[Wed 14 Oct 2026, 12:27 Europe/Oslo,
  UTC+02:00]`.
- `packages/core/src/runtime.ts`: `Conversation` stamps every message it runs, steers or follows up
  (owner, friends, agents, scheduled jobs all pass through it). `foldInSteps()` replaces the sliding
  fold: nothing changes until 80 messages or the old 240k-character cap, then one fold down to 50
  messages / 160k characters. Between the model calls of one run only the size cap applies, so a fold
  happens once, at the start of a message.
- The off switch brings back upstream's prompt and fold on the next restart.

**Guards.** A test builds the system prompt at different times of day and requires it to be byte for
byte the same, so anything time-dependent added later fails at once. Tests also check the stamps, that
the history is only appended to between folds, the one-step fold on count and size, and the switch.
`packages/server/scenarios/cache.mjs` runs the real runtime against the real model, on and off, and
prints what each call read from the cache.

**Tested with the real model** (2026-10-14). Cache: with the switch on, each message after the first
read the whole start from the cache and cost about a tenth of the first; off, every message wrote it
again. The clock reaches the model ("It's 14:13 in Oslo", right) and no reply copied a stamp.
Reminders 14/14 at the right time. Tapbacks 37/38, no serious mistakes. One side effect found and
fenced: with stamps, a tapback of theirs sometimes got one back (2 of 6, 0 of 8 without stamps); see
`[sunshine:reactions]`. To watch: after "sounds good" the model sometimes sets a reminder nobody asked
for and says so (2 of 3 runs with stamps, 1 of 6 without, then 0 of 1).

**Known limits.** The memory digest (today's journal) is still in the system prompt: a journal entry
breaks the cache once. A message after more than 5 minutes of quiet pays full price (the cache's
lifetime); a 1-hour cache (`PI_CACHE_RETENTION=long`) is possible but costs twice as much to write.
`[sunshine:prune]` makes that full price smaller by shortening old tool results at exactly those moments.

**To remove.** Set `features.stableCache` to false in the agent's config and restart, or revert its
commit (`git log --grep "stable-cache"`) or delete the tagged blocks in `prompt.ts`, `runtime.ts`,
`types.ts`, the tests and the scenarios.

### `[sunshine:delivery-mirror]`: Sunshine knows what it texted the owner from elsewhere

**Problem.** A reminder, a news-watch text, a relay from a friend or an approval question reaches
the owner's phone from another conversation (`scheduled:<id>`, `scheduled:watcher`, a friend's
thread). The owner's own thread never recorded it, so a reply to it had no context: "preciate the
reminder" got "Did the stretch reminder come through?", and "What's Sanna?" after a news text made
Sunshine dig through its logs (live, 2026-10-14).

**What the fork adds** (as OpenClaw's "delivery mirror", `src/infra/outbound/deliver-transcript.ts`).

- `InkboxChannel.afterSend` (`packages/inkbox/src/channel.ts`): called after every successful send,
  never after a failed one; a failing hook never fails the send. Every text passes there: the
  runtime, the core tools, `send_message`, the news watch, payments. `boot.ts` wires it to the runtime.
- `AgentRuntime.mirrorToOwner` (`packages/core/src/runtime.ts`): if the text reached the owner's own
  thread (`ownerLast`) from a different conversation, two messages are added to that thread: a note
  (time stamp, "Not a message from <owner>: a note that you texted them the next message from <the
  news ("on your own, after reading the news for them") / a reminder ("when "stretch", which they
  set up with you, came due") / your conversation with Sam, in words without machinery>") and the text itself as
  Sunshine's message. Once: the same text to the same thread within two minutes is skipped. If the
  thread is mid-run, the copy is added when the run ends; if it is not loaded, it goes into the saved
  session file. Failures are logged, never retried or fatal.
- Off switch: `config.features.deliveryMirror = false`.

**Why the note.** Tested with the real model: a bare copy made Sunshine disown the news text ("didn't
come from anything I looked up, and I shouldn't have sent it"). With the note it answered "what's
Sanna?" from the text it had sent (`packages/server/scenarios/mirror.mjs`, on vs off).

**Not covered yet.** Files sent from elsewhere (`sendFile`) are not mirrored; only text.

**To remove.** Set `features.deliveryMirror` to false, or revert its commit
(`git log --grep "delivery-mirror"`) or delete the tagged blocks in `channel.ts`, `runtime.ts`,
`types.ts`, `boot.ts`, the tests and the scenario.

### `[sunshine:reminders]`: plain reminders cost nothing; repeating ones leave room in the day's texts

**Problem** (2026-10-15). Every reminder, even "drink water", ran a full agent turn: half a cent to a
few cents each, more when nothing else had run for a while, and nothing at all when the model was
unreachable (the credits ran out twice). And nothing limited how often a repeating one fired: "every
2 minutes, text me PING" worked in testing, which would cost dollars a day and use up the day's texts
(Inkbox lets an agent send 100 iMessages per rolling 24 hours).

**What the fork adds.**

- `schedule_create` takes `text` or `prompt` (`packages/core/src/core-tools.ts`). A plain reminder,
  whose words need no thinking when it fires, gives `text`: that message is stored on the job
  (`ScheduleEntry.text`, `types.ts`) and `runScheduled` sends it as written (`runtime.ts`), with no
  model run. A job that looks something up or decides gives `prompt`, as before. The model chooses,
  from the tool's description; the result repeats the exact message so its confirmation can say it.
- A repeating job is refused when, on its busiest day, it and the other repeating jobs would plan more
  than 40 texts (`REPEATING_SEND_SHARE` of `DAILY_SEND_LIMIT` 100; `busiestDayRuns` in
  `scheduler.ts` counts them). The refusal says why, so the model can tell the owner and offer an
  interval that fits. One-off reminders and jobs that run in code (the news, the memory notes) are not
  counted. A limit taken from the platform, not a judgment of how often is reasonable.

**Tested with the real model** (`packages/server/scenarios/reminder-kinds.mjs`, about 5 cents a round):
9 of 9 as expected. Five plain reminders (in 5 minutes, at 18, hourly 9-17, weekdays 8:55, Friday 12)
were saved as messages; three jobs (the daily weather, "only tell me if it rains", the morning XRP
price) as prompts; "every 2 minutes, PING" was refused and the reply explained it and offered what fits
("every 2 minutes for a limited window, like 14:10 to 14:50"). Found and fixed: an example message with
the owner's name came back in every reminder ("…, Torstein"), and the refusal counted only to 41.

**What it does not cover.** Repeating jobs that run the model ("every 10 minutes, check the price")
still cost per run; a daily spending limit per owner is the planned safety net for those.

**To remove.** Revert the commit (`git log --grep "sunshine:reminders"`) or delete the tagged blocks
in the files above and their tests (`core-tools.test.ts`, `scheduler.test.ts`, `runtime.test.ts`).
Jobs saved with `text` would then run their prompt ("Send the plain reminder: …") through the model.

### `[sunshine:memory]`: Sunshine keeps notes on what matters

**Problem** (2026-10-15). After three days of chatting, `memory/MEMORY.md` held 231 bytes: saving
depended on the model calling `memory_write` (3 times in 3 days), so the fund, the concert tickets and
the apartment plans were not in it. The summary of a trimmed conversation was the first 200 characters
of each message, and at the next trim that summary was clipped like any other message, so everything
older vanished (seen live: "[Conversation summ…"). And the digest in the prompt kept the start of
`MEMORY.md`, so once it grew, the newest facts would have been the first to drop out.

**What the fork adds.**

- `packages/core/src/runtime.ts` (`summarizeMessages`): an earlier summary is carried forward whole;
  time stamps are kept short ("[Wed 14 Oct, 12:27]"); over 6,000 characters the oldest highlights go.
- `packages/core/src/memory.ts` (`digest`): the start and the newest end of `MEMORY.md` when it is long.
- `packages/server/src/memory-pass.ts`: the nightly notes. At 03:30 in the owner's timezone a job that
  runs in code (gate `memory`, never wakes the agent, never texts) checks whether the owner texted since
  the last pass. If so, one model call reads `MEMORY.md` and the owner's own thread since then (and the
  summary of its trimmed part, if it was trimmed since) and writes `MEMORY.md` back, in sections: About,
  People, Preferences, Lately. The model decides what a friend would remember; the code checks the
  answer: under 2,400 characters (the part of the digest shown in full; one retry with the reason), a
  rewrite under 40% of a longer file is refused as a loss, seven backups in `memory/backups/`, every run
  in `memory-pass.json` and the audit log (`memoryPass`). A refused or failed night reads the same
  conversation again the next night.
- `packages/core/src/core-tools.ts`: `schedule_list` leaves out jobs that run in code (keeping up with
  the news, the memory notes) and `schedule_delete` will not remove them: they are not the owner's
  reminders.
- `packages/server/src/watcher-writer.ts`: `ownerThreadEntries`, the owner's thread as entries, shared by
  the news writer and the notes.

**Why at night.** The notes are in every message's prompt. Changed by day, the next message pays for
the whole prompt again (`[sunshine:stable-cache]`); at 03:30 the cache has long gone cold and nobody waits.

**Cost.** One call on nights after the owner texted, none otherwise: about 1-3 cents with Sonnet 5.5,
at most about $0.30-0.60 per owner per month. The notes in the prompt stay under the digest's cap.

**Privacy.** The Preferences section is what partners and family may see (`preferencesDigest`), so the
notes keep private things out of it. Only the owner's own thread is read.

**Settings.** `MEMORY_PASS_MODEL` picks the model; `off` switches the notes off and removes their job.
Without a key for the model there is no job either.

**Labelled lines** (2026-10-17, `packages/server/src/memory-notes.ts`).

The problem. Two nights of live notes had:
- under About: a one-off file, the app setup, and a stale "next step";
- under Preferences: a testing habit ("often asks for quick water reminders");
- no People section;
- under Lately: an inbox summary with a prescription message, and the news settings.

Rules about what each section is for helped, but every new rule moved something else (inertia, duplicates,
calendar invitees with their addresses). The cause: one call found, classified, reconciled and rewrote
the whole file as prose.

What changed:
- The model reads the notes as numbered lines with their labels and proposes changes: add, update,
  remove with a reason, relabel.
- Each line's labels:
  - `kind`: lasting / person / preference / current;
  - `date`: last true;
  - `until`: for something coming up;
  - `source`: said / showed / read;
  - `taken_up`, `about_agent`, `private`.
- Code applies the changes and enforces the rules:
  - it keeps out lines about the agent itself, what it read and nobody took up, and private things they
    did not raise;
  - a private preference goes under About, out of the shared section;
  - it strips email addresses and phone numbers;
  - a current note goes the day after its `until`, or 14 days after its `date`; each note shows the day
    it goes;
  - it renders `MEMORY.md` in the same shape, so the digest, `preferencesDigest`, `memory_write` and hand
    edits keep working.
- Lines the model does not mention stay as they are. A line without labels (a hand edit, `memory_write`,
  older notes) is labelled the next night.
- Labels are kept in `memory/labels.json`.
- Every removal or line kept out goes to the audit log with its reason (`memoryChanges`).
- A night that would lose more than 60% of the lines is refused.
- Where facts came from is shown, not guessed: a reply after tools that read the world is marked
  "Sunshine (after reading email or calendar)". `replySources`/`toolSource` in core's `history.ts` work
  this out, and the history keeps it (`tools` on an entry).
- Reasoning medium (`MEMORY_REASONING`).

Tests:
- Unit tests in `test/memory-notes.test.ts` and `test/memory-pass.test.ts`.
- `scenarios/memory-notes.mjs`: 16 one-case conversations, plus copies of a live agent's notes, about
  10 cents a round.
- Round 1: 12 of 13 made-up cases right. The live copies showed an upcoming concert filed as current with
  no day (it would have gone before the concert), a fund merged into a plan, and a setting ("text me if
  Kanye tours") that hid an interest. Answered with `until`, the day a note goes shown, "a lasting fact and
  a current plan are separate notes", and "a setting that also tells something about them gets a separate
  note".
- Round 2: 14 of 16 made-up cases right, and every privacy slip stayed out of both live copies.
  - "Keep your answers short" was taken for something about the agent ("how they use it"). Fixed: how they
    want to be talked to or helped is a preference.
  - A relabelled Kanye line lost the interest. Fixed: the separate note applies on relabelling too.
  - Left to watch live: an invitee meeting kept as coming up.
- Due notes. A fund merged into a plan once, in a run from older notes: aging out would have taken the
  fund with it, unseen. Now a current note past its day is marked "due" (`isDue`). The model must decide
  it: keep it with a new date or `until`, relabel it, split out what is lasting, or remove it. Left
  undecided, it goes back once as a problem. A night with no model call deletes nothing.
  3 of 3 with the real model:
  - the fund was split out and kept as a lasting fact;
  - a quiet Maldives idea was removed, with the reason given;
  - a concert that had happened went, and "huge J. Cole fan" stayed.

**Known limits.** On a very busy day, messages trimmed before the night reach the notes only as summary
highlights (200 characters each).

**To remove.** `MEMORY_PASS_MODEL=off`, or revert the commits (`git log --grep "sunshine:memory"`) or
delete the tagged blocks in the files above, `memory-notes.ts` and their tests
(`packages/server/test/memory-pass.test.ts`, `memory-notes.test.ts`, `packages/core/test/runtime.test.ts`,
`memory.test.ts`, `core-tools.test.ts`, `history.test.ts`). `memory/labels.json` can then be deleted.

### `[sunshine:apps]`: Gmail and Calendar through Composio's router (workbench kept)

**Measured** (2026-10-15, a local boot with the live agent's settings, Anthropic's token counter):
Gmail and Google Calendar in Composio's **direct** mode are 109 tools, about **100,000 tokens on every
message** (nearly six times the whole prompt). **Router** mode is 6 meta tools, about 8,600 tokens
(the remote workbench 2,019 and remote bash 406 of them). The agent runs with `COMPOSIO_MODE=router`
and `COMPOSIO_TOOLKITS=gmail,googlecalendar` (Maritime settings), so apps are the owner's only.

**Loaded only when needed** since `[sunshine:tool-loader]`: the router's tools come with `load_tools`
("apps") instead of riding along with every message.

**History: the workbench was left out 2026-10-15 to 2026-10-22, and that broke reading emails.** A
`LEFT_OUT_TOOLS` filter hid the workbench and bash tools ("email and calendar never need them", judged
from their descriptions). But Composio moves large results to the workbench and returns a preview plus
a note (its docs: "Large responses ... are automatically synced to a secure remote workbench"); a single
full email (`format: full`) is enough. Without the tools Sunshine could not read past the preview: Zia's
agent said "the full text lands somewhere I can't open" (19 Oct). Removed again 2026-10-22, back to
upstream's `tools()`. Test: `packages/apps/test/composio.test.ts` "keeps Composio's remote workbench
tools"; real check `packages/server/scenarios/long-email.mjs` (real Composio, one connected account, the
email's real ending as the answer key): with the tools, a full Delphi email was offloaded, read with the
bash tool and its ending quoted word for word (26/123 six-word runs, $0.107). The two tools cost about
2,400 tokens only on email and calendar turns (tool loader).

**To remove.** Nothing left in the code; the test and the scenario above guard the workbench.

**Other people's agents** reach the apps through `[sunshine:app-permissions]` below; router mode alone made
them owner-only.

### `[sunshine:app-permissions]`: other people's agents use the owner's apps within their tier, in router mode

**Problem** (2026-10-23). Upstream tags every app action with what it needs (`capabilitiesForSlug`: free/busy,
calendar read or write, email read or send, contacts), so in Composio's direct mode a friend's agent may check
the owner's free/busy and a partner's may read the calendar, each as `docs/PERMISSIONS.md` says. In router mode,
which the fork uses because direct mode costs about 100,000 tokens per message (`[sunshine:apps]`), every action
runs through `COMPOSIO_MULTI_EXECUTE_TOOL`, which upstream tags owner-only because the guard could not see
inside it. So another person's agent could use none of the owner's apps: in the agent-to-agent test Zia's
agent had to ask Zia whether Zia was free instead of checking.

**What the fork adds.**
- `ToolMeta.capabilitiesFor` (`packages/core/src/types.ts`) and `callCapabilities` (`policy.ts`): a tool whose
  calls differ in what they do says per call what that call needs. `PolicyEngine.evaluate`, the approval's
  capability (`askedCapability`) and spend recording (`recordToolCall`) use it; the fixed `capabilities` still
  decide who sees the tool. A call it cannot judge is refused.
- `COMPOSIO_MULTI_EXECUTE_TOOL` (`packages/apps/src/wrap.ts`, `capabilities.ts`): shown to every tier with
  `apps.use` (staff, partner, family, friend); each call needs `apps.use` plus every listed action's own tags
  (`capabilitiesForMultiExecute`), so it gets exactly what the same actions as direct tools would get. A call
  that is not a list of `{ tool_slug }`, or that runs a Composio meta tool, stays owner-only. Approvals and the
  audit name the actions, not the generic tool. For the owner the only change is that money actions now go
  through the spend policy, as upstream's direct tools do.
- `COMPOSIO_GET_TOOL_SCHEMAS` opened to tiers with `apps.use`: checked live, it returns input schemas and
  suggestions, no account data. The search (`COMPOSIO_SEARCH_TOOLS`) stays owner-only: checked live, its answer
  carries the owner's account data (calendar events, with names and addresses). Connections and the workbench
  (which can run any action from code) stay owner-only.
- Discovery without the search: at boot, in router mode, the agent reads Composio's catalog of the configured
  toolkits' actions (`ComposioApps.actionCatalog`, no session, no account data; 108 for Gmail and Calendar), and a
  conversation with anyone but the owner gets a short section naming the actions that person's tier may ever use
  (`appsForOthersGuidance`, `actionsAllowed`, wired in `boot.ts` `promptExtra`). The owner's prompt is unchanged.
- Upstream's free/busy row lacked the catalog's name for one action: `GOOGLECALENDAR_FREE_BUSY_QUERY` added.

**Tested** (all free). Unit tests: `packages/core/test/policy.test.ts` and `runtime.test.ts` (per-call
capabilities, refusal of a call it cannot judge, grants, a friend's call run or refused through the runtime),
`packages/apps/test/capabilities.test.ts` (the multi-execute answer equals the direct tool's for every tier,
unreadable calls and meta tools owner-only, the owner's spend policy, the per-tier action lists) and
`wrap.test.ts`. End to end, `packages/server/scenarios/app-permissions.mjs` (the real server, the real Composio
router of the owner's own account, a stand-in model, no model cost): a friend was offered only the schema
lookup and the executor, its prompt named the two free/busy actions, free/busy ran against Composio, the inbox was
refused before anything reached Composio and the owner was told ("Sam asked to GMAIL_FETCH_EMAILS ...; I
declined"), and the search was not offered. An owner chat's system prompt and tools stayed byte-identical (same
fingerprints, 11,017 tokens); with the app tools loaded, only the executor's note changed.

**Known limits.**
- The free/busy actions accept calendar ids, so a friend's agent could ask about any calendar the owner can see
  (a shared work calendar), as upstream's direct tools allow too.
- Large results go to the workbench, which stays the owner's: a partner's agent asking for a long event list
  may get a truncated answer.
- The catalog is read at boot: a toolkit added later is listed for others after a restart.
- Permissions come from the tier and grants as upstream defines them; a grant must include `apps.use` for a
  contact-tier person to reach any app.

**To remove.** Revert the commit (`git log --grep "sunshine:app-permissions"`) or delete the tagged blocks in
`types.ts`, `policy.ts`, `runtime.ts`, `capabilities.ts`, `wrap.ts`, `composio.ts`, `guidance.ts`, `index.ts`,
`boot.ts`, the tests and the scenario. Apps are then the owner's alone in router mode, as upstream intends.

### `[sunshine:prune]`: old tool results are removed once their turn is over

**Problem** (measured live 2026-10-15, a Gmail and Calendar test). Six requests in seven minutes grew the
owner's history from 35k to 72k tokens: every email list and tool search (10,000-21,000 characters each)
stayed in the history and was sent again with every later message. Tool results were 59% of it, nearly
all in the 9 results over 2,000 characters. A message after a pause would have cost about 18 cents.

**What the fork adds** (copied from OpenClaw's session pruning, `contextPruning.mode: "cache-ttl"`).

- `pruneToolResults` (`packages/core/src/runtime.ts`): every tool result before the last turn that is
  longer than 2,000 characters (`PRUNE_MIN_CHARS`), or holds an image, is replaced by `PRUNED_RESULT`:
  "[Removed from the history later, to save space. You had the full result when you used it. Run the
  tool again if you need the details.]". The call, its id and its place stay, so the history stays valid
  for the API; running it again changes nothing. Conversation text is never touched, and nothing else
  reads old results (the memory notes and the news writer read only messages and replies).
- **Why nothing of the result is kept** (`packages/server/scenarios/prune.mjs`, 2026-10-15). A first
  version kept the first 600 characters and "N more characters left out". With the real model the answers
  stayed right, but beside a partial start its own detailed reply looked unsupported: it looked the emails
  up again and told the owner "I wrote it from a result that had been cut off, so I should have
  re-checked" and "my first summary went out when I'd only seen part of your inbox" (2 to 3 of 3 runs;
  rewording the note alone did not stop it). Removed whole, as OpenClaw's hard clear and Anthropic's own
  clearing do, 3 of 3 runs answered from its own earlier reply with no self-doubt and nothing made up.
  A follow-up that needs a detail only in the removed result (the J. Cole order number, in none of the
  first summaries): 3 of 3 runs looked the emails up again and answered right, with no self-doubt and
  nothing made up.
- The last turn (from the message that began the last model run) stays whole, so "reply to the second
  one" still finds what was just looked up. A reminder's note and copy added since do not move it.
- **When:** at the start of a message, only if the start of the prompt is paid in full anyway: the history
  was just folded, or the last model call in this conversation is at least 5 minutes ago (Anthropic's
  cache lifetime, `PROMPT_CACHE_MS`; one hour when `PI_CACHE_RETENTION=long`, passed by `boot.ts` as
  `promptCacheMs`). Between messages a few minutes apart nothing changes, so the cache keeps being read.
  OpenClaw's other route, Anthropic's server-side clearing, was not used: its docs say clearing
  invalidates the cache from the first cleared result, every time it clears.
- The history is saved without them, so later calls start from the same text. Each pruning leaves an audit
  entry (`policy`, `prunedToolResults`, `prunedChars`).
- Off switch: `config.features.pruneToolResults = false`.

**Expected effect.** In the measured history about 83,000 of 92,600 tool-result characters go (about
20,000 tokens): a message after a pause from about 18 cents to about 10. Chat without tools barely changes.
In the scenario the first call after the pause carried 5,500 tokens instead of 12,500.

**Tests** (`packages/core/test/runtime.test.ts`, "prune old tool results"): warm cache leaves everything;
lapsed cache removes all but the last turn and saves it; a fold removes even while warm; the one-hour
cache and the off switch; small results untouched, old screenshots removed, the same result on a second
pass; reminder copies do not count as model calls. Real model: `node scenarios/prune.mjs [on|off|both]
[rounds]` (about 6 cents for the first round, about 2 for each further one).

**To remove.** Set `features.pruneToolResults` to false, or revert the commit
(`git log --grep "sunshine:prune"`) or delete the tagged blocks in `runtime.ts`, `types.ts`, `boot.ts`
and the tests.

### `[sunshine:onboarding]`: a short welcome on a new owner's first text

**Problem** (2026-10-15/16). Upstream's welcome skill was an eight-step checklist (name, city, texting
style, news, apps, partner, family, morning text) that began by asking for the name signup already
gave. And it never ran: tested with the real model and a new friend's exact prompt
(`packages/server/scenarios/onboarding.mjs`), Sonnet never opened it, because nothing says a text is
someone's first ("Hej!" with no history looks like any other). Without it the first reply was a bare
"Vad kan jag hjälpa dig med?", and it never asked what news to follow, so the news stayed idle.

**What the fork adds.**

- `skills/onboarding/SKILL.md` rewritten as principles: greet by name and do not ask what signup gave;
  one short opening text (who you are, a couple of things you can do, one question, usually what to
  follow); one question per text; two or three exchanges, then something useful or "text me whenever";
  stop when they are busy; their language; everything else (style, quiet hours, people, apps, a morning
  text) when it comes up. Apps only when set up.
- `welcomeIfFirstText` (`packages/core/src/runtime.ts`): on the owner's very first text in their own
  text thread (nothing in it yet, no facts in `MEMORY.md`), a note goes in front of it: "[Not a message
  from <owner>: they signed up a moment ago, and the next message is their first text to you. How to
  welcome them:]" and the skill's instructions. In the delivery mirror's form, so the news writer and
  the memory notes treat it as a note. Once: afterwards the thread is not empty; saved with the thread,
  so a restart does not repeat it. Audit entry `policy` `firstContact`. Not for the dashboard chat, groups,
  or an owner with saved facts (existing agents never see it). OpenClaw passes its first-run ritual
  (BOOTSTRAP.md) with the first message for the same reason: models do not reliably open it themselves.
- `RuntimeDeps.firstContactGuide`, filled by `boot.ts` with `skillGuide(skills, "onboarding")`
  (`packages/server/src/skills.ts`: the skill without its header and comments).

**Tested with the real model** (2026-10-16, $0.087): a curious Swede writing Swedish and a busy one
opening in English, the friend played by Haiku. Both opened with hello by name, who Sunshine is, what it
does and one question (what to follow); no name or timezone questions, one question per text, Swedish
throughout for the Swede; it saved her interests and memory and set two correct reminders for her
Lisbon flight in three texts; the busy one got "No problem, Åsa. Text me whenever something comes up."
The opening follows the skill's example almost word for word, so that example is the welcome's wording.

**To remove.** Revert the commits (`git log --grep "sunshine:onboarding"`) or delete the tagged blocks
in `runtime.ts`, `boot.ts`, `skills.ts` and their tests; restore upstream's `skills/onboarding/SKILL.md`.

### `[sunshine:history]`: the owner's conversations stay searchable after a trim

**Problem** (seen live 2026-10-16). Upstream folds older messages into a short summary and deletes
them from disk. The owner's agent could see whole messages back to the day before, 200-character
highlights for one more day, and nothing older: what was said on the first days survived only as the
few facts in `MEMORY.md`. The nightly notes had the same gap on busy days (only the highlights of
what a trim removed). OpenClaw keeps transcripts searchable (`memory_search`).

**What the fork adds.**

- `HistoryArchive` (`packages/core/src/history.ts`): each time an owner thread (their own iMessage/SMS
  threads and the dashboard chat) is saved, its conversation is added to `history/owner.jsonl`: the
  owner's texts, the agent's replies, and the runtime's notes (kept to 300 characters), with the time;
  each message once. Not kept: tool calls and results (they can be fetched again), trim summaries,
  other people's threads. Entries older than 365 days (`HISTORY_KEEP_DAYS`) are dropped.
- Two owner-only tools (`packages/core/src/core-tools.ts`, capability `memory.write`):
  `history_search` (words, optional days in the owner's timezone; newest first, each with the answer
  that followed; dated, "things may have changed since") and `history_forget` (lists what contains the
  words, removes it on `confirm`; removed messages are remembered by fingerprint in
  `history/forgotten.json`, no text, so the live thread cannot write them back).
- The nightly notes (`packages/server/src/memory-pass.ts`) read the whole day from the archive, merged
  with the live thread; the trim summary is used only where the archive does not reach back.
- Off switch: `config.features.history = false` (no archive, no tools).

**Cost.** The two tools add about 246 tokens to every message (measured with Anthropic's token count),
about $0.08 per owner per month; a search is one extra model call when the past is asked about. Storage
is text on the agent's disk, about 1 MB a month.

**Tested.** Unit tests (`packages/core/test/history.test.ts`, the "kept history" test in
`runtime.test.ts`, `memory-pass.test.ts`): kept once, stamps dropped, notes short, no tool traffic;
words in any order, newest first, a reply shown under its question; days in the owner's zone; forget
lists then removes and never re-adds; the age limit; a fold removes a message from view but search finds
it; other people's threads not kept; the notes read whole messages from the archive. Real model
(`packages/server/scenarios/history.mjs`, $0.027): with nothing in view, it searched and answered "Your
bike lock code is 4471. You told me on Monday."; reproduced Thursday's four fund-vs-apartment points;
for a birthday never mentioned it searched twice and said it could not find it, without inventing one.

**To remove.** `features.history = false`, or revert the commit (`git log --grep "sunshine:history"`)
or delete `history.ts`, its tools and the tagged blocks in `runtime.ts`, `types.ts`, `index.ts`,
`boot.ts`, `memory-pass.ts`, `watcher-writer.ts` and the tests.

### `[sunshine:in-the-flow]`: what is already known comes with everything new; look before asking

**Why** (2026-10-27). Torstein's first voice note was answered with "What's the event on 3 Nov, and what time?" while
the answer was in his email: nothing brought what Sunshine knows to the new item, and email was reachable only if the
model thought to look (it loaded the apps, searched for calendar tools, never for email). Torstein: memory is always
part of the flow, not something the agent has to remember to search; the agent is not lazy, but not eager either
where it is not clearly his. Town feeds the relevant part of its memory into every session. Design and decisions:
`~/sunshine-ops/DESIGN-memory-in-the-flow.md` (step 1).

**What the fork adds**
- `packages/server/src/recall.ts`: before the agent decides, code gathers what is already known about the item's
  subjects (its title, the owner's tasks, what is unclear, what was left open): the closest pieces of the owner's
  chats and kept items by meaning and words (`MeaningSearch.searchScored`, new in core, with each piece's closeness),
  the item itself left out, one entry per item, best first, at most six, kept short. Pieces less close than
  `RECALL_MIN_NEAR` (0.45) are dropped: measured with `scenarios/recall-calibrate.mjs` on the memory trial's archive,
  the closest piece for 25 real questions was 0.41-0.73, for 20 everyday things it holds nothing about 0.25-0.49; at
  0.45, 24 of 25 keep their match and 1 of 20 gets a weak one. Word search answers when the search model takes over
  30 s.
- `intake.ts`: the summary also lists `to_settle` (what a task needs that the record leaves out: which event, what
  time, who), kept on the item as `toSettle` (not part of the searched summary lines); the hand-off shows it as "Still
  unclear", brings "What you already know that may bear on it" (or says nothing kept bears on it; says nothing when
  nothing was looked up), and says the order: what you know, then email, calendar and earlier conversations (check the
  calendar before adding), then ask only what is left, in one text. Where doing ends is the owner's setting:
  "prepare and offer" (default: small undoable things done and told in one line, bigger work prepared and offered
  once), "ask first", "just do it"; heard tasks acted on only when clearly the owner's (band and recordings); other
  people, money and speaking for the owner always ask first. The `proactivity` tool (owner only) sets the level in
  words, in `/data/proactivity.json`. Since 2026-10-30 these criteria and the setting are one rule for everything the
  owner's Sunshine does, in the system prompt: `[sunshine:acting]`.
- `runtime.ts` (core): `runSystemTask({ load })` starts a task with tool groups loaded (a hand-off with `apps`: email
  and calendar), after the run's cold-cache unload (which would drop them again), with what loading says in the prompt
  ("ready now"). `boot.ts` passes `apps` when Composio (or a scenario's stand-in apps tools, `extraTools`) is there.

**Tested** (free): `test/recall.test.ts` (closest first, weak ones and the item itself left out, one per item, word
search when the model is slow), `test/intake.test.ts` (recall asked about the right subjects, "Still unclear", the
known block or its absence, the three levels, heard-not-typed only for recordings, `load`), core `runtime.test.ts`
(the group's tools in the first model call, the prompt saying so). All tests and smoke pass.
Paid, `scenarios/in-the-flow.mjs` (Torstein OK'd up to $1; real summary step and agent, Sonnet 5.5; a stand-in inbox
and calendar; a small kept memory; graders checked on 10 known answers incl. the live reply): new version 10/10
(3 Nov 2/2: added from the email, nothing asked; group project 2/2: "from your 19 Oct kickoff, it's you, Ian and Scott,
topic traversable wormholes ... What day next week is it due? I can draft a slide outline meanwhile"; someone else's
task 2/2 left alone; a passing thought 2/2 nothing done; nowhere to find it 2/2 asked, with a reminder set); the live
version 1/2 (3 Nov passed: the stand-in email tool is one obvious tool, unlike Composio's several steps, so this case
does not tell the two apart; group project failed: a bare reminder, no topic). About $0.02 a run; $0.24 in all.
Seen in both: a promotional email ("Elkjøp has 20% off chargers") linked to "buy a new charger" (Torstein to judge:
help or clutter).

**Open.** The same for the owner's own messages (only on strong matches; next). The live check: a voice note about
something only in his real email, through Composio.

**Live check, then the look-up by code** (2026-10-29). The live check of 27 Oct ("do I have anything next week?")
failed twice: the agent asked "What is the 3 Nov event?" again without searching his email (instructions and loaded
tools were not enough), and it offered to add a concert already in his calendar because the 27 Oct summary had guessed
"not in it yet" and that guess was kept. Evaluated first (`DESIGN-memory-in-the-flow.md`, "Fixes after the live
check"); Composio's own `session.execute` checked on his real Gmail first (free, OK'd): the date search found the
right email alone, about 1 s a search; his event confirmation and ticket order are both in Gmail's Updates category.
- `packages/server/src/lookup.ts`: code reads the live sources before the hand-off. The summary step writes
  `searches` (for the points still unclear, in Gmail's search words) and `days` (YYYY-MM-DD or a span, worked out from
  the record's date, now given with its year); each search runs on the email plug (newest 5 shown, promotions left out,
  Updates kept; HTML entities decoded, invisible padding dropped) and each day or span (up to 31 days: "in November"
  is asked as the whole month) on the calendar plug, from the owner's midnight to the next. Shown under "What ... email
  and calendar show for it, looked up just now", as untrusted data, with "nothing found" told apart from "not looked
  at" (a failed or slow source: 30 s), and every cut said (one more email or event is asked for than is shown; a longer
  span names the day it was asked to end); at most 8,000 characters. The plugs are Composio's
  GMAIL_FETCH_EMAILS and GOOGLECALENDAR_EVENTS_LIST, each only when its toolkit is in the agent's list; another app is
  one more plug. Searches and days are for that hand-off only, not kept with the item (other systems' state is read
  live, never kept as memory). No extra model call; a failed look-up never stops the hand-off.
- `apps/src/composio.ts`: `ComposioApps.execute(slug, args)` runs one action through the session the agent's tools
  use; code only, the model never gets it.
- `intake.ts`: the summary is told the record says what was said and asked for, not what is in a calendar, an inbox
  or another app now. `boot.ts` wires the Composio plugs (or a scenario's `liveSources`).
- Not done: leaving "(note)" lines out of recall (seen once as noise; notes may be copies of texts Sunshine sent, so
  watch list until checked).

**Tested** (free): `test/lookup.test.ts` (12: each search and day shown, nothing found vs not looked at, slow source,
spans and all-day events, cuts said, the owner's midnights across daylight saving, size bounds, entities and invisible
characters, the Composio plugs' requests and answers, only connected toolkits), `test/intake.test.ts` (+2: the summary asked for searches and days with the year,
the hand-off section and wording, nothing looked up when nothing asked, a failed look-up does not stop the hand-off),
apps `composio.test.ts` (+2). All tests (1,472), smoke and typecheck pass. `scenarios/in-the-flow.mjs`: the stand-in
inbox now goes through the look-up with Gmail-like matching (checked free on 5 known searches; `LOOKUP=0` leaves it
out); the stand-in's 3 Nov is now a Tuesday, as in 2026. `scenarios/look-up-real.mjs` (graders checked free on 14
known answers): the real summary step against his REAL Gmail and calendar (read only), the agent not run.
Paid, test 1 (Torstein OK'd; 2 runs x 3 cases, $0.027): 6/6. "The event on the third of November" -> a search for the
date written six ways found the Founders Story guestlist email first, calendar 3 Nov read; "put the J. Cole concert in
my calendar" -> the Ticketmaster order AND the calendar's J. Cole event on 12 Nov (already there: the 27 Oct
duplicate offer cannot happen with this); "do I have anything next week?" -> 2-8 Nov read. No calendar-state claim
in any summary (no before run, so (B) itself is not shown). It showed three things, fixed after it: the month span was
cut at 14 days without saying so (J. Cole on 12 Nov was inside by luck), the same silent cut at 5 emails and 25
events, and snippets with HTML entities and invisible padding. Watch: with one real match the date search fills up
with old newsletters (dated, so the agent can tell).
Paid, test 2 (Torstein OK'd; `in-the-flow.mjs` on the new version, stand-in inbox through the look-up, 2 runs x 5
cases, $0.27): 10/10 after a grader fix. Scored 9/10 at first: the 3 Nov reply ("I added the Startup Norway Founder
Meetup ... Do you want me to look for one? If so, tell me which device it's for.") was counted as asking about the
event; the question was about the charger. The check now counts only questions (a sentence ending in "?"), checked on
12 known answers incl. that reply and the live failure of 27 Oct; `REGRADE=<file>` re-judges saved runs free. The
look-up shows in the replies: "Your calendar was empty that day", "Nothing in email or calendar on the due date", "I
found nothing in your mail, calendar or past chats". This stand-in cannot show the 3 Nov gain (the old version passed
it too, with an easy stand-in email tool); that is the live check's job. Watch: broad one-word searches ("PowerPoint
OR presentation OR slides OR deadline") would fill up with unrelated mail in a real inbox; reminders set without asking
in the "nowhere" case (as before; small and undoable, allowed by "prepare and offer").

**To remove.** Revert the commits (`git log --grep "sunshine:in-the-flow"`), or delete `recall.ts`, `lookup.ts`, their
tests and the three scenarios, and the tagged lines in `intake.ts`, `boot.ts`, apps `composio.ts` and `index.ts`, core
`items.ts`, `meaning.ts` and `runtime.ts`.

### `[sunshine:grounding]`: every message from the owner is grounded before the model answers it

**Why** (2026-10-29). Torstein texted "Anything happening next week for me"; Sunshine read his calendar (empty) and asked
him for the details of a 3 Nov event it knew of, though they were in his email. Torstein: "this is a very simple task
... we can't just patch a fix on top"; "looking at everything and then acting is such a core thing". Replayed on a
local copy of his thread (`scenarios/look-before-ask.mjs`, `[sunshine:look-before-ask]`), it never searched email: 0/3
as live, 0/3 with thinking at "high" (Sonnet 5.5 judged the texts too simple to think about; no thinking blocks at any
level), 0/3 without its two old questions in the thread (it then forgot the event and answered from the calendar
alone). An instruction would still leave looking to the model's diligence. Assistants that know a person's work
ground in code: Microsoft 365 Copilot grounds each prompt in the person's mail, calendar and files; Glean answers from
its index; Town feeds its wiki into every session. Design: `~/sunshine-ops/DESIGN-memory-in-the-flow.md` (Part 1, job 4).

**What the fork adds**
- core `runtime.ts`: `RuntimeDeps.groundMessage(input)`, called for the owner's own messages (imessage, sms, chat;
  not groups, not delegated results) after the typing dots start; what it returns goes after the owner's text in that
  run's model calls only (`transformContext`, `withGrounding`), never saved, so the thread, its archive and later recall
  stay the owner's words. It gets the text and the latest 8 texts before it (notes and tool steps left out, each
  clipped to 500 characters). A failure is logged and the reply goes on; so it does after 20 s.
- `packages/server/src/ground.ts`: recall on the message first (`recall.ts`, chats of the last day left out: they are
  in the thread), then a small model (Claude Haiku 5.5, `GROUND_MODEL`, "off" grounds nothing) sees now, the owner's
  notes, that recall and the latest texts, and answers `needed`, `about`, `days`, `searches` (criteria: what it
  concerns including what it implies; dates worked out from now, a week Monday to Sunday; email searches, and for
  anything known only in part a search for the rest by its name or date; Gmail searches by an email's words and send
  date, not an event's date). Nothing needed (a greeting, a general question): nothing handed over. Otherwise recall on
  the message and what it concerns, and the look-up (`lookup.ts`: calendar for the days, email searches), side by side;
  handed over as a note "[Not a message from <owner>: what Sunshine's own code gathered ...]" with the same blocks as a
  recording's hand-off. The answer comes in a fixed form (`[sunshine:fixed-form]`); an unreadable one is logged with
  how it began.
- `recall.ts`: `chatsBefore`. `boot.ts`: recall and the look-up built once for the hand-offs and the grounding; the
  grounding's recall waits 8 s for a cold search model, then word search answers.
- `lookup.ts` `weeksLine`: this week and next, Monday to Sunday with their dates, in the step's "Now" line and in a
  recording summary's date line, so "next week" is read, not worked out (10 runs of "Anything happening next week for
  me", 29 Oct: 2 took it as the next 7 days). The prompt's "(a week runs Monday to Sunday)" removed.

**Tested** (free): core `runtime.test.ts` (+2: the grounding in both model calls of a run with a tool step, not in the
next run, never on disk; the step's input; a failing step does not stop the reply; strangers not grounded),
`test/ground.test.ts` (7), `test/recall.test.ts` (+1). All tests (1,482), smoke and typecheck pass.
Paid (Torstein OK'd each), `look-before-ask.mjs` on the copy of his thread with the stand-in inbox and calendar (the
Founders Story email found only when a search would match it; grader checked on 5 known answers incl. the live reply):
first version 1/3 ($0.117): the small model wrote its searches before seeing what was known ("invitation OR booking";
once "after:2026/10/29", a send-date filter) and the agent then said "I found no invites in your email". Known-first
version 3/3 ($0.118): "Yes, one thing: Founders Story Oslo, Tuesday 3 Nov, 18:00-21:00 at Startup Lab ... It's not in
your calendar. Want me to add it?"; without the old questions 2/3 ($0.079), the miss an unreadable answer from the
small model (1 in 10 calls so far; now asked again). The step: about $0.0004 and 3-6 s a message.

**Open.** Everyday texts (greetings, general questions): nothing gathered, time added. Live: the search model loads
more often (released after 10 idle minutes), up to 8 s more after a gap. The records of events with dates (design step
2) and email flowing in (step 3) are still to come; this reads email live.

**To remove.** Revert the commits (`git log --grep "sunshine:grounding"`), or delete `ground.ts`, its test and
`scenarios/look-before-ask.mjs`, and the tagged lines in core `runtime.ts`, `recall.ts` and `boot.ts`.

### `[sunshine:fixed-form]`: small model steps answer in a fixed form

**Why** (2026-10-29). The grounding step and a recording's summary asked the model for JSON between tags. 1 grounding
answer in 10 could not be read, and the agent then answered without what was gathered; the fix was a second try plus a
reader for code fences and bare JSON (patches on a weak contract). Anthropic's structured outputs make the answer fit a
schema by construction (supported on Claude Haiku 5.5 and Sonnet 5.5).

**What the fork adds**
- watcher `models.ts`: `ModelCall` takes an optional `schema`; `modelCall` puts `output_config.format` (`json_schema`)
  into the request beside the effort Pi sets (`withFormat`, through Pi's `onPayload`, as Pi has no setting for it).
  Only for Anthropic models; others get the prompt's instructions alone.
- `ground.ts`: `GROUND_SCHEMA`; one call; the tag/fence/bare reader and the second try removed.
- `intake.ts`: `SUMMARY_SCHEMA`; one call; the second try removed. An empty summary still counts as unreadable.

**Tested** (free): watcher `models.test.ts` (+1: the form beside the effort, only with a schema), `ground.test.ts`,
`intake.test.ts` (the tests for the second try replaced by one-call tests).

**Open.** The nightly memory pass (`memory-notes.ts`, `<changes>`) and the news decider (`watcher/decide.ts`) still
read JSON out of free text; same change when they are next touched.

**To remove.** Revert the commit (`git log --grep "sunshine:fixed-form"`); the second try and the lenient reader come
back with it.

### `[sunshine:acting]`: one rule for how Sunshine acts for its owner, in everything it does

**Why** (2026-10-30). The rule for when to just do something and when to ask (act or ask, sunshine-ops NOTES 2026-10-24;
the owner's proactivity setting, 27 Oct) lived only in a recording's hand-off. His own texts had the base prompt's
general lines ("Prefer doing over describing", "Ask one question at a time"), so a text that turned up something to do
got an offer: live, "Anything happening for me next week" found Founders Story in his email, not in his calendar, and
ended "Want me to add it?". The setting did nothing for texts. The policy lets the owner's own calendar be written
without approval, so nothing in code made it ask. Torstein: one rule, written to hold for everything Sunshine does,
including sources and tools still to come.

**What the fork adds**
- `packages/server/src/acting.ts`: `actingSection(owner, level)`, a section "# How you act for <owner>" written as
  criteria: find out before asking, and check how things stand before changing them; weigh how clearly it is theirs,
  what a mistake would cost and whether it can be undone; the setting's line; how sure the source is (typed, or heard
  in a recording or read in someone else's message); anything that goes to other people, costs money or speaks for them
  asks first; unasked, tell only what is worth their attention. `actingPromptFor` gives it to the verified owner's
  conversations only (owner tier: not an email from their address, not other people) through boot's `promptExtra`, so
  texts, recordings' hand-offs (system tasks) and scheduled jobs read the same text. Fixed text per setting, so the
  prompt cache holds between messages. The setting (`PROACTIVITY_LEVELS`, `readProactivity`, the `proactivity` tool)
  moved here from intake.ts; the tool is registered for every agent and its description covers everything Sunshine does.
- `intake.ts`: the hand-off's own copy (first settle what you can, the level, heard is not typed, ask first) is one line
  pointing to the rule; `IntakeDeps.proactivity` removed.
- Scenarios: `look-before-ask.mjs` SET=acting, five texts on the copy of his thread: should act (next week's event found
  in email, a direct calendar request), should not (a passing thought, something owed to someone else, a question
  involving another person). Graders checked on 12 known answers incl. the live reply; the event's name is now also
  matched as "Founder's" (the live reply's spelling, which the earlier checks would have missed). `in-the-flow.mjs`:
  NO_SETTLE removed (the line it took out is gone).

**Tested** (free): `test/acting.test.ts` (the criteria at every level, no channel, source or tool as its scope, owner
only, the same text for the same setting, the setting tool), `intake.test.ts` (the hand-off points to the rule and
carries no copy), and the real server booted offline (scratchpad prompt-check.mjs): the section is in the owner's text
thread and in a system task, not in a friend's. All tests (1,488) and smoke pass.

**Paid** (Torstein OK'd each). First version, $0.51: texts 8/10 (a direct calendar ask 2/2 added; a passing thought 2/2,
a deck owed to Morten 2/2 and dinner with Zia on the 3rd 2/2 left alone), recordings 5/5; the target, "Anything happening
next week for me", 0/2: once the grounding step searched no email and never found the event, once it found it and asked
"Want me to add the Founders Story event to your calendar?". 0 thinking blocks in 8 of 10 texts. With the "Why:" line
(Anthropic's guide: give the motivation), $0.25: the target 0/3 (once not found, twice found and offered), the three
not-to-act texts 3/3, two not-to-act recordings 2/2. Reading: the rule breaks nothing and the setting now reaches texts,
but wording does not turn an offer into an action for something found while answering a question (Sonnet 5.5 at medium
effort answers such texts without thinking; Anthropic notes it checks in more at low and medium effort). The same lesson
as reply length (2026-10-15) and looking before asking (2026-10-29). The structural answer for a registered event is
email flowing in: added when the email arrives, through the hand-off; records for the grounding step's misses (found 3
of 5 times here). Wording changes for this case stop here.

**To remove.** Revert the commit (`git log --grep "sunshine:acting"`): the hand-off gets its own lines back and texts
lose the rule.

### `[sunshine:hindsight]`: Hindsight is the memory engine; a thin layer of ours decides what goes in and brings it back

**Why** (2026-10-30). Sunshine's own recall (chunks by meaning and words) failed the date questions on his real data;
Hindsight 1.1.0 (open source, MIT, vectorize-io), used as its makers intend, answered 17 of 20 fully and 3 in part: its
facts carry the date an event happens, so "next week" is a list by date, not a guess at search words; the newest version
wins when something changes; deleting a source removes what it taught. Torstein decided: Hindsight is the engine, a thin
layer of ours, no records of our own; no catch-up when a source is connected. Design: `~/sunshine-ops/
DESIGN-memory-in-the-flow.md`, "Hindsight as the engine". This is step 1(a) (free, on the laptop).

**What the fork adds**
- `packages/server/src/hindsight.ts`, `HindsightMemory`: Hindsight follows the archive, as the meaning search's vectors
  do. What goes in (the input policy): every kept item (recordings now; email next) and the owner's own messages, a
  spell at a time (a new spell after an hour's pause), once the spell has been quiet 30 minutes. Not Sunshine's replies
  or the runtime's notes (30 Oct: the reply "the calendar has no events 2-8 Nov" became a fact and ranked first; another
  system's state is read live). The makers' OpenClaw plugin offers the same as a setting (`retainRoles`); it keeps one
  document per session and appends, but an iMessage thread never ends and an append re-reads the whole document. Each
  document has its own id (`item:<id>`, `chat:<thread>:<first message>`), the owner's wall-clock time with its offset,
  and a context line naming their timezone (and, for recordings, that "[12:34]" is the time into the conversation).
  A changed document (a line forgotten) is stored again under its id; one that is gone (forgotten, past the age limit)
  is deleted there; a failed store is tried again after 10 minutes. `history/hindsight.json` says what was stored (id
  and a hash), so a restart stores nothing twice. The bank is set up on first use, as the makers' integrations do: the
  30 Oct retain mission with the owner's name, concise extraction, observations on.
- Local times: Hindsight reads a time without a zone as UTC (its `stored_dates.py`); the 30 Oct documents went in as
  UTC, so "19:00" in the J. Cole ticket email was kept as 19:00 UTC (20:00 in Oslo) and "Thursday at 14:00" as 14:00
  UTC; the invitation that said "(CET)" came out right. The makers' own plugins also send UTC. Fix here: local time with
  the offset, the zone named. Not yet checked with a real store (paid).
- `createHindsightRecall`, the same `Recall` seam (recall.ts) the hand-offs and grounding use: for the days asked
  (`opts.days`, new; the grounding step's and the summary's days), every fact whose event falls on them, by the owner's
  days (widened for dates kept as midnight UTC), in time order, one per source and event time, observations (Hindsight's
  consolidated view) instead of the facts they were built from; then the queries as one search by meaning (Hindsight's
  own: meaning, words, time, links, re-ranked) with now as the query time. Lines read "[happens Tue, 3 Nov 2026, 17:00;
  noted 30 Oct 2026] ... (from email: ...)". The item itself and chats of the last day are left out, as before. When
  Hindsight fails or is slower than the wait (8 s for grounding, 30 s for hand-offs), the meaning search answers.
- `boot.ts`: on with `HINDSIGHT_URL` (`HINDSIGHT_API_KEY` when the server asks for one; bank `HINDSIGHT_BANK` or the
  agent's handle), using the makers' TypeScript client (`@vectorize-io/hindsight-client` 1.1.0, no dependencies of its
  own). Without it nothing changes. `ground.ts` and `intake.ts` pass their days; `lookup.ts` exports `addDays` and
  `offsetAt`; `intake.ts` exports `SOURCES` (each item's context line).

**Tested** (free): `test/hindsight.test.ts` (5, a stand-in server): only the owner's lines go in, quiet spells only,
local times across the clock change (CEST and CET), the zone in every context, the bank set up once; stored once,
stored again when a line is forgotten, a spell whose first message is forgotten deleted and stored anew, a failed store
tried again; recall by date (the owner's days, dates without a time, a fact just past midnight left out, one per source,
observations instead of their facts), by meaning with now in local time, the item itself and today's chats left out,
nothing kept = nothing said, slow = meaning search answers. All tests (1,493), typecheck and smoke pass. Free check on
the real local server's 30 Oct bank (recall and listing only, no model call; scratchpad hs_recall_real.mjs): "next week"
lists the 3 Nov facts (13 lines before the per-source and observation rules, 3 after), "December" Firi's fee change and
Dune on the 18th, "what did me and Morten decide about the server?" the right answer; 3-4 s each on the laptop CPU.

**Open.** A real store with the local-time fix (paid, about 2-3 cents). Whether Hindsight's search can replace the agent's
own meaning search (history_search) or should sit beside it. Hindsight's output language is a server setting
(`HINDSIGHT_API_LLM_OUTPUT_LANGUAGE`), not per bank. Where it runs live (about 3 GB with its search models).

**To remove.** Revert the commit (`git log --grep "sunshine:hindsight"`), or delete `hindsight.ts` and its test, the
dependency, and the tagged lines in `boot.ts`, `ground.ts`, `intake.ts`, `lookup.ts` and `recall.ts`.

### `[sunshine:intake]`: what reaches the owner from elsewhere is kept, summarized once and acted on

**Why** (2026-10-24). Sunshine should know what its person knows without being told (NOTES "PRINCIPLE: the one AI
that knows what you know"); the first source is the band. Run 1 of `[sunshine:meeting]` handed the raw transcript to
one agent run: it filed a decided point as open, set no reminder for the owner's task, wrote a paragraph into the
always-on notes and could not find the meeting when asked (`history_search` held only the owner's chats). Bee,
Plaud and Limitless keep every transcript searchable and write a summary with to-dos per conversation.

**What the fork adds.**
- `ItemArchive` (`packages/core/src/items.ts`): one archive for every source (`band` now; email, team chat, other AI
  tools later), `history/items.jsonl`, one item per line: id, source, title, start and end, people, the whole text
  (one line per turn, "[12:34] Sarah: ..."), the summary. The same id again replaces the item. Kept 365 days like the
  chat history.
- `history_search` also searches items (`core-tools.ts`): lines of the text and of the summary with the most words of
  the query, grouped by item, newest first; each item with its heading (when, what, source, with whom) and its whole
  summary (up to 3,000 characters: word matching ranks lines, not meaning, so the summary is never left out; Bee,
  Plaud and Limitless show the summary first too), then up to five matching lines of the text; a long line is clipped
  so the matching words show, keeping "[12:34] Sarah:"; a hit in the text comes with the minute of talk after it,
  where the answer to a question usually is. `history_forget` removes matching lines
  from items too (text and summary), remembered by fingerprint so the same item sent again cannot bring them back. Both
  owner-only, as before.
- The intake (`packages/server/src/intake.ts`), staged as separate calls: (1) keep the item; (2) one model call
  (`INTAKE_MODEL`, default Sonnet 5.5, medium reasoning; "off" keeps items unsummarized) reads the whole item as data,
  with the owner's notes, and answers JSON: title, summary, decisions ("settled when the group went with it, even if
  nobody said decide", the run-1 failure), the owner's tasks, others' tasks, open questions; one retry if unreadable;
  (3) one line in the day's journal (`MemoryStore.appendJournal`), which is how the owner's own conversation learns
  the item exists (today's and yesterday's journal are in every owner prompt); (4) the summary, marked as data, goes
  to the agent as a system task (upstream's `runSystemTask`, `system:intake-<id>`) with the act-or-ask criteria: do
  what is clearly the owner's and easy to undo (a reminder) without asking, ask what is unclear or would matter, all
  questions in one text, ask first for anything outward, text only when needed, else `NO_REPLY`. The agent never sees
  the raw transcript; it can search it. Audit `policy` entries `intake` (outcome, cost, counts).
- How it arrives: an `intake.item` event (`packages/core/src/envelope.ts`, `intakeItemOf`) on `/chat`, like
  upstream's `system.task`, from Sunshine's own backend once it exists (checklist #5); `BootResult.intake` for tests
  and scenarios. Speakers are taken from the "[mm:ss] Name:" lines when the sender gives no people (not the owner,
  not unknown voices).
- Switch: with `features.history = false` there is no archive and no intake.

**Tested** (free). `packages/core/test/items.test.ts` (kept whole, replaced by id, search over text and summary,
partial, ranges, forget lists then removes and keeps out on resend, age limit, `history_search` output with chats and
items, a long line clipped around the match), `envelope.test.ts` (`intakeItemOf`), `packages/server/test/intake.test.ts`
(stand-in model: the record goes in as data with the notes; summary saved; people from the speakers; one journal
line; the agent gets the summary and the criteria, not the transcript; unreadable twice, no model, a failing model),
`http.test.ts` (the event reaches the intake with times in ms, never owner chat; refused when off). All tests (about
1,418), typecheck, lint and smoke pass; the meeting scenario boots with the intake in DRY mode.

**Open.** How long others' words are kept (365 days like the chats) is for the legal step (#6). The search matches
words; search by meaning is `[sunshine:meaning-search]` (2026-10-25). The nightly notes still read only the owner's chats.

**To remove.** Revert the commit (`git log --grep "sunshine:intake"`) or delete `items.ts`, `intake.ts`, their tests
and the tagged blocks in `core-tools.ts`, `envelope.ts`, `index.ts`, `boot.ts` and `http.ts`.

### `[sunshine:meaning-search]`: earlier conversations are found by meaning, not only by the same words

**Why** (2026-10-25). Word search finds what was said in the same words; asked in other words it misses ("ring
people" for phone calls; run 2 of `[sunshine:meeting]`: "target group" vs "age groups"). On 25 real questions about
the owner's own work (sunshine-ops NOTES "Memory trial", free): word search 7, a search model 14-16. Search models
compared the same way: Qwen3-Embedding-0.6B (Apache 2.0, multilingual) as good as bigger ones. Then run the way the
agent would run it (NOTES "IN-AGENT CHECK"): 4-bit 15 / 17 (as asked / either of two searches) against the full
model's 16 / 18, peak 2.0 GB of memory; 8-bit 9 / 14 (its compression also rounds in-between results); half
precision 16 / 18 but 2.65 GB of the agent's about 3 GB free. So: the 4-bit model inside each agent, no server for
the test version; a shared EU service later (sunshine-ops DESIGN-meaning-search.md). Upstream has no meaning search;
OpenClaw's memory_search and Hindsight both merge meaning and word rankings, and fall back to words when the model fails.

**What the fork adds.**
- `MeaningSearch` (`packages/core/src/meaning.ts`): the chat history and the items cut into pieces of about 1,800
  characters (the tested size): consecutive messages of one thread, a new piece after an hour's pause; an item's
  summary (with its title) as one piece and its text in stretches; a long line cut with its speaker kept in front.
  Each piece's vector is stored in `history/meaning.json` under a hash of its text, so a changed piece (a thread grows,
  a line is forgotten) gets a new one and vectors no piece uses are removed: nothing forgotten stays behind. Vectors
  from another model or version are made again. A search ranks the pieces in the date range by closeness of meaning
  and by words (BM25, 50 candidates each) and merges them as OpenClaw does: 0.7 x closeness + 0.3 x the word score
  scaled to the best closeness (chosen on the scenario below over rank fusion, Hindsight's way).
- Storing runs in the background (`schedule`, 30 s after the last change; the archives call it through a new
  `onChange` option; 2 min after boot for what is not stored yet), newest pieces first, one at a time, saved every 25;
  a failure is audited (`error` with `meaningIndex`), what was stored is kept; audit `policy` `meaningIndex` (added,
  removed, ms).
- `history_search` (`core-tools.ts`): with meaning search, the best pieces in rank order until past about 8,000
  characters (as tested): a stretch of a chat as it was ("[2026-10-24 12:00] Torstein: ..."), a stretch of an item
  under its heading, with the item's whole summary the first time it shows (grouping an item's pieces together pushed
  better ones down: 13 vs 15 in the first scenario run). If the model fails or takes over 20 s (still loading), word search answers exactly as
  before and an `error` with `meaningSearch` is audited. The description says it searches by meaning and words and
  adds one criterion: if what comes back does not answer it, search again in other words (the gap the test left).
  `history_forget` also removes the forgotten text's vectors at once.
- The model (`packages/server/src/embedder.ts`): `onnx-community/Qwen3-Embedding-0.6B-ONNX`, 4-bit (`q4`), pinned
  revision `c25a394d`, through Transformers.js 4.3.1 (Apache 2.0) on the CPU with 2 threads; the files (about 0.9 GB)
  are fetched into `/data/models` on first use. It runs in its own process (`embed-worker.ts`), started only when
  needed and only with 2.3 GB free memory (else word search answers; tried again after 5 minutes), stopped after 10
  minutes idle, one text at a time (storing and a search never run at once: that would double the peak). Its own
  process because, measured on the live agent (2026-10-25, first deploy, model inside the agent's process): RSS 160 MB
  before, 1,788 MB loaded, 923 MB after the release; about 0.75 GB stayed held, leaving the free memory (2,369 MB)
  right at the 2.3 GB line. A process that exits gives everything back, and if memory runs out Linux stops the
  biggest process, then the model's, not the agent (it also offers itself first: `oom_score_adj` 500). Laptop check:
  parent 47-49 MB throughout, the process gone after the release; first query 2.4 s (start + load), then about 0.1 s.
  Queries get the model's own search instruction.
- Switch: on with `INSTINCT_MEANING_SEARCH=1` (off by default, so tests, local runs and agents without it never fetch
  the model); `BootOptions.embedder` for tests and scenarios. Needs `features.history` on.
- `deploy/Dockerfile.agent`: the ONNX runtime's Mac and Windows builds are removed from the image. (pnpm 10 skips
  onnxruntime-node's install script, which would download graphics-card support; the CPU runtime ships in the package.)

**Tested** (free). `packages/core/test/meaning.test.ts` with a stand-in model where words of the same meaning share a
dimension: pieces (threads, pauses, size, long messages, items), storing once and again after a change with the old
vector removed, another model starts again, a storing failure keeps what was stored, `history_forget` removes vectors
at once, another wording found by meaning where words alone find nothing, an exact number found by words, date
ranges, `history_search` output, fallback to word search when the model fails (audited).
`packages/server/test/embedder.test.ts`: loaded only when used, the query instruction, one text at a time, released
when idle, not loaded without free memory, a failed load not retried at once, a process that ended unexpectedly not
restarted at once, off at boot unless switched on.
`scenarios/meaning-search.mjs` (free): the owner's 20 Claude Code work sessions (285k words) as items, 1,227 pieces
stored with the real 4-bit model (8 threads on the laptop: 0.73 s per piece, 15 minutes), the 25 questions asked as
written and as keywords, graded by the earlier tests' grader (~/sunshine-memory/grade_scenario.py). Found (as asked /
keywords / either): `history_search` today (words) 3 / 7 / 7; ranked by meaning and words merged 16 / 14 / 17; by
meaning only 16 / 14 / 17; rank fusion 15 / 14 / 16; words only (BM25 over pieces) 11 / 8 / 11; the new
`history_search`'s whole answer 16 / 14 / 17 (median 9,227 characters, about 2,300 tokens; 118 ms median per search,
about 2 s for the first, which loads the model). All tests (about 1,437), typecheck and smoke pass.

**Open.** Speed and memory on the agent's own machine (2 vCPU AMD EPYC) are measured at deploy. Norwegian is
untested (the model is multilingual). The 25 questions are the owner's work with Claude, not meetings; the band test
(about 5 Nov) checks real conversations.

**To remove.** Unset `INSTINCT_MEANING_SEARCH` (everything works as before), or revert the commit
(`git log --grep "sunshine:meaning-search"`) or delete `meaning.ts`, `embedder.ts`, `embed-worker.ts`, their tests and the scenario,
the tagged blocks in `core-tools.ts`, `history.ts`, `items.ts`, `index.ts`, `boot.ts`, `Dockerfile.agent`, and the
`@huggingface/transformers` dependency of `packages/server`.

### `[sunshine:recordings]`: a recording the owner sends becomes a conversation Sunshine knows

**Why** (2026-10-26). V1 does not wait for hardware: the phone is the recorder (the app developer's idea, Torstein
agreed), the band plugs in later. Files sent on iMessage already land in the agent's workspace (upstream's inbound
hydration), and the app's chat can send them the same way, so the agent is the one door for recordings: no upload
system in a backend, recordings and voice prints stay with each person's own agent, and testers can use it before the
app exists. The transcription itself runs on a GPU service outside the agent (~/sunshine-audio `service/`: who spoke
when, what was said, voices named from prints; it keeps nothing and holds no keys to agents). Decided with Torstein:
the audio is deleted after transcription (as Bee does).

**What the fork adds** (`packages/server/src/recordings.ts`, owner-only tools in the always-loaded memory group):
- `recording_add` {path, title?, startedAt?}: for an audio file the owner sent. Returns at once ("Transcribing it
  now..."); in the background the file goes to the service (as a job, with the owner's voice print if learned; see
  long recordings below), the transcript ("[mm:ss] Name: ..." lines; unknown
  voices "Speaker N") into the intake as an item with source `recording` (kept, summarized once, journaled, handed to
  the agent with the act-or-ask criteria), and the audio file is deleted whatever happens. No speech, an unsupported
  language (Norwegian, for now) or a failure: nothing kept, a short note to the agent to tell the owner if it matters.
  Audit `policy` `recording` (status, seconds, language, voices, ms) and `error` `recording`.
- `voice_mine` {path? | forget}: a short recording of just the owner (20-60 s) becomes their voice print in
  `/data/voice/owner.json` (refused if too little speech or a second voice); their lines in recordings are then theirs.
  In the background too, the outcome reaching the agent as a note. The sample is deleted; `forget: true` deletes the
  print.
- A service scaled to zero (OVHcloud AI Deploy, measured 2026-10-26) answers 503 at once while it starts, for about 3
  minutes, and a large first request got 502 without waking it (live, 2026-10-27): a tiny `POST /ping` wakes it and is
  asked again every 30 s before any audio goes, for up to 2 hours (a start can wait in OVH's queue for a free machine:
  ranked 105, the first in line 50 minutes, 2026-10-27; the queue is not billed); other failures are tried again after
  30 s and 2 min.
- Long recordings (2026-10-27, Torstein: "it has to work for longer recordings"). Four limits, each handled:
  (1) the service: OVH scaled the app to zero in the middle of a job, because only new requests count as use; a job is
  now created (`POST /jobs`), its audio sent as it is (`PUT /jobs/<id>/audio`, streamed from the file with
  `fs.openAsBlob`, no base64 copy in memory) and asked about every 30 s (`GET /jobs/<id>`), so no request lasts as long
  as the job and the asking keeps the service up exactly while it works. A job the service lost (it restarted: 404) is
  sent again; one that runs over 10 minutes plus half the recording's length is given up on and the owner told (the
  asking would otherwise keep a stuck service up and paid). (2) This agent: Maritime snapshots an agent after 15 minutes
  without requests, which would stop the asking; while a job is out, a schedule in code (`RECORDINGS_GATE`, every 5
  minutes as a minute list like the news watch's crons, its gate never calls the model) makes Maritime send the agent
  a request, and it is removed when the last job
  ends (and at boot, or at its next run when no job is out). (3) The way in: upstream downloads attachments up to 10 MB
  in 20 s (`packages/inkbox/src/hydration.ts`), about 20 minutes of Voice Memos; a new `limitsFor` option there lets
  `boot.ts` give the owner's attachments up to `MAX_SENT_RECORDING_BYTES` (200 MB, 10 minutes); everyone else keeps
  10 MB. By size, not by type: a Voice Memos file arrives with no name or known type (saved as `.bin`). (4) The
  agent's memory: the audio is no longer read whole and base64-encoded (a 500 MB file would have passed V8's string
  limit).
- The intake (`intake.ts`) words the source "recorded on their phone" with the same caveat as the band, plus that
  unknown voices show as "Speaker N"; `speakersOf` no longer takes "Speaker 2" for a person. `core-tools.ts` names the
  source in search results.
- Settings: `TRANSCRIBE_URL` and `TRANSCRIBE_KEY` (secret); without both there are no tools. Needs the intake
  (`features.history` on).

**Tested** (free). `packages/server/test/recordings.test.ts` with a stand-in service: handed to the intake with times
and people, audio deleted, the owner's print sent once learned and forgotten on request, no speech and Norwegian told
and nothing kept, a busy service tried again, a service that never answers told and the audio still deleted, files
outside the workspace refused, a two-voice print refused, "Speaker 1" not taken for a person; since 2026-10-27 also:
the audio sent as it is (not in the JSON), a service in standby woken with pings before anything else, a long job asked
about until done through a service restart (one job, not sent twice), a lost job sent again, a stuck one given up on
and not sent again, the keep-awake schedule there while a job is out and gone after (and a leftover one removed by its
gate). `packages/inkbox/test/hydration.test.ts`: the larger size only for the messages `limitsFor` names.
`scenarios/recording.mjs` (real server, real service on the laptop GPU, no model calls): Maya's voice learned in 4.2 s
(sample deleted); the AMI ES2004b meeting as an iPhone-style .m4a (17.6 MB, 39 min) kept 18 s after recording_add
answered (96 ms): 235 lines, 57 named Maya, the others "Speaker 1, 2...", the file deleted, history_search finds it.

**First real recording** (2026-10-26, Torstein's 23-min call with a friend about the project, iPhone on the table,
transcribed by the service on the laptop, handed to his live agent with `scenarios/send-recording.mjs`, about 10 c):
transcript right on every line by his reading (only a few backchannel "yeah"s missed); Sunshine titled it "Project
status sync with Morten" (the friend's name taken from what he said; his voice stays "Speaker 1"), wrote 3 decisions,
5 owner tasks and 6 open points each with where it was left, set no reminders (no times given) and sent one bundled
question through ask_owner: put Thursday's company meeting at 14:00 and invite the team (named from its notes), how
long, whose emails, and offered a RAG explainer; then NO_REPLY. Torstein: the "same server" decision was read right
(the principle decided, the choice his task and open). Seen: one owner "task" was his explanation of the test
itself (a meta case; watch in real use). Fixed: the journal line said "12:52 ... until 14:15" (the journal's stamp is
the machine's UTC clock, the end was in Oslo time); it now gives both ends in the owner's time with the zone
("13:52-14:15 Europe/Oslo").

**Wording** (2026-10-27). Live, learning Torstein's voice gave "I'll tell you if it doesn't work" and "your lines in
recordings will show as you, not "Speaker N"": both echoed this change's own tool texts (a result that did not say the
outcome would come back; the internal label in the description, the result and the note). The tool texts now state
facts for the agent in what they mean for the owner, with no internal labels, sizes or error codes (those stay in the
audit), and say that the outcome comes back as a note for the agent to tell; no replies are scripted.
`scenarios/voice-wording.mjs` (real Sonnet 5.5, stand-in service; checks for a conditional promise, an internal label
and machine talk, checked first on 7 known answers incl. the two real replies): before, a recording sent with the
voice unknown got "Otherwise they show up as "Speaker 1""; after, "I can pick out your voice in future recordings",
"I'm learning your voice now. I'll tell you when it's done", "I can now tell you apart from other voices in recordings
you send me": 0 flags on all 3 ($0.078 for both runs; one run per case).
2026-10-29 (d3428c1, deployed 29 Oct with sha-1ca48a9): live, every recording got "Got it, transcribing now. I'll send the summary
when it's done", echoing the tool result's "its summary comes to you then": a promised summary (not the product) that
often never came. The result now says what happens: what was said comes to the agent to act on, and the owner hears
only if something needs them.

**Open.** Other people's names: only the owner's voice is recognised; connected people's prints (connect = consent)
come with agent-to-agent. Voice messages to Sunshine (one voice, the owner's) go the same way as a meeting for now.
The service runs on OVHcloud AI Deploy (CPU, scale to zero; sunshine-ops NOTES). How large a file iMessage carries is
published by neither Apple nor Inkbox (reports: 100-220 MB; Voice Memos is about 0.5 MB a minute): to be seen with a
real long recording; past it, recordings need the app's upload.

**To remove.** Unset `TRANSCRIBE_URL`/`TRANSCRIBE_KEY`, or revert the commit (`git log --grep "sunshine:recordings"`)
or delete `recordings.ts`, its test and scenario, and the tagged lines in `boot.ts`, `intake.ts`, `core-tools.ts` and
`packages/inkbox/src/hydration.ts` (`limitsFor`) with its test.

### `[sunshine:tool-loader]`: email, desktop, file and people tools load when a request needs them

**Problem** (measured 2026-10-16, a local boot with the live agent's settings, Anthropic's token
counter). Every message carried 23,700 tokens before the conversation: 5,700 of instructions and 51
tools (18,000). Most of the tools are for things most messages never touch: Gmail and Calendar through
Composio's router (6,000), the desktop (2,900, plus 350 of instructions), files and shell (2,100),
contacts, trust and other people's assistants (2,600). They are paid again on every message after a
pause and on every scheduled run.

**What the fork adds** (Pi's mid-conversation tool changes, which Sonnet 5.5 supports).

- `packages/core/src/tool-loader.ts`: four loadable groups by `meta.group` (`apps`; `computer`;
  `files`; `people` = `contacts` + `network`) and the `load_tools` tool, which lists them with one line
  each. The owner's conversations start without those groups; `load_tools` adds one, and its result
  carries the group's guidance (the desktop and apps text that `boot.ts` otherwise puts in every
  prompt).
- `packages/core/src/runtime.ts`:
  - `bindTools` gives the owner's own conversations the base tools, `load_tools` and the loaded groups;
    everyone else sees what policy allows, as before.
  - `loadToolGroups` marks a group loaded, and `prepareNextTurnWithContext` hands the new list to the
    next model call. Pi then announces the added tools in a system message after the load (a
    `tool_addition` block), so the tool list and instructions at the start stay as they were and the
    cache is read back.
  - `applySystemPrompt` builds the opening from the base tools only and keeps those announcements in
    place. Before, it rebuilt the opening from the current tool list and threw the announcements away,
    so every message after a load would have paid for the whole prompt again.
  - `foldInSteps` keeps announcements where they are. Before, it moved every system message to the
    front before each request, which would have put them ahead of the whole history and broken the
    cache. In a fold they stay in place, or go right after the summary if what followed them was
    folded away, so a fold in the middle of a desktop session does not take the tools away.
  - `unloadIfPaidAnyway` drops the loaded groups and their announcements at the moments
    `[sunshine:prune]` uses: the cache has lapsed (5 minutes after the last model call, an hour with
    `PI_CACHE_RETENTION=long`) or the history was folded. The start is paid in full then anyway. A
    restart starts from the base list too (announcements are not saved). The calls made with a dropped
    group stay in the history; Anthropic accepts tools that are no longer declared there.
  - `systemPromptFor` lists capabilities and tool groups from everything the person may use, loaded or
    not, so a load never changes the prompt.
  - Audit `policy` entries: `toolsLoaded`, `toolsUnloaded`.
- `packages/server/src/boot.ts`: with the loader on, the desktop and apps guidance go to the loader
  instead of the prompt.
- Off switch: `config.features.toolLoader = false`. It also needs `stableCache`; without it the
  prompt changes every run anyway.

**Measured** (free). The owner's thread: 23,703 tokens before the conversation, now 9,813 (instructions
5,013, 23 tools 4,800, of which `load_tools` is 414). About $3.90 per owner per month with email,
about $2.10 for a friend without email (each 1,000 tokens is about $0.28 per user per month).

**Checked without a model run.**
- Pi's own Anthropic requests for a conversation that loads the file tools mid-reply (scratchpad
  `loader-wire2.mjs`, built by Pi and stopped before sending): the same tool list and system in all 5
  requests, each request only adding to the one before, the `tool_addition` blocks right after the
  load's result, and every request accepted by Anthropic's token counter.
- A history using a tool no longer declared, and a `tool_removal`, are accepted too.

**Tests** (`packages/core/test/runtime.test.ts`, "tools loaded when needed"):
- the opening leaves the groups out and never changes across messages and loads; every request only
  adds to the one before;
- a warm second message keeps the group, and a cold one drops it;
- a restart starts from the base list;
- "already loaded";
- other people's conversations are unchanged, and the switch and stableCache-off restore everything;
- a fold keeps the announcements.

Two checks were made by putting the old behaviour back on purpose: the tests fail for both traps. The
smoke test loads `files` before making its PDF.

**Real model** (`packages/server/scenarios/tool-loader.mjs`, 18 requests each in a thread of its own,
canned tool answers, 2026-10-16, $0.36 a round).
- Every request that needed a group loaded the right one first (12 of 12: inbox, calendar, an email to
  Martin, moving an appointment, a web form, a screenshot, a PDF, saved files, saving a contact, what
  Sanna may see, asking Sanna's assistant, the contact list). Every request that needed none loaded
  nothing (6 of 6: a sum, a reminder, weather, "thanks", last week's question, XRP news).
- No reply mentioned loading. The two replies with "can't" were about the scripted data, not about
  loading: a calendar answer dated the 23rd on Friday the 16th, and a trust list without the tier's
  details.
- The cache held. Each thread's first call read the shared start (about 10,000 tokens). The call after
  a load read it again and wrote only the added tools (6,500 for apps, 3,400 desktop, 2,200 files,
  2,750 people), and the calls after that read everything back.
- Requests that needed no group cost 0.2 to 0.7 cents; email and calendar ones 3.5 to 5.5 cents.
- A new friend's first email request, with Gmail and Calendar set up but not connected
  (`NOT_CONNECTED=1`, 2026-10-17, $0.10), 3 of 3 right: "can you connect to my gmail?", "put dentist on
  friday at 15:00 in my calendar" and "check my inbox" each loaded apps, called `apps_connect` and sent
  the sign-in link, with a promise to do the task after sign-in ("Gmail isn't connected yet, so I can't see
  your inbox. Sign in here and I'll check it on your next message: …").

**To remove.** `features.toolLoader = false`, or revert the commit (`git log --grep "tool-loader"`) or
delete `tool-loader.ts` and the tagged blocks in `runtime.ts`, `tools.ts`, `types.ts`, `index.ts`,
`boot.ts`, `smoke.ts` and the tests.

### `[sunshine:read-receipts]`: "Read" under a text as soon as it arrives

**Problem** (2026-10-16). On a bigger question nothing showed that the text had arrived until the answer
came (10 to 27 seconds for the slowest; 102 replies measured, median 4 s, none over 30 s). The typing
dots are sent once at the start, and whether they reach the phone was never logged: a refusal was
silently dropped. Inkbox supports read receipts (`POST /mark-read`), and upstream's
`InkboxChannel.markRead` existed but was never called. OpenClaw sends read receipts on iMessage by default.

**What the fork adds.**
- `Outbox.markRead` (optional), passed through by `ChatAwareOutbox` (`packages/server/src/console-outbox.ts`).
- `markReadOnArrival` (`packages/core/src/runtime.ts`): a one-to-one iMessage from the owner or a contact
  is marked read when it arrives, before the queue. A text that waits behind a reply still being worked
  on shows "Read" too. Not for groups (Inkbox has no read receipts there), strangers, duplicates,
  delegated results or the dashboard chat.
- `courtesyFailed`: a refused read receipt, or refused typing dots in a one-to-one thread, leaves an
  `error` entry with `courtesy` in the audit log. Never retried, never in the way of the answer.
- Off switch: `config.features.readReceipts = false`.

**Not done, on purpose.**
- Refreshing the typing dots: they last about 60 to 90 seconds on iMessage providers, and no reply has
  come near that. A refresh just after the answer would bring the dots back.
- An "on it" text: two bubbles for one answer, fixed wording, and it counts toward Inkbox's messages.

**Tests** (`packages/core/test/runtime.test.ts`, "read receipts"):
- read on arrival, also while a run is going;
- contacts yes, and strangers, groups, chat, duplicates and the switch no;
- a refusal is logged and the answer still goes out.

**To remove.** `features.readReceipts = false`, or revert the commit (`git log --grep "read-receipts"`)
or delete the tagged blocks in `runtime.ts`, `types.ts`, `console-outbox.ts` and the tests.

### `[sunshine:search]`: friends' agents get the web search key

**Problem** (2026-10-16). Sunshine said its searches were failing. Without a key, `web_search`
(`packages/core/src/core-tools.ts`) reads DuckDuckGo's HTML page, and that page stopped answering
requests from the agent's server (each search timed out after about 11 seconds) while it still answered
from a laptop: a block on DuckDuckGo's side, not a code change. Upstream already supports the Brave
Search API: `BRAVE_SEARCH_API_KEY` is mapped to `searchApiKey` in `packages/server/src/boot.ts`. With the
key set, Torstein's agent searched in about a second. Only the gateway did not pass it to new agents.

**Why Brave.** It runs its own index and sells access to it. Cheaper providers such as Serper resell
results scraped from Google, which Google is contesting in court (Google v. SerpApi, 2025-), so that
route could break the same way. About $5 per 1,000 searches, with a monthly credit that covers a few
users. With the key, search uses Brave only (no DuckDuckGo fallback; it is blocked from Maritime anyway).

**What the fork adds.** `BRAVE_SEARCH_API_KEY` in `AGENT_SETTINGS` (`packages/gateway/src/main.ts`):
when it is set on the gateway, every new agent gets it, as a secret (its name ends in `KEY`). Agents
created before keep what they had: add it with `agent-env.sh set-secret` or Maritime's dashboard and
restart them.

**To remove.** Delete the name from `AGENT_SETTINGS` and the tagged test in
`packages/gateway/test/main.test.ts`, or unset the variable on the gateway.

### `[sunshine:a2a]`: two agents working together, tested on one machine (a test only)

**What the fork adds.** `packages/server/scenarios/a2a.mjs`: boots Torstein's and Zia's agents (real server,
prompt, tools, permission checks, Sonnet 5.5), each with the other in contacts at `TIER` (default friend), and a
stand-in for Inkbox between them: SendMessage becomes `a2a.task.created`, a worker reply becomes
`a2a.sent_task.updated`, and the task lookup returns what Inkbox stores (id, context, state, the caller's
authenticated handle and the message history), because the runtime checks the webhook against it and reads the
request text from it (a stand-in without the history made the worker drop every request as `inactive-task`).
Every event goes through `parseInkboxEvent` and `runtime.handleInbound` as `server/src/http.ts` does. Zia the
person is Haiku with a made-up calendar (silent when nothing is asked, at most four answers). `DRY=1` checks the
setup and the parser for free.

**First run** (2026-10-22, $0.27 with one failed attempt): Torstein's agent sent a typed `propose_times` and told
him it would report back; Zia's agent replied progress, asked Zia (clarified a bare "ok"), accepted, and Torstein
was asked whether to add it to his calendar. No calendar titles shared except one Zia asked to pass on.
Clumsy: "is Zia free" became an acceptance, then a follow-up `inform` left both sides unsure who still had to
confirm; Zia's agent promised to pass a note on before it had. Progress updates on a sent task are ignored by
design (runtime.ts: submitted/working wake nobody). Zia's agent could not read Zia's calendar (router mode:
the multi-execute tool is owner-only), so it asked Zia, as expected.

**Seven situations** (2026-10-22, $1.24 in all): booking, a question, a counter-offer, a decline, missing details,
dinner with a budget, and a late reply (other texts in between). `SITUATIONS=a,b` picks some, `MAX_USD` caps the
spend, each situation boots fresh agents, the people follow a brief and answer NONE when nothing is asked, and the
scripted calendar records created, changed and deleted entries. What held everywhere: requests arrived, the other
person was always asked, nothing was paid, no wrong bookings, the original request survived other texts. One real
gap, in upstream's design: each A2A message is its own job (`readA2AAdmission` drops messages on finished tasks;
`runtimeKey` gives each task and message its own conversation), so a "confirm" sent after an accept arrives as a new
task with no memory of the exchange and Zia was asked again. Other slips were seen once each. "Details" stalled on
the simulated Zia and "dinner" never reached the step where Zia comes in, so neither says anything. Paid runs of
this test are paused: tuning one task in simulation is the per-feature tuning we decided against; real use comes
first.

**Harness fixes** (2026-10-23, after a run that said nothing): "Friday" is the first Friday after the run day and
the calendars follow it (fixed dates made "Friday at 14:00" a past time on Friday 23 Oct); a free/busy check returns
times with every title replaced by "busy", as Google's free/busy does (it returned the whole calendar, titles
included, which a friend's agent could never see); the simulated person always answers a text with a question
(twice it wrote NONE to "Does that work?"); each A2A send shows its task and whether it continues a topic, and the
report counts the requests that reached Zia's agent with the topic's earlier turns. Still weak: once the simulated
Zia texted "N", which started a side thread.

**To remove.** Delete the file.

### `[sunshine:a2a-topic]`: a follow-up in an agent-to-agent topic remembers the earlier turns

**Problem** (seen in the 7-situation test, 2026-10-22). An A2A request is a task; related tasks share a
context (upstream's docs: "One A2A context per topic... Tasks inside it are turns"). Upstream runs each incoming
task in a conversation of its own ("Worker execution is isolated by task and caller-message generation, so
simultaneous tasks cannot overwrite each other's reply targets") and shows the model only that task's messages.
When the worker answers `complete` the task closes, so a follow-up starts a new task: Zia's agent accepted
(task 1, closed), Torstein's agent sent "confirm" (task 2, same topic), and Zia's agent, with no memory of task 1,
told Zia "I have no record of you agreeing" and asked again.

**What the fork adds.**
- Worker side (`packages/core/src/runtime.ts`, `earlierInTopic`; `A2AStore.tasksInContext` in `a2a-state.ts`):
  admitting a task, the runtime also reads the agent's earlier tasks in the same context from Inkbox (the same
  `loadA2ATask` upstream uses for the current task) and puts them before upstream's "Earlier messages in this
  task" as "Earlier in this topic with @caller (finished requests, oldest first)". Only tasks Inkbox reports for
  the same authenticated caller and context count. Tasks are read newest first until 24,000 characters are filled
  (`A2A_TOPIC_CHARS`, the same limit upstream uses for one task's own earlier messages), so a long topic costs a
  few reads and keeps its newest turns; a read that fails ends the reading (the request goes through with what was
  read, not after a string of failed reads). Execution stays isolated: each task still runs and answers on its own.
- Why no count of tasks: the first version also capped the reads at the last 5 tasks, a number of the fork's own.
  Torstein questioned it (2026-10-23); the character budget alone bounds both the size and the reads, newest first.
- Caller side: the note that brings a peer's answer back names the context ("Delegated task X (context Y) with
  @peer is completed."), and `ask_instinct`'s `contextId` says to give it for a follow-up (a confirm, a change,
  another question), so the other agent sees the exchange. Whether to continue a topic stays the model's call.

**Tested** (free). `packages/core/test/runtime.test.ts`, "a follow-up in the same topic": the earlier task with the
same caller is shown, another caller's task in the same context and the same caller's task in another context
are not, the answer still goes to the current task only; an unreadable earlier task leaves the request as before;
a topic of 40 earlier tasks shows the newest that fit (with 12 reads, not 40), oldest first and within the budget;
the caller's note carries the context. With the real model (the first version, with the cap of 5; the same for a
topic this short) (`scenarios/a2a.mjs`, situation "late", 2026-10-23,
$0.27, one run): Torstein's agent sent its "confirm" in the same topic, Zia's agent received it with the earlier
turns and answered "noted... settled. No further action needed" instead of asking Zia again (the failure seen
2026-10-22). Not covered: a change proposed from the other side (Zia's agent asking to move the meeting) starts a
topic in its own direction, so the receiving agent relies on its own calendar. One run, simulated people: the live
test is the real check.

**Weighed afterwards** (2026-10-23, against the fork's principles). For: a real flaw in upstream's standard flow
(propose, accept, confirm would ask the other owner twice on most bookings), general, fails safe (nothing happens
when the topic is not continued), keeps upstream's isolation. Against: found in one simulated run, not real use;
a partial alternative without code was not weighed first (the principle "when both say yes it is final, no extra
confirm round" removes the commonest follow-up, though not changes or later questions); it adds fork code to
upstream's core A2A handling, which upstream changes often. Kept; it belongs upstream, and is a candidate to offer.

**To remove.** Revert the commit (`git log --grep "sunshine:a2a-topic"`) or delete the tagged blocks in
`runtime.ts`, `a2a-state.ts`, `packages/network/src/tools.ts` and the tests.

### `[sunshine:meeting]`: a meeting transcript handed to the agent (a test only)

`packages/server/scenarios/meeting-transcript.mjs` boots the real server for a person ("Maya") and gives it a named
meeting transcript as a system task (upstream's `runSystemTask`, the way the audio backend would hand one over), then
asks a question in Maya's own thread; it prints tool calls, texts, reminders, MEMORY.md and the answer. Input: AMI
meeting ES2004b through `~/sunshine-audio` (Nemotron 3 + Parakeet, voices named with TitaNet prints from ES2004c).
Answer key written before the run: `~/sunshine-audio/keys/ES2004b.maya.md`.

**Run 1** (2026-10-24, $0.077): six of seven decisions kept in MEMORY.md, nothing invented, no text (NO_REPLY); the
target group, which Sarah states ("I think we are focusing on a sort of mid-range business kind of class type
people"), was filed as still open; Maya's task (research instruction manuals) was noted but got no reminder; asked
"what did we decide about who the remote is for?", the agent searched `history_search`, which holds only the
owner's chats, found nothing and answered from its note ("We didn't settle it"). The notes got one long paragraph
for one meeting, which a day of meetings would bloat. Next: transcripts into the searchable archive, a short note.
Built as `[sunshine:intake]`; the scenario now hands the transcript to the intake (`app.intake.receive`) as the
backend will.

**Run 2** (2026-10-24, through the intake, $0.085: summary 3.2 c, the agent's turn about 2.8 c, the question about
2.5 c; output `~/sunshine-audio/keys/ES2004b.run2.txt`). Against the key: Maya's task (instruction manuals before the
next meeting) caught, and the agent sent one bundled text asking when the next meeting is so it can set a reminder,
and whether to draft the research email (asks before anything goes to others); MEMORY.md untouched; one journal line;
decisions B5 and B7-B10 kept, B2 and B12-B15 caught; nothing invented (the two doubtful lines checked in the
transcript: Una offered "5-6 designs" at 35:54, Sarah named a customer service number at 30:20). Missed again: the
target group (B6). Maya asked whether to start with a younger group; Sarah answered "I think we are focusing on a sort
of mid-range business kind of class type people" (26:14) and moved on. The summary filed "whether to target a younger
age group first" as open and lost Sarah's answer; the later question searched the archive twice and answered "I
can't find a clear decision", without Sarah's statement. Two causes, both general: an open point keeps only the
question, not where it was left; and a search hit in a transcript shows the matching line only, while the answer is
in the lines after it (here six short fragments later), unlike the chat search, which shows the answer that followed.
Noise: two of the four "owner tasks" were not tasks (a presentation already given, a vague "refer to the findings");
the agent left them out of its text.

**After run 2** (Torstein OK'd both): the summary's open points now say where each was left ("the last view stated,
and by whom"); a hit in a transcript comes with what was said in the minute after it (`FOLLOWING_SECONDS`, indented
under the hit; untimed lines: the next line), as the chat search shows the answer that followed. Free replay of run
2's two searches on the real transcript: neither would have shown Sarah's answer even so, because neither hit Maya's
question ("age groups" does not match "age group"; "target" was never said). Word search misses different wording;
meaning-based search (the memory engine, NOTES) is the real fix, not word patches.

**Run 3** (2026-10-24, $0.088, `~/sunshine-audio/keys/ES2004b.run3.txt`). The summary now keeps where open points
were left: "Whether to target a younger age group first: Maya suggested it; Sarah said the focus is mid-range
business-class people. Not settled." Decisions B5 and B7-B11 kept; nothing invented. The agent set the reminder itself
(Mon 09:00, plain text) and sent one text saying so, with its two questions bundled (when the next meeting is, to time
it better; whether to email the research details): the act-or-ask levels as designed. (The reference has the next
meeting "after lunch", but our transcript lost that sentence, so asking was right.) MEMORY.md untouched. The question
still got "I can't find a clear decision": the agent's one search ("remote target users audience") showed two
transcript lines matching three of the words, and the summary's open line matched only "target", so it was not shown
(free replay with run 3's summary confirmed it). The answer was in the archive; the search's ranking hid it.

**After run 3** (zoomed out with Torstein, 2026-10-24). Answering about a past conversation is three steps: find the
conversation, read what it says, answer with who and when. Bee, Plaud and Limitless give every conversation a summary
and show it first; Plaud's "Ask" on one recording reads that recording's transcript and summary and answers with
timestamps. Done: a conversation found by a search now shows its whole summary, then its matching lines. Free replay:
both of run 2's and run 3's searches now show "Sarah said the focus is mid-range business-class people". No paid rerun
(agreed: move on after run 3). Not built, on purpose: a tool to read one conversation whole (Plaud's single-file Ask),
until a real question shows the summary is not enough; meaning-based search for finding the conversation (memory
engine). Meeting tests total $0.25.

**To remove.** Delete the file.

### `[sunshine:language]`: reply language (a test only; nothing changed in the prompt)

**Seen** (2026-10-22, a local test): asked in English about a Norwegian email in an empty thread,
Sunshine answered in Norwegian (Oslo timezone, +47 number and Norwegian material outweighed the
English question). **Tried:** one system-prompt line ("write in the language they write to you in, even
when what you read is in another language"): 0/2 in empty threads, so not shipped. How others do it:
Anthropic's docs (Claude follows the conversation; state a fixed language in the system prompt), the Claude
app (one rule), Hermes (the model, plus an optional fixed language), OpenClaw (nothing).
**Real conditions:** the live history had 13/13 clear text-reply pairs in the same language, inbox
summaries of Norwegian email included; with even one English message first, the test answers in English
2/2 and follows English -> Norwegian -> English turn by turn.

**What the fork adds.** `packages/server/scenarios/language.mjs` only: conversations with English
history (default), `PLAN=fresh` for the empty-thread weak spot, `GRADER_CHECK=1` for the grader itself.
Run it after prompt changes. **To remove.** Delete the file.

### `[sunshine:phone-calls]`: upstream's phone calls stay off

**Why.** Upstream added phone calls through Inkbox Voice AI (2026-10-15/16): a `phone_call` tool every agent
with Inkbox gets, and rule 8 in every system prompt. Every call waits for the owner's yes, so it can never dial
by itself, but Sunshine has not decided on the Inkbox plan it needs, the minutes it costs, or the law on
recorded calls in Norway, and an offered tool the plan may not support invites "I'll call them" promises.

**What the fork adds.** `config.features.phoneCalls` (env `INSTINCT_PHONE_CALLS=1`), off unless true:
`messagingTools` (`packages/inkbox/src/tools.ts`) leaves `phone_call` out, and `rulesSection`
(`packages/core/src/prompt.ts`) leaves rule 8 out. The rest of upstream's call code (the `call.ended` text to
the owner, the voice setting, the gateway adding `call.ended` to webhook subscriptions when it holds the Inkbox
admin key) stays as upstream wrote it; with no calls placed it never fires. Like other config features, the env
var seeds `config.json` on first boot; an existing agent needs `features.phoneCalls: true` in it.

**Tests.** `packages/inkbox/test/tools.test.ts` (not offered by default; upstream's call tests switch it on) and
`packages/core/test/prompt.test.ts` (rule 8 only with the switch).

**To remove** (calls on for everyone, as upstream). Delete the tagged lines in `tools.ts`, `prompt.ts`,
`types.ts`, `config.ts` and the two tests.

### Long replies (investigated 2026-10-15, nothing changed)

A money question ("what should be considered: fund vs apartment") got a 1,435-character, seven-point
reply although the persona and the iMessage line ask for short texts. `packages/server/scenarios/texting.mjs`
plays 17 questions through the exact live prompt (boots the server; about 30 cents a run). Three
wordings of the iMessage line (upstream's, a principle, real example replies with the reason) and a
prompt with only the everyday tools all landed in the same range (advice answers 712-828 characters on
average, lists in 6-12 of 22), so neither the wording nor the tool list is the lever. Detail requests
were answered in full and the main risk kept in every version. Upstream's line stays. Untested: the
skills list, memory (`[sunshine:memory]`), the thinking level.

## Upstream merges

### 2026-10-23: upstream up to `cb3d97c`

**What came in** (28 commits, 95 files): the `staff` tier (another agent working for the same owner, A2A
only, never shell, files or computer; email senders capped at `partner`); a safer `contacts.json` (each entry
checked on load, a broken file keeps the old list and blocks saves); owner-installed skills in `<data>/skills`,
re-read every 30 s, private to the owner unless marked public, and the skills index built per person; the
history fold never starts at a tool result, and older screenshots become a one-line placeholder in a fold;
"Hit a snag on my end (reason)" instead of a raw error; a narrow echo rule for queued texts; an optional "on it"
text (`INSTINCT_ACK_SLOW_REPLIES`, off); a front door that lets the first texter with a one-time code claim an
agent (off); Atomic Mail (only with its key); phone calls through Inkbox Voice AI; dedicated iMessage pool
helpers; Link payment fixes; "Want me to go ahead?" once; a `maritime` skill.

**Left out.** The `maritime` skill (it tells anyone who asks where the agent runs, with Maritime's prices and
signup links; not for a product sold as Sunshine). Phone calls stay off: `[sunshine:phone-calls]`.

**Collisions** (11 files). Mostly both sides adding in one place, kept both: settings flags, imports, contact
store options (`phoneCountry` and `warn`), the bodies of `foldInSteps` and upstream's `nextUserTurn` comment.
Fitted by hand:
- `handleInbound`: upstream's owner claim runs first, then `[sunshine:read-receipts]` with the resulting
  principal, so a claimed owner gets "Read" too.
- The skills: `[sunshine:onboarding]` reads the welcome from upstream's live skill catalog (`skillGuide(skillCatalog.list(), "onboarding")`).
- The gateway: upstream named its page renderer `page`, the name the fork uses for the brand options; it is
  `messagePage` here and draws the branded page by default (`[sunshine:gateway-settings]`).
- Both sides had added the same `desktop` option to Maritime agents; upstream's is kept, the fork keeps only
  `INSTINCT_AGENT_DESKTOP` feeding it.
- `recordToolCall`: the fork's reply-guard and tapback flags, then upstream's `recordsOwnSpend`.

**Checked before committing** (all free).
- Upstream's fold fix applies to the fork's `foldInSteps` too: a run with two screenshots of 300,000 characters
  left a tool result without its call before the merge (the API refuses that: every desktop step fails) and a
  valid history after. Upstream's screenshot placeholder runs only inside a fold, which `[sunshine:stable-cache]`
  does rarely, so it does not cost a cache write per message.
- Contacts with Norwegian numbers, written either way, survive the new check on load and stay findable (new
  test in `contacts.test.ts`).
- The fork's reply rules run before upstream's echo rule (new test, see `[sunshine:reply-guard]`).
- The real server booted with a stand-in model, its Anthropic requests built by Pi and compared byte for byte
  (Anthropic's free token counter, no model run): before and after the merge, the system prompt and the 24 tools
  of an owner chat are identical (same fingerprints and token counts, 11,017 for a first message), each request
  only adds to the one before, also after a tool load, and `phone_call` is not offered.
- All tests (about 1,380) and the smoke test pass.
No real-model scenario was run: what the model sees in an ordinary owner chat did not change.

### 2026-10-15: upstream up to `9d262da`

**What came in** (9 commits, none fixing what the fork fixes): approvals in the owner's own words
(`approval_settle`, no tokens or "Reply YES or NO" in texts), `image_generate` (needs `IMAGE_API_KEY` or
`OPENAI_API_KEY`; without one it says it is not set up), `system.task` envelopes (an operator-started
task, `runSystemTask`, nothing sends them here yet), `INSTINCT_INSTRUCTIONS` seeding `AGENTS.md`, an
apps hint after a connect link, a blocked-merchant fix, Windows fixes.

**Collisions,** all both sides adding in the same place, resolved by keeping both: one import line in
`core-tools.ts`; the run flags on `Conversation` and the place where the fork's two audit helpers meet
`runSystemTask` in `runtime.ts`; the end of `runtime.test.ts`.

**Fitted to the fork.** `runSystemTask` texted its final reply straight to the owner, past the
`[sunshine:silent-reply]` and `[sunshine:reply-guard]` checks, and a `system:` conversation did not count
the owner as its audience. Both now behave as a scheduled job (tagged blocks in `runtime.ts`, two tests).

**Checked after the merge.** All tests (1,148) and the smoke test; real-model scenarios: reminders 14/14,
the cache read on every message after the first, the mirror (answers "what's Sanna?" on, not off),
tapbacks (misses only the known English "Loved “…”" text and the flaky "you're hilarious"), voice
(no machinery talk in 4 of 4). Approvals now add a section to the system prompt while one is pending,
which costs one cache write when it appears and when it goes.

## Earlier changes (tagged afterwards, 2026-10-15)

The fork's first changes were made before tagging started. Their code and tests now carry tags too,
so the same search finds them. Ordered from most to least likely to cause trouble. `git show
<commit>` shows a change in full; `git revert <commit>` undoes it (later commits build on some of
them, so a revert may need small fixes by hand). JSON files (`package.json`, the lockfile) and the
docs cannot carry a comment; they are listed under each change instead.

### `[sunshine:phone]`: phone numbers outside the US (`80b36b5`, `parsePhone` in `f5edfbb`)
- **What:** adds the `libphonenumber-js` library (pinned 1.13.14) and replaces the old rule that
  read any ten-digit number as American. Numbers written the local way are read as the owner's
  country. The three copies of the phone rule now share one function.
- **Where:** `packages/core/src/principal.ts` (`normalizePhone`, `parsePhone`, `phoneCountryOf`),
  `core/src/contacts.ts`, `core/src/config.ts`, `core/src/runtime.ts` (group threads),
  `network/src/lookup.ts`, `inkbox/src/tools.ts`, `server/src/boot.ts`, `cli/src/commands/invite.ts`;
  untagged: `packages/core/package.json` and `pnpm-lock.yaml` (the library).
- **If it breaks:** the owner or a contact is treated as a stranger, or a text goes to a wrong number.

### `[sunshine:signup]`: country picker, picked handles, repeat signups (`f5edfbb`, `ba288a7`)
- **What:** the country picker (`GATEWAY_DEFAULT_COUNTRY`); handles like `sunshine-anna-k3f9` picked
  by the gateway (`GATEWAY_HANDLE_PREFIX`); a repeat signup recognized by phone alone (restarts a
  failed setup, reveals nothing about the record).
- **Where:** `packages/gateway/src/validate.ts`, `gateway/src/server.ts`, `gateway/src/main.ts`,
  the form in `gateway/src/pages.ts`.
- **If it breaks:** friends cannot sign up, see "does not look like a phone number", get a second
  agent, or stay at "Setting up".

### `[sunshine:gateway-settings]`: settings for new agents (`ba288a7`)
- **What:** `GATEWAY_BRAND_NAME`, `INSTINCT_AGENT_DESKTOP`, `INSTINCT_MODEL`. New agents get the brand
  as their name (Inkbox display name, `INSTINCT_AGENT_NAME`, Maritime persona), the chosen model, and
  the desktop setting; every page shows the brand. Since 2026-10-23 the `desktop` option itself is
  upstream's; the fork's part is the env var feeding it, and the branded `messagePage` in `server.ts`.
- **Where:** `packages/gateway/src/brand.ts` (whole file), `gateway/src/main.ts`,
  `gateway/src/provision.ts`, `gateway/src/server.ts`, `gateway/src/pages.ts`.
- **If it breaks:** new agents fail to be created at Maritime, or run the wrong model or name.

### `[sunshine:schedule-list]`: finished reminders read as done (`704d137`)
- **What:** finished one-time jobs read "done, already sent at ...". Only the list text changed.
- **Where:** `packages/core/src/core-tools.ts` (`schedule_list`).
- **If it breaks:** the agent misreads its reminders. Low risk.

### `[sunshine:contact-card]`: "save to contacts", switched off (`08d5728`, `f82b1bd`)
- **What:** a "save to contacts" step with a sun picture. Off unless `GATEWAY_AGENT_NUMBER` is set.
- **Where:** `packages/gateway/src/contact.ts` (whole file), the `/connect/:id/contact.vcf` route in
  `gateway/src/server.ts`, `GATEWAY_AGENT_NUMBER` in `gateway/src/main.ts`, the save step in
  `gateway/src/pages.ts`.
- **If it breaks:** nothing while it is off.

### `[sunshine:design]`: the page design (`ba288a7`, `08d5728`, `f82b1bd`)
- **What:** minimal signup and connect pages, always dark, top-left sunlight, sun mark,
  animations (off with Reduce Motion), flags, one "Connect to Sunshine" button.
- **Where:** `packages/gateway/src/pages.ts`: the fork rewrote most of the file, so a note at its top
  says which parts are upstream's (the URL and router helpers) and the rest is tagged by block.
- **If it breaks:** only how the two web pages look or behave; the agent is not affected.

### Docs (untagged)
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
- `examples/dinner-a2a.mjs` fails at cb3d97c (seen 2026-10-23, also on pure upstream): the runtime now reads each
  A2A task from Inkbox before working on it, and the demo transport does not answer that `GET .../a2a/tasks/<id>`,
  so Sam's side never answers. `packages/server/scenarios/a2a.mjs` has a stand-in that does.
