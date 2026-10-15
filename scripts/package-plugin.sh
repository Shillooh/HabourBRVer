#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_dir/server/Jellyfin.Plugin.TvItemLayout.csproj"
target="${1:-10.11.0}"
release_version="1.0.0.0"

case "$target" in
    all) targets=(10.10.7 10.11.0 12.0.0) ;;
    10.10.7|10.11.*|12.*) targets=("$target") ;;
    *) echo "Usage: $0 [10.10.7|10.11.x|12.x|all]" >&2; exit 1 ;;
esac

command -v dotnet >/dev/null || { echo 'A compatible .NET SDK is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required to create the ZIP archive.' >&2; exit 1; }
cd "$repo_dir"
if [[ ! -d node_modules ]]; then
    npm ci
fi
npm run build
mkdir -p "$repo_dir/dist/releases"

for jellyfin_version in "${targets[@]}"; do
    case "$jellyfin_version" in
        10.10.7) framework=net8.0; plugin_version="$release_version" ;;
        10.11.*) framework=net9.0; plugin_version="$release_version" ;;
        12.*) framework=net10.0; plugin_version="$release_version" ;;
    esac
    dotnet build "$project" --configuration Release --nologo -p:JellyfinVersion="$jellyfin_version" -p:ReleaseVersion="$release_version"
    assembly="$repo_dir/server/bin/Release/$framework/Jellyfin.Plugin.TvItemLayout.dll"
    archive="$repo_dir/dist/releases/TvItemLayout_${plugin_version}_jellyfin-${jellyfin_version}.zip"
    python3 - "$repo_dir" "$assembly" "$archive" "$jellyfin_version" "$plugin_version" <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json
import sys

root, assembly, output = map(Path, sys.argv[1:4])
jellyfin_version, plugin_version = sys.argv[4:6]
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.write(assembly, assembly.name)
    archive.write(root / 'server/LICENSE.InPlayerEpisodePreview.md', 'LICENSE.InPlayerEpisodePreview.md')
    for name in ('CREDITS.md', 'JELLYFIN-LICENSE.md', 'jellyfin-icon--color-on-dark.svg'):
        archive.write(root / 'assets/loading' / name, 'assets/loading/' + name)
    for asset in sorted((root / 'assets/seasonal').glob('*.md')):
        archive.write(asset, 'assets/seasonal/' + asset.name)
    for asset in sorted((root / 'assets/seasonal-fonts').iterdir()):
        if asset.suffix in ('.md', '.txt', '.json'):
            archive.write(asset, 'assets/seasonal-fonts/' + asset.name)
    archive.write(root / 'docs/server.md', 'INSTALL.md')
    archive.writestr('build-info.json', json.dumps({
        'name': 'ScreenHarbour Brasil',
        'id': 'c985bcfd-992f-4a16-a583-258014d98d75',
        'version': plugin_version,
        'jellyfinVersion': jellyfin_version,
        'clientSha256': hashlib.sha256((root / 'dist/jellyfin-tv-layout.js').read_bytes()).hexdigest(),
    }, indent=2) + '\n')
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(f'{checksum}  {output.name}\n')
print(f'Packaged {output}')
PY
done
