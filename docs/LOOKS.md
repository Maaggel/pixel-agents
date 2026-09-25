# Choosing a look

A character in the office is four parts stacked up: a **hairstyle**, a **top**, a pair of **legs**
and a **skin**. Hair, top and legs each take a hue of their own, so the same shirt comes in eight
colours and dyeing it does not tint the hands or the hair.

A name with no look chosen still gets one - the nametag is hashed into a hairstyle, a shirt, a pair
of legs and a skin - so nothing has to be configured, and an agent looks the same on every screen
and after every restart. Choosing a look replaces the hashed one.

## Picking one in the office

Click a character, then the 🧵 button beside its name. The panel steps through each part and offers
the hues. Changes show at once and are kept by the relay, so they reach every other browser and the
tablet, and they outlive the tab.

## Picking your own, as an agent

Agents choose by asking the relay directly. The token is in `~/.pixel-agents/daemon.json`:

```sh
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.pixel-agents/daemon.json'))['relayToken'])")
curl -s -X POST https://apps.blommemix.dk/pixelagents/api/looks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"Pixel Agents (Pantograph / Panto)": {"skin":2,"hair":8,"hairHue":0,"top":7,"topHue":180,"legs":1,"legsHue":0}}'
```

The key is the name on your nametag, matched without regard to case - `GET /api/looks` lists what is
set, and the office shows the rest. Sending `null` instead of a look puts that name back to what its
name hashes to. Every field is required; half a look is ignored rather than half-applied.

## What the numbers mean

`skin` is one of the six characters, `hair`, `top` and `legs` are indexes into their own pools, and
the hues are degrees. To see what each number looks like:

```sh
cd renderer && node tools/parts-sheet.mjs     # the catalogue, every part numbered
```

## Drawing new parts

Parts are PNGs in `webview-ui/public/assets/characters/parts/`, named `<layer>_<n>.png`, each the
same shape as a character sheet: 7 frames across, 3 direction rows down, 16x32 each, with only that
one garment on it. Numbering runs from 0 with no gaps. `top_0`-`top_5`, `hair_0`-`hair_5` and
`legs_0`-`legs_5` were cut out of the six characters; anything after that was drawn.

Two tools draw new ones rather than editing 21 frames by hand:

```sh
cd renderer
node tools/make-tops.mjs      # shirts, by pushing an existing garment's pixels lighter or darker
node tools/make-hair.mjs      # hairstyles, drawn onto the skull the six characters share
node tools/parts-sheet.mjs --anim --look <hair>,<top>,<legs>,<skin>   # every frame, every direction
```

Both write at fixed numbers, so running them again redraws the same files. `renderer/test/character-parts.mjs`
checks that the six cut-out parts still rebuild their characters pixel for pixel, and that the files
on disk match the cut.

The relay reads the parts at startup, so new files need a relay restart, not just an upload -
`relay/deploy.sh` restarts it when relay code changed, and `--restart` forces it.
