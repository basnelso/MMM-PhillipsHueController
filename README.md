# MMM-PhillipsHueController

A [MagicMirror²](https://magicmirror.builders/) panel for controlling [Philips Hue](https://www.philips-hue.com) rooms
from a touchscreen mirror. Based on [mmm-hue-lights](https://github.com/michael5r/mmm-hue-lights) by Michael Schmidt.

- One tile per room or zone, coloured like its lights, with a brightness bar.
- Tap a tile to turn the room on or off. The tile changes straight away; the bridge confirms it a moment later.
- Drag a room's brightness bar to dim or brighten it.
- Hold a room's tile to pick one of the scenes saved for it in the Hue app.
- Changes made anywhere else (the Hue app, a switch, a schedule) show within about a second, through the bridge's
  event stream. The module also polls every `updateInterval` as a fallback.
- Finds the bridge again by itself if its address changes.
- Works with [MMM-Photobooth](https://github.com/basnelso/MMM-Photobooth): sets the camera lights to white while a
  photo or clip is taken and restores them afterwards, without the change showing on the panel.

## Installation

```sh
cd ~/MagicMirror/modules
git clone https://github.com/basnelso/MMM-PhillipsHueController
```

There are no npm dependencies.

You need a Hue bridge user (application key). Follow the
[Hue getting started guide](https://developers.meethue.com/develop/get-started-2/): press the bridge's link button,
then `POST {"devicetype":"magicmirror"}` to `https://<bridge ip>/api` and copy the `username` it returns.

## Configuration

```javascript
{
    module: "MMM-PhillipsHueController",
    position: "bottom_right",
    config: {
        user: "YOUR_HUE_USER",
        displayFilter: ["Living Room", "Kitchen", "Bedroom"],
    }
},
```

| Option | Default | Description |
|---|---|---|
| `user` | `''` | Hue bridge user (application key). Required. |
| `bridgeIp` | `''` | Bridge address. Optional: if it is empty or stops answering, the module asks the [Hue discovery service](https://discovery.meethue.com) and uses the bridge there that accepts `user`. |
| `displayFilter` | `['all']` | Rooms and zones to show, in this order. Names match if they contain the text, ignoring case. |
| `hideFilter` | `[]` | Rooms and zones to leave out, matched the same way. |
| `updateInterval` | `15000` | Fallback poll interval (ms). |
| `toggleConfirmTimeout` | `5000` | How long (ms) a tapped or dimmed room keeps its new state on screen while waiting for the bridge to report it. |
| `brightnessThrottle` | `250` | Minimum time (ms) between brightness commands while dragging. |
| `longPressDuration` | `500` | How long (ms) to hold a tile to open its scene menu. |
| `sceneMenuTimeout` | `10000` | The scene menu closes after this long (ms) without a tap. |
| `cameraLights` | `{ left: 21, right: 22, bulb: 47 }` | Hue light IDs the photobooth uses. Keys are free-form names. Only needed with MMM-Photobooth. |

The bridge address found by discovery is saved in `bridge-ip.json` in the module folder (not tracked by git) and
used from then on.

## Using the panel

- **Tap** anywhere on a tile except the brightness bar to switch the room on or off.
- **Drag** the brightness bar. Rooms that are off have no bar.
- **Hold** a tile to open its scene menu, which takes the place of the panel. Each scene is a circle in its colours;
  the active one has a white ring. Tap a scene to recall it (the menu stays open so you can try others), drag to
  scroll, and tap an empty part of the menu, or anywhere else on the screen, to close it. A tap outside the menu only
  closes it, so it can't also press another module's button.

Scenes come from the bridge's v2 API, which leaves out the bridge's internal scenes. They are re-read every five
minutes and whenever a scene changes, so scenes saved in the Hue app appear without a restart.

## Photobooth notifications

From MMM-Photobooth the module accepts `LIGHTS_ON` (camera lights to white at a colour temperature in mireds, or
`cool`/`medium`/`warm`), `CHANGE_TEMP`, `PREVIEW_TEMP`, `END_PREVIEW` and `REVERSE_LIGHTS_BACK`. It replies to
`LIGHTS_ON` with `SAVE_LIGHT_STATE`, carrying the camera lights' previous states for the photobooth to hand back with
`REVERSE_LIGHTS_BACK`.

While the camera lights are in use, and for two poll intervals after they are restored, the panel shows them as they
were before, so the white light never appears on the tiles.

## License

MIT. See [LICENSE](LICENSE).
