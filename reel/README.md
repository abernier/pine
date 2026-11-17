# The reel

Short films about pine, drawn by code: a mocked terminal, editor and phone that play a script.
Almost nothing in them is recorded. The exceptions are cut in or shown as pictures: a scanner
filmed on a phone, a camera's clips made by a video model, and in the film for the README the
desktop app, in pictures of the real one (see below).

| File | What it is |
| --- | --- |
| `reel.html` | the page the film is drawn on |
| `engine.js` | plays a script: typing, clicks, the camera, captions |
| `story.js` | the script, scene by scene |
| `story-scans.js` | a second script: an agent for its owner's bills (`--story scans`) |
| `story-front.js` | a third: half a minute for the top of the repository's README (`--story front`) |
| `app-shots.mjs` | takes the pictures of the desktop app that `story-front.js` shows |
| `bill/` | the made-up letters the films show, and what draws them |
| `render.mjs` | draws the film frame by frame in a headless browser and hands the frames to ffmpeg |
| `sound.py` | makes the typing and click sounds from the cues the render writes down |
| `assets/` | the logo and the font (JetBrains Mono, under the SIL Open Font License) |

## Rendering

It needs `ffmpeg`, and Python 3 with numpy for the sound.

```bash
node reel/render.mjs
```

writes `reel/pine-reel.mp4`. A part of it, or single frames to look at:

```bash
node reel/render.mjs --from 20 --to 30
```

```bash
node reel/render.mjs --at 3.2,12,40
```

What the render writes (`*.mp4`, `*.webp`, `sfx.wav`, `sfx.json`, `frames/`) is not kept in the
repository.

## The film in the README

`docs/images/reel.webp`, at the top of the repository's README, is `story-front.js`: 28 seconds
that say what pine is. First where it runs and what for, in two seconds each: `pine start` as
a service, the terminal UI for a chat, the desktop app for code. Then the thing it is built
for, which takes the rest: agents that are woken by events. A card says so, and three things
happen in the world, each cut in for two seconds, and each time the picture goes back to pine,
close on the event as it arrives, and out again while the agent works:

| What happens | What the agent does |
| --- | --- |
| a colleague writes in Slack | reads the message and says what it is about |
| a camera sees a stranger at the door at night | watches the clip, and asks on Telegram whether to ring the alarm |
| a letter goes through the scanner | reads it and puts what is due on a TODO list, in the desktop app |

It is made to be read small and without sound, so each step says what it shows in a line of its
own. Its backdrop is one dark colour (a soft gradient breaks into blocks in a small picture),
and it shows no picture that is other people's work.

The terminal, the team chat and the phone are drawn like in the other films. Three things are
not, and their pictures are not kept in the repository:

| Folder | What it is |
| --- | --- |
| `assets/cam/` | the camera's clips of `story-watchdog.js`, made by a video model |
| `assets/scan/` | the scanner of `story-scans.js`, filmed on a phone |
| `assets/front/` | the desktop app, taken from the real one by `app-shots.mjs` |

```bash
node reel/app-shots.mjs
```

starts the app from `desktop/` on a pine home of its own, with the scripted model server of
pine's tests, has an agent change a project and lets a letter arrive in a folder another agent
watches, and keeps a picture of every change of the window. It needs a Mac with a screen and
`pnpm install` in `desktop/`. While it runs, the home and the folders the app shows lie under
`/Users/Shared`, so that the app writes them as `~/dev/flipper` and `~/Documents/scans`; they
are removed when it ends. Without those pictures the film still renders, without the app's two
scenes.

```bash
node reel/render.mjs --story front --webp
```

writes `reel/pine-reel-front.mp4` and, from it, `reel/pine-reel-front.webp`: 1280 pixels wide,
15 pictures a second, no sound, about 4 MB. That file is copied to `docs/images/reel.webp`. `--webp` needs
`img2webp` (libwebp).

It is an animated WebP because that is what a README can show by itself: a picture in the
repository starts playing at once and repeats, on GitHub and on npm. A video plays in a README
only when it was uploaded through GitHub's own editor (it is then kept by GitHub, not in the
repository), and it waits for a click. A GIF of the same film is several times as large with a
quarter of the colours.

## Pictures you bring yourself

The first film (`story.js`) shows four things that are other people's work, so they are not in the repository.
Put your own into `assets/` under these names; without them the film still renders, with a
plain dark backdrop and without those pictures.

| File | What the film shows there |
| --- | --- |
| `wallpaper.jpg` | the desktop backdrop behind the windows, a wide picture (16:9) |
| `meme.jpg` | the "This is fine" picture the agent downloads in the first scene (the script names its address) |
| `cones.jpg` | a photo of pine cones that is dropped into the terminal |
| `spag-00.jpg` to `spag-39.jpg` | 40 square frames of the video the agent plays (the script names its address) |
