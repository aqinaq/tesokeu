"""Tesokeu local server: static files plus PDF, EPUB, and article extraction."""
from __future__ import annotations

import argparse
import http.client
import html
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import ipaddress
import json
import os
import posixpath
import re
import socket
import ssl
from urllib.parse import unquote, urljoin, urlparse
import xml.etree.ElementTree as ET
import zipfile

import certifi
from pypdf import PdfReader

MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 1_200_000
MAX_ZIP_UNCOMPRESSED = 60 * 1024 * 1024
BLOCK_TAGS = {'p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'br', 'tr'}
SKIP_TAGS = {'script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form'}


class ImportErrorMessage(Exception):
    pass


def clean_text(value: str) -> str:
    value = value.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
    value = re.sub(r'[ \t]+', ' ', value)
    value = re.sub(r' *\n *', '\n', value)
    value = re.sub(r'\n{3,}', '\n\n', value)
    return value.strip()


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ('br', 'hr', 'img', 'meta', 'link', 'input'):
            if tag == 'br' and not any(name in SKIP_TAGS for name in self.stack):
                self.parts.append('\n')
            return
        self.stack.append(tag)
        if tag in BLOCK_TAGS and not any(name in SKIP_TAGS for name in self.stack):
            self.parts.append('\n')

    def handle_startendtag(self, tag, attrs):
        if tag == 'br' and not any(name in SKIP_TAGS for name in self.stack):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in BLOCK_TAGS and not any(name in SKIP_TAGS for name in self.stack):
            self.parts.append('\n')
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            self.stack = self.stack[:index]

    def handle_data(self, data):
        if not any(name in SKIP_TAGS for name in self.stack):
            self.parts.append(data)

    def result(self):
        return clean_text(''.join(self.parts))


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.capture: dict | None = None
        self.title = ''
        self.heading = ''
        self.author = ''
        self.paragraphs: list[tuple[str, bool, bool]] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            key = (attrs.get('property') or attrs.get('name') or '').lower()
            content = html.unescape(attrs.get('content', '')).strip()
            if key in ('og:title', 'twitter:title') and content and not self.title:
                self.title = content
            if key in ('author', 'article:author', 'parsely-author') and content and not self.author:
                self.author = content
        if tag in ('meta', 'br', 'hr', 'img', 'link', 'input'):
            return
        if tag in ('p', 'h1', 'h2', 'h3') and not any(name in SKIP_TAGS for name in self.stack):
            self.capture = {'tag': tag, 'parts': [], 'article': 'article' in self.stack, 'main': 'main' in self.stack}
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.capture and tag == self.capture['tag']:
            value = clean_text(''.join(self.capture['parts']))
            if value:
                if tag == 'h1' and not self.heading:
                    self.heading = value
                if tag == 'p' and len(value) >= 35:
                    self.paragraphs.append((value, self.capture['article'], self.capture['main']))
                elif tag in ('h2', 'h3') and (self.capture['article'] or self.capture['main']):
                    self.paragraphs.append((value, self.capture['article'], self.capture['main']))
            self.capture = None
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            self.stack = self.stack[:index]

    def handle_data(self, data):
        if self.capture and not any(name in SKIP_TAGS for name in self.stack):
            self.capture['parts'].append(data)
        if self.stack and self.stack[-1] == 'title' and data.strip() and not self.title:
            self.title = data.strip()

    def result(self):
        article = [text for text, in_article, _ in self.paragraphs if in_article]
        main = [text for text, _, in_main in self.paragraphs if in_main]
        all_paragraphs = [text for text, _, _ in self.paragraphs]
        chosen = article if sum(map(len, article)) >= 200 else main if sum(map(len, main)) >= 200 else all_paragraphs
        unique = list(dict.fromkeys(chosen))
        return self.heading or self.title, self.author, clean_text('\n\n'.join(unique))


def extract_pdf(data: bytes, filename: str) -> dict:
    try:
        reader = PdfReader(BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise ImportErrorMessage('This PDF is password protected. Unlock it first, then try again.')
        if len(reader.pages) > 800:
            raise ImportErrorMessage('This PDF has too many pages for the local reader (800 maximum).')
        pages = []
        for page in reader.pages:
            pages.append((page.extract_text() or '').strip())
            if sum(map(len, pages)) > MAX_TEXT_CHARS:
                raise ImportErrorMessage('This PDF contains too much text for local browser storage.')
        text = clean_text('\n\n'.join(filter(None, pages)))
    except ImportErrorMessage:
        raise
    except Exception as exc:
        raise ImportErrorMessage('This PDF could not be read. Please check that the file is valid.') from exc
    if len(text.split()) < 10:
        raise ImportErrorMessage('No readable text was found. Scanned image PDFs need OCR before import.')
    metadata = reader.metadata
    title = str(getattr(metadata, 'title', '') or '').strip() if metadata else ''
    author = str(getattr(metadata, 'author', '') or '').strip() if metadata else ''
    return {'title': title or filename.rsplit('.', 1)[0], 'author': author or 'Imported PDF', 'text': text, 'kind': 'pdf'}


def extract_epub(data: bytes, filename: str) -> dict:
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > 5000 or sum(info.file_size for info in infos) > MAX_ZIP_UNCOMPRESSED:
                raise ImportErrorMessage('This EPUB is too large to extract safely.')
            container = ET.fromstring(archive.read('META-INF/container.xml'))
            rootfile = container.find('.//{*}rootfile')
            if rootfile is None or not rootfile.get('full-path'):
                raise ImportErrorMessage('This EPUB has no readable book package.')
            opf_path = rootfile.get('full-path')
            opf = ET.fromstring(archive.read(opf_path))
            title = opf.findtext('.//{http://purl.org/dc/elements/1.1/}title') or filename.rsplit('.', 1)[0]
            author = opf.findtext('.//{http://purl.org/dc/elements/1.1/}creator') or 'Imported EPUB'
            manifest = {item.get('id'): item.get('href') for item in opf.findall('.//{*}manifest/{*}item')}
            chapters = []
            total = 0
            for item in opf.findall('.//{*}spine/{*}itemref'):
                href = manifest.get(item.get('idref'))
                if not href:
                    continue
                path = posixpath.normpath(posixpath.join(posixpath.dirname(opf_path), unquote(href.split('#')[0])))
                if not path.lower().endswith(('.xhtml', '.html', '.htm')):
                    continue
                info = archive.getinfo(path)
                if info.file_size > 5 * 1024 * 1024:
                    raise ImportErrorMessage('An EPUB chapter is too large to extract safely.')
                raw = archive.read(path)
                parser = VisibleText()
                parser.feed(raw.decode('utf-8-sig', errors='replace'))
                chapter = parser.result()
                if chapter:
                    chapters.append(chapter)
                    total += len(chapter)
                if total > MAX_TEXT_CHARS:
                    raise ImportErrorMessage('This EPUB contains too much text for local browser storage.')
            text = clean_text('\n\n'.join(chapters))
    except ImportErrorMessage:
        raise
    except Exception as exc:
        raise ImportErrorMessage('This EPUB could not be read. Please check that the file is valid.') from exc
    if len(text.split()) < 10:
        raise ImportErrorMessage('No readable text was found in this EPUB.')
    return {'title': clean_text(title), 'author': clean_text(author), 'text': text, 'kind': 'epub'}


def public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or len(value) > 2000:
        raise ImportErrorMessage('Enter a public http or https article URL.')
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ImportErrorMessage('The article host could not be found.') from exc
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ImportErrorMessage('Only public article URLs can be imported.')
    return value


def extract_article(url: str) -> dict:
    try:
        for _ in range(6):
            public_url(url)
            parsed = urlparse(url)
            port = parsed.port or (443 if parsed.scheme == 'https' else 80)
            addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
                raise ImportErrorMessage('Only public article URLs can be imported.')
            pinned_ip = addresses[0][4][0]
            connection = (http.client.HTTPSConnection(parsed.hostname, port, timeout=12, context=ssl.create_default_context(cafile=certifi.where()))
                          if parsed.scheme == 'https' else http.client.HTTPConnection(parsed.hostname, port, timeout=12))
            connection._create_connection = lambda address, timeout, source_address=None: socket.create_connection((pinned_ip, port), timeout, source_address)
            try:
                path = parsed.path or '/'
                if parsed.query:
                    path += '?' + parsed.query
                connection.request('GET', path, headers={'Host': parsed.netloc, 'User-Agent': 'Mozilla/5.0 (compatible; TesokeuReader/1.0)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity'})
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader('Location')
                    if not location:
                        raise ImportErrorMessage('The article redirected without a destination.')
                    url = urljoin(url, location)
                    continue
                if response.status >= 400:
                    raise ImportErrorMessage('The article could not be loaded. Try another link or paste the text.')
                if response.headers.get_content_type() not in ('text/html', 'application/xhtml+xml'):
                    raise ImportErrorMessage('This link is not an HTML article.')
                raw = response.read(MAX_HTML_BYTES + 1)
                if len(raw) > MAX_HTML_BYTES:
                    raise ImportErrorMessage('This article page is too large to import.')
                charset = response.headers.get_content_charset() or 'utf-8'
                source_url = url
                break
            finally:
                connection.close()
        else:
            raise ImportErrorMessage('This article redirected too many times.')
    except ImportErrorMessage:
        raise
    except Exception as exc:
        raise ImportErrorMessage('The article could not be loaded. Try another link or paste the text.') from exc
    parser = ArticleParser()
    parser.feed(raw.decode(charset, errors='replace'))
    title, author, text = parser.result()
    if len(text.split()) < 25:
        raise ImportErrorMessage('Not enough article text was found. This site may block automated reading; try pasting its text.')
    if len(text) > MAX_TEXT_CHARS:
        raise ImportErrorMessage('This article contains too much text for local browser storage.')
    return {'title': title or urlparse(source_url).hostname, 'author': author or urlparse(source_url).hostname, 'text': text, 'kind': 'article', 'sourceUrl': source_url}


class Handler(SimpleHTTPRequestHandler):
    ALLOWED_FILES = {
        'index.html', 'library.html', 'insights.html', 'guide.html',
        'styles.css', 'pages.css', 'data.js', 'app.js', 'pages.js', 'import.js',
    }

    def allowed_static(self):
        path = urlparse(self.path).path.lstrip('/') or 'index.html'
        return path in self.ALLOWED_FILES

    def do_GET(self):
        if not self.allowed_static():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not self.allowed_static():
            return self.send_error(404)
        return super().do_HEAD()

    def send_json(self, status: int, data: dict):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path not in ('/api/import-file', '/api/import-url'):
            return self.send_json(404, {'error': 'Unknown endpoint.'})
        origin = self.headers.get('Origin')
        if origin:
            parsed_origin = urlparse(origin)
            if parsed_origin.scheme not in ('http', 'https') or parsed_origin.netloc != self.headers.get('Host') or parsed_origin.path not in ('', '/'):
                return self.send_json(403, {'error': 'This request must come from Tesokeu.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            limit = MAX_FILE_BYTES if self.path == '/api/import-file' else 4096
            if length <= 0 or length > limit:
                raise ImportErrorMessage('The import is empty or too large.')
            body = self.rfile.read(length)
            if self.path == '/api/import-file':
                filename = unquote(self.headers.get('X-File-Name', ''))
                if len(filename) > 255:
                    raise ImportErrorMessage('The filename is too long.')
                if filename.lower().endswith('.pdf'):
                    result = extract_pdf(body, filename)
                elif filename.lower().endswith('.epub'):
                    result = extract_epub(body, filename)
                else:
                    raise ImportErrorMessage('Choose a PDF or EPUB file.')
            else:
                payload = json.loads(body.decode('utf-8'))
                result = extract_article(str(payload.get('url', '')).strip())
            self.send_json(200, result)
        except ImportErrorMessage as exc:
            self.send_json(400, {'error': str(exc)})
        except (ValueError, UnicodeError, json.JSONDecodeError):
            self.send_json(400, {'error': 'The import request is not valid.'})


def main():
    parser = argparse.ArgumentParser(description='Run the Tesokeu local reader server')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '4173')))
    parser.add_argument('--host', default='0.0.0.0' if os.environ.get('PORT') else '127.0.0.1')
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Tesokeu is running at http://{args.host}:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
