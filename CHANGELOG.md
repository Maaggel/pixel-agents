# Changelog

## v1.34.3

- Proof of the above: a version-only deploy ends the tablet streams so they re-read the build, without the relay restarting.

## v1.34.2

- The tablet's version line was stuck at whatever was live when it connected: the build is sent in the headers that open the stream, and since deploys stopped restarting the relay that connection is never dropped. The relay now ends the streams when the version changes, so they reconnect and re-read it. The relay itself stays up, so it is a blink rather than the minute a restart costs.

## v1.34.1

- **A door sign flashed "free" while the toilet was in use.** Rebuilding the furniture instances - which happens whenever a door opens, a lamp turns on or somebody sits down at a desk - gave every item a fresh instance with no state sprite, and until the next tick set it again the renderer fell back to the item's *base* sprite. For a sign that base is the vacant green one, so it showed free at exactly the moment it mattered. State sprites are now carried across the rebuild. Measured against the live office: 12 wrong ticks out of 1575 with somebody on the toilet before, 0 out of 3001 after.
- The same blip applied to clocks, load gauges and thirsty plants; nobody noticed because their base frame looks near enough to their current one. A sign's does not.

## v1.34.0

- **Two agents could be given the same seat, and it was a release-before-check.** `reassignToWeightedIdleZoneSeat` freed the character's current seat *before* checking the new one was still free, and on that early return the character carried on sitting where they were with their seat marked free - so the next thing to hand seats out, a meeting, gave it to somebody who came and sat on top of them. `reassignSeat` had the same shape. Both secure the new seat before letting go of the old.
- **A booked room is cleared.** Anyone sitting in the meeting room who is not in the meeting gets up and takes a free seat elsewhere when it starts, the way it goes in an office.
- **A net under all of it:** if two characters are ever on one tile, whoever does not hold that seat stands up and takes another, leaving the meeting first if they were in one. It logs `[Seats] N was sitting on top of M` so the cause is findable.
- **Every seat pathfound to was left blocked for good.** `withOwnSeatUnblocked` unblocks the caller's seat for a query and put it back unconditionally - harmless when every chair was blocked, but since v1.24.0 only an occupied chair is, so each query walled off another seat tile until the office was carved up. It now restores only what it removed. Over 30 office days: parched plants fall from 15% to **3%**, tidying goes 52 -> 79 and drinks 53 -> 78, all of it work that was quietly being blocked.
- A claim on a thing - a toilet, a plant, a mug - is released when the action ends, and a claim held by a remote agent (another window's, replayed here) no longer reserves anything locally. A stale claim on the only toilet in the building reserved it for ever.

## v1.33.1

- Two agents can no longer sit on the same tile. Seats are handed out in several places - meetings, idle zones, restored agents, the toilet - and any one of them getting it wrong puts two characters on one chair, which is unmistakable on screen. Whoever does not hold that seat now gets up and takes a free one, leaving the meeting first if they were in one. It logs `[Seats] N was sitting on top of M at x,y` when it fires, because 66 office minutes of simulation did not reproduce it and the log is what will say where it comes from.

## v1.33.0

- **One person sees to the plants at a time** (`MAX_CONCURRENT_WATERERS`). Three agents crossing the office with watering cans reads as an obsession rather than an office. Nobody sets off while somebody else is already on the rounds.
- It costs the plants almost nothing: 68 watering rounds over 30 office days instead of 114, and they still average 71% freshly watered against 16% parched (was 73/17). Conversation is comfortably ahead of watering again in the mix, which is the right order.

## v1.32.0

- **Being in the same room as a withered plant counts as noticing it.** "Close" was a straight line of `PLANT_NOTICE_DISTANCE_TILES` tiles and nothing else - so a plant through a wall counted and one eight tiles away across the same open floor did not. Every tile is now labelled with the room it is in (`rebuildRooms`, separated by walls, the void and doorways - a room being what you can close a door on), and for a plant that has withered completely, sharing that room is enough. Walking past still counts for the merely fading ones.
- `WATER_NEAR_PARCHED_WEIGHT` goes 70 -> 120 with it. Over 30 office days the plants average **73-75% freshly watered against 14-17% parched**, up from 63/20, on 114 watering rounds. That is a lot of watering, but it is what sixteen plants drying every sixteen office minutes actually ask for - about 144 - so the office is still running slightly behind them rather than fussing.

## v1.31.0

- **The tablet's status line says which build it is looking at**, not which build its own apk came from: the relay announces the version it is serving in an `X-Pixel-Agents-Version` header on the stream, and the app puts it in front of the fps counters. The version stamp is out of the picture again, now that the text can carry it.
- **The app stops fast-forwarding after a stall.** It skips a frame when a whole newer one is already waiting, but the yardstick was a fixed 32 KB - set when frames were bigger. At the ~24 KB they are now, one queued frame sat under it and was decoded anyway, which is a short fast-forward on screen and an fps count above the cap. It measures against the frame in hand instead. **Needs the new apk sideloading.**

## v1.30.1

- Someone washing their hands turns to face the sink, rather than standing at it facing whichever way they happened to walk in.

## v1.30.0

- **One renderer feeds the tablet at a time.** Two of them - a restart where the old process has not quite gone, or a debug run taking a screenshot, which also publishes - interleave frames from two separate simulations, and the tablet shows a picture at double rate that jumps about. The relay now takes the first renderer to send a frame as the stream's source and ignores the rest until it disconnects.
- The simulation itself was never frame-rate dependent: the renderer's loop advances the office by real elapsed time, capped at 0.1 s, so a slow frame makes the office lag rather than speed up.

## v1.29.1

- Proof of the above: a version-only deploy leaves the relay running and the tablet's stream untouched.

## v1.29.0

- **A deploy no longer blacks out the tablet.** Every deploy restarted the relay, which drops each tablet's HTTP stream, and their app takes over a minute to reconnect - measured at 73 seconds of a frozen picture. The relay is restarted only when its own code actually changed now, compared against a marker left on the host by the last deploy; a webview build and a version bump leave it running. The version itself is no longer captured at startup: the relay re-reads `package.json` whenever it recomputes the build id, which happens on every new webview anyway.

## v1.28.0

- The version stamp burns bright for thirty seconds and then fades to half, so a deploy announces itself and then gets out of the way. The renderer restarts on every deploy, which is what resets it. Fading is a change nothing else would report - the corner it sits in can go a long time without the office repainting there - so the stamp pushes its own frame when its alpha moves, in twelve steps to keep that cheap.
- **The toilet could still be handed out as a seat.** `findFreeSeat` skipped it, but the two pickers that move idle agents towards rest and kitchen seats walked `this.seats` directly and did not - so an idle agent could be sent to sit on the loo, where they read a newspaper all day. Both skip it now, and a net under all of them takes the toilet back off anyone holding it who is not actually on a visit.

## v1.27.0

- **The build is stamped in the corner of the tablet's picture**, bottom left, where the app's own fps overlay (top left) will not cover it. It goes into the scene rather than onto the nametag overlay, because that overlay only exists when the scene is drawn at half size and doubled by the renderer - and it is not any more; the tablet does the doubling. Drawn with a 3x5 pixel font rather than a real one: at this size a font is anti-aliased into a smear, and the frame is quantised to RGB565 and doubled by the tablet on top of that.
- `npm run deploy` now ends with `renderer/refresh.sh`, which rebuilds the headless engine and restarts the tablet renderer. Nothing else restarted it, so the tablet kept drawing with whatever engine it started with - and a version stamp claiming a build it was not running would be worse than no stamp at all.

## v1.26.3

- The phone sits a pixel further left, centred in the lap.

## v1.26.2

- The phone is a pixel wider, with two screen pixels instead of one, and the screen is never quite still - two frames alternating on the seated animation's own clock, about every 0.8 s. Riding that clock rather than a new one means the damage tracker already knows the character changed, so an animated screen costs the tablet nothing.

## v1.26.1

- The phone is held low, down in the lap with the arms down, rather than up at the chest - which is how anyone sits on a toilet. `renderer/tools/pose-shot.mjs` photographs both poses, since they are picked at random and cannot be asked for.

## v1.26.0

- Nobody reads a newspaper on the toilet. The seated idle animation holds up a sheet of paper, which was what an agent in there appeared to be doing; they now either just sit, or sit looking at their phone, picked at random when they sit down.

## v1.25.1

- Walking past a plant that has gone properly parched is much harder to ignore: `WATER_NEAR_PARCHED_WEIGHT` goes from 32 to 70, on a par with walking past a stray mug. Over 30 office days that is 53 watering rounds rather than around 25, and the plants average 65% freshly watered against 19% parched.

## v1.25.0

- **Mugs actually get cleared away now.** Two things were in the way. Props aged by the wall clock rather than the office's own, so the audit - which fast-forwards - saw mugs eight seconds old after half an office day and reported two things tidied over thirty office days; they now age by `elapsedSec`, the way plants already did, and the same thirty days show thirty-five things cleared away against a hundred fetched. And "somebody is using this" meant *anyone* sitting within a tile of it, which protected a drink for ever, because a drink is put down on the desk of whoever fetched it and that person then sits there working. Only its own owner counts now, and only until `PROP_ABANDONED_SEC`.
- **An empty is finished with, not in use.** An empty plate or bowl can be cleared at once, even from under someone's nose - it is the utensils with somewhere to be taken but nowhere to be fetched from. Anything still full waits out its minimum lifetime.
- **A drink goes down on a clear bit of desk.** If something is already standing where they would put it - a monitor, a laptop - they look along the desk to either side for a free spot first, out to `DESK_SPOT_SEARCH_TILES`. Only if the whole desk is occupied does it go on top of something, which beats carrying it around for ever. Measured over an office day: 32 of 37 drinks put down on a clear tile.

## v1.24.1

- Something standing on a desk can be reached across it. A mug on the back row of a desk against a wall had no free tile beside it at all, so nobody could ever clear it away - but anyone in front of the desk can lean over and take it, which is what it looks like from the outside. Every plant, utensil and machine in the office is now reachable.

## v1.24.0

- **An empty chair is something you walk past, not a wall.** Chairs blocked everyone but their own occupant, so a row of them walled a room into cells: a plant behind one could never be watered, and whoever sat there could not get out to fetch anything. Only the tile somebody is actually sitting on blocks now, added and removed each tick the way a moving vacuum's tile is, and chairs stay out of the wander destinations so nobody chooses to stand on one.
- The office proper went from 182 of its 340 floor tiles to 233. Every plant is reachable, no seat is walled in, and over 30 office days the plants average 61% freshly watered against 18% parched, up from 55/24.

## v1.23.0

- **The toilet is an actual toilet.** It is a chair, so an agent could be assigned one as their working seat and sit on it for the rest of the day, coming back to it after every break. A seat marked `privacySeat` is now left out of seat assignment entirely, and visited by a new idle action instead: walk over, sit a short while, **wash your hands at the nearest sink**, then back to your own desk. The room still shuts and locks its doors while it is in use.
- The toilet is borrowed as a seat for the trip and given back on the way to the sink. That is what unblocks the tile for whoever is walking to it - a chair blocks everyone but its own occupant - and what tells the room to lock, without either being a special case.

## v1.22.3

- `reachability.mjs` measures from the largest connected patch of floor rather than from a character's own tile. A character sitting on a chair can step off it into a cell nobody else can enter, so measuring from one made everything behind that chair look reachable - and the answer changed depending on which character happened to be picked.

## v1.22.2

- `reachability.mjs` also reports **seats an agent cannot get out of**. A chair tile is blocked for everyone but its own occupant, so a row of chairs walls a room into cells, and whoever spawns in one is stuck: they cannot reach a sink to fill a watering can, a coffee machine, or anything else. That is why a plant can be left parched with an agent standing right beside it - the only person who can reach it is the one who cannot fetch water.

## v1.22.1

- `renderer/test/reachability.mjs`: which plants, utensils and machines nobody in the office can actually walk to. A plant that is never watered is usually not a watering bug but a plant in a nook - and a chair tile is blocked for everyone but its own occupant, so one chair across a gap seals the corner behind it. Run it after moving furniture about.

## v1.22.0

- **The Wall tab is Wall Decor, and holds only things you hang to look at.** The TV and the four wall panels moved to Tech, where a screen belongs; paintings, charts, mirrors, the chalkboard and the clocks stay. Twenty items in one tab was too many to find anything in.
- The door sign hangs three pixels higher, by way of a new catalog field: **`yOffset` lifts what is drawn without moving the tile** an item sits on or how it sorts. A footprint cannot express three pixels, and growing the footprint to fake it shifted every sign already placed down by a tile - which is exactly what happened on the first attempt.

## v1.21.2

- The door sign is back to a single tile, with a shorter plate drawn in the top half of it so it sits in the wall's lit face without hanging past the bottom edge. On the two-tile footprint it sat too high and the only half step that stayed on the wall was upward, which is the wrong way for a sign that is already too high; on one tile both the whole and the half position are valid, so it can be nudged either way.

## v1.21.1

- The door sign hangs high on the wall instead of halfway down it with its lower half past the wall's bottom edge: it is a 16x32 sprite on a 1x2 footprint now, so the tile you point at is where its bottom row lands and the plate sits up in the wall's face. It is also half-tile placeable, so it can be nudged eight pixels at a time rather than taken or left where it falls.

## v1.21.0

- **A sign for a door, saying whether the room behind it is free, in a meeting, or in use.** Hang it on the wall (it is wall-placeable, in the Doors tab) and it finds the nearest room worth reporting on - one with a toilet in it, or one meetings are held in - and reads that room: green with a tick when it is empty, amber with two heads at a table while a meeting is running, red with a bar while someone is on the toilet. Which room a sign watches is settled once per layout; only the state is read each tick.
- Driven by a new `roomCycle` in the catalog, so a sign is data rather than code: three frames, ordered free, meeting, in use.
- A room with a toilet in it is whatever walls and doors enclose that toilet, but **a meeting room is its zone, not its walls** - meeting areas are rarely walled off, and flooding out from one swallows the open plan and reports on nothing useful. A sign with no qualifying room within `SIGN_ROOM_MAX_DISTANCE_TILES` stays on its first frame rather than latching onto a room across the office.
- The north-south door is its own entry in the Doors tab. It shared a rotation group with the east-west one, so it could only be reached by placing that and rotating, which is no way to find a door.

## v1.20.0

- **The north-south door has no open state.** Seen edge on it is just the narrow beam of the leaf, and a door that is edge on barely changes when it swings: every attempt at drawing the leaf swung out - angled, tapered, flat, past ninety degrees - read as a plank stuck to the wall rather than a door. The engine still opens, closes and locks it, it simply looks the same either way, and the catalog is one asset lighter for it. The east-west door keeps its pair, where there is a face to show.

## v1.19.11

- The open side door is about a tile long rather than two, and its top edge lines up with the top of the beam it hangs on.

## v1.19.10

- The open side door is drawn square: no skew, no taper, just the door itself swung the whole way and lying flat beside its frame, at the proportions a door actually has. Every attempt at an angle read as a plank.

## v1.19.9

- The swung leaf lies nearly horizontal: a door standing wide open sticks straight out from the wall it hangs on, rather than at the diagonal it had before.

## v1.19.8

- The door swings further: the leaf's angle goes from about 17 degrees to about 27, so an open side door reads as open rather than ajar.

## v1.19.7

- The swung leaf is joined to the beam rather than outlined away from it - a black seam down the hinge edge made it read as a separate board standing beside the door - and it casts a shadow on the floor it has swung over, so it no longer floats.

## v1.19.6

- The swung leaf falls away from its hinge instead of climbing, so the door reads as swinging out toward the viewer rather than up the wall - and it no longer runs into whatever is hanging above the doorway. One sign on the shear argument.

## v1.19.5

- The north-south door's swung leaf reads as a door rather than a plank: shorter, deeper, a gentler angle, and sitting beside the doorway instead of climbing off over the wall above it. Its length, depth and angle are the arguments to `stampSwungLeaf`, so the swing can be tuned without redrawing anything.

## v1.19.4

- The north-south door closed is now just the leaf itself seen edge on: a beam a third of the tile wide standing in the middle of the doorway, with the way through showing either side of it. It was a full-width slab before, which is more door than that direction can actually show.
- Opened, that beam stays as the frame and the leaf swings out beside it, sheared so it reads as a door standing at an angle. Its sprite is two tiles wide, since a swung leaf reaches past the doorway it belongs to; the footprint is still the one tile. Both are generated rather than typed out (`stampBeam`/`stampSwungLeaf` in `renderer/tools/make-doors.mjs`), because a sheared rectangle is not something to draw by hand.

## v1.19.3

- **Every door sprite was 8 px too high in the actual office.** They were drawn against previews that composited the sprite onto a rendered frame using the tool's own camera maths, which sits 8 px below the engine's - so what looked right in a picture was wrong once the engine drew it. All four are shifted to match, and `renderer/tools/door-shot.mjs` now puts a door in the layout and lets the engine draw it instead, which is the only honest way to look at one.
- The north-south door's beam fills the slot it actually has: from the edge of the dark band above down to where the wall below begins. In a vertical wall run that wall draws in front of the doorway, so anything lower was never visible anyway.
- Opened, that door leaves the beam standing as the frame and puts the leaf beside it, face and handle toward us, with the way through clear.

## v1.19.2

- A door in a north-south wall is seen edge on, so there is no door face to show from that direction. Closed, it is now simply a wooden beam filling the gap rather than a panelled door drawn as if we were looking at it square on. Swinging it open turns it toward the camera, and that is when its panels and handle appear.

## v1.19.1

- The north-south door, standing open, was a thin bar across the top of an empty frame and read as a hole rather than a doorway. Its leaf now lies back against the top jamb as a proper panelled door, handle and all, with the way through left clear below it so whoever is walking through is not hidden behind it.

## v1.19.0

- **Doors.** A new Doors category in the editor, with a door for a gap in an east-west wall and one for a gap in a north-south wall, each drawn open and closed (`renderer/tools/make-doors.mjs`). A door is a 16x48 sprite on a 1x3 footprint whose top two rows lie in the wall, so it can reach above the tile people walk through: its head sits up in the wall's dark top band and its body fills the lit face down to the wall's bottom edge. That geometry was measured off a rendered wall rather than guessed - a wall block is 1 px of outline, 7 px of dark top, 23 px of lit face and 1 px of outline, and that last outline falls 8 px into the tile row, not at its bottom. `renderer/test/doors.mjs` covers the behaviour.
- Doors are never walked around. They are left out of the blocked set entirely, so pathfinding treats a doorway as the open floor it is; what a door does is **open when somebody reaches it** (a tile ahead, so it is open by the time they step through) and close again behind them - usually. `DOOR_CLOSE_BEHIND_CHANCE` is 0.65, because people mostly close doors and sometimes do not. One left open is not shut by an invisible timer: the next person to walk past it closes it, the same noticing that gets a stray mug cleared away or a dry plant watered.
- **A toilet is a seat you want the room to yourself for.** While one is sat on, the doors of the room it stands in shut and lock, and because a locked door is in the blocked set, everyone else quietly paths around it - they reroute at the next tile, so nobody is left walking into a shut door. The lock waits for anyone else still inside to leave rather than shutting them in, and lifts the moment the occupant stands up. Which seats are private is catalog data (`privacySeat`, set on the toilet), and the room is found by flooding out from the seat to the doors around it, giving up on anything bigger than `PRIVACY_ROOM_MAX_TILES` so a toilet standing in the open plan cannot lock the whole building.
- **Steam you can actually see.** Each wisp was a single pixel at 45% alpha, which at sixteen pixels to a tile meant nobody ever saw a drink steam. Wisps now leave the cup as one pixel and curl out into a puff as they climb, four of them, rising further and at 80%.
- `renderer/tools/shot.mjs` renders a patch of the live office scaled up, with a colour readout, so a new sprite can be matched to the wall or floor it will actually touch.

## v1.18.0

- **Meetings are an occasional event again, not the office's main activity.** The roll to start one was written to happen once per tick but had no guard, so it ran for every idle agent: a room with twelve people free multiplied the chance by twelve, and a meeting started roughly every ten seconds. Most of the office spent most of its idle time sitting in the meeting room, which is why a glass of water or a steaming cup was so rarely seen. The roll now really does happen once per tick, and `MEETING_CHANCE_PER_SEC` is 0.003 - about one meeting per five and a half idle minutes. Over 30 office days: 36 meetings instead of 77-106, with conversations, meals, drinks, tidying and plant care taking back the time.

## v1.17.1

- Breaks and plant care rebalanced. Making watering prompt-on-sight had turned it into most of what the office did: over 30 office days there were 48 trips with the watering can and only 5 drinks fetched, so a glass of water was a sight nobody ever saw. Watering weights are roughly halved, a break is more likely to be taken, drinks are picked three times as often as something to read, and plants last 16 minutes rather than 10 - sixteen plants on a ten minute cycle is a treadmill. Now around 30 drinks to 35 waterings, with the plants still averaging about half freshly watered.
- `renderer/test/office-audit.mjs` reports the whole mix - actions chosen, items fetched and tidied, plant health, steam - so balance can be measured rather than guessed at.

## v1.17.0

- **Walking past a dry plant is what sets someone off to water it**, the same way walking past a stray mug is what gets it cleared away. A plant that has merely started to fade is now worth watering at all, and one that is parched and close by is acted on far more readily (`PLANT_NOTICE_DISTANCE_TILES` and the `WATER_*_WEIGHT` constants). Someone with a canful waters the worst plants first, nearest within that.
- The office keeps its plants alive as a result: over 30 simulated office days, 56 watering rounds instead of 16, and the plants averaged 65% freshly watered against 18% parched rather than steadily wilting.

## v1.16.1

- Plants dry at their own pace: each draws a fresh figure for how long its watering lasts, within about half again either way, so the office no longer wilts in lockstep - one plant droops while its neighbour is still fine.
- The drying colours go further still: clearly yellow-green partway, golden-olive and darker when parched.

## v1.16.0

- **Fresh coffee steams.** Three wisps climb out of a cup on their own rhythm, wandering sideways and fading as they rise, thinning out over a minute and a half until the drink is cold. Which drinks are served hot is catalog data (`steams: true`, set on the coffee mug), so tea or soup can steam later without touching the engine.
- Thirsty plants read more clearly: the leaves now walk green to yellow-green to dry olive rather than merely losing a little colour. The first attempt was too subtle to see at sixteen pixels.
- `renderer/test/steam.mjs` checks a poured drink steams at once, thins as it cools, and stops.

## v1.15.0

- **Plants are one tile, not two.** Their sprites are 16x32 with every pixel in the lower half, so the declared 1x2 footprint covered a tile of empty air: a two tile footprint in the editor, and an agent standing two tiles away when watering one from above. The sprites are cropped to their bottom tile and bottom-aligned (which also lifts the one plant that sat a few pixels high), and placed plants moved down a row to stay where they were.
- **Plants look thirsty.** Two drier variants of each - faded, then faded further and drooping - shown through a new `thirstCycle` as the time since watering grows, and reset when someone waters them. They start fading at 60% of the way to wanting water, so the office looks thirsty before anyone is sent round with the can.
- Plant dryness is measured in office time rather than wall-clock time, so a tab left in the background does not come back to a room full of dead plants.
- `renderer/tools/crop-plants.mjs` and `make-thirsty-plants.mjs` generate the sprites; `renderer/test/plants.mjs` checks a plant passes through watered, fading and parched.

## v1.14.0

- **Someone waters the plants.** An agent fetches the watering can from a sink or water cooler, does the rounds of the plants that have not had a drink lately, and goes back for more water after a few of them - then puts the can away. Driven by catalog data like the other utensils: a new `utensilUse: "water"` with `utensilTargets` (what it is used on) and `utensilUses` (plants per fill). Plants on shelves or boxed in by desks are not counted, since nobody can stand next to them.
- **Cups and plates you placed yourself get cleared away too.** Anything drinkable or edible from the layout is fair game for tidying; books and paper are left alone as decoration, and so is the watering can. They are only hidden, never removed from your layout, so reloading brings them all back.
- New sprite: `renderer/tools/make-watering-can.mjs` draws the can in the same style as the mug.

## v1.13.0

- **The office keeps office hours.** Meals peak around noon and drinks in the first hours of the day, both thin out overnight, and everything still happens at its normal rate in between (`OFFICE_MEAL_HOURS`, `OFFICE_DRINK_HOURS`). Measured over 40 office days: 12 meals in the lunch hours against 1 overnight.
- **Lamps burn where people are.** After dark a desk lamp stays lit only while someone is working within a few tiles of it, so the office ends up lit in pools around whoever is still at it.
- **A wall panel that means something.** "Wall Panel - Office Load" is a gauge whose bars follow how many agents are working, through a new catalog cycle `loadCycle` (ordered quiet to busy, picked by state like the clocks' `timeCycle`). The server racks take a new `loadReactive` flag and blink up to three times faster as the office gets busy.
- **Nearest means nearest to walk to.** Choosing a coffee machine, a bin or a stray mug now measures the real route with the same pathfinding the agents walk with, not straight-line distance - a bin three tiles away through a wall no longer beats one eight tiles down the corridor. Only the closest few candidates are measured, so it stays cheap.
- **One at a time at the coffee machine.** Agents prefer a machine nobody is using, and where there is only one they wait beside it for their turn instead of brewing through each other. The claim is released the moment the drink is handed over, so sitting down to eat no longer keeps the fridge looking busy.
- `renderer/test/office-day.mjs` simulates whole office days against live state and reports the rhythm, plus the engine `debug()` hook it reads.

## v1.12.1

- The wall clocks now read quarter hours, with both hands. The first cut stepped in half hours, which meant the minute hand only ever pointed straight up or straight down and flipped 180 degrees on every step - flapping rather than telling the time. At quarters it steps 90 degrees the same way round each time and sweeps. 48 dial frames per clock.
- Note when changing catalog data on the relay: it reads the catalog and sprites at startup only, so an upload needs `sudo systemctl restart pixel-agents-relay`. `relay/deploy.sh` restarts it only when relay code changed.

## v1.12.0

- **The two wall clocks tell the office's time.** Both dials are driven by the same cycle as the sun, so they agree with the daylight in the windows: the day phase reads as 06:00 to 20:00 and the night phase as the hours back round to dawn. A five minute office day means a hand moves every few seconds.
- Done with a new catalog cycle, `timeCycle`: 24 dial frames per clock (half hours, as fine as a seven pixel face can show), chosen by the time of day rather than by a timer like the other cycles. The renderer needed no idea what a clock is, and the native renderer's damage tracking noticed the swaps by itself. Frames are generated by `renderer/tools/make-clock-frames.mjs`, which finds each dial in the art, clears the hands painted on it and draws new ones clipped to the face.
- The office's day now runs whether or not sunlight is drawn. It used to advance only while the sunlight option was on, which would have quietly stopped the clocks.

## v1.11.3

- Fix: a wall-mounted item was drawn behind the wall when mounted on the upper or lower part of one - on a pillar, on a thick wall, or simply nudged up half a tile. A wall sprite is drawn a tile taller than its tile and sorts by that tile's bottom, so the wall below an item, and its own wall once the item moved up, painted over it. Such items now sort in front of every wall sprite that overlaps them, which is safe because walls are not walkable and nothing can stand between. Items hanging over open floor keep their own sort, so furniture and characters in the room still occlude them.

## v1.11.2

- Three wall-mountable screens added to the live catalog (Wall tab): **Wall Monitor** (the desk monitor's screen, no stand), **Wall Panel - Graphs** (bar charts and trend lines, 7 frames) and **Wall Panel - Console** (terminal text scrolling, 6 frames). The two animated ones use the catalog's `idleCycle`/`randomIdleCycle`, the same mechanism the server racks blink with, so they run on their own with no agent nearby. All are 1x1, wall-only, and half-tile placeable. Generated by `renderer/tools/make-wall-panels.mjs` from `MONITOR_FRONT_ON.png`; the sprites and catalog live on the relay Pi.
- Note for placing them: a wall tile with another wall tile *below* it (a pillar, or the top of a two-tile-thick wall) draws over anything mounted on it, because the lower wall sprite extends a tile upwards. Mount them on a wall with floor below.

## v1.11.1

- Fix: a half-tile item could not be nudged onto a desk standing against a wall - the one spot where a mug looks like it sits *on* the desk rather than on its front edge. Placement checked the tile the item leans into (the wall) instead of the one it rests on, so it was refused. It now checks the resting row; a mug over a plain wall with no desk under it is still refused.

## v1.11.0

- **The tablet stream is sent at the office's own resolution (512x300) instead of being upscaled to 1024x600 first.** The viewer app already scales frames to fit with filtering off, which is the same nearest-neighbour doubling the renderer was doing, so the picture is pixel-identical - but the frame is a quarter of the bytes: less conversion, a quarter of the compression work and of the network (about 600 KB/s -> 150 KB/s), and a quarter of the tablet's decode. Set with `width`/`height`/`zoom`/`upscale` in `~/.pixel-agents/renderer.json`.
- Relay: when the renderer's frame size changes, connected stream clients are ended so they reconnect and read the new CONFIG. A client is told the size once, when its stream opens, and sizes its bitmap from it, so without this it would decode the new frames into the old bitmap.
- Note: half resolution and crisp nameplates are mutually exclusive. Nameplate text cannot survive being doubled, which is what the full-resolution overlay existed for; with the stream at 512x300 there is no overlay, so turning `showNametags` back on for kiosk displays means blocky labels. Raise `width`/`height`/`upscale` back to 1024x600/2 if you want them.

## v1.10.2

- **The renderer no longer paints a full-resolution overlay when nameplates are off.** It was clearing a 1024x600 canvas and redrawing every speech bubble on it each frame - bubbles the scene had already drawn - which a profile put at 47% of the renderer's entire CPU. With nameplates off (the kiosk default now), a frame costs 2.6 ms of rendering instead of 5.6, and 13.9 ms of CPU instead of 22.
- Fix: with nameplates off the overlay pass still drew them, so the kiosk setting had no effect on the tablet.

## v1.10.1

- **Fix: the tablet dribbled at 2 fps after the renderer had been up overnight.** Skia's text rendering degrades over a long run: a 19 hour old process spent 96 ms a frame drawing the same fourteen nametags that cost 1.4 ms when it started, which starved the frame loop and dropped 400 frames a minute. Nametag text is now rendered once per label into a small canvas and blitted from then on (`renderNametags`), which takes that path out of the loop entirely and also makes a healthy frame ~28% cheaper (render 5.0 ms -> 3.6 ms). The browser viewer gets the same caching.
- A watchdog restarts the renderer if a frame ever costs more than four times its healthy CPU (floor 25 ms), since the root cause is inside the native canvas and this is not the only path through it. It measures CPU per frame, not wall time, so a busy box under SCHED_IDLE never trips it, and it ignores idle minutes, where the office is still simulated at full rate while only a keyframe or two is drawn.

## v1.10.0

- **Damage tracking in the native renderer**: each frame reports which rectangles can differ from the last one, and only those are converted to RGB565 and upscaled. That stage was writing a megabyte per frame and cost 6.5 ms on an idle box but 14.8 ms under load, because it thrashed the cache exactly when the owner's sessions needed it; it is now 0.5 ms. A frame costs 8.2 ms instead of 12.8, and the service uses 19% of one thread instead of 29% at 10 fps. Default frame rate is now 10 (was 20).
- Clipping the *drawing* to the damaged rectangles was tried and reverted: it made rendering five times slower (3.7 ms -> 18.4 ms), because every draw call then tests against a multi-rect clip. The scene is still drawn in full; the win is downstream.
- The headless renderer quantises the sun's angle, intensity and colour into small steps. It sweeps a full cycle in 300 s, so every frame differed slightly and nothing could ever be reused; the steps are invisible at this scale.
- `renderer/test/dirty-rects.mjs` (`npm run test:dirty`) checks the invariant against live relay state: every pixel that changes between frames must lie inside a reported rectangle, compared in RGB565 because that is what the tablet is sent.

## v1.9.2

- The renderer no longer competes with the owner's Claude sessions: the unit runs at `CPUSchedulingPolicy=idle` and is no longer pinned to CPUs 1,3. The pinning was a Chrome-era setting that forced the renderer onto one physical core *and its hyperthread*, so any session work landing there ran at ~60% speed; SCHED_IDLE makes anything else preempt it outright. Short-burst latency with the renderer running went from 2-3x the idle-box baseline to indistinguishable from it. The daemon unit is unpinned for the same reason (it keeps `Nice=5`).
- `renderer/test/latency-bench.mjs` (`npm run bench:latency`): measures what a background service costs interactive work, which the old throughput benchmark could not see (it reported 4% where bursts were 2-3x slower).

## v1.9.1

- Fix: every relay restart (each deploy) made all viewers despawn and respawn every agent, because the relay broadcast each partial state while the daemon's publishers reconnected one by one. The relay now holds agent state for 20 s after starting (viewers keep what they have) and then sends one full sync.
- Interference re-measured with the native renderer: a normal-priority CPU job runs 0-9% slower (mean ~4%, inside the noise of the other sessions) while the tablet watches; was 2x with Chrome.

## v1.9.0

- **Native renderer for the tablet stream** - the office is now rendered in Node with Skia (`@napi-rs/canvas`), no browser. The same engine TypeScript the web viewer runs is bundled for Node (`webview-ui/src/headless/entry.ts` -> `renderer/native/engine.mjs`) and fed straight from the relay's viewer WebSocket. Sprites are blitted as immutable images (6x cheaper than Skia's picture replay of a canvas source), the floor is a cached layer, the scene is drawn at half resolution and doubled (identical pixel art), nameplates and bubbles are drawn on a full-resolution overlay with the pixel font at its native 16 px (crisp; emoji prefixes stripped, `nametagEmoji: true` keeps them). ~8 ms CPU per frame at 15 fps against ~1 core and 1.5 GB for headless Chrome. `renderer/install.sh` installs it by default; `--chrome` is the fallback.
- `renderFrame` gains an opt-in `TileLayerCache` and `setNametagFont`; the browser's rendering is unchanged.

## Unreleased

- Playbook adopted (vendored v1.20.1, `npm run sync-playbook`); `CLAUDE.md` now carries the bootstrap pointer, house rules, versioning table and server map. Versioning and the branch rule apply from here forward; earlier history is not renumbered. `relay/deploy.sh` refuses a code deploy without a version bump.

## v1.8.1

- Fix: the headless daemon burned ~50% of a core re-reading every sync file on every write (11 backends watching each other for a VS Code multi-window feature nothing headless uses). Headless backends now write sync files but never read them back (~4%).
- Renderer cost brought under control on the 2-core thinkstation it shares with the owner's sessions: idles when no tablet is connected (page CPU-throttled 8x, 0.5 fps keyframes, wakes within 5 s); raw pixels leave the page over a local binary WebSocket and all compression happens in Node (thread pool), LZ4 only when an LZ4 client exists; `#fps=N` caps the office's animation loop; both services run at `Nice=` and are pinned to one physical core's hyperthreads (`CPUAffinity=1 3`). Measured: a normal-priority job is slowed 5-15% while the tablet watches, down from 2x.

## v1.8.0

- **Kiosk display settings** - View dropdown gains "Apply to kiosk displays": nameplates, sunlight, dynamic items, lamp lights and weather from this browser are stored on the relay and pushed live to every `#kiosk` viewer (the tablet renderer, wall screens). Also `GET/POST /api/kiosk`.
- Stream no longer "catches up": the relay drops a frame for a client whose previous frame is still queued, and the app skips decoding frames it is behind on (`skip=` in the status line).
- Viewer app hardening from Oriel's review: backoff resets after a healthy session, `Inflater` released per session, a rejected key stops retrying and says so, non-200 responses are disconnected, TLS factory built once.

## v1.7.2

- Stream up to 30 fps: the renderer reads the office canvas inside the page instead of screenshotting (5x cheaper), encodes off the main thread; ~20 fps delivered from the thinkstation. Relay default cap 15, per-client `fps=` up to the renderer's cap.
- Viewer app: instance key shown in clear text and preset; fps 1-30 (default 15).

## v1.7.1

- Fix: an idle agent visiting furniture placed on a half tile crashed the game loop (`tileMap[4.5]`), freezing the office until reload. Found by the headless renderer running the office nonstop.
- **Legacy viewer app** (`android/`): the Android 4.1 client for the frame stream - Oriel's proven decoder/receiver/surface, plus a pinned-root TLS 1.2 HTTPS client, deflate support and a settings dialog. `build/pixel-agents-viewer-<version>-debug.apk`.
- Renderer reloads the page properly after an error (`page.reload`, not a same-URL `goto`).

## v1.7.0

- **Legacy tablet stream** - the relay serves `GET /stream` (chunked; `CONFIG` then `FRAME_FULL`, RGB565 + LZ4 block, protocol v1 from `docs/HANDOFF-from-TabScreen.md`) fed by a new `renderer/` process that renders the viewer headlessly and publishes frames over the publisher WebSocket. `GET /api/stream` reports its state. LZ4 codec and framing verified against TabScreen's fixtures and its Java client stack (`renderer/test`).
- **`#kiosk` URL flag** - display mode with no UI at all and the camera kept centred on the office; for the renderer and wall-mounted tablets.
- Login link (`#token=...`) now keeps other hash flags.

## v1.6.15

- **Dynamic items** - agents fetch a coffee mug at the coffee machine, carry it back (drawn in hand), put it on their desk, and now and then pick up stray mugs and take them to the sink. Data-driven: any catalog asset marked `utensil` with `utensilOrigin`/`utensilDisposal` works (fridge → food → sink next, once the sprites exist). Toggle: View → "Dynamic items". Utensils have a `utensilUse`: `drink` (coffee breaks) or `food` - eating in the kitchen now fetches a food item from its origin first, when one exists.
- Settings modal renders above activity labels.
- Catalog `useSide` (asset-manager "Use side"): characters stand in front of the coffee machine/sink instead of a random side.
- Fetched mugs/food come in random colour variants; three placeholder foods (plate, salad bowl, sandwich) picked at random.
- More utensils: a glass of water from the sink or water cooler (back to the sink), a sheet of paper from the printer (to the bin), a book from any bookshelf (back to a bookshelf). Origin/disposal now take comma lists and `*` wildcards; new use type `item`.
- "Keep screen awake" view option (default on): the tablet/phone display stays on while the office is visible (Screen Wake Lock API; PWA on iOS 16.4+).
- Food turns into an empty plate/bowl when the agent finishes eating (catalog `utensilEmpty`), and is then tidied like anything else.
- Catalog `surface` flag (asset-manager "Is Surface"): mugs/plates - placed by agents or by you - can go on non-desk surfaces such as the chess board.
- Tidying is smarter: items someone is sitting next to are left alone; a stray item nearby makes an idle agent far more likely to grab it (nearest first).
- Action bubbles: the item being fetched shows in a bubble on the way to get it; a broom bubble while tidying.
- Placeholder `PLATE_FOOD` sprite on the relay so food fetching is testable (Behaviour bar: Coffee / Food / Tidy).

## v1.6.14

- **Agents keep their look** - appearance is now derived from the nametag (hash → palette + hue), identical on every device and spawn; Shuffle overrides are remembered per name.
- **Touch panning** - double-tap and hold, then drag, moves the view on phones/tablets (same as middle-mouse drag).
- **Calmer idle behaviour** - agents sit 2-3× longer between outings and take shorter walks.

## v1.6.13

### Features

- **Headless daemon - run without VS Code** - `npm run package:daemon` builds a single self-contained `pixel-agents-daemon.cjs` (~60 KB tarball with `daemon/install.sh`). Run it on the Linux box where Claude Code runs; it publishes to the relay so the office is viewable from anywhere. The installer sets up a systemd user service that starts on boot. See [daemon/README.md](daemon/README.md).
- **Exact session discovery** - the daemon finds running `claude` processes through Claude Code's own registry (`~/.claude/sessions/<pid>.json`: pid, sessionId, cwd, name), verified against `/proc/<pid>/stat` start time to rule out pid reuse, with a `/proc` scan fallback for older Claude Code. No folder list or timestamp heuristics. User-named sessions show their name on the nametag.

### Internal

- Backend no longer imports `vscode`: environment access goes through a `Host` interface (`src/host.ts`) with `vscodeHost.ts` (extension) and `daemon.ts` (headless) implementations. The daemon bundle is built without `vscode` as an external so any leak fails the build.
- `relayClient.ts` falls back to the `ws` package when there is no global `WebSocket` (bundled into the daemon → Node 18+).
- Removed dead webview-only helpers (`launchNewTerminal`, `sendExistingAgents`, `sendLayout`).

## v1.0.2

### Bug Fixes

- **macOS path sanitization and file watching reliability** ([#45](https://github.com/pablodelucca/pixel-agents/pull/45)) - Comprehensive path sanitization for workspace paths with underscores, Unicode/CJK chars, dots, spaces, and special characters. Added `fs.watchFile()` as reliable secondary watcher on macOS. Fixes [#32](https://github.com/pablodelucca/pixel-agents/issues/32), [#39](https://github.com/pablodelucca/pixel-agents/issues/39), [#40](https://github.com/pablodelucca/pixel-agents/issues/40).

### Features

- **Workspace folder picker for multi-root workspaces** ([#12](https://github.com/pablodelucca/pixel-agents/pull/12)) - Clicking "+ Agent" in a multi-root workspace now shows a picker to choose which folder to open Claude Code in.

### Maintenance

- **Lower VS Code engine requirement to ^1.107.0** ([#13](https://github.com/pablodelucca/pixel-agents/pull/13)) - Broadens compatibility with older VS Code versions and forks (Cursor, etc.) without code changes.

### Contributors

Thank you to the contributors who made this release possible:

- [@johnnnzhub](https://github.com/johnnnzhub) - macOS path sanitization and file watching fixes
- [@pghoya2956](https://github.com/pghoya2956) - multi-root workspace folder picker, VS Code engine compatibility

## v1.0.1

Initial public release.
