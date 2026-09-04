# Handover — World Engine phase 1

What shipped, what it was tested with, and how to check it by hand.

Every command below was **executed against the live install** before this
document was written, and a script re-runs them all on demand (§6). A manual
test nobody ran is a list of typos.

---

## 1. What shipped

Six commits, `57bbfad..0afab86` — 56 files, +4601 / −62.

| Commit | What |
|---|---|
| `60263a0` | `world` becomes a capability — and a capability is twelve registries |
| `c3bb36f` | Audit of the spec against the codebase, then the plan |
| `3d5ab0b` | The acceptance contract: 102 test cases, before any code |
| `e557dbb` | Phase 1 backend: the world exists, is versioned, and knows it has no scale |
| `7101dc0` | The suite gives a stable answer, and five real bugs it was hiding |
| `0afab86` | A provider's response is untrusted input, and so are the URLs in it |

### New surface

- **1 migration** (102) — `film_worlds`, `film_world_versions`,
  `film_world_assets`, `film_world_sources`, plus `world_version_id` and
  `world_pinned_at` on `film_previs_blocking`
- **5 modules** — `lib/worlds.js`, `lib/world-scale.js`, `lib/world-assets.js`,
  `routes/worlds.js`, and the `worldlabs` adapter completed
- **17 HTTP routes**, dispatched before the project and shot catch-alls
- **10 MCP tools** (251 total) — only `world_generate` spends
- **6 feature flags**, all defaulting **off**

### Bugs fixed along the way

Five were found by the suite rather than by the feature work:

1. **A derived music cue claimed a director's allowance.** `authored` meant "has
   a description", and `cueFromBrief` derives one — so every derived cue took the
   4000-character written budget and shipped a whole scene of camera blocking to
   a music model. Provenance is declared now, not inferred.
2. **Declining to replace a character plate destroyed it.** The orbit cut frames
   with `ffmpeg -y` straight onto the plate's own filename, so an approved
   plate's pixels were gone *before* the decision was made, and the decline path
   then unlinked the file. Cuts go to a scratch path now.
3. **Character plates were never fingerprinted** — a rewritten appearance could
   never mark the turnaround cut from the old description as behind.
4. **`video_draft` had no control** — a setting deciding whether every clip
   generates at the draft floor was settable only by curl.
5. **`fromCard` discarded its own azimuth solve**, so seeding always faced one way.

And two security issues in code shipped this session (§5).

---

## 2. Test results

```
npm test   (= node --test --test-concurrency=4 backend/tests/*.test.js)

  tests   3250
  suites  197
  pass    3250
  fail    0
```

**`--test-concurrency=4` is not optional on a many-core machine.** The default is
one worker per core (48 here), which spawns dozens of API servers and
synchronous ffmpeg processes at once; a blocked server's event loop stalls long
enough for the TCP backlog to reset an in-flight poll, and the suite then
reports four to twenty failures **in different files each run** — accusing code
that passes perfectly in isolation. Capped, it is deterministic and costs
nothing: 87s against 83s.

Also fixed to get there: retry backoff is overridable (one file went 77s → 2.7s
of real sleeping), and ten test files drew random ports from **overlapping**
ranges — now disjoint, with a derived guard that immediately found a pair the
first scan had missed.

---

## 3. Manual testing — the free path

Nothing here spends. Every command was run against the live install.

**Setup.** Start the API against your data profile:

```bash
cd /Users/mannyhenri/code/film-engine
export WORLDLABS_API_KEY=$(grep -o 'WORLDLABS_API_KEY=[^ ]*' ~/.zshrc | head -1 | cut -d= -f2- | tr -d '"'"'"'')

# Idempotent: only start one if the port is free, so re-running this document
# does not fight the server you already have.
if ! lsof -ti tcp:3100 > /dev/null 2>&1; then
  FILM_DATA_DIR=~/gridlight-profiles/rescue/dot-gridlight/film-engine/data node backend/server.js &
  sleep 4
fi
export A=http://localhost:3100/film
curl -s http://localhost:3100/api/health
```

**Pick a project and a shot.**

```bash
export PID=$(curl -s $A/projects | python3 -c "import json,sys;d=json.load(sys.stdin);ps=d if isinstance(d,list) else d['projects'];print([p for p in ps if 'Wingfall' in (p.get('title') or '')][0]['id'])")
export SID=$(curl -s $A/projects/$PID/shotlist | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('shots') or d)[0]['id'])")
echo "project $PID / shot $SID"
```

### 3.1 The flags are off

```bash
curl -s $A/settings | python3 -c "import json,sys;d=json.load(sys.stdin);v=d.get('settings',d);print('world_engine =',v.get('world_engine'),'| world_splats =',v.get('world_splats'))"
```
Expect `world_engine = False | world_splats = False`. **With every flag off the
app is byte-identical to the one you were running before** — that is what makes
this shippable in phases.

### 3.2 A world is created, listed and read

