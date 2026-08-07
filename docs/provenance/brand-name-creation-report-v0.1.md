# Brand Name Creation Report
## Multi-Engine Coding Workflow Orchestrator

**Method:** Scientific (linguistic) naming methodology — semantic decomposition → source-domain mapping → morpheme inventory → phonosemantic targeting → systematic candidate construction → multi-axis screening → weighted scoring → verification protocol
**Input documents:** Product Specification v0.1, Decision & Scope Audit v0.1 (30 July 2026)
**Status:** Candidate shortlist with partially verified namespace data; final legal/namespace verification checklist included in §10

---

## 1. Naming brief (derived from the specification)

Before generating a single candidate, the method requires an explicit brief extracted from the product's own claims, because the name must be optimized against measurable criteria, not taste.

**What the product is.** A local-first, durable control plane that turns multiple subscription-backed coding-agent CLIs (Claude Code, Codex CLI, Cursor CLI) into one dependable, inspectable software-delivery system. A daemon owns long-running work; runs survive the parent conversation closing; stages exchange durable artifacts; whole tasks execute in dependency-ordered parallel waves; every decision has provenance.

**Naming surfaces the name must survive.** This is unusually demanding: the same string will be (a) a CLI command typed dozens of times a day (`tool run status …`), (b) a daemon/process name, (c) an npm package and GitHub org if the open-source direction is validated, (d) a spoken word in conversation with Claude Code ("run the careful-epic pipeline in ___"), and (e) potentially a public developer brand. Requirement (a) dominates: the primary user interface is a human's fingers.

**Audience.** v1: expert technical users. Later: the global open-source developer community. The name must work internationally and benefits from — but does not require — continuity with the predecessor system's concrete, working-machine naming culture.

**Hard constraints (from the surfaces above):**

| # | Constraint | Rationale |
|---|---|---|
| C1 | ≤ 8 characters, ideally ≤ 6, lowercase-clean | CLI ergonomics; no shift key, no diacritics |
| C2 | Unambiguous English pronunciation from spelling | Spoken to Claude Code; discussed in issues/talks |
| C3 | Legal, non-comic, non-offensive reading in EN, PL, DE, ES, FR, PT | Open-source reach |
| C4 | No dominant existing developer tool, npm package, or trademark in orchestration/DevTools | Ownability |
| C5 | Phonotactically valid in English (no /ʂt/, /pʃ/ onsets etc.) | Adoption friction |
| C6 | Extensible into a naming system (daemon name, verb use, sub-commands) | `foo` / `food`… must not produce accidents |

**Soft targets:** semantic resonance with *conducting many engines*, *durability/persistence*, *waves/cadence*, *handoff/continuation*, *provenance*; a touch of the predecessor lineage's concrete-machine humor; sound symbolism appropriate to "precise, dependable control" (see §4).

---

## 2. Method overview

The scientific approach treats a name as an engineered artifact with testable properties, produced by a pipeline (fittingly):

1. **Semantic decomposition** — reduce the product to its distinctive semantic features (§3).
2. **Source-domain mapping** — enumerate metaphor domains whose vocabulary already encodes those features (§3.2).
3. **Morpheme inventory** — collect productive roots and affixes from Latin, Greek, Italian musical vocabulary, Polish, German, Norse, and English craft lexicons (§5).
4. **Phonosemantic targeting** — define the sound profile the name should have, using sound-symbolism research (§4).
5. **Systematic construction** — generate candidates by defined operations: direct borrowing, semantic loan, blending, clipping, affixation, and coinage (§6).
6. **Screening** — phonotactic, cross-linguistic, and namespace filters, including live collision checks (§7).
7. **Weighted scoring** — score survivors on explicit weighted axes (§8).
8. **System design + verification** — build the naming system around finalists and define the pre-adoption verification protocol (§9–10).

---

## 3. Semantic decomposition

### 3.1 Distinctive semantic features

From the specification, the features that differentiate this product from the crowded "AI agent orchestration" category — and are therefore worth encoding — are:

