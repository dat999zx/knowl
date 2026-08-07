# Regenerate:
#
#   docker build -f docs/assets/demo.Dockerfile -t knowl-vhs docs/assets
#   docker run --rm -v "$PWD/docs/assets:/vhs" -w /vhs knowl-vhs demo.tape
#
# Through Docker deliberately, not a local `vhs`. VHS hangs on Windows 11 with no output and
# no error -- ttyd is never spawned and nothing binds a port, reproduced here on a one-line
# tape with vhs 0.11.0, ttyd 1.7.7 and ffmpeg 9.0 all installed and on PATH. Upstream issue
# charmbracelet/vhs#631. The image pins the published knowl release, so the recording shows
# what someone who runs `npm install -g @dat999zx/knowl` actually gets.

Output demo.gif

Set Shell bash
Set FontSize 16
Set Width 1240
Set Height 470
Set Theme "Dracula"
Set TypingSpeed 45ms
Set Padding 22

# Setup the viewer does not see. A fresh, empty repository matters: the duplicate finder
# matches the nearest subject, so pre-existing atoms turn the exact-title match below into a
# near-duplicate advisory and the second decide stops superseding.
Hide
Type "mkdir -p /demo && cd /demo && git init -q . && knowl init --yes > /dev/null 2>&1"
Enter
Sleep 30s
Type "export PS1='$ ' && clear"
Enter
Show

Sleep 800ms

Type `knowl decide "Auth approach" "Stateless auth via JWT."`
Enter
Sleep 2500ms

Type `knowl decide "Auth approach" "Server-side session cookies. Revocable."`
Enter
Sleep 3500ms

# head, because `status` also prints a per-category breakdown that pushes the line the demo
# exists for off the top. Active 1 / Superseded 1 is the whole claim in two lines.
Type `knowl status | head -n 11`
Enter
Sleep 4500ms
