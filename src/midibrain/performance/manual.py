"""Read-only, bundled documentation; no MIDI Session or internet access needed."""
import json
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, Response

HERE = Path(__file__).parent
ASSETS = {
    '/manual.js': ('manual.js', 'text/javascript'),
    '/manual-model.mjs': ('manual-model.mjs', 'text/javascript'),
    '/manual-context.mjs': ('manual-context.mjs', 'text/javascript'),
    '/manual.css': ('manual.css', 'text/css'),
}


@lru_cache(maxsize=1)
def manual_bundle():
    directory = HERE / 'manual'
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    return {**manifest, 'pages': [
        {**page, 'markdown': (directory / f"{page['id']}.md").read_text(encoding='utf-8')}
        for page in manifest['pages']
    ]}


def register(app):
    @app.get('/manual', response_class=HTMLResponse)
    def manual_page():
        return (HERE / 'manual.html').read_text(encoding='utf-8')

    @app.get('/api/manual')
    def manual_index():
        return manual_bundle()

    @app.get('/manual/source/{page_id}.md')
    def manual_source(page_id: str):
        # Resolve only manifest IDs, never turn a request path into a file path.
        page = next((item for item in manual_bundle()['pages'] if item['id'] == page_id), None)
        if page is None:
            raise HTTPException(404, 'Manual page not found')
        return Response(page['markdown'], media_type='text/markdown')

    def make_asset(name, media):
        def asset():
            return Response((HERE / name).read_text(encoding='utf-8'), media_type=media,
                            headers={'Cache-Control': 'no-cache'})
        return asset

    for route, (name, media) in ASSETS.items():
        app.get(route)(make_asset(name, media))
