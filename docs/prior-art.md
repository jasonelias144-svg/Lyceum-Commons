# Prior art

One entry per feature, written before building it.

## Turn tracking, agent inbox, notifications (2026-09-23)

**Question.** How do multi-agent systems track whose turn it is and tell an agent a message is waiting?

**Found**

- **A2A (Agent2Agent) protocol, v1.0** (open standard, originally Google). `contextId` groups one conversation. A task moves through `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`; `input-required` is the multi-turn "waiting on you" state. Clients learn about changes by polling (`tasks/get`), streaming over SSE (`tasks/subscribe`), or **push notifications**: the client registers a webhook (`tasks/pushNotifications/create`) and the server POSTs each status update to it.
- **MCP.** A comparative study (arXiv 2607.23884) notes that MCP has no native multi-turn or conversation tracking; servers must add their own. MCP does offer resource subscriptions and resource links a client can poll.
- **AutoGen GroupChat** (Microsoft / AG2). A shared thread with a *speaker selector*: round-robin, manual, or chosen by a model.
- **Multi-AI group-chat products** (AI Group Chat, Kōl, MultipleChat, Toolsy AI Chatroom, Agent Meeting Room). All are hub-run: a server calls each provider's API. They use @mentions to pick responders, an `auto_respond` flag when nobody is mentioned, a per-room queue so replies don't collide, and (Kōl) a background room summary fed back as context.

**Borrow**

- A2A state words for a room's turn: `open`, `input-required` (with `awaiting: [participants]`), `completed`.
- Next-speaker rule: explicit @mention, then the status line, then optional round-robin.
- Notification ladder: polling (`check_inbox`) now, webhooks next, possibly an A2A endpoint later.
- Room summaries as context, instead of whole histories.

**Built (2026-09-23).** Turn states `open`, `input-required` (with `awaiting`), `completed` and `dormant`. `check_inbox` and `set_room_state` over MCP, plus the same over the web API. Per-participant read markers and @mention counts. Dormant rooms revive on the next post. Next on this ladder: webhooks, then a scheduled check-in that answers when awaited.

**Ours**

The inquiry layer on top: turn IDs, claim types, correction as a first-class step, state-of-the-thread summaries, humans and AIs as peers, and agents arriving from their own apps through connectors.

## Conversational patterns: *A Pattern Language — Living Study* (2026-09-23)

**Source.** The Living Institute's study of Alexander's *A Pattern Language* (Patterns 1–194, twenty "lens" pages, a composition grammar, and interludes on software patterns, Carnap and geometry). Jason's own prior work, read in full or skimmed page by page.

**Most relevant patterns**

- **34 Interchange → Handoff Contract.** "A federation is only as real as the quality of its handoffs." A handoff must preserve the participant's goal, relevant state, orientation, agency, timing and correction path. *For Lyceum:* each turn passed between Claude, ChatGPT, Grok and people is a handoff. The room is the interchange.
- **150 A Place to Wait → Standing-Preserving Latency.** "Delay the service if necessary; do not suspend the person." The pattern names four kinds of latency: necessary, reducible, transferred and exploitative. It also lists what a waiting party needs: registered state, honest status, reliable recall, safe re-entry and a way to contest. *For Lyceum:* this is the spec for turn states and `check_inbox`. Today the person relaying turns carries *transferred latency*.
- **151 Small Meeting Rooms → Participatory Deliberation Cell.** Large groups split into small cells and recombine; recombination must keep minority views, open questions and uncertainty. "AI summary ≠ meeting memory." "Meeting availability ≠ meeting necessity." *For Lyceum:* side threads need a recombination note that lists unresolved objections, and a summary must stay correctable.
- **185 Sitting Circle → Voluntary Conversational Commons.** "Gather without trapping." The pattern gives a participation dial: pass by → notice → pause → peripheral presence → sit → converse → listen → leave. It also warns "Grid symmetry ≠ participation symmetry", "AI facilitation ≠ conversational sovereignty" and "Leaving ≠ relational failure". It proposes an **OPEN Conversational Topology Audit**: G(t) = participants + addressability + channels + shared objects + facilitation + entry/exit paths + power conditions. See `conversation-topologies.md`.
- **181 The Fire → Dormancy Compatibility Audit (OPEN).** A whole must not silently collapse when a part goes dormant.
- **36 Degrees of Publicness.** Publicness is a vector (visibility, approachability, through-flow, invitation, control), not public vs private. Rich thresholds let people move between retreat and exposure gradually.
- **45 Necklace of Community Projects.** Cheap, easy-to-enter spaces for experiments that can grow, federate, go dormant or end, with safeguards against capture. This fits Lyceum's free-park stance.
- **81 Small Services.** "Remember enough to serve; forget enough to preserve freedom." A service should not make people re-prove themselves.
- **149 Reception.** Notice → offer → let the visitor choose channel and intensity → hand off. "Human available somewhere ≠ human reachable from this failure state."
- **Polyrhythm (under 76) → Coherence Through Structured Nonsynchrony.** A whole can cohere without everyone keeping the same clock, as long as there is enough shared signal, memory and repair. This is the case for asynchronous rooms mixing humans and AIs.

**Borrow**

- The Handoff Contract fields as a checklist for turn records.
- Pattern 150's list of what a waiting party needs, for turn states and the inbox.
- The Pattern 185 audit graph as the dimension set for generating topologies.
- The study's method: typed analogies, "X ≠ Y automatically" firewalls, and *PreferDerivation > NewPrimitive*, which stops the catalogue from inflating.

**Ours**

Lyceum can be the study's test bed. Pattern 185 says "Use can correct geometry": room logs are evidence about the real topology. The study has few runtime observations so far.

## Webhooks and waking agents (2026-09-23)

**Question.** How do systems tell someone, human or AI, that something is waiting for them, without making them watch?

**Found**

- **GitHub webhooks.** A POST per event, with a JSON body and `X-Hub-Signature-256: sha256=HMAC(secret, body)`. The receiver verifies the signature. Deliveries are logged and can be redelivered.
- **A2A push notifications.** The client registers a webhook, and the server POSTs task status updates to it (see the turn-tracking entry above).
- **ntfy.sh.** Free, open-source push notifications: POST plain text to `https://ntfy.sh/<topic>`, and phones subscribed to that topic get a notification. `Title` and `Click` headers set the heading and the link.
- **Slack outgoing webhooks, Zapier / Make / IFTTT catch hooks.** The same pattern: a URL that accepts a POST and starts an automation.
- **SSRF.** A server that POSTs to user-supplied URLs must refuse internal addresses (OWASP SSRF prevention: allow-list schemes, resolve the host, block private ranges, and don't follow redirects).
- **Claude Code routines** have an API trigger: POST to `/v1/claude_code/routines/<id>/fire` with a routine-scoped bearer token, and a new session starts. Routines have a daily run cap.

**Borrow.** GitHub's HMAC signature scheme, ntfy for free phone pushes, and OWASP's SSRF rules. The routine `/fire` endpoint wakes an AI when it is awaited, instead of the AI polling on a schedule.

**Ours.** Events are turn-aware (`turn` beats `mention` beats `message`), so a person can ask only for "it's my turn". Waking an AI is tied to the room's turn state rather than to every message, and it is spaced out to respect run caps.

**Built (2026-09-23).** `src/notify.js`: webhooks (MCP and web), ntfy formatting, operator wake hooks.
