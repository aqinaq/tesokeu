const TesokeuImport = (() => {
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const extension = name => name.toLowerCase().split('.').pop();

  async function result(response) {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('The import service is unavailable. Try again in a moment.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'This import could not be completed.');
    return data;
  }

  async function file(file) {
    if (!file) throw new Error('Choose a .txt, .pdf, or .epub file.');
    const ext = extension(file.name);
    if (!['txt', 'pdf', 'epub'].includes(ext)) throw new Error('Choose a .txt, .pdf, or .epub file.');
    if (file.size > MAX_FILE_BYTES || (ext === 'txt' && file.size > 2 * 1024 * 1024)) {
      throw new Error(ext === 'txt' ? 'Text files must be smaller than 2 MB.' : 'PDF and EPUB files must be smaller than 12 MB.');
    }
    if (ext === 'txt') {
      const text = (await file.text()).trim();
      if (!text) throw new Error('This text file is empty.');
      return { title: file.name.replace(/\.txt$/i, ''), author: 'Your bookshelf', text, kind: 'txt' };
    }
    let response;
    try {
      response = await fetch('/api/import-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file
      });
    } catch {
      throw new Error('The import service could not be reached. Try again in a moment.');
    }
    return result(response);
  }

  async function article(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid article link.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Enter an http or https article link.');
    let response;
    try {
      response = await fetch('/api/import-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: parsed.href })
      });
    } catch {
      throw new Error('The article service could not be reached. Try again in a moment.');
    }
    return result(response);
  }

  return { file, article };
})();
