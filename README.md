# Tesokeu

Tesokeu (тез оқу, “read fast”) is a focused reading website. It shows one word at a time while you choose the pace.

## Pages

- **Reader:** one-word display, adjustable speed (100–900 WPM), play/pause, skipping, position slider with text preview, bookmarks, focus view, nearby text, themes, word size, and punctuation pauses.
- **Bookshelf:** sample reads, pasted text, PDF/EPUB/TXT upload, public article links, search, filters, sorting, saved positions, and JSON backup/restore.
- **Insights:** words read, focus time, sessions, completed reads, a seven-day activity chart, and an optional weekly reading goal.
- **Guide:** product explanation, keyboard shortcuts, and answers to common questions.

Books, extracted article text, bookmarks, progress, preferences, activity, and the weekly goal are saved in this browser's local storage. Existing data from the earlier Stillword prototype is retained. Use **Download backup** on the Bookshelf page to save a JSON copy; restoring one replaces the current browser data after confirmation. The local server extracts text and returns it to the browser; it does not store uploaded files or fetched articles.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

Then open [http://localhost:4173](http://localhost:4173). The import features require this server. PDF and EPUB files may be up to 12 MB; TXT files may be up to 2 MB. Image-only PDFs need OCR first. Article links must be public HTTP or HTTPS pages with extractable text. Large extracted books can exceed browser storage, in which case the app reports the problem.

Keyboard shortcuts in the reader: Space to play or pause, Left and Right to skip 10 words, Up and Down to change speed.

Run parser tests with `.venv/bin/python -m unittest discover -s tests -v`.

## Deploy

The included `render.yaml` configures a free Python web service on Render. Connect this repository through Render's Blueprint flow. The service installs `requirements.txt`, runs `python server.py`, and listens on Render's `PORT`. The same server provides the pages and the PDF, EPUB, and article import endpoints. Reading data remains in each visitor's browser and does not sync between devices.