```bash
export WID=$(curl -s -X POST $A/projects/$PID/worlds -H 'Content-Type: application/json' -d '{"name":"Maple Street","description":"the cul-de-sac"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['world']['id'])")
curl -s $A/projects/$PID/worlds | python3 -c "import json,sys;print(len(json.load(sys.stdin)['worlds']),'world(s)')"
curl -s $A/worlds/$WID | python3 -c "import json,sys;w=json.load(sys.stdin)['world'];print(w['name'],'| locked =',w['locked'],'| versions =',w['version_count'])"
```

### 3.3 Versions accumulate; they are never overwritten

```bash
export V1=$(curl -s -X POST $A/worlds/$WID/versions -H 'Content-Type: application/json' -d '{"reason":"Storyboard generated","model":"marble-1.0-draft"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['version']['id'])")
curl -s -X POST $A/worlds/$WID/versions -H 'Content-Type: application/json' -d "{\"reason\":\"Added reverse angle\",\"parent_version_id\":\"$V1\"}" > /dev/null
curl -s $A/worlds/$WID/versions | python3 -c "import json,sys;vs=json.load(sys.stdin)['versions'];print('versions',[v['version'] for v in vs],'| scale:',vs[0]['scale_state'])"
```
Expect `versions [1, 2] | scale: APPROXIMATE SCALE`.

An unknown model is refused **locally**, naming the legal set — a typo should
not cost a round trip and come back as something that reads like a credential
problem:

```bash
curl -s -X POST $A/worlds/$WID/versions -H 'Content-Type: application/json' -d '{"model":"marble-9"}'
```

### 3.4 What a world costs, before spending anything

```bash
curl -s "$A/world-versions/$V1/plan?model=marble-1.1" | python3 -c "import json,sys;d=json.load(sys.stdin);print('credits =',d['credits'],'| free =',d['free'])"
```
Expect `credits = 1600 | free = True`. The plan is priced from the same table
the run bills from, so this number is the number charged.

### 3.5 Scale — the one that matters

A reconstruction has no unit until you measure something in it. Give it one
known height:

```bash
curl -s -X POST $A/world-versions/$V1/calibrate -H 'Content-Type: application/json' -d '{"source":"character_height","known_meters":1.68,"measured_units":2.042}' | python3 -c "import json,sys;v=json.load(sys.stdin)['version'];print('factor = %.4f'%v['scale_factor'],'|',v['scale_state'])"
```
Expect `factor = 0.8227 | SCALE CALIBRATED`.

A degenerate measurement is **refused, never clamped** — a division by zero
becomes `Infinity` metres and every distance on the screen is then nonsense:

```bash
curl -s -X POST $A/world-versions/$V1/calibrate -H 'Content-Type: application/json' -d '{"source":"custom","known_meters":1.68,"measured_units":0}'
```

### 3.6 Geometry says why it cannot answer

```bash
curl -s $A/world-versions/$V1/geometry | head -c 130; echo
```
Expect `NO_COLLIDER` with a sentence, not a stack trace — this version has not
been generated yet, so there is nothing to measure.

### 3.7 A lock refuses the destructive set and nothing else

```bash
curl -s -X POST $A/worlds/$WID/lock > /dev/null
curl -s -o /dev/null -w "new version while locked: %{http_code}\n" -X POST $A/worlds/$WID/versions -H 'Content-Type: application/json' -d '{"reason":"x"}'
curl -s -o /dev/null -w "pin a shot while locked:  %{http_code}\n" -X POST $A/shots/$SID/world -H 'Content-Type: application/json' -d "{\"world_version_id\":\"$V1\"}"
curl -s -X DELETE $A/worlds/$WID/lock > /dev/null
```
Expect **423** then **200**. A lock that froze the work is one nobody switches on.

### 3.8 A newer version never migrates a pinned shot

```bash
curl -s $A/shots/$SID/world | python3 -c "import json,sys;d=json.load(sys.stdin);print('pinned to v'+str(d['version']),'| newer available: v'+str(d['newer_version']))"
```
Expect `pinned to v1 | newer available: v2`. You are **told**; nothing moves.

### 3.9 Deleting a world keeps the blocking authored inside it

```bash
DB=~/gridlight-profiles/rescue/dot-gridlight/film-engine/data/film-engine.db
echo "blocking rows before: $(sqlite3 $DB "select count(*) from film_previs_blocking where shot_id='$SID'")"
curl -s -o /dev/null -X DELETE $A/worlds/$WID
echo "blocking rows after:  $(sqlite3 $DB "select count(*) from film_previs_blocking where shot_id='$SID'")"
echo "pin now:              $(sqlite3 $DB "select coalesce(world_version_id,'NULL') from film_previs_blocking where shot_id='$SID'")"
```
Expect the row count unchanged and the pin `NULL`. Deleting a set must not take
the camera work staged inside it.

### 3.10 The agent surface

```bash
cd /Users/mannyhenri/code/film-engine && node -e "
const {listTools}=require('./backend/lib/mcp-tools');
const n=listTools().map(t=>t.name).filter(x=>x.startsWith('world_'));
console.log('world tools ('+n.length+'):', n.join(', '));
console.log('total tools:', listTools().length);"
```
Expect **10** world tools of **251**. In Claude Desktop, *"create a spatial world
for the cul-de-sac and tell me what generating it would cost"* drives
`world_create` then `world_plan` without naming either.

