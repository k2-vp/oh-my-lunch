# Configuration

Everything lives in `data/restaurants.json`. The server reads the file on every request and validates it as a whole. A bad value produces an error that names the exact field, and the board shows that error instead of running.

Unknown fields are rejected. A typo in a field name fails loudly rather than being ignored.

## Shape

```json
{
  "restaurants": [
    { "name": "Golden Bowl" },
    { "name": "Ten Minute Hand-Pulled Noodle House", "short": "Noodles" }
  ],
  "settings": {
    "schedule": { "time": "12:00", "weekdays": ["mon", "tue", "wed", "thu", "fri"] },
    "mode": "auto",
    "redropKey": "r",
    "redropWindowSeconds": 90,
    "theme": {
      "lightGround": "#f6f6fa",
      "darkGround": "#100f24",
      "ball": "#181737",
      "ink": "#181737",
      "accent": "#1f9c5b",
      "grey": "#bfc0c9",
      "backgroundMark": {
        "light": "/brand/k2-mark.png",
        "dark": "/brand/k2-mark-knockout.png",
        "opacity": 0.05
      }
    }
  }
}
```

`restaurants` is required. Everything under `settings` is optional and falls back to the defaults shown above.

## restaurants

| Field | Rules |
|---|---|
| `name` | Required. A non-blank string, unique in the list. Case does not matter for uniqueness. |
| `short` | Optional. A non-blank string. Shown in the lane when the full name does not fit. The reveal card always shows the full name. |

The list must hold 2 to 15 entries. The board builds one lane per entry.

## settings

| Field | Default | Rules |
|---|---|---|
| `schedule.time` | `"12:00"` | 24-hour `"HH:MM"`. Validated and stored, but nothing starts on a timer yet. The board runs when the page loads. |
| `schedule.weekdays` | mon to fri | Array drawn from `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`. Same status as `time`. |
| `mode` | `"auto"` | `auto` follows the host's light or dark preference. `light` and `dark` force one look. |
| `redropKey` | `"r"` | One printable character, or a named key: `Space`, `Enter`, `Tab`, `Backspace`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`. |
| `redropWindowSeconds` | `90` | Whole number above zero. How long the reveal card waits for Enter or the re-drop key before the first result accepts itself. |

## settings.theme

Six colors, each a `#rrggbb` hex string:

| Field | What it paints |
|---|---|
| `lightGround` | Page and board background in light mode |
| `darkGround` | Page and board background in dark mode |
| `ball` | The ball |
| `ink` | Text and dark structure in light mode. In dark mode text uses `lightGround`. |
| `accent` | The one highlight color: the countdown bar, today's row, the confirm key |
| `grey` | Pegs and quiet structure |

`backgroundMark` is optional. It draws a faint image behind the lattice:

| Field | Rules |
|---|---|
| `light` | Path to the image used in light mode, served from `public/` |
| `dark` | Path to the image used in dark mode |
| `opacity` | Number from 0.04 to 0.06. The mark is meant to stay faint. |

Remove the `backgroundMark` key and the board draws no mark.
