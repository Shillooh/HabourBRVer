#!/usr/bin/env python3
"""Generate the Jellyfin catalogue from the three packaged release archives."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parent.parent
repository = 'Shillooh/HabourBRVer'
release_url_prefix = f'https://github.com/{repository}/releases/download/'
previous_release_url_prefix = release_url_prefix
release = json.loads((root / 'package.json').read_text())['version']
plugin_id = '1a06b74f-7609-4af9-899d-430c9b5a52b1'
client_hash = hashlib.sha256((root / 'dist/jellyfin-tv-layout.js').read_bytes()).hexdigest()
timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
versions = []
for target in ['12.0.0', '10.11.0', '10.10.7']:
    version = release
    archive = root / 'dist/releases' / f'TvItemLayout_{version}_jellyfin-{target}.zip'
    data = archive.read_bytes()
    with ZipFile(archive) as package:
        assert package.testzip() is None, f'Corrupt archive: {archive.name}'
        info = json.loads(package.read('build-info.json'))
        assert info['id'] == plugin_id and info['version'] == version
        assert info['jellyfinVersion'] == target and info['clientSha256'] == client_hash
        assert 'Jellyfin.Plugin.TvItemLayout.dll' in package.namelist()
        for name in ('CREDITS.md', 'JELLYFIN-LICENSE.md', 'jellyfin-icon--color-on-dark.svg'):
            assert 'assets/loading/' + name in package.namelist(), f'Missing loading-artwork credit or source: {name}'
        for asset in (root / 'assets/seasonal-fonts').glob('*-OFL.txt'):
            assert package.read('assets/seasonal-fonts/' + asset.name) == asset.read_bytes(), f'Missing font licence: {asset.name}'
    assert archive.with_suffix('.zip.sha256').read_text().split()[0] == hashlib.sha256(data).hexdigest()
    versions.append({
        'version': version,
        'changelog': 'Lançamento inicial do ScreenHarbour Brasil 1.0.0.0. Hard fork independente com interface cinematográfica totalmente em português (pt-BR), fileiras dinâmicas de filmes e séries Em Alta via TMDB cruzadas com o catálogo local, novos presets de streaming brasileiros e melhorias de navegação.',
        'targetAbi': target,
        'sourceUrl': f'{release_url_prefix}v{release}/{archive.name}',
        # Jellyfin catalogue protocol requires MD5; SHA-256 files are also published.
        'checksum': hashlib.md5(data).hexdigest(),
        'timestamp': timestamp,
    })

manifest_path = root / 'manifest.json'
if manifest_path.exists():
    previous = next((item for item in json.loads(manifest_path.read_text()) if item['guid'] == plugin_id), None)
    if previous:
        current = {item['version'] for item in versions}
        # This is a rename of the same repository: its existing release assets
        # move with it. Keep their versions/checksums and canonicalise only URLs
        # from the known former name; unrelated repositories stay excluded.
        for item in previous['versions']:
            if item['version'] in current:
                continue
            source_url = item.get('sourceUrl', '')
            if source_url.startswith(previous_release_url_prefix):
                source_url = release_url_prefix + source_url[len(previous_release_url_prefix):]
            if source_url.startswith(release_url_prefix):
                versions.append({**item, 'sourceUrl': source_url})
versions.sort(key=lambda item: tuple(map(int, item['version'].split('.'))), reverse=True)
manifest = [{
    'guid': plugin_id,
    'name': 'ScreenHarbour Brasil',
    'overview': 'Interface cinematográfica premium para Jellyfin (Edição Brasil), com integração TMDB dinâmica e navegação in-player.',
    'description': 'Interface cinematográfica independente para Jellyfin em modos TV e Desktop, totalmente localizada para o Brasil (pt-BR). Conta com fileiras dinâmicas "Em Alta" que consultam a API do TMDB diariamente e cruzam com o acervo da sua biblioteca local, presets nacionais de streaming (Globoplay, Max, Prime Video, Netflix, Brasil Paralelo, Disney+, Paramount+, etc.), guia de TV ao vivo horizontal, tela de pausa estilizada e navegação in-player fluida. Mantido por Shillooh.',
    'owner': 'Shillooh',
    'category': 'General',
    'imageUrl': f'https://raw.githubusercontent.com/{repository}/main/assets/catalogue/screenharbour.png',
    'versions': versions,
}]
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Generated {manifest_path.name} for v{release} with {len(versions)} package versions.')
