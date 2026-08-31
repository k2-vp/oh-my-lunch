# Edit the lunch list

The list lives in `data/restaurants.json`. Edit it with any text editor.

## Change the restaurants

Replace the sample entries with your own:

```json
{
  "restaurants": [
    { "name": "Golden Bowl" },
    { "name": "Taco Cantina" },
    { "name": "Ten Minute Hand-Pulled Noodle House", "short": "Noodles" }
  ]
}
```

Rules the file must follow:

- Two to fifteen restaurants. The board builds one lane per entry.
- Every name must be unique. Case does not matter, so "Tacos" and "tacos" count as the same name.
- A name can be any length. Long names shrink and wrap to fit their lane.
- `short` is optional. When a lane is too narrow for the full name, the board shows the short form instead. The reveal card always uses the full name.

## Apply the change

Reload the page. The dev server and the production server both read the file on each request, so there is nothing to restart.

If you break the file, the board tells you which field is wrong instead of guessing at what you meant. Fix the named field and reload.

## Fit check

Names render inside their lanes at the size of your screen. After a big list change, glance at the bottom row on the TV itself. If a name looks cramped, give it a `short` form.
