# Conversation topologies: 50 patterns from existing apps

A survey of how existing apps shape conversation, written before designing Lyceum's rooms (see `CLAUDE.md`, rule 1). Only patterns that exist today are listed. From memory of the apps, not a fresh audit: details may lag the current versions.

**Half-life** is how long a conversation typically stays alive: minutes, days (session), months (project), or years (perennial).

## A. Linear chat

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 1 | Direct message | WhatsApp, iMessage, Signal | two people, one stream | indefinite | private room between two parties |
| 2 | Small group chat | WhatsApp groups | few people, one stream | days–years | the default room |
| 3 | Swipe-to-reply quoting | WhatsApp, Telegram | inline reference to an earlier message | — | quote-reply to a specific turn |
| 4 | Reactions | Slack, Discord, iMessage | emoji attached to a message | — | lightweight agreement without a new turn |
| 5 | Read receipts and presence | WhatsApp ticks, Slack status | who has seen what, who is here | — | "seen by" per turn; who is in the room now |
| 6 | Disappearing messages | Signal, WhatsApp | messages expire on a timer | designed decay | optional ephemeral rooms |
| 7 | Voice notes | WhatsApp, Telegram | spoken turns in a text stream | — | later: audio turns with transcripts |

## B. Channels and side threads

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 8 | Channel with threads | Slack | main stream + side threads; "also send to channel" | days | side threads off any turn, keeping the main line clean |
| 9 | Pins and bookmarks | Slack, Reddit stickies | a few items held above the stream | — | pin the packet and the latest state-of-the-thread |
| 10 | @mention and notification levels | Slack, Discord | @user, @here, @channel; per-channel mute | — | @mention decides who is up next; per-room notification level |
| 11 | Voice drop-in | Slack huddles, Discord voice | presence-based live talk | minutes | later: live sessions attached to a room |
| 12 | Broadcast channel | Telegram and WhatsApp channels | one speaks, many react | indefinite | announcements |
| 13 | Channel + linked discussion group | Telegram | broadcast post opens its own discussion | days | a post that spawns a room |
| 14 | Forum channel | Discord | each post is its own thread, with tags | weeks | rooms as posts inside a topic, tagged |
| 15 | Slow mode | Discord, Twitch | minimum time between posts per person | — | pacing for AI turns and heated rooms |

## C. Threaded discussion and voting

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 16 | Nested comment tree | Reddit, Hacker News | replies nest; siblings sorted by votes; branches collapse | days | branching turns with collapse |
| 17 | Community with rules and moderators | subreddits, Discourse categories | the place has an identity and norms | years | a room's packet is its rules; stewards per room |
| 18 | Vote-sorted replies | Reddit, Stack Overflow | community ranking | — | optional; sort by support, not just time |
| 19 | AMA | Reddit | time-boxed; one answerer; questions upvoted | hours | "ask this human or AI anything" sessions |
| 20 | Recurring megathread | Reddit daily or weekly threads | a conversation reborn on a schedule | periodic | recurring rooms: weekly open questions |
| 21 | Topic auto-close after inactivity | Discourse | silence ends the topic | set per forum | a visible *dormant* state, with revival |
| 22 | Trust levels | Discourse | privileges earned through participation | — | later: newcomers post, stewards merge and close |
| 23 | Summarize this topic | Discourse | a long topic compressed on demand | — | state-of-the-thread summaries |

## D. Questions and answers

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 24 | Question with accepted answer | Stack Overflow | answers ranked; asker accepts one | years | mark a turn as the room's current best answer |
| 25 | Comments vs answers | Stack Overflow | clarifications live in a separate layer | — | two layers: turns and side comments |
| 26 | Close as duplicate | Stack Overflow | new question points to the canonical one | years | merge into canonical room (Lyceum has merge) |
| 27 | Community wiki answer | Stack Overflow | an answer anyone can edit | years | a shared, editable room summary |
| 28 | Bounty | Stack Overflow | attention offered to a stale question | days | "call for help" on a dormant room |
| 29 | Live question queue | Slido | audience questions upvoted during an event | hours | questions queued for a session |
| 30 | Discussions with categories and polls | GitHub Discussions | Q&A, Ideas, Polls, each with its own mechanics | months | room types |

## E. Work items and artifacts

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 31 | Issue with lifecycle | GitHub Issues, Linear | open → closed; labels, assignees | weeks–months | room states: `open`, `input-required`, `completed`, `dormant` |
| 32 | Cross-references | GitHub "mentioned this", backlinks | conversations aware of each other | — | links between rooms, both directions |
| 33 | Issue relations | Linear, Jira | blocks, duplicates, relates to | — | a graph of rooms |
| 34 | Pull request review | GitHub | discussion anchored to a proposed change; approve or request changes | days | proposals with review |
| 35 | Line-anchored comments | GitHub, Google Docs | comments attached to part of an artifact; resolvable | — | comment on a sentence of a packet or turn |
| 36 | Suggested edits | Google Docs, GitHub suggestions | a proposed change shown in place; accept or reject | — | corrections as suggestions, keeping the original visible |
| 37 | Fork | GitHub | the whole thing copied to diverge | indefinite | fork a room to pursue another direction |
| 38 | History and blame | git, Wikipedia | every line traceable to its author and time | forever | provenance on every turn and edit |
| 39 | Kanban card with comments | Trello, Linear | each work item carries its own conversation as it moves | weeks | rooms as cards moving through stages |
| 40 | Document as the conversation's state | Notion, Google Docs | the doc holds conclusions; comments hold discussion | months | the state document beside the stream |

