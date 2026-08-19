# Regenerating `overview.gif`

`overview.html` is the source of `../overview.gif`. It exists because the previous GIF had no
generator anywhere in the repo — it was recorded and edited by hand, so when the brand moved it
could not be brought along, and it kept shipping a logo the product had stopped using.

**The page is a pure function of a frame number.** Every scene reads `location.hash` and renders
the state for that frame; nothing depends on wall-clock time. So each screenshot is deterministic
and the whole animation can be rebuilt byte-for-byte at any time.

## Rebuild

Any Chromium will do — Chrome, Brave and Edge all ship the headless screenshot flag.

```bash
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
FF=ffmpeg   # winget install Gyan.FFmpeg

mkdir -p /tmp/frames
for i in $(seq 0 135); do
  n=$(printf "%03d" $i)
  "$CH" --headless --disable-gpu --hide-scrollbars \
        --screenshot="/tmp/frames/f$n.png" --window-size=1200,675 \
        "file:///$(pwd)/overview.html#$i"
done

"$FF" -y -framerate 11 -i /tmp/frames/f%03d.png \
  -filter_complex "[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 ../overview.gif
```

136 frames at 11 fps is 12.4 seconds, which matches the recording it replaced. The palette pass
matters: without it ffmpeg picks a global 256-colour table per frame and the flat panels band
badly. With it the result is ~155 KB, against 1,059 KB for the hand-made original.

## Timing

The beats are frame numbers in the script at the bottom of `overview.html`:

| frames | beat |
| --- | --- |
| 0–5 | hold on the stale answer |
| 6–44 | type the correction, two characters a frame |
| 45–63 | the predecessor retires; the payoff lines appear |
| 64–103 | the benchmark and the capability grid |
| 104–135 | the closing card |

The typewriter **must** finish before the supersede fires — an earlier cut had the old atom retiring
at frame 48 while the command was still being typed, which reads as the tool acting before you
asked it to.

## Colour

Everything comes from the tokens at the top of the file, which mirror
`design/site/_knowl/base.css` in `knowl-cloud`. The six capability bars and the four closing stats
use the product's own category hues, so colour on this page means the same thing it means in the
app. If the brand moves, edit `:root` and re-run — that is the whole point of keeping this file.

`demo.gif` is **not** generated here. It is a real terminal recording of `knowl decide` and
`knowl status`, and its output still matches the current CLI verbatim, so it needs no rebuild.
