# minis

A tiny site for my hand-painted miniatures, with two views:

- **gallery**: the untouched photos in a justified grid. Click one for a fullscreen, snap-scrolling viewer with click-to-zoom.
- **stickers**: every mini cut out as a die-cut sticker. Drag, fling, spin, pinch and stack them. Your arrangement is saved on your device until you hit *reset*.

It's plain HTML, CSS and JS with no framework and no build step for the frontend. A small Python script does the image work.

## Adding a mini

1. Drop the photos in `photos/` (any of jpg/png/webp/tif).
2. Optionally group them by model and add a name and description in [`minis.toml`](minis.toml):

   ```toml
   [[mini]]
   photos = ["DSC_8855", "DSC_8849", "DSC_8859"]   # file names, without extension
   name = "Mimic"
   description = "Sculpt by [Someone](https://example.com). Painted *Nov 2026*."
   ```

   Every photo appears in the gallery, with a model's photos kept together. Each model gets one sticker, cut from its first photo. A photo that isn't listed in any `[[mini]]` counts as a model of its own. Descriptions support `[links](https://…)`, bare URLs, `*italic*` and `**bold**`. You can also set `sticker = "<photo>"` or `sticker = false`, `order`, and `hidden = true`.
3. Build the assets and commit:

   ```sh
   pip install -r requirements.txt
   python3 scripts/build.py
   ```

   Or just push the photos. The deploy workflow runs the same build and commits the results for you.

The build writes responsive WebPs for every photo. For each sticker photo it also makes a background-removed sticker with a white die-cut border (using [rembg](https://github.com/danielgatis/rembg) with BiRefNet), a soft shadow sprite and a hit-test mask. Results are cached, so only new or changed photos get processed. The first cutout downloads a model of about 1 GB.

If a cutout comes out wrong, put your own transparent PNG next to the photo as `photos/<name>.cutout.png` and it will be used instead.

## Running locally

```sh
python3 -m http.server -d site
```

Then open http://localhost:8000.

## Deploying

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main`. To turn it on, go to **Settings → Pages → Source** and choose **GitHub Actions**.

## License

Photos and site © Brannon Dorsey, licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See [LICENSE](LICENSE).
