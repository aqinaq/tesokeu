# Tesokeu

Tesokeu is a focused reading website. It uses RSVP to show one word at a time while the reader chooses a comfortable pace; it does not claim to increase reading speed.

## Pages

- **Reader:** selecting a book opens a dedicated reading page with a one-word display, adjustable speed (100–900 WPM), play/pause, skipping, position slider with text preview, exact word navigation, bookmarks, focus view, nearby text, themes, word size, and punctuation pauses.
- **Bookshelf:** sample reads, pasted text, PDF/EPUB/TXT upload, public article links, search, filters, sorting, saved positions, and JSON backup/restore.
- **Insights:** words read, focus time, sessions, completed reads, a seven-day activity chart, and an optional weekly reading goal.
- **Guide:** product explanation, keyboard shortcuts, and answers to common questions.

## Mountain integration

This reader is a good candidate for an optional Mountain focus mode, rather than a replacement for Mountain's normal document view. The smallest integration surface is a link or action that passes plain text, title, author, and an optional saved word position into the reader. Keep the conventional document view one action away, preserve the same content permissions, and return progress only after the reader opts in. Before shipping, test keyboard access, 200% browser zoom, larger default text, reduced motion, and long unbroken tokens inside Mountain's actual content frame.

Books, extracted article text, bookmarks, progress, preferences, activity, and the weekly goal are saved in this browser's local storage. Optional device sync copies this data to a protected online collection so paired browsers can exchange changes. Existing data from the earlier Stillword prototype is retained. Use **Download backup** on the Bookshelf page to save a JSON copy; restoring one replaces the current browser data after confirmation. The import server extracts text and returns it to the browser; it does not retain uploaded files or fetched articles outside an opted-in synced collection.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

Then open [http://localhost:4173](http://localhost:4173). The import features require this server. PDF and EPUB files may be up to 12 MB; TXT files may be up to 2 MB. Image-only PDFs need OCR first. Article links must be public HTTP or HTTPS pages with extractable text. Large extracted books can exceed browser storage, in which case the app reports the problem.

Keyboard shortcuts in the reader: Space to play or pause, Left and Right to skip 10 words, Up and Down to change speed.

Run import and sync tests with `.venv/bin/python -m unittest discover -s tests -v`. Run reader regression tests with `node --test tests/test_reader.cjs` (Node.js 18+).

During playback, word lists are cached and progress is saved at most once per second, with an immediate save when pausing, hiding the tab, or leaving the page.

## Deploy

The included `render.yaml` configures a free Python web service on Render. Connect this repository through Render's Blueprint flow. The service installs `requirements.txt`, runs `python server.py`, and listens on Render's `PORT`. The same server provides the pages and the PDF, EPUB, article import, and optional device sync endpoints. Reading data remains in each visitor's browser until they opt in to device sync.

To enable device sync, configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as secret environment variables on the web service. The Redis database must be durable; the web service's local filesystem is not. The 12-character pairing code expires after 10 minutes and can be used once. The device credential stays in each browser's local storage. Backups intentionally do not include that credential.
