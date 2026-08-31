# Put it on the office TV

The production setup is one Node process. It serves the page, the API, and the week's record.

## 1. Build and start

On the machine that feeds the TV:

```bash
npm install
npm run build
npm start
```

The server prints the address it listens on, http://127.0.0.1:4173 by default. Open that address in the TV's browser, full screen.

## 2. Point the room at it

To open the board from another machine on the office network, use the server machine's hostname or LAN address with the same port.

The record and the list stay on the server machine:

- `data/restaurants.json` is the list. Edit it any time. The server reads it fresh on every request.
- `data/state.json` is the week's record. The server creates and updates it on its own.

## 3. Make it a habit

The board runs when the page loads. Nothing starts on a clock yet, so the daily ritual is one keypress: reload the page around lunch time, or leave the tab open and reload when the room gets hungry. The `settings.schedule` block in the config file is validated and stored for a future scheduler, but today it changes nothing.

A few practical notes:

- The board draws at any resolution and looks best at 1080p or 4K, full screen.
- The theme follows the host's light or dark preference. Force one with `settings.mode` in the config file.
- Enter and the re-drop key come from a keyboard attached to the machine that shows the page. A wireless keyboard in the room works well.
