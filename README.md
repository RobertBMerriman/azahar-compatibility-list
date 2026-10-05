<p>A visualizatin of Azahar's compatibility list. </p>
<p>https://kahmenah.github.io/azahar-compatibility-list/</p>
<p>It "should" stay up-to-date as it's pulling from the Official Azahar Repository info.</p> 
<p>https://github.com/azahar-emu/azahar</p>

## Box art

Box art is matched to each game by its Title ID and stored in `data/boxart/` as small WebP thumbnails, so the site never calls a third-party API.
`data/games.json` maps Title IDs to images; games without art show a placeholder.
`data/lookup-state.json` records where each image came from and which games couldn't be found.

The [Update game data](.github/workflows/update-game-data.yml) workflow runs daily (or manually from the Actions tab) and only looks up games it hasn't seen before.
Sources, in order: [GameTDB](https://www.gametdb.com/), then [libretro-thumbnails](https://github.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS).
Games that can't be found are retried after 30 days.

To fix or add art by hand, add `"<Title ID>": "<image URL>"` to `data/boxart-overrides.json`.

To run it locally (needs Node 18+ and `cwebp`, e.g. `brew install webp`):

```sh
node scripts/update-game-data.mjs
python3 -m http.server   # then open http://localhost:8000 (box art doesn't load from file://)
```
