# Choosing a look

A character in the office is four parts stacked up: a **hairstyle**, a **top**, a pair of **legs**
and a **skin**. The top and legs each take a hue, so the same shirt comes in any colour and dyeing
it does not tint the hands or the hair. Hair takes a named colour instead, because blonde is a
matter of lightness rather than hue, and the same rotation would land somewhere different on black
hair than on brown.

A name with no look chosen still gets one - the nametag is hashed into a hairstyle, a shirt, a pair
of legs and a skin - so nothing has to be configured, and an agent looks the same on every screen
and after every restart. Choosing a look replaces the hashed one.

## Seeing the options

`docs/parts-catalogue.png` in this repo has every part, numbered, and every hair colour, named. It
is the thing to look at before choosing. Regenerate it after adding parts:

```sh
cd renderer && node tools/parts-sheet.mjs && cp parts-sheet.png ../docs/parts-catalogue.png
```

Everything is also described below, for choosing without opening the picture.

## Picking one in the office

Click a character, then the 🧵 button beside its name. The panel steps through each part, offers the
hues, and names the hair colours. Changes show at once and are kept by the relay, so they reach
every other browser and the tablet, and they outlive the tab.

## Picking your own, as an agent

Agents choose by asking the relay directly. The token is in `~/.pixel-agents/daemon.json`:

```sh
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.pixel-agents/daemon.json'))['relayToken'])")
curl -s -X POST https://apps.blommemix.dk/pixelagents/api/looks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"📱 TabScreen (Oriel)": {
        "skin": 3, "hair": 7, "hairColor": 2,
        "top": 9, "topHue": 0, "legs": 4, "legsHue": 0,
        "reason": "why you chose it"
      }}'
```

`GET /api/looks` (no token) returns what is chosen so far, each with its reason, and `names`: the
nametags the office currently knows. **Find yours in that list** - the key is the whole nametag,
folder emoji and all, matched without regard to case. Sending `null` instead of a look puts a name
back to what its name hashes to.

Every numbered field is required; half a look is ignored rather than half-applied. `reason` is free
text up to 600 characters, kept as written, and is the only record of why anybody looks the way they
do - so write one.

## The parts

**Hairstyles** (`hair`)

| # | what it is |
|---|---|
| 0 | tan, shaggy, heavy fringe |
| 1 | long blonde waves, past the shoulders |
| 2 | black afro |
| 3 | white, swept back |
| 4 | brown mop |
| 5 | black bob |
| 6 | brown mop, gathered into a ponytail |
| 7 | sleek, side parting, low ponytail |
| 8 | sleek, side parting, high ponytail |

**Hair colours** (`hairColor`)

| # | colour | | # | colour |
|---|---|---|---|---|
| 0 | as drawn - whatever that hairstyle came in | | 8 | ash grey |
| 1 | jet black | | 9 | blue |
| 2 | dark brown | | 10 | teal |
| 3 | chestnut | | 11 | purple |
| 4 | auburn | | 12 | magenta |
| 5 | ginger | | 13 | pink |
| 6 | honey blonde | | 14 | green |
| 7 | platinum blonde | | | |

**Tops** (`top`), each dyed by `topHue` in degrees (0 leaves it as drawn; 45, 90, 135, 180, 225, 270,
315 take it round the circle). A white or grey garment has no hue to rotate and stays as it is.

| # | what it is |
|---|---|
| 0 | blue jacket, open over a white tee |
| 1 | black sleeveless dress |
| 2 | orange jacket over white |
| 3 | grey sweatshirt |
| 4 | plain white t-shirt |
| 5 | red jumper |
| 6 | red jumper, horizontal stripes |
| 7 | white shirt and tie |
| 8 | grey hoodie with a front pocket |
| 9 | waistcoat over a white shirt |

**Legs** (`legs`), dyed by `legsHue` the same way.

| # | what it is |
|---|---|
| 0 | dark navy shorts, black shoes |
| 1 | black skirt |
| 2 | blue jeans, pale trainers |
| 3 | tan shorts, bare legs |
| 4 | blue jeans, dark shoes |
| 5 | dark skirt, bare legs |

**Skins** (`skin`), which bring the face with them - one of the six characters the office was drawn
with, rather than a tint.

| # | tone |
|---|---|
| 0 | light, warm |
| 1 | fair |
| 2 | deep brown |
| 3 | medium brown |
| 4 | light, warm |
| 5 | very fair |

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
node tools/parts-sheet.mjs --anim --look <hair>,<top>,<legs>,<skin>[,<hairColor>]
```

Both write at fixed numbers, so running them again redraws the same files.
`renderer/test/character-parts.mjs` checks that the six cut-out parts still rebuild their characters
pixel for pixel, and that the files on disk match the cut.

The relay reads the parts at startup, so new files need `relay/deploy.sh --restart`, not just an
upload.
