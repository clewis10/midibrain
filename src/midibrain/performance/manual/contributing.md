# Contributing to the wiki

The canonical wiki lives in `src/midibrain/performance/manual/`. These Markdown files serve both the in-app reader and repository readers. Keep one copy of each article so GitHub contributions and application updates stay in step.

## Write for a musician using the app

Start with what the feature does, then how to reach it and how it connects to other features. Use the exact current UI labels. Explain one concrete route or gesture before listing unusual options. Link related pages instead of repeating their full explanations.

Distinguish implemented behavior, simulation checks, physical hardware validation and future ideas. A successful output request is not a device acknowledgment. Avoid describing a historical deployment path as a universal installation default.

For each new feature, cover its input, output, settings, persistence boundary, interactions and likely failure mode. Include a short recipe when a user would otherwise have to infer the wiring order.

## Add or change a page

1. Add a lowercase hyphenated `.md` filename in the manual directory.
2. Add its ID, exact app title, section, parent (or null), kind (reference, guide or example), summary and search keywords to `manifest.json`. Place an example under the feature it demonstrates; use an app object or panel as the parent of a setting.
3. Link it from the home page or its parent, and from related entries. The reader derives related entries and backlinks from Markdown links.
4. Add or update `manual-context.mjs` for the relevant node, wire, Add item, panel, section or field. Ambiguous labels such as IN/OUT need the selection context; a Device input is sync, not a Control input binding.
5. Run the manual tests, including the link/anchor coverage check.

The manifest controls topic hierarchy, navigation order and search metadata. A–Z uses article titles. Keep parent links acyclic. Add a `redirects` entry such as `"mappings#feedback": "feedback"` when moving an existing page or section; update all Markdown links too so repository viewers work without the reader. The package-data configuration includes the manual's Markdown and JSON, so the same articles ship in an installed wheel. Restart the web server after editing articles to refresh its cached bundle.

## Markdown conventions

The reader supports headings, paragraphs, ordered and unordered flat lists, bold, emphasis, inline code, fenced code, blockquotes, links and simple tables. Keep content text-focused. Raw HTML is displayed as text, not executed. Images, nested lists and advanced Markdown extensions are intentionally outside this small renderer's supported subset.

Use relative links such as `[Feedback](feedback.md)`. They work as Markdown in the repository and become reader navigation in the app. Headings generate lowercase hyphenated anchors. Keep headings unique within a page and update incoming links when renaming one.

Use HTTPS links for external references when needed. External links are optional reading; the wiki itself must remain usable without internet access. Do not embed remote scripts, stylesheets or fonts.

## GitHub and sharing

The repository already contains a browsable wiki-style guide through the wiki's home page. Link to that file from the project README. GitHub's separate Wiki is another repository; publishing there would require copying/synchronizing these articles or a later export workflow. Do not create a second hand-maintained source of truth.

When collecting feedback, ask for the expected/actual behavior, source version, OS, hardware model/firmware, route addresses and a minimal reproduction. A demo example is useful for UI/model issues; physical MIDI reports should say what was actually connected and observed.

## Verification

The manual's tests check that every manifest page exists, internal links and inspector targets resolve, search ranks useful matches, rendering treats unsafe markup as text and the web routes do not mutate the MIDI session. Browser coverage checks the reader and inspector links with the demo server. Package checks ensure documentation ships with the app.

When software behavior changes, update the matching article in the same change. Documents under `docs/` are design notes and should not silently override the current user guide.