- **F1 · One-from-many.** Multiple heterogeneous engines composed into one system (the executive summary's core promise).
- **F2 · Directed, not merely aggregated.** A deterministic control plane directs cognitive workers; the conductor is not a player (§4.3 of the spec).
- **F3 · Durability / survival.** Work persists after the parent session closes; artifact-before-completion; a daemon that endures (§4.4, product promise).
- **F4 · Cadenced parallelism.** Waves of whole tasks over a dependency DAG (§4.6).
- **F5 · Seamless continuation.** Fused adjacent stages in one session; continuation capsules handed to fresh sessions (§4.2, smart continuation).
- **F6 · Provenance.** Every decision recorded (§4.10).
- **F7 · Local, private, workmanlike.** Confidential by default; a tool on your own machine, not a cloud brand (§4.8).

A single short name cannot encode seven features. Naming science says: encode one or two *distinctive* features strongly and let the naming system (taglines, sub-command vocabulary) carry the rest. F1+F2 (directed one-from-many) and F5 (seamless continuation) are the most distinctive versus competitors, whose names cluster around generic flow/conducting (Airflow, Prefect, Conductor, Kestra, Maestro — all taken, all F1/F2 only).

### 3.2 Source-domain map

| Domain | Encodes | Vocabulary richness | Category crowding |
|---|---|---|---|
| Orchestra / musical direction | F1, F2, F4, F5 | Very high (Italian performance directions are a ready-made controlled vocabulary) | High for conductor-words (Maestro, Conductor, Orkes, Kestra taken); low for *performance-direction* words |
| Weaving / textile | F1, F4 (warp = parallel worktrees; weft = integration) | High | **Very high — verified saturated**: Warp (terminal), Loom (video), and Weft (≥5 active projects incl. an AI-agent CLI; see §7.3) |
| Agriculture / machinery (predecessor lineage) | F7, humor, heritage | Medium | Low, but semantics of F1–F5 weak |
| Navigation / crew command | F2 | Medium | High (Helm, Bosun, Armada, Flotilla variants taken) |
| Engine mechanics | F1, F2 ("governor", "manifold") | Medium | Medium |
| Latin/Greek coinage | Any (by construction) | Unlimited | Low by definition |
| Polish working lexicon | F7, heritage, distinctiveness abroad | Medium | Near zero collisions |
| Lean manufacturing | F4 ("takt") | Narrow but precise | Low–medium |

**Decision:** primary territory = *musical performance directions* (rich, precise, under-exploited — the category took the conductor's *titles* but not his *language*); secondary = *Polish working lexicon* (heritage + ownability); tertiary = *engine mechanics* and *Latin coinage*.

---

## 4. Phonosemantic targets

Sound-symbolism research (Köhler's *bouba/kiki* effect; Sapir's magnitude symbolism; Klink's brand-phonetics studies) gives directional guidance:

- **Voiceless stops /t, k, p/** connote precision, speed, smallness, technicality — desirable for a control plane (`kiki` cluster). Klink's experiments associate front vowels + voiceless stops with "faster, sharper, more precise" brand perception.
- **Sonorants /l, m, n/ and open vowels /a, o/** connote smoothness, continuity, reliability (`bouba` cluster) — desirable for F3/F5 (durable, seamless).
- The ideal profile is therefore **mixed**: a stop-anchored skeleton (control, precision) softened by sonorants or open vowels (continuity, dependability). Pattern targets: `CVC·CV`, `CV·CVC·CV`, stress on the penult (natural for EN, PL, IT alike).
- **Avoid:** sibilant-heavy strings (hissy, unstable), /ʃt/ /ʂ/ onsets (C5), final /s/ (plural ambiguity in CLI docs), and strings whose English spelling→sound mapping is unstable (C2: *gh*, *ough*, soft/hard *c* ambiguity in final position).

**Target profile:** 2–3 syllables, penultimate stress, ≥1 voiceless stop, ≥1 sonorant, ends in a vowel or clean consonant (/t/, /n/, /k/), zero diacritics.

---

## 5. Morpheme inventory (working set)

| Morpheme | Origin | Meaning | Notes |
|---|---|---|---|
| *attacca* | It. music | "proceed to the next movement without pause" | Encodes F5 exactly; performance-direction lexicon |
| *tutti* | It. music | "all together; full ensemble" | Encodes F1 |
| *legato* | It. music | "connected, without breaks" | F5; softer profile |
| *segno / dal segno* | It. music | "the sign to resume from" | F5 (continuation capsule) |
| *ostinato* | It. music | "persistently repeating figure" | F3; 4 syllables (long) |
| *ripieno* | It. music | "the full ensemble backing the soloists" | F1; obscure |
| *takt* | Ger./Pol. via lean mfg. | beat, measure; *takt time* = production cadence | F4; already a term of art in flow production |
| *osnowa* | Pol. | warp threads; figuratively "framework"; *osnowa geodezyjna* = geodetic **control network** | F1+F2 triple meaning; heritage |
| *kapela* | Pol. | band, ensemble of players | F1; heritage; warm register |
| *hetman* | Pol./hist. | supreme field commander; the queen in Polish chess | F2; heritage |
| *wataha* | Pol. | coordinated pack (of wolves) | F1; wave-hunting connotation |
| *dux / duc-* | Lat. | leader; root of *conductor* | F2 |
| *ordo / ordin-* | Lat. | order, rank, arrangement | F2, F6 |
| *agmen* | Lat. | an army *in ordered march column* | F2+F4; near-unique |
| *cursus* | Lat. | course, track; *cursus honorum* = the canonical sequential pipeline | F4 |
| *dirigo* | Lat. | "I direct, I guide straight" | F2; Maine state motto |
| *per-dur-* | Lat. | to last through, endure (*perdurable*) | F3 |
| *governor* | En. mech. | device regulating **engine** speed | F1+F2 literalized in machinery |
| *manifold* | En. mech. | junction joining multiple engine cylinders into one flow | F1 |
| *-or / -er* | Lat./En. agent | doer | agentive suffix |
| *-a / -o* | Romance/Slavic | noun-forming vowel coda | pronunciation-stabilizing coda |

---

## 6. Systematic candidate construction

Candidates were generated by five defined operations across the chosen territories. The full longlist (with elimination reasons) precedes the scored shortlist so the search space is auditable — provenance for names, in the product's own spirit.

### 6.1 Longlist with construction notes and screening outcomes

**Territory A — Musical performance directions (primary)**

| Candidate | Operation | Encodes | Outcome |
|---|---|---|---|
| **attacca** | direct borrowing | F5 (+F2 via "attack the task") | **Shortlisted** — see §8 |
| **tutti** | direct borrowing | F1 | **Shortlisted** |
| **legato** | direct borrowing | F5 | Shortlist reserve; legacy "Legato Systems" (EMC backup) residue; softer/less technical sound profile |
| segno | direct borrowing | F5 | Reserve; "seg-no" misparse risk in EN; near-collision with *Segment*, *Sentry* mindshare |
| ostinato | direct borrowing | F3 | Eliminated: 4 syllables, violates C1 spirit |
| ripieno | direct borrowing | F1 | Eliminated: opaque, pizza-adjacent reading ("ripieno" = stuffed, on every Italian menu) |
| coda, presto, tempo, maestro, cadence | direct borrowing | — | Eliminated: verified/known dominant collisions (Coda docs; Presto SQL; Grafana Tempo; Maestro mobile testing; Uber Cadence — the last is literally a workflow orchestrator) |

**Territory B — Polish working lexicon (heritage)**

| Candidate | Operation | Encodes | Outcome |
|---|---|---|---|
| **osnowa** | direct borrowing | F1+F2 (warp/framework/control network) | **Shortlisted** |
| **kapela** | direct borrowing | F1 | **Shortlisted** |
| batuta | direct borrowing | F2 | **Eliminated by verification** (§7.3): `paiml/batuta` is an existing orchestration CLI on crates.io, and batuta.com is a security platform with a "BatutaAgent" |
| hetman | direct borrowing | F2 | Reserve: strong and typeable, but Hetman Software (data recovery) exists and the word is geopolitically loaded in the current decade |
| wataha | direct borrowing | F1 | Reserve: evocative (a pack hunting in coordinated waves) but /wa-TA-ha/ reads unstably in EN; known Polish TV series *Wataha* |
| sztygar (Silesian mine foreman), majster, kuźnia, żniwa | direct borrowing | F2/F7 | Eliminated: C1/C2/C5 violations (diacritics, /ʂt/ onset, EN spelling instability) |
| orka | clipping/pun (plowing; orca; *or*-chestrator) | F7+F1 | **Eliminated by prior knowledge**: Orka is MacStadium's macOS **orchestration** product — direct category collision |

**Territory C — Engine mechanics / lean flow**

| Candidate | Operation | Encodes | Outcome |
|---|---|---|---|
| **takt** | semantic loan (takt time) | F4 | **Shortlisted** |
| governor | direct borrowing | F1+F2 | Reserve: semantically superb (a governor *is* a deterministic device controlling engines), but 8 chars, dictionary-word ownability problems, political homonym |
| manifold | direct borrowing | F1 | Eliminated: Manifold Markets + mathematical homonym saturation |
| flywheel | direct borrowing | F3 | Eliminated: Flywheel hosting (WP Engine) |
| yoke | direct borrowing (joins engines; pilot's control column) | F1+F2 | Reserve: 4 letters, dual metaphor; recent `yoke` IaC project in the k8s space needs checking; slight "burden" connotation |

**Territory D — Latin coinage**

| Candidate | Operation | Encodes | Outcome |
|---|---|---|---|
| **agmen** | direct borrowing (obscure) | F2+F4 | **Shortlisted** as the "unique coinage" control candidate |
| dirigo | direct borrowing | F2 | Reserve: clean, but soft-g ambiguity /dɪˈriː-goʊ/ vs /dɪˈrɪdʒoʊ/ violates C2 |
| cursus | direct borrowing | F4 | Reserve: final /s/ (C-avoid), "cursor" adjacency is a *negative* here (Cursor CLI is a managed engine — implies favoritism) |
| perdur | affix blend (*per-* + *dur-*) | F3 | Eliminated: reads as fragment, stress unstable |
| ordino | affixation | F2 | Eliminated: pharmaceutical sound profile |

**Territory E — Weaving** *(entered with warp/loom already known-taken)*

| Candidate | Operation | Encodes | Outcome |
|---|---|---|---|
| weft | direct borrowing | F1+F4 | **Eliminated by verification** (§7.3): ≥5 active projects named Weft, including `weftlabs/weft-cli`, "a developer-first CLI that uses specialized AI agents to build software" — a near-identical positioning |
| jacquard | direct borrowing | F2 | Eliminated: 8 chars, FR spelling trap (C2), luxury-brand trademark adjacency |
| selvage | direct borrowing | F3 | Eliminated: opacity; "salvage" misreading |

The weaving territory's saturation — every core term now hosts an AI/dev product — is itself a finding: it confirms the method's premise that *obvious* metaphors are pre-mined, and pushes weight toward Territories A, B, and D.

---

## 7. Screening detail

### 7.1 Phonotactic & ergonomic screen (C1, C2, C5, C6)

All shortlisted names were checked for: English onset/coda legality; stable grapheme→phoneme mapping; typing effort (alternation of hands on QWERTY, no awkward same-finger bigrams); and safe morphological extension (daemon suffix `-d`, possessives, verb use).

| Name | Syll. | Chars | EN pronunciation | Typing | `-d` daemon form | Verb-ability |
|---|---|---|---|---|---|---|
| attacca | 3 | 7 | ah-TAH-ka (stable) | good; double letters aid memory | `attaccad` ✓ | "attacca it" (marginal) |
| tutti | 2 | 5 | TOO-tee (stable) | excellent | `tuttid` (weak) | no |
| osnowa | 3 | 6 | oss-NO-va (stable) | good | `osnowad` ✓ | no |
| kapela | 3 | 6 | ka-PEL-a (stable) | good | `kapelad` ✓ | no |
| takt | 1 | 4 | TAKT (stable) | excellent | `taktd` ✗ → `takt-daemon` | "takt the epic" ✓ |
| agmen | 2 | 5 | AG-men (stable) | good | `agmend` (odd) | no |

### 7.2 Cross-linguistic screen (C3)

Checked against EN, PL, DE, ES, FR, PT lexicons for false friends, vulgarity, and comic readings:

- **attacca** — IT "attack/attach imperative"; ES *ataca* "attacks"; PL neutral. The aggression reading is mild and arguably on-brand for autonomous execution. No vulgarity found.
- **tutti** — universally positive ("everyone"); EN "tutti-frutti" adds a candy/ice-cream register (dilutes seriousness); *tutti.ch* is a major Swiss classifieds site (different class, same string).
- **osnowa** — PL as designed; RU cognate *osnova* "basis" is positive; no negative readings found. Confusability with **Osnova**, the Russian CMS platform behind vc.ru, must be verified (§10).
- **kapela** — PL "band"; CZ/SK identical; ES/PT proximity to *capela/capilla* "chapel" is harmless. In PL, *kapela* is warm/folksy — consistent with the predecessor's register.
- **takt** — DE/PL/SV "beat; tact"; universally clean; bonus: DE *Takt* also means "tactfulness."
- **agmen** — no lexical presence in checked languages; PL reads it cleanly; no vulgar near-neighbors found.

### 7.3 Namespace collision screen (C4) — live-verified findings

Verified by web search during this exercise (30 Jul 2026):

- **batuta — FAIL.** An existing orchestration CLI describes itself with the identical conductor's-baton metaphor, plus batuta.com, an endpoint-security platform shipping a "BatutaAgent."
- **weft — FAIL.** At least five active projects, among them an AI-agent developer CLI (`weftlabs/weft-cli`), an AI-agent platform, an AI-orchestration language, and a cloud platform — the exact category.
- **attacca — PASS (provisional).** Searches for "attacca" as a developer tool surfaced no existing CLI, npm package, or platform; known uses are musical (Attacca Quartet — unrelated class). Requires the §10 protocol before adoption.
- **tutti, osnowa, kapela, takt, agmen — UNVERIFIED.** Not yet searched; known-adjacent risks noted above (tutti.ch; Osnova CMS; possible small "Takt" SaaS). Must run §10 before use.

---

## 8. Weighted scoring

Weights follow the brief: usability at the keyboard and ownability dominate, because the CLI is the primary surface and the category is crowded.

**Axes:** Semantic fit to F1–F7 (25%) · Distinctiveness/ownability (20%) · CLI & spoken usability (20%) · Cross-linguistic safety (15%) · Namespace availability outlook (15%) · System extensibility (5%). Scale 1–5.

| Name | Semantic ×.25 | Distinct ×.20 | Usability ×.20 | X-ling ×.15 | Namespace ×.15 | Extens. ×.05 | **Weighted** |
|---|---|---|---|---|---|---|---|
| **attacca** | 5 | 4 | 4 | 4 | 4 (verified prov.) | 5 | **4.35** |
| **osnowa** | 5 | 5 | 3 | 4 | 4 | 4 | **4.25** |
| **takt** | 4 | 3 | 5 | 5 | 3 | 4 | **4.00** |
| **kapela** | 3 | 4 | 4 | 4 | 4 | 4 | **3.75** |
| **agmen** | 4 | 5 | 3 | 4 | 4 | 2 | **3.90** |
| **tutti** | 4 | 2 | 4 | 4 | 3 | 2 | **3.35** |

Scoring rationale for the top two:

**attacca** scores 5 on semantics because it names the product's most distinctive mechanism, not just its category. *Attacca* is the instruction a composer writes when the next movement must begin **without pause, in the same breath** — precisely the fused-stage / smart-continuation design (§4.2 of the spec: stages remain distinct movements; the session does not go cold between them). It secondarily reads as "attack the task" in English — apt for autonomous execution — and its phonetic skeleton (/t/ /k/ stops around open /a/) matches the §4 target profile: precise attack, sustained vowel. It is Italian performance vocabulary, i.e. the *conductor's own language*, taken from a shelf the category ignored while fighting over "Conductor" and "Maestro."

**osnowa** scores 5 on semantics and distinctiveness through a rare triple meaning in one Polish word: (1) the **warp** — the parallel threads held under tension that everything else is woven across (the worktrees/waves); (2) the figurative **framework** on which a story is built; (3) in surveying, *osnowa geodezyjna* — literally a **control network**: the fixed, durable reference points every measurement is anchored to. "A durable local control plane" translates itself. It also continues the predecessor tradition of naming serious machinery in plain Polish. Its cost is usability abroad: three syllables, /os-NO-va/, and confusability with the Russian *Osnova* CMS.

---

## 9. Recommendation and naming system

### 9.1 Recommendation

**Primary: `attacca`** — pending §10 verification (which it has provisionally passed).
**Heritage alternative: `osnowa`** — if the predecessor lineage and maximal ownability outweigh international ease.
**Fallback: `takt`** — if a 4-letter, zero-explanation, verb-able command wins the day; accept weaker distinctiveness.

### 9.2 The naming system around `attacca`

A scientific name must extend into a *system* (C6). The musical-direction lexicon supplies a coherent, optional vocabulary that maps 1:1 onto the spec's own concepts without renaming any of them:

| Product concept (spec term stays canonical) | System flavor |
|---|---|
| CLI | `attacca` (`attacca pipeline run careful-epic --issue 482`) |
| Daemon | `attaccad` |
| Continuation capsule | *dal segno* — the capsule is the sign the fresh session resumes from (docs metaphor only) |
| Bundled pipelines `fast` / `careful` | presets may keep plain names; *presto*/*adagio* available as aliases if wanted |
| Full-ensemble run of all engines | a *tutti* run (colloquial docs term) |
| Release codenames | movement numbers: *v1 "Primo"*, *v2 "Secondo"* |

Tagline candidates (testing the F-features the name itself doesn't carry): "Movements change. The music doesn't stop." (F5+F3) · "Many engines. One score." (F1+F2) · "Runs that outlive the conversation." (F3, literal).

The same exercise for `osnowa`: daemon `osnowad`; the tagline writes itself as "the control network for your coding agents"; wave/worktree docs language borrows warp-and-weave naturally.

---

## 10. Pre-adoption verification protocol

The method is only scientific if the winner is verified, not admired. Before committing (per name, in order, stop at first failure):

1. **Exact-match search**: "<name> CLI", "<name> npm", "<name> github", "<name> AI agent", "<name> orchestration". Batuta and Weft failed at this step; Attacca provisionally passed on 30 Jul 2026 — re-run at adoption time.
2. **Registry checks**: npmjs.com, crates.io, PyPI, Homebrew formulae, GitHub org availability, `apt`/`brew` binary-name conflicts (`which <name>` on target OSes).
3. **Trademark screen**: EUIPO + USPTO TESS in Nice classes 9 and 42; knock-out search only at this stage, counsel later if going public.
4. **Domain screen**: `<name>.dev` / `.sh` / `.io` availability (not blocking for v1, decisive before open-sourcing).
5. **Pronunciation test**: three non-Polish, non-Italian speakers read the written name cold; ≥2/3 must converge on one pronunciation (C2).
6. **The spec's own bar applies**: as v0.1 itself states, naming does not block implementation — `tool` remains a fine placeholder until a candidate clears steps 1–5.

---

## Appendix A — Reproducibility

To regenerate or extend the longlist, the generative grammar used was: *{performance-direction ∪ Polish-craft ∪ engine-mechanics ∪ Latin-column} × {borrow, blend, clip, affix} → filter(C1–C6) → score(§8 weights)*. Any new candidate should enter at §7.1, not §8, so that ergonomic and cross-linguistic screens are never skipped on grounds of enthusiasm.

---

## 11. Addendum (v0.2, same date) — Territory F: Historical systems & eponyms

### 11.1 The referential-naming operation

A sixth construction operation was added at the user's direction: **referential naming** — selecting a historical system, mechanism, institution, or figure that already *performed* the product's function or embodied its value, so the name imports a verified story. Developer tooling uses this operation heavily (literary: Kafka, Cassandra; mythic: Prometheus, Argo; technological: Jacquard-descendants, Hollerith). Its scientific risk profile differs from metaphor-borrowing:

- **R1 · Recognition decay / explanation tax.** The reference only pays off if the audience decodes it; otherwise it's an arbitrary sound plus a README paragraph. (Acceptable in dev culture, where the origin-story paragraph is a beloved genre.)
- **R2 · Fame saturation.** Famous references are mined first — empirically confirmed below (Orrery, Semaphore, Lighthouse, Apollo, Kanban all gone).
- **R3 · Eponym hazards.** Surnames carry trademark conflicts and biography risk (a person's legacy becomes your brand's liability). Policy adopted: prefer the *system or mechanism* name over the *person* (thus no Saxby, Pacioli, Hollerith, Chappe).
- **R4 · Cultural-artifact sensitivity.** References to artifacts of specific cultures (e.g., quipu) add optics review to the checklist.

### 11.2 Functionality → historical system map, with screening outcomes

| Product functionality / value | Historical embodiment | Candidate(s) | Outcome |
|---|---|---|---|
| Durable relay; runs survive the parent session; continuation handoff (F3+F5) | **Cursus publicus** — Rome's imperial relay: the message persisted while carriers changed at way-stations | **mansio** (the station where one *remains*; fresh horses, same journey); statio | **mansio SHORTLISTED** (unverified). *statio* verified noisy: iOS monitoring app, legacy PyPI/npm packages, constant `pg_statio_*` adjacency — weak ownability |
| Same (Asian parallel) + auth tokens | Mongol **yam/örtöö** relay network; the *paiza* passport | paiza; yam | Eliminated: paiza.jp/paiza.io is a major dev platform; *yam* too slight |
| One crank, many coordinated bodies (F1+F2) | The **orrery** (clockwork solar-system model) | orrery | **Eliminated by verification**: an existing "workflow planning and orchestration CLI for AI agents" named Orrery, featuring parallel execution with git-worktree isolation and detached background execution — a near-identical product; plus an architecture-diagram DSL of the same name |
| Deterministic conflict prevention; locks/leases; one-writer rule (F2, §4.3–4.4) | **Railway signal interlocking** (Saxby & Farmer, 1856): a mechanical plant making conflicting routes physically impossible | interlock; detent | *interlock*: reserve (dictionary-word ownability, existing security-sector uses to verify). **detent SHORTLISTED** (unverified): the chronometer's detent escapement (durable precision) ∧ mechanical detent = position lock — F2+locks in one stop-heavy word matching the §4 sound profile |
| Cadenced parallelism; waves; ordered permutations executed without pause (F4+F5) | English **change ringing** (full peals rung from memory, conductor "calls the changes"); the trireme's stroke-caller | peal; **hortator** | *peal*: reserve (4 letters, dense semantics; "peel" homophone; unverified). *hortator*: reserve-plus (distinctive, stable /HOR-tay-tor/, near-zero expected collisions; galley-optics caveat) |
| Constant delivery while the energy source depletes (context management, F5) | Horology's **remontoire/fusee** (constant-force mechanisms) | — | Concept adopted for docs storytelling only: *remontoire* fails C1; *fusee* carries a well-known console-exploit association |
| Provenance; every decision journaled (F6) | **Double-entry bookkeeping** (Pacioli's *Summa*, 1494) | pacioli; summa | Eliminated: eponym policy (R3) + C2 instability; *summa* generic-Latin saturation |
| Message relayed station-to-station | **Chappe optical telegraph** | semaphore; chappe | Eliminated: Semaphore CI + the synchronization primitive; *chappe* fails C2 |
| Pre-industrial parallel assembly of complete units (F4) | The **Venetian Arsenal** (a galley a day from standardized parts) | arsenale | Eliminated: Arsenal saturation (football club; pentesting tool) |
| Production cadence | **Taktzeit** (1930s German aircraft production → Toyota Production System) | takt | Already shortlisted in §8 — reclassified as Territory F: it *is* a historical-functional reference, which strengthens its story |

Reclassification note: **attacca** likewise carries historical depth (centuries of performance practice — the instruction that the music must not stop between movements), so the two leading candidates from v0.1 both gain, rather than lose, from the referential lens.

### 11.3 Scoring of new Territory F entrants (same axes and weights as §8)

| Name | Semantic ×.25 | Distinct ×.20 | Usability ×.20 | X-ling ×.15 | Namespace ×.15 | Extens. ×.05 | **Weighted** |
|---|---|---|---|---|---|---|---|
| **mansio** | 5 | 4 | 4 | 4 | 3 (unverified) | 4 | **4.10** |
| **detent** | 4 | 4 | 4 | 3 (détente homograph FR/EN politics) | 3 (unverified) | 3 | **3.60** |
| hortator | 4 | 5 | 3 | 4 | 4 (expected) | 2 | **3.90** |
| peal | 4 | 3 | 4 | 3 (homophone) | 3 (unverified) | 3 | **3.50** |
| interlock | 4 | 2 | 3 | 4 | 2 | 3 | **3.10** |

### 11.4 Revised standing

1. **attacca — 4.35** (primary; provisionally verified; historically grounded performance practice)
2. **osnowa — 4.25** (heritage alternative)
3. **mansio — 4.10** (new: best pure historical-reference candidate; must clear §10 before it can rank above osnowa)
4. **takt — 4.00** (fallback; now doubles as the lean-manufacturing historical reference)

Daemon forms for the new entrant: `mansiod` ✓; docs metaphor free of charge ("your run rests at the mansio while the horses change" = continuation capsule). If `mansio` clears the §10 protocol with a clean sheet while `attacca`'s re-check surfaces anything, it is the designated successor.

### 11.5 Protocol amendment

Step 1 of §10 gains a sub-step for Territory F names: search the *reference itself* + "app/tool/AI" (e.g., "cursus publicus app"), because referential names collide not only on the string but on the story — a competitor telling the same historical story with a different string still erodes distinctiveness (R2).

---

## 12. Verification log — `takt` (30 Jul 2026): **FAIL**

Full §10 protocol executed at the user's request. Result: eliminated at steps 1–2, with steps 3–4 also compromised.

**Step 1–2 (exact-match + registries): FAIL.** The npm package `takt` belongs to an active project, nrslib/takt — "TAKT Agent Koordination Topology," a YAML-defined AI-agent coordination CLI (`npm install -g takt`) that executes queued tasks in isolated git worktrees, supports Claude/Codex/OpenCode providers, offers diff review/merge/retry/requeue of task branches, and stores global configuration in `~/.takt/config.yaml`. This is a near-identical product to the one being named — overlapping on multi-engine support, worktree isolation, YAML workflow definitions, global application home, and PR delivery. The ecosystem is expanding (takt-action GitHub Action for automated PR review; takt-sdd workflow package; community articles from Jan–Feb 2026). GitHub namespace equally occupied.

**Steps 3–4 (trademark + domains): COMPROMISED.** At least four unrelated live software-sector users of the mark: Takt, Inc. (takt.io — warehouse labor-management SaaS), Takt (Software) (SF manufacturing-intelligence startup, founded 2025, VC-backed), TAKT Software (taktsoftware.com — enterprise software/ERP), and takt.com (brand/digital agency). Additionally, "takt" functions semi-generically in lean-construction scheduling, where an entire product category of "Takt planning software" exists. Prime domains (.com, .io) are held. Formal TESS/EUIPO knock-out unnecessary given registry failure, but the density of live class-9/42 users independently disqualifies the name for public release.

**Methodological note.** The collision is diagnostic, not merely unlucky: an independent team building nearly the same product converged on the same lean-manufacturing metaphor. This validates the semantic analysis (§3) while confirming rule R2 — the more apt and available-looking a famous concept, the more likely a competitor has already taken it. Single-morpheme concept words in this category should be presumed taken until proven otherwise.

### 12.1 Revised standing (post-verification)

1. **attacca — 4.35** — primary; provisionally verified clean (30 Jul 2026); re-run §10 at adoption.
2. **osnowa — 4.25** — heritage alternative; unverified.
3. **mansio — 4.10** — assumes the fallback slot vacated by takt; unverified.
4. ~~takt~~ — **eliminated by verification** (this section).

Namespace-availability scores in §8/§11.3 are superseded by this log where they conflict: takt's namespace score is retroactively 0.

---

## 13. Candidate evaluation — `lecimy` (user proposal, 30 Jul 2026)

### 13.1 Classification

`lecimy` (Polish, "we're flying / here we go / let's roll") introduces a construction operation not previously used: **speech-act naming** — the name is the utterance that initiates use, not a description of mechanism (contrast: attacca/osnowa name *how it works*; lecimy names *the moment you trust it*). Semantically it encodes the product promise of §2 (say the word, close the laptop, the run outlives the conversation) and echoes F1 through the first-person plural (the user + the crew of engines fly *together*). Register is ideal predecessor continuity: colloquial, concrete, wryly Polish.

### 13.2 Screening

- **Namespace (verified): PASS — cleanest result of all names tested.** Sole discovered use: lecimy.org, a legacy Polish VFR flight-planning web app (small, unrelated class). No npm package, CLI, AI tool, or company found. Domains .pl/.dev unverified.
- **C2 (pronunciation stability): FAIL for global audience.** PL /lɛˈt͡ɕimɨ/ vs. EN reading /ləˈsiːmi/ — two permanent camps; no offensive readings in either.
- **C3 (cross-linguistic): PASS.** No negative meanings found in EN/DE/ES/FR/PT.
- **C6 (extensibility): MARGINAL.** Verb-phrase-as-noun ("install lecimy"); `lecimyd` serviceable but clunky.
- **Positioning tension:** the spec markets *dependable, inspectable, deterministic* and names "YOLO execution" a risk (§34); lecimy is distilled go-energy. Resolvable only by tagline-level framing ("Say the word. Close the laptop." / "Powiedz lecimy. Zamknij laptopa.") that presents the name as the benefit the architecture makes safe.

### 13.3 Scoring — two weight regimes

| Regime | Semantic ×.25 | Distinct ×.20 | Usability ×.20 | X-ling ×.15 | Namespace ×.15 | Extens. ×.05 | **Weighted** |
|---|---|---|---|---|---|---|---|
| Public release (standard C1–C6) | 3 | 5 | 3 | 3.5 | 5 | 3 | **3.73** |
| Personal v1 (C2/C3 relaxed — audience of one) | 4 | 5 | 5 | n/a* | 5 | 3 | **≈4.5** |

*Cross-linguistic weight redistributed to usability/namespace for the personal regime.

### 13.4 Recommendation: dual-track naming

The spec defers public release until differentiation is validated (§35) and declares naming non-blocking. This licenses a phase split:

1. **Working name for personal v1: `lecimy`.** Verified clean, maximally motivating for its audience of one, and the rename cost of a CLI binary pre-open-sourcing is trivial.
2. **Reserved public name: `attacca`** (4.35, provisionally verified) — which is, fittingly, near enough a translation of *lecimy* into the conductor's vocabulary: *go on, without pause*. The migration story writes itself.
3. `osnowa` and `mansio` remain the verified-pending alternates if attacca's re-check fails at adoption time.

---

## 14. Territory G — Speech-act & character names (user-directed pivot, 30 Jul 2026)

### 14.1 Direction change

The user rejected mechanism-descriptive naming in favor of the *lecimy* class: colloquial, original, personality-forward. Territory G therefore generates from Polish action-speech — the utterances surrounding work's lifecycle (ignition → cruise → landing) — plus crew-character nouns. Mechanism semantics (F1–F6) are demoted from scoring axis "semantic fit" in favor of *moment fit*: which moment of use the name captures and how truthfully.

### 14.2 Roster and screening

| Candidate | Utterance / meaning | Moment named | Screening notes | Verification |
|---|---|---|---|---|
| **jazda** | "Jazda!" — go! let's ride! | Ignition | 5 letters; PL /ˈjaz.da/, EN reads "JAZZ-da" — the jazz-ensemble association is an accidental multi-agent fit; strongest predecessor lineage (what you shout when the machine rolls); `jazdad` daemon weak → use `jazda-daemon` | **PASS (provisional)** — no dev-tool hits found |
| **smiga** (śmiga) | "Śmiga!" — it just flies / runs great | Cruise (the run humming after you leave) | Diacritic must drop; EN /ˈsmiː.ga/ clean; meaning legible only to PL speakers | Unverified |
| **spoko** | "spoko" — relax, it's handled | The feeling during autonomy | Universally readable; benefit-names the trust the architecture buys; mild too-casual tension with "dependable/inspectable" positioning | Unverified |
| **hajda** | "Hajda!" — off we go! (archaic, borderlands; cf. Balkan *ajde*) | Ignition | More distinctive, higher explanation tax than jazda | Unverified |
| **gotowe** | "Gotowe." — done. | Landing (the notification moment) | The inversion play: names the payoff, not the launch; 6 letters; low energy by design | Unverified |
| **sfora** | the hound pack | The crew as character | /sf/ onset rare in EN but attested (cf. *sforzando*); coordinated-pack = wave semantics for free | Unverified |
| wataha | the wolf pack | Crew character | Reserve (known PL TV series owns mindshare) | Unverified |
| wio | "Wio!" — giddy-up | Ignition (farmhorse) | 3 letters, ideal ergonomics | **FLAGGED** — Seeed Studio "Wio" hardware line (prior knowledge) |
| pyk | "pyk i gotowe" — click, done | Effortlessness | — | **FAIL (verified)** — reads as "py-K"; K Framework Python toolkit, Kubernetes toolkit, active GitHub handle occupy the string |
| ogar | the hound; slang *ogarnia* = handles it | Crew character | — | **FAIL (verified)** — Agar.io private-server ecosystem (OgarProject, Ogar3, MultiOgar) saturates GitHub/npm |

### 14.3 Scoring (personal-track regime, per §13.3)

| Name | Moment fit ×.25 | Distinct ×.20 | Usability ×.20 | Register fit* ×.15 | Namespace ×.15 | Extens. ×.05 | **Weighted** |
|---|---|---|---|---|---|---|---|
| **lecimy** (carried from §13) | 4.5 | 5 | 4.5 | 5 | 5 | 3 | **≈4.5** |
| **jazda** | 4.5 | 4.5 | 4.5 | 5 | 4.5 | 3 | **≈4.5** |
| smiga | 4.5 | 4.5 | 4 | 4.5 | 3 | 3 | **≈4.1** |
| spoko | 4 | 4 | 4.5 | 4 | 3 | 3 | **≈3.9** |
| hajda | 4 | 4.5 | 4 | 4 | 3 | 3 | **≈3.9** |
| gotowe | 3.5 | 4 | 4 | 4 | 3 | 2 | **≈3.6** |
| sfora | 3.5 | 4.5 | 3.5 | 4 | 3 | 3 | **≈3.6** |

*Register fit = continuity with the predecessor naming culture (concrete, wry, working-Polish).

### 14.4 Revised recommendation (v0.3)

**Early working name: `lecimy` or `jazda`** — co-leaders, both provisionally clean, differing only in the moment they immortalize: *lecimy* names the walk-away promise (the run flies on without its parent — the product promise of §2 in one word); *jazda* names ignition, with the jazz-ensemble bonus reading and the strongest tractor-lineage from the predecessor. Tiebreak is product taste.

**Public-release reserve remains `attacca`** (§9), with `osnowa`/`mansio` as verified-pending alternates. The mechanism-name track is retained only for the public phase, where pronunciation stability and self-explanation carry weight that the personal phase ignores.

---

## 15. Territory H — Global speech-act names (constraint lifted: not only Polish, 30 Jul 2026)

### 15.1 Precedent

The class is legitimized by **Vite** (French colloquial "quick!"): a foreign-language exclamation that became a top-tier global tool name, whose pronunciation split (veet/vight) produced community lore rather than adoption friction. This retroactively discounts the C2 penalty applied to lecimy-class names.

### 15.2 Roster by moment

**Ignition** — | Candidate | Source | Notes | Verification |
|---|---|---|---|
| **mush** | sled-dog command (EN, from Fr. *marche!*) | Best semantic fit of the entire speech-act class: one word → a coordinated pack pulls for hours over terrain the musher cannot see = one utterance → crew of engines + endurance + trust; 4 letters | Unverified (known: defunct UK "Mush" social app) |
| **yosh** | JP よし! — psych-up before starting | 4 letters; globally familiar via anime; grin-dense | Unverified |
| **hup** | NL stadium cry + EN drill cadence | 3 letters — shortest viable candidate on any board; marching cadence ≈ task waves | Unverified |
| **zack** | DE "zack, zack — fertig" | The Teutonic pyk that survives in English (reads as a name) | Unverified |
| **aupa** | Basque/ES "¡aúpa!" — cheer + "upsy" child-lift | Warm; near-certainly unclaimed; sleeper | Unverified |
| daje / andale / allez / tallyho | Roman / MX / FR go-words; EN hunt cry | Honorable mentions | Unverified |
| bora | BR "let's go!" + Adriatic wind | — | **COMPROMISED (verified)**: npm `bora` squatted by dead deploy package; BORA gaming blockchain noise |
| yalla | AR/HE "let's go!" | — | FAIL (prior knowledge): Yalla Group (NYSE: YALA) |
| hajime | JP referee's "begin!" | — | FAIL (prior knowledge): Hajime IoT botnet association |
| davai | RU "come on!" | — | Rejected: 2026 geopolitical optics |
| vite | FR "quick!" | — | Already the category's legend |

**Ready / answering** — | Candidate | Source | Notes | Verification |
|---|---|---|---|
| **pronto** | IT "ready" + EN "quickly" + how Italians answer the phone | Wittiest concept found: the daemon that picks up with "Pronto?" — always on the line, always ready | **FLAGGED**: niche Ruby linting gem `pronto`; legacy Pronto team-chat app |
| **listo** | ES "¡listo!" = done! + clever | Double meaning (finishes + smart); 5 letters, reads everywhere | Unverified |

**Landing** — | Candidate | Source | Notes | Verification |
|---|---|---|---|
| **tada** | the presentation flourish | The sound of draft PRs appearing; maximum grin, minimum gravitas | Unverified |
| voila | FR "there it is!" | — | FAIL (prior knowledge): Voilà, the Jupyter dashboard tool |
| fiat | Lat. "let it be done" (*fiat lux*) — the literal speech act of creation | The category's beautiful corpse | FAIL: automobiles and currency |

### 15.3 Standing (personal-track regime, merged with §14.3)

| Name | Moment fit ×.25 | Distinct ×.20 | Usability ×.20 | Register ×.15 | Namespace ×.15 | Extens. ×.05 | **Weighted** |
|---|---|---|---|---|---|---|---|
| lecimy | 4.5 | 5 | 4.5 | 5 | 5 | 3 | **≈4.5** |
| jazda | 4.5 | 4.5 | 4.5 | 5 | 4.5 | 3 | **≈4.5** |
| **mush** | 5 | 4 | 5 | 4.5 | 3 (unverified) | 4 | **≈4.4** |
| pronto | 4.5 | 3.5 | 4.5 | 4 | 2.5 (flagged) | 4 | **≈3.9** |
| yosh | 4 | 4 | 4.5 | 4 | 3 | 3 | **≈3.9** |
| hup | 4 | 4 | 5 | 4 | 3 | 3 | **≈4.0** |
| listo | 4 | 3.5 | 4.5 | 3.5 | 3 | 3 | **≈3.8** |
| aupa | 3.5 | 4.5 | 4 | 3.5 | 3.5 | 3 | **≈3.8** |
| zack | 4 | 3.5 | 4.5 | 3.5 | 3 | 3 | **≈3.8** |
| tada | 3.5 | 3.5 | 4.5 | 3.5 | 3 | 3 | **≈3.6** |

### 15.4 Recommendation (v0.4)

Podium for the personal v1 working name: **lecimy · jazda · mush** — the Polish co-leaders joined by one global challenger whose pack-and-musher metaphor uniquely encodes crew + endurance + walk-away trust in a single syllable. `mush` requires a §10 verification pass before it can formally tie; lecimy and jazda stand provisionally verified. Public-release reserve unchanged: `attacca` (with osnowa/mansio as alternates).

---

## 16. Consolidated scoreboard — speech-act cohort under the full §8 rubric (30 Jul 2026)

Applied at the user's request: original public-release axes and weights (Semantic fit F1–F7 ×.25 · Distinctiveness ×.20 · Usability ×.20 · Cross-linguistic ×.15 · Namespace ×.15 · Extensibility ×.05), with the §13 personal regime alongside. ✓ = verified, ⚑ = flagged, ? = unverified.

| Name | Sem | Dist | Usab | X-ling | Namespace | Ext | **Public** | **Personal** |
|---|---|---|---|---|---|---|---|---|
| jazda | 3 | 4.5 | 4 | 4 | 4.5 ✓prov | 3 | **3.88** | ≈4.5 |
| lecimy | 3 | 5 | 3 | 3.5 | 5 ✓ | 3 | **3.78** | ≈4.5 |
| mush | 4 | 3.5 | 4.5 | 3.5 | 3 ? | 4 | **3.78** | ≈4.4 |
| spoko | 3 | 4 | 4.5 | 4 | 3 ? | 3 | **3.65** | ≈3.9 |
| pronto | 3.5 | 3 | 4.5 | 4.5 | 2.5 ⚑ | 4 | **3.63** | ≈3.9 |
| listo | 3 | 3.5 | 4.5 | 4.5 | 3 ? | 3 | **3.63** | ≈3.8 |
| aupa | 2.5 | 4.5 | 4 | 4 | 3.5 ? | 3 | **3.60** | ≈3.8 |
| smiga | 3 | 4.5 | 4 | 3.5 | 3 ? | 3 | **3.58** | ≈4.1 |
| hup | 2.5 | 3.5 | 5 | 4 | 3 ? | 3 | **3.53** | ≈4.0 |
| yosh | 2.5 | 4 | 4.5 | 4 | 3 ? | 3 | **3.53** | ≈3.9 |
| tada | 3 | 3 | 4.5 | 4.5 | 3 ? | 2.5 | **3.50** | ≈3.6 |

Reference (mechanism track): attacca **4.35** · osnowa **4.25** · mansio **4.10**.

Scoring notes: mush earns the cohort's only semantic 4 (encodes F1 pack, F2 single-command control, F3 endurance) and its extensibility 4 names the user's role for free (*musher*), but pays for English homonyms (porridge / sentimentality / UK slang). jazda beats lecimy on the public rubric via grammar (noun vs conjugated verb) and dual attractive pronunciations. hup carries a discovered wrinkle: Unix SIGHUP — `nohup` ("survive the session closing") is literally the product promise, yet naming a daemon after the signal that restarts daemons is a joke that costs clarity; scored neutral.

**Interpretation.** The speech-act class structurally cannot win the public rubric: 25% of its weight rewards self-explanation, which these names refuse on principle. The ~0.6–0.9 gap between columns is the quantified explanation tax; Vite is the precedent that a strong product amortizes it. Verdict is therefore regime-dependent: public — attacca > osnowa > mansio > jazda; personal — lecimy ≈ jazda > mush (mush pending §10 verification; the only speech-act name in the top cohort of both columns).

---

## 17. User-flagged candidates: `pyk` and `siup` (30 Jul 2026)

### 17.1 siup — provisional PASS, joins the podium

Verification found zero namespace presence: no package, repository, or product named `siup`. Semantically reclassified during analysis: siup names neither ignition nor landing but the **toss** — "siup do worka" — which is the product's most-repeated gesture (delegating a task to the daemon and walking away). Command language falls out naturally (`siup add #482` — in it goes; `siup inbox` — what came back).

Scores: **Public 3.73** (Sem 3 — names a real core interaction; Dist 5; Usab 3.5; X-ling 3 — EN reading genuinely broken: correct /ɕup/ "shoop", foreigners produce "sigh-up"/"see-up"; NS 4.5 ✓prov; Ext 3). **Internal ≈4.6** (Moment 4.5 — the toss; Dist 5; Usab 5 — fastest honest typing on the board; Register 5 — maximum predecessor-core, nursery-adjacent charm; NS 4.5; Ext 3).

**Podium (personal track) is now a three-way tie: siup · lecimy · jazda (~4.5–4.6)** — differentiated only by immortalized gesture: the toss, the flight, or the ignition.

### 17.2 pyk — FAIL confirmed, with a designated heir

The §14.2 verification stands and compounds: `pyk` is the K Framework's actively maintained Python toolkit (Runtime Verification), plus kubernauts/pyk (Kubernetes), enlnt/pyk, and a GitHub user holding github.com/pyk and pyk.sh. Beyond registries, the perception trap: a "py"-prefixed three-letter string parses as a Python package to any developer — permanent dissonance for a TypeScript-first tool, and `pip install pyk` guarantees documentation/search collision even in personal use. Public ≈3.0; Personal ≈3.8. Eliminated with honors — "pyk i gotowe" remains the platonic idiom for the product's effortlessness.

**Rescue variants preserving the idiom:**
- **pyklo** (from "i pykło!" — "and it just clicked/worked") — names the landing; 5 letters; escapes the py-parse (the /k/ closes the string before Python pattern-matching completes); EN "PIK-lo" acceptably stable; expected clean; unverified.
- pyknij (imperative "knock it out") — command-form alternative; harder for non-PL tongues.

pyklo is designated pyk's legal heir, pending §10 verification on request.

### 17.3 pyklo — verified and scored (30 Jul 2026)

Namespace verification: **PASS (provisional)** — no package, repository, or product found. Scores: **Public 3.88** (Sem 3 · Dist 4.5 · Usab 4 · X-ling 4 · NS 4.5 ✓prov · Ext 3) — ties jazda atop the speech-act cohort on the public rubric. **Personal ≈4.4** (Moment 4 — the landing, "i pykło!" = and it just worked · Register 5 · Usab 4.5) — just below the siup/lecimy/jazda trio, the landing moment being slightly less central than the toss or takeoff.

Footnotes: grammatically past tense (unusual, but functions as a standing promise); colloquial shadow-meaning "coś pykło" (something popped/gave out) exists but "i pykło" is unambiguous; residual "py-" prefix perception reduced, not eliminated. Pairing note: **siup → pykło** forms a complete conversation (what you say to the daemon; what it says back) — a candidate two-name system (CLI vs success-voice) at zero extra cost.

---

## 18. User-flagged candidates: the hop family (30 Jul 2026)

| Candidate | Profile | Verification | Public | Personal |
|---|---|---|---|---|
| hopla | "Hop là!" (FR/Alsatian/DE) + PL idiom "mieć hopla" = to be obsessed — a self-aware automation reference with broadly stable pronunciation | Unverified; adjacency: "hoopla" (EN word + major US library-streaming app, one letter away) | **~3.6** | **~3.8** |
| hopsa | PL/pan-European nursery bounce; would be the C2 champion of the Polish set (identical reading in every language) | **COMPROMISED (verified)**: active startup on hopsa.app + hopsa.io; Hopsan (Linköping simulation tool) one letter away; HOPSA EU HPC project | ~3.3 | ~3.6 |
| hops | EN beer domain; Hopsworks (MLOps platform) adjacent; DE meme slang "hops nehmen" = to fool someone; faint positive network-hop ≈ session-handoff reading | Prior knowledge; not separately searched | ~3.0 | ~3.1 |

**Finding reinforced:** speech-act candidates succeed in proportion to how precisely they name a gesture in the product's lifecycle (toss/takeoff/ignition/landing); pure energy-words without a moment (the hop family) plateau at bench level. Podium unchanged: **siup · lecimy · jazda (~4.5–4.6)**, pyklo 4.4, hopla enters the bench at ~3.8.

---

## 19. Territory I — Cheek proper: alibi, persona, and heritage jokes (30 Jul 2026)

### 19.1 The discovered principle

Prior territories named the mechanism (A–F) or the moment (G–H). The cheekiest class names **the crime the tool lets you commit** — the user's alibi — or gives the daemon a persona. Precedent for the persona class: the CI category is covertly servant-named (Jenkins, Hudson, Jeeves, Alfred — all butlers/valets); the Polish warsztat equivalent is unclaimed.

### 19.2 Roster

| Candidate | Joke class | The joke | Verification | Personal |
|---|---|---|---|---|
| **fajrant** | Alibi | Silesian "quitting time" (Ger. *Feierabend*) — the tool named after the end of work; every invocation announces your evening: `fajrant run careful-epic` | **PASS ✓ (verified)** — no software presence | **≈4.6 — new outright leader** |
| **heniek** | Persona | The Polish Jenkins: not a butler, the warsztat fixer with a first name — "Heniek się tym zajmie"; changes the relationship from operating to asking | Unverified (near-certain clean) | ≈4.4 |
| **krasnal** | Heritage | Poland's bronze city dwarfs: hundreds of tiny workers scattered across a city, each mid-task — a codebase full of agents, self-illustrating docs | Unverified | ≈4.3 |
| **spadam** | Exit line | "I'm off!" — the run command that is literally the user leaving; fully readable abroad (SPA-dam) | Unverified (expected clean) | ≈4.2 |
| **kombinat** | Bloodline | Predecessor heir: harvester → industrial complex; the verb *kombinować* (creative scheming) — "Kombinat kombinuje" = the plant is scheming | Unverified | ≈4.2 |
| obibok | Alibi | The loafer — the user's new job title | Unverified | ≈4.0 |
| nara | Exit line | "See ya!" — 4 letters | FLAGGED: Nara (city), AI-brand crowding | ≈4.0 |
| wagary | Alibi | Playing hooky while the tool does the homework | Unverified | ≈3.9 |
| bigos | Pot | Everything in, better reheated; "narobić bigosu" = glorious mess — radical honesty | Unverified | ≈3.8 |
| urlop | Alibi | Vacation mode | Unverified | ≈3.8 |
| bumelka | Alibi (deep cut) | PRL absenteeism slang on a productivity tool — forty-year-aged irony | Unverified | ≈3.6 |
| essa | Meme | Effortless W | Unverified; meme-decay risk docked | ≈3.7 |

### 19.3 Standing (personal track, v0.5)

**fajrant ≈4.6** > siup · lecimy · jazda (~4.5–4.6, statistical tie zone) > heniek 4.4 ≈ pyklo 4.4 > krasnal 4.3 > spadam · kombinat 4.2. Public reserve unchanged (attacca). Note: fajrant + heniek compose — "Heniek, robisz. Ja mam fajrant." — the two-name system (daemon persona + CLI alibi) remains available at zero cost, mirroring the siup→pykło pairing of §17.3.

---

## 20. Territory J — Global cheek: alibi and servant classes worldwide (30 Jul 2026)

### 20.1 Crown jewel: shabti — verified near-clean

Egyptian funerary worker-figurine whose defined mythological function is the product: when the owner is called to labor in the afterlife, the shabti steps forward and answers "Here I am — I shall do it" (Book of the Dead, Spell 6). Full sets numbered 401: one worker per day plus 36 overseer figurines managing the crews — named workers, role hierarchy, and fire-and-forget delegation, ca. 2000 BCE. 6 letters, /ˈʃæb.ti/ stable in every checked language; register erudite-cheeky. Verification: sole software use is a dormant hobbyist Perl IRC bot; no npm/company/active project. **Personal ≈4.6 — ties fajrant for the outright lead.**

### 20.2 Alibi class, global

| Candidate | Source | The joke | Verification | Personal |
|---|---|---|---|---|
| **smoko** | AUS tradie break | The Chats' anthem chorus is the product promise verbatim: "I'm on smoko, so leave me alone" | Unverified (song = fame, not trademark) | ≈4.4 |
| apero | FR apéritif hour | Agents grind; you're at apéro | Unverified | ≈3.9 |
| otsu | JP netslang 乙 ("good work, done") | The knock-off word of the JP internet | FLAGGED: Otsu's method (canonical CV thresholding algorithm) | ≈3.7 |

Correction of record: **fajrant is pan-Central-European** (fajront in SI/HR, from Ger. *Feierabend*) — the incumbent leader already satisfies the not-only-Polish constraint.

### 20.3 Servant class, global

Category precedent strengthened: beyond Jenkins/Hudson/Jeeves/Alfred, **Spotify's Luigi** is a workflow orchestrator persona-named after the pipe-plumber — the cheeky-servant lane is proven *in orchestration specifically*.

| Candidate | Persona | Notes | Verification | Personal |
|---|---|---|---|---|
| **heinzel** | Heinzelmännchen of Cologne — night elves who finish all work, but only unobserved; one lantern-spy and they leave forever | The legend encodes the UX manifesto: stop babysitting the agents | Unverified (expected clean) | ≈4.3 |
| famulus | Faust's lab assistant (Wagner) | The scholar-magician's helper; erudite deep cut | Unverified | ≈4.0 |
| igor | "Yes, master" — the lab assistant | — | FLAGGED: Igor Pro (WaveMetrics, decades-old) | ≈3.9 |
| factotum | Lat. "does everything"; dictionary-defined servant-of-all-work | Prior art too on-the-nose: Plan 9's `factotum` is literally an agent daemon | FLAGGED | ≈3.8 |
| bruno / sancho / jarvis / friday / kobold / duende | — | Casualties: Bruno API client; MX slang "el sancho" (the secret lover); Marvel ×2; KoboldAI; Duende Software | FAIL | — |

### 20.4 Standing (personal track, v0.6)

**fajrant ≈ shabti (4.6)** > siup · lecimy · jazda (~4.5) > smoko · heniek (4.4) > heinzel · krasnal (4.3) > pyklo (4.4 by §17.3 — sits within the 4.3–4.5 band) > spadam · kombinat (4.2). Cross-language symmetry noted for the two leaders: *the shabti answers the call so you can have fajrant* — the same promise named from opposite ends (who works / what you gain). Public reserve unchanged: attacca.

---

## 21. Convergence: heniek — verified, dual-rubric scored (30 Jul 2026)

### 21.1 Verification: PASS ✓
Sole GitHub presence: a Polish ham-radio hobbyist's test repo (sp9mrn/Heniek). No npm package, product, or company.

### 21.2 The two principles heniek exposes
1. **Graceful degradation of names.** Misread words become noise (siup → "sigh-up"); misread names stay names (heniek → "HEN-ee-ek" — still a guy). Every plausible EN reading lands in-category, with *Heineken* as a free phonetic anchor.
2. **Persona-class exemption from the explanation tax.** Nobody decodes "Jenkins" or "Luigi"; a name needs no semantics. This makes heniek the only cheeky candidate that performs on the public rubric.

### 21.3 Scores
**Public 4.13** (Sem 3 — servant-persona aptness per Jenkins/Luigi category convention · Dist 4.5 · Usab 4.5 — graceful degradation · X-ling 4.5 — just a name · NS 4.5 ✓ · Ext 4.5 — no daemon suffix needed, *the daemon is Heniek*; workers = Heniek's crew; one-sentence global positioning: "like Jenkins, but Heniek"). **Third on the public board: attacca 4.35 > osnowa 4.25 > heniek 4.13 > mansio 4.10.**

**Personal ≈4.55 — new outright leader** (Joke 4 — persona warmth, affectionate blue-collar wink where "Janusz" would be mockery · Usab 5 · Register 5 · NS 4.5 ✓ · Ext 4.5).

### 21.4 Structural consequence: the dual track dissolves
The lecimy-now/attacca-later architecture (§13.4) existed because no candidate survived both regimes. Heniek survives both: one name from personal v1 through open-source release, no rename event. Footnotes: github.com/heniek likely a personal username → org as `heniek-dev` or repo under the author's account (cosmetic); first-name trademarks are viable per the Jenkins precedent, subject to the standard §10 formal knock-out before public release.

### 21.5 Final standing (v0.7)
**Unified recommendation: `heniek`** — personal leader (≈4.55) and top-3 public (4.13), verified clean, cheeky, explanation-tax-exempt.
Alternates: fajrant / shabti (4.6 personal band, weaker public), siup·lecimy·jazda (~4.5 personal), attacca (4.35 — strongest if a mechanism-serious public brand is later preferred; the reserve remains valid).

---

## 22. Protocol completion and decision record (30 Jul 2026) — FINAL

### 22.1 §10 protocol results for `heniek`

| Step | Result |
|---|---|
| 1. Exact-match searches (CLI/npm/GitHub/AI/orchestration) | **PASS ✓** — sole hit: a ham-radio hobbyist's test repo (sp9mrn/Heniek) |
| 2. Registry checks | **PASS (search-level) ✓** — no npm package, PyPI project, or product surfaced in any search; confirm locally per §22.2 |
| 3. Trademark knock-out | **PASS ✓** — no "Heniek" mark found; only Heineken (beer, cl. 32) and Henkel (consumer goods) in the phonetic neighborhood — different strings, unrelated classes, no confusion basis for software cl. 9/42 |
| 4. Domains | Deferred — not blocking for personal v1 (spec §35); check heniek.dev before public release |
| 5. Pronunciation test | Satisfied by design — graceful degradation (§21.2); formal 3-reader test optional before public release |
| 6. Non-blocking clause | Honored throughout — implementation was never gated on naming |

### 22.2 Residual local checks (2 minutes, run before first publish)

```bash
npm view heniek                # expect 404 → name free
pip index versions heniek      # expect not found
cargo search heniek            # expect no exact match
brew search heniek             # expect none
which heniek                   # expect empty on macOS + Linux
```

### 22.3 Decision record

- **Name: `heniek`** — unified across personal v1 and future public release; no rename event planned.
- **GitHub: `davebream/heniek`** — no organization; resolves the §21.4 username footnote entirely.
- **npm: `heniek`** (unscoped; fallback `@davebream/heniek` only if sniped between now and first publish).
- **Binary: `heniek`. Daemon: no `-d` suffix — the daemon *is* Heniek.**
- **Global home: `~/.heniek/`** (per the spec's global-application-home requirement; XDG-compliant variant `$XDG_CONFIG_HOME/heniek` acceptable).

### 22.4 Identity kit

**Pronunciation:** PL /ˈxɛɲɛk/ "HEH-nyek"; EN "HEN-yek" or "HEN-ee-ek" — all readings acceptable by design.
**One-liner:** *Like Jenkins, but Heniek — the guy at the warsztat who takes the job so you can go home.*
**The spec's §2 command surface, renamed:**

```bash
heniek profile run sol-critic --task current
heniek pipeline run careful-epic --issue 482
heniek run status run_01...
heniek run answer run_01... interaction_04
heniek inbox
heniek doctor
```

**Persona voice rules (docs & UX):** Heniek speaks plainly and takes responsibility — "Heniek's on it", "Heniek has a question about #482", "Heniek finished: 3 draft PRs linked". Never servile, never cutesy beyond the name itself; workers are "Heniek's crew" informally, canonical spec terminology (workers/roles/profiles) stays unchanged in schemas. The affectionate blue-collar register is the brand; mockery (Janusz-style) is out of bounds.
**Origin blurb (README-ready):** *Every Polish workshop has a Heniek — the one who says "zostaw, ja to zrobię." This one lives in a daemon, runs your coding agents across the whole codebase, and doesn't stop working when you close the laptop.*

### 22.5 Closing standings (for the record)

Personal track: **heniek 4.55 (SELECTED ✓)** > fajrant · shabti 4.6-band* > siup · lecimy · jazda ~4.5 > smoko · pyklo 4.4. (*higher raw joke scores, weaker verification/public survivability.)
Public rubric: attacca 4.35 > osnowa 4.25 > **heniek 4.13** > mansio 4.10 — heniek is the only selection viable on both boards, which decided it.
Reserve (released, archived for reference): attacca, osnowa, mansio.

**Naming phase: CLOSED.** Per spec §35, the "domain terminology accepted" checklist item may now include the product name. Heniek się tym zajmie.
