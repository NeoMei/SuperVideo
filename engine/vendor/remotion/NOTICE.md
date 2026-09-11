# Headless Remotion browser entry

`render-entry.mjs` derives from the published `@remotion/studio` 4.0.522 render entry. That package declares the MIT license and credits Jonny Burger. The MIT notice is retained in `LICENSE.MIT`. Its npm distribution does not include a separate license file.

SuperVideo removed the index-mode Studio loader, loading spinner and unused helpers, and inlined only the two color constants used by headless rendering. Composition evaluation, metadata resolution, renderer hooks and composition rendering are retained. A small optional hook mounts SuperVideo's own read-only preview controls within the composition timeline; playback uses core contexts, without the upstream Studio UI. The complete Studio, its editor and development server are not included. See `provenance.json` for exact source hashes and modifications. Run `node scripts/vendor-remotion.mjs /path/to/pinned/node_modules` to reproduce from the matching installed npm packages; this maintainer script does not download anything.

The production `remotion` core and `@remotion/renderer` dependencies retain their separate Remotion license. `REMOTION-LICENSE.md` is copied verbatim from the pinned core package for visibility. The application's Apache-2.0 license does not relicense these dependencies or this entry.