---

## 4. Manual testing — the paid path

**Not run for you.** One draft world is **250 credits ≈ $0.20** and takes about
40 seconds. Read the plan first; it quotes what the run will bill.

```bash
# Plates for a location become the world. Several views reconstruct far better
# than one: up to four are used, each with its compass bearing.
curl -s -X POST $A/world-versions/$V1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a residential cul-de-sac on an overcast morning"}'
```

Then the geometry that was refused in §3.6 answers:

```bash
curl -s "$A/world-versions/$V1/geometry?budget=20000" | python3 -c "import json,sys;d=json.load(sys.stdin);print('triangles',len(d['triangles']),'of',d['triangles_total'],'| size',[round(n,1) for n in d['size']],'| scale',d['scale'])"
```

Reference numbers from the world already generated this session
(`06be9e1f-9c68-4717-84d5-95395597a7c5`, 250 credits, 37 seconds): collider
**28,717 vertices / 53,841 triangles**, extent **39.6 × 9.0 × 47.9**, decimating
cleanly to the stage's 20,000 budget. The panorama is equirectangular
**2304 × 1152**, exactly 2:1.

If the call is abandoned part-way it returns **202 pending** with an operation
id rather than failing — the world is collectable, not lost.

---

## 5. Security

Two issues were found in code shipped this session, both fixed and
mutation-proven:

- **SSRF, the read-and-exfiltrate kind.** Asset URLs arrive in a provider
  response, are fetched by this server, and stored where
  `/film/worlds/media/...` serves them back. Nothing checked scheme or host, so
  a spoofed response pointing at `169.254.169.254` would have turned cloud
  credentials into a file the API hands out. Now https-only, non-public hosts
  refused by literal, redirects refused. Residual, stated: a hostname that
  *resolves* to a private address is not caught.
- **Unbounded download**, now capped at 64 MB — above `full_res` (25 MB
  measured), below anything that OOMs.

Clean elsewhere: no secret in any commit, every new query parameterised, path
traversal on the media route refused across seven encodings, `npm audit` reports
0 vulnerabilities against 2 production dependencies.

**One pre-existing exposure worth your decision.** The API binds **all
interfaces**, unauthenticated, `Access-Control-Allow-Origin: *` — verified by
observation (`node *:3100`, while the page server correctly binds `127.0.0.1`).
That is a deliberate decision the LAN/mobile work depends on, and I did not
change it. But this work put a **spending** endpoint on that surface: anyone who
can reach the machine can run up a World Labs bill. Either bind loopback by
default with a `FILM_ENGINE_HOST` opt-in exactly as `dev-server.js` already
does, or put a shared token on the spending routes.

---

## 6. Re-running this document

Every command above is extracted and executed by:

```bash
node backend/tests/handover-commands.js
```

It fails if any command in this file stops working — so the document cannot rot
into a list of things that used to be true.

---

## 7. What is not built

Phase 1 is the backend. Named rather than implied:

| | |
|---|---|
| Phase 2 | The console behind `WORLD_ENGINE` — camera view, 11 overlays, lens/operate/blocking |
| Phase 3 | Direct the Shot, Explore Shot ×6, 180° axis — all as MCP brief/propose pairs |
| Phase 4 | The timeline UI over the existing legs/keys model |
| Phase 5 | Generation plate → the image and video bridge |
| Phase 6 | Match Reference (manual-assist only), shot complexity, export |

**Splats are deliberately behind `WORLD_SPLATS` and not rendered.** Spark ships
no UMD build and needs three ≥ 0.180, which ships no UMD either — while this
page loads six classic scripts with r149 inlined. The collider carries every
cinematographic quantity, so phase 1 does not need them. Two no-bundler routes
stay open and named in `audit.md` §4.

### Two defects carried forward

Both found this session, both real, both deliberately not fixed in the step that
found them:

1. **The client `previsProject` has no near-vertical up-reference fallback**,
   though the server's `basis()` and the client's own inverse both carry it. A
   top-down camera degenerates on the client only — and phase 2 adds a TOP view
   preset that walks straight into it.
2. **The pipeline runs ffmpeg through `execFileSync` inside the HTTP server**,
   blocking the event loop for the length of an encode. In production a conform
   or stitch freezes every other request; here it only surfaced as a test flake.

---

## 8. Rollback

Nothing in phase 1 is reachable with the flags off, so the first option is
usually enough.

1. **Turn it off** — set the six flags false in Settings. No code change.
2. **Revert the code** — `git revert e557dbb 0afab86`. Migration 102 is additive
   and its two columns are nullable, so an un-reverted database is harmless: the
   tables simply stop being read.
3. **The migration is not reverted**, deliberately. Dropping tables that may
   hold generated worlds — which cost money and cannot be re-fetched, because
   `GET /marble/v1/worlds` is a 404 — is worse than leaving four unused tables.