## F. Encyclopedias and deliberation

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 41 | Talk page | Wikipedia | discussion about an artifact, beside it; old sections archived | years | every packet has a talk room |
| 42 | Request for comment with a closer | Wikipedia RfC | structured decision closed by an uninvolved editor | weeks | a neutral closer, human or AI, writes the ending |
| 43 | Revert | Wikipedia | any change undoable | forever | nothing is lost; corrections preserve earlier states |
| 44 | Opinion clustering | Polis | people vote on statements; opinion groups are mapped; bridging statements surface | weeks | find claims that people (and models) who usually disagree both accept |
| 45 | Bridging-based notes | X Community Notes | a note shows only if raters who usually disagree find it helpful | days | the same test for room summaries |
| 46 | Pro/con argument tree | Kialo | claims with pro and con branches | months | the claim ledger |

## G. Broadcast and live

| # | Pattern | Where | Shape | Half-life | Borrow for Lyceum |
|---|---|---|---|---|---|
| 47 | Quote-post | X | a post becomes the start of a new conversation for another audience | days | quote a turn into another room |
| 48 | Hashtag aggregation | X, Instagram | a conversation defined by a tag, not a place | days | tags across rooms |
| 49 | Live stream chat | Twitch, YouTube Live | firehose beside a live event; emotes; slow mode | minutes | commentary lane beside a live session |
| 50 | Timestamped comments | SoundCloud, YouTube | comments pinned to a moment in media | — | comments on a moment in a transcript or recording |

## What the survey shows

1. **Every lasting conversation has an anchor**: a question (Stack Overflow), an artifact (pull request, wiki article), a place (subreddit), or a time (AMA, live event). Lyceum's anchor is the room's packet: its question and its rules.
2. **Successful designs separate layers**: answers vs comments, main stream vs threads, article vs talk page. Lyceum needs at least turns vs side comments.
3. **Conversations have explicit lifecycles**: open, answered, closed, dormant, reopened. That matches A2A's task states and Open Inquiry's endings.
4. **Ranking uses different signals for different jobs**: time (chat), votes (Reddit), acceptance (Stack Overflow), bridging (Community Notes, Polis). Inquiry wants acceptance by test, and bridging for summaries, rather than popularity.
5. **Long-lived conversations survive turnover through summaries and rebirth**: megathreads, digests, wiki answers, talk-page archives. That is how a conversation gets an identity beyond any contributor, and it is Open Inquiry's state-of-the-thread.
6. **Silence is handled explicitly**: auto-close, bounties, disappearing messages. "Silence is death" suggests a visible *dormant* state, and a way to revive a room with its history intact.
7. **Provenance and reversibility build trust**: edit history, blame, revert.
8. **Attention is managed**: mentions, notification levels, slow mode. With AIs that can post instantly, pacing matters more than it does between humans.

## Intuitive defaults for Lyceum

People should be able to do what they expect, the way similar apps taught them:

- Rooms that look like a group chat (2), with quote-reply (3), reactions (4) and side threads (8).
- A pinned packet and state summary at the top (9).
- @mentions to call on someone, human or AI (10).
- Room states and labels like issues (31), with links between rooms (32).
- "Mark as current best" for answers (24), and corrections as suggested edits (36).
- Full history on everything (38, 43).
- Dormant rooms that can be revived (21, 28).

What no surveyed app combines: humans and AIs from different companies as labelled peers, rooms tied to outside verifiers, and inquiry states (claim types, promotion by test) as first-class parts of the conversation.

## A grammar for generating new topologies

The Living Study (`prior-art.md`) already supplies the generative machinery this catalogue lacked:

- **Dimensions.** Pattern 185's open audit: G(t) = participants + addressability relations + channels + shared objects + facilitation + entry/exit paths + power conditions. Add Pattern 36's publicness vector and Pattern 150's latency states. Each surveyed app is a point in this space. Empty cells are candidate new topologies (Zwicky).
- **Operators.** The study lists fifteen relational transformations (create, remove, redirect, mediate, translate, decouple, aggregate, distribute, observe, delegate, gate, buffer, remember, repair, retype). It also has seven composition modes (sequential, nested, parallel, complementary, federated, gradient, transformational). Applying an operator to a known topology gives a new one. For example, *buffer* applied to linear chat gives a standing-preserving waiting room (150), and *distribute + remember* applied to a meeting gives fission and recombination (151).
- **Discipline.** A new entry must earn its place (*PreferDerivation > NewPrimitive*). If it is only a composition of existing entries, record it as a composition.
- **Audit questions** for each topology: Who can address whom? Does one seat, host or relay hold hidden centrality? Can people join and leave without disrupting the whole? Does the whole survive when a participant goes dormant?

Lyceum's current honest audit result: the human relay is a hidden centre. AIs speak only when a person wakes them. Turn states, the inbox and webhooks are what remove that bottleneck.
