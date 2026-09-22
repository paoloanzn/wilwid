# wilwid

The internet has become flooded with huge amount of information, and most of it is slop for your brain.

But now you can stop the slop before it reaches you. 

Just tell Chrome **😍what you like & 🙅what you don't!**

![video demo](./wilwid.mp4)

This extension reads every page you visit and folds away the parts you
don't like, using [Jev](https://docs.typesafe.ai/introduction).

(1) Blocks about something you dislike fold into a `🙈 not your thing · politics`
  pill (click to peek), or vanish completely.

(2) A block about something you like stays, even if it also touches a dislike.

(3) We also have `Only what I like here` mode that hides everything not about your likes.

## Install

1. Download `wilwid-vX.Y.Z.zip` from the [latest release](../../releases/latest) and unzip it.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
3. Open the wilwid popup and paste your TypeSafe API key
   ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)).
4. Add a few words and watch the slop go away in real time.

To run from source instead, clone this repo and pick the repo folder in step 2.

### Releasing

```bash
scripts/publish.sh          # 0.1.0 -> 0.1.1 (or: minor, major, 0.3.0)
```

It bumps `version` in `manifest.json`, commits, tags and pushes. The tag triggers the [release workflow](.github/workflows/release.yml), which zips the extension and publishes it as a GitHub release.

## How it works

**Finding blocks (content.js).** For every piece of visible text, walk up the DOM to the unit it belongs to:

1. explicit item markup (`article`, `li`, `tr`, `[role=article]`, …) if it's 25–3000 chars;
2. otherwise the lowest ancestor with ≥2 look-alike siblings (same tag +
   `data-testid` or first class). That's how feeds, cards, search results and
   comments look, whatever the site calls them;
3. otherwise the nearest paragraph/heading.

Navigation, headers, footers, menus, dialogs and form controls are skipped.
A `MutationObserver` picks up infinite scroll and SPA navigation. Only blocks
within 800px of the viewport are ever sent, so off-screen content costs nothing.

**Asking Jev (background.js).** One Noul per (block, keyword):
`Is \`content\` about politics?`, with the block's text inside the question's
structured instructions. All pairs from a batch go into one request (Jev
evaluates them in parallel, ~0.6–1s), and requests are packed by size so each
stays well under Jev's context limit. Answers are cached per (keyword, text), so
adding a keyword only asks about that keyword, and revisiting a feed is free.

**Deciding (content.js).** Pure code over the probabilities, with a threshold of 0.5.
Switching strict mode or pill/vanish never calls the model again.

## Limitations

- Text only: images and video aren't judged (Jev is text-only).
- Content inside shadow DOM and cross-origin iframes isn't scanned.
- Jev is best in English; other languages work with lower accuracy.
