import io
import json
import threading
import unittest
import zipfile
from email.message import Message
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from server import ArticleParser, Handler, ImportErrorMessage, extract_article, extract_epub, extract_pdf, public_url


class ImportTests(unittest.TestCase):
    def test_pdf_text_and_metadata(self):
        writer = PdfWriter()
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({
            NameObject('/Type'): NameObject('/Font'),
            NameObject('/Subtype'): NameObject('/Type1'),
            NameObject('/BaseFont'): NameObject('/Helvetica'),
        })
        font_ref = writer._add_object(font)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font_ref})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 72 720 Td (The quick brown fox jumps over the lazy dog and keeps reading every single word.) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        writer.add_metadata({'/Title': 'PDF sample', '/Author': 'Test Writer'})
        output = io.BytesIO()
        writer.write(output)
        result = extract_pdf(output.getvalue(), 'sample.pdf')
        self.assertEqual(result['title'], 'PDF sample')
        self.assertEqual(result['author'], 'Test Writer')
        self.assertIn('quick brown fox', result['text'])

    def test_epub_spine_order_and_metadata(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
            archive.writestr('OEBPS/content.opf', '''<package xmlns="http://www.idpf.org/2007/opf"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">EPUB sample</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Test Author</dc:creator></metadata><manifest><item id="second" href="two.xhtml"/><item id="first" href="one.xhtml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>''')
            archive.writestr('OEBPS/one.xhtml', '<html><body><p>First chapter has several words for the reader to show in order.</p></body></html>')
            archive.writestr('OEBPS/two.xhtml', '<html><body><p>Second chapter follows the first chapter and adds more words.</p></body></html>')
        result = extract_epub(output.getvalue(), 'sample.epub')
        self.assertEqual(result['title'], 'EPUB sample')
        self.assertEqual(result['author'], 'Test Author')
        self.assertLess(result['text'].index('First chapter'), result['text'].index('Second chapter'))

    def test_article_ignores_navigation(self):
        parser = ArticleParser()
        parser.feed('''<html><head><meta property="og:title" content="Article title"><meta name="author" content="A Writer"></head><body><nav><p>Navigation links and other filler that should never become part of the article body.</p></nav><article><h1>Article title</h1><p>Here is a full paragraph of article text that is long enough to be useful to a focused reader.</p><p>Here is another paragraph with more words, giving the article enough substance to select.</p><p>The third paragraph completes the article and provides a clear ending for the import test.</p></article></body></html>''')
        title, author, text = parser.result()
        self.assertEqual(title, 'Article title')
        self.assertEqual(author, 'A Writer')
        self.assertIn('full paragraph', text)
        self.assertNotIn('Navigation links', text)

    def test_private_article_url_is_rejected(self):
        for url in ('http://127.0.0.1:4173/', 'http://localhost/', 'file:///etc/passwd'):
            with self.subTest(url=url), self.assertRaises(ImportErrorMessage):
                public_url(url)

    def test_article_preserves_line_breaks_and_self_closing_elements(self):
        parser = ArticleParser()
        parser.feed('<article><p>First line of a paragraph with enough readable text.<br>Second line<br/>Third line<svg/> and the ending.</p></article>')
        text = parser.result()[2]
        self.assertIn('text.\nSecond line\nThird line', text)
        self.assertIn('and the ending.', text)

    def test_article_falls_back_from_unknown_charset(self):
        response = MagicMock()
        response.status = 200
        response.headers = Message()
        response.headers['Content-Type'] = 'text/html; charset=made-up-encoding'
        response.read.return_value = ('<article><p>' + 'Readable article text. ' * 15 + '</p></article>').encode()
        connection = MagicMock()
        connection.getresponse.return_value = response
        addresses = [(2, 1, 6, '', ('93.184.216.34', 80))]
        with patch('server.socket.getaddrinfo', return_value=addresses), patch('server.http.client.HTTPConnection', return_value=connection):
            result = extract_article('http://example.com/article')
        self.assertIn('Readable article text.', result['text'])
        connection.close.assert_called_once()


class ImportHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_malformed_article_requests_return_json_errors(self):
        for payload in ([], None, 'url', 123, {}, {'url': []}):
            with self.subTest(payload=payload):
                request = Request(self.origin + '/api/import-url', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
                with self.assertRaises(HTTPError) as error:
                    urlopen(request, timeout=5)
                self.assertEqual(error.exception.code, 400)
                self.assertIn('error', json.load(error.exception))

    def test_private_files_are_not_served(self):
        for path in ('/server.py', '/.git/config', '/requirements.txt'):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                urlopen(self.origin + path, timeout=5)
            self.assertEqual(error.exception.code, 404)

    def test_static_assets_revalidate_after_updates(self):
        for path in ('/', '/app.js', '/styles.css'):
            with self.subTest(path=path), urlopen(self.origin + path, timeout=5) as response:
                self.assertEqual(response.headers['Cache-Control'], 'no-cache')

    def test_cross_origin_import_is_rejected(self):
        request = Request(self.origin + '/api/import-url', data=b'{"url":"http://example.com"}', headers={'Origin': 'https://other.example'})
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
