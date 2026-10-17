import os
import subprocess
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import shutil

root = Path(__file__).resolve().parent.parent
project = root / 'server/Jellyfin.Plugin.TvItemLayout.csproj'
release_version = "1.5"
plugin_id = "c985bcfd-992f-4a16-a583-258014d98d75"

# Target definitions ordered from highest to lowest ABI
targets = [
    ("12.0.0", "net10.0"),
    ("10.11.0", "net9.0"),
    ("10.10.7", "net8.0"),
]

# Ensure client script is built
client_script = root / 'dist/jellyfin-tv-layout.js'
if not client_script.exists():
    print("Building client script...")
    subprocess.run(["npm", "run", "build"], cwd=str(root), check=True)

client_hash = hashlib.sha256(client_script.read_bytes()).hexdigest()

releases_dir = root / 'dist/releases'
releases_dir.mkdir(parents=True, exist_ok=True)
# Clean old release archives in dist/releases
for old_f in releases_dir.glob("*.zip*"):
    old_f.unlink()

packages_dir = root / 'packages'
packages_dir.mkdir(parents=True, exist_ok=True)
# Clean old packages
for old_f in packages_dir.glob("*.zip*"):
    old_f.unlink()

versions_manifest = []

for jellyfin_version, framework in targets:
    print(f"\n--- Building for Jellyfin {jellyfin_version} ({framework}) - Plugin v{release_version} ---")
    cmd = [
        "dotnet", "build", str(project),
        "--configuration", "Release",
        "--nologo",
        f"-p:JellyfinVersion={jellyfin_version}",
        f"-p:ReleaseVersion={release_version}"
    ]
    subprocess.run(cmd, cwd=str(root), check=True)

    assembly = root / f"server/bin/Release/{framework}/Jellyfin.Plugin.TvItemLayout.dll"
    assert assembly.exists(), f"Assembly not found: {assembly}"

    archive = releases_dir / f"TvItemLayout_{release_version}_jellyfin-{jellyfin_version}.zip"
    print(f"Packaging {archive.name}...")
    with ZipFile(archive, 'w', ZIP_DEFLATED) as zip_out:
        zip_out.write(assembly, assembly.name)
        zip_out.write(root / 'server/LICENSE.InPlayerEpisodePreview.md', 'LICENSE.InPlayerEpisodePreview.md')
        for name in ('CREDITS.md', 'JELLYFIN-LICENSE.md', 'jellyfin-icon--color-on-dark.svg'):
            zip_out.write(root / 'assets/loading' / name, 'assets/loading/' + name)
        for asset in sorted((root / 'assets/seasonal').glob('*.md')):
            zip_out.write(asset, 'assets/seasonal/' + asset.name)
        for asset in sorted((root / 'assets/seasonal-fonts').iterdir()):
            if asset.suffix in ('.md', '.txt', '.json'):
                zip_out.write(asset, 'assets/seasonal-fonts/' + asset.name)
        zip_out.write(root / 'docs/server.md', 'INSTALL.md')
        zip_out.writestr('build-info.json', json.dumps({
            'name': 'ScreenHarbour Brasil',
            'id': plugin_id,
            'version': release_version,
            'jellyfinVersion': jellyfin_version,
            'clientSha256': client_hash,
        }, indent=2) + '\n')

    data = archive.read_bytes()
    sha256_hash = hashlib.sha256(data).hexdigest()
    md5_hash = hashlib.md5(data).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{sha256_hash}  {archive.name}\n')

    # Copy to packages/
    shutil.copy2(archive, packages_dir / archive.name)
    shutil.copy2(archive.with_suffix('.zip.sha256'), packages_dir / f"{archive.name}.sha256")

    versions_manifest.append({
        'version': release_version,
        'changelog': f'ScreenHarbour Brasil v{release_version} para Jellyfin {jellyfin_version}. Adicionado reprodutor integrado LiveTV Box com suporte a MPEG-TS e HLS, catálogo horizontal de canais ao vivo com suporte a Premiere isolado, filtragem estrita de canais locais por estado (sem vazamentos regionais), sincronização de configurações globais e por usuário no painel administrativo e diversas otimizações de performance.',
        'targetAbi': jellyfin_version,
        'sourceUrl': f'https://raw.githubusercontent.com/Shillooh/HabourBRVer/main/packages/{archive.name}',
        'checksum': md5_hash,
        'timestamp': '2026-10-17T03:00:00Z',
    })

manifest = [{
    'guid': plugin_id,
    'name': 'ScreenHarbour Brasil',
    'overview': 'Interface cinematográfica premium para Jellyfin (Edição Brasil), com integração TMDB dinâmica e navegação in-player.',
    'description': 'Interface cinematográfica para Jellyfin em modos TV e Desktop, totalmente localizada para o Brasil (pt-BR). Conta com fileiras dinâmicas "Em Alta" que consultam a API do TMDB diariamente e cruzam com o acervo da sua biblioteca local, presets nacionais de streaming (Globoplay, Max, Prime Video, Netflix, Brasil Paralelo, Disney+, Paramount+, etc.), guia de TV ao vivo horizontal, tela de pausa estilizada e navegação in-player fluida. Mantido por Shillooh.',
    'owner': 'Shillooh',
    'category': 'General',
    'imageUrl': 'https://raw.githubusercontent.com/Shillooh/HabourBRVer/main/assets/catalogue/screenharbour.png',
    'versions': versions_manifest,
}]

manifest_path = root / 'manifest.json'
manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(f"\nGenerated {manifest_path.name} with updated checksums and GUID {plugin_id}.")

# Copy to local downloads/pruu directory if present
pruu_env = os.environ.get("PRUU_DIR")
pruu_dir = Path(pruu_env) if pruu_env else (Path.home() / "Downloads" / "pruu")
pruu_dir.mkdir(parents=True, exist_ok=True)

# Clean legacy versions from pruu_dir
for old_pruu in pruu_dir.glob("TvItemLayout_1.0.0.[123]*"):
    try:
        old_pruu.unlink()
    except Exception:
        pass

for jellyfin_version, framework in targets:
    src_dll = root / f"server/bin/Release/{framework}/Jellyfin.Plugin.TvItemLayout.dll"
    dest_dll = pruu_dir / f"Jellyfin.Plugin.TvItemLayout_jellyfin-{jellyfin_version}.dll"
    shutil.copy2(src_dll, dest_dll)
    print(f"Copied {dest_dll.name} to {pruu_dir}")

    # Subpastas dedicadas prontas para uso direto
    folder_mapping = {
        "12.0.0": "Jellyfin_12.x_(net10.0)",
        "10.11.0": "Jellyfin_10.11.x_(net9.0)",
        "10.10.7": "Jellyfin_10.10.x_(net8.0)",
    }
    target_folder = pruu_dir / folder_mapping.get(jellyfin_version, f"Jellyfin_{jellyfin_version}")
    target_folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_dll, target_folder / "Jellyfin.Plugin.TvItemLayout.dll")
    print(f"Copied {src_dll.name} into {target_folder}")

# Default Jellyfin 10.11.x DLL na raiz
shutil.copy2(root / "server/bin/Release/net9.0/Jellyfin.Plugin.TvItemLayout.dll", pruu_dir / "Jellyfin.Plugin.TvItemLayout.dll")
print(f"Copied default net9.0 Jellyfin.Plugin.TvItemLayout.dll to {pruu_dir}")

# Copy zip archives too
for archive in releases_dir.glob("*.zip*"):
    shutil.copy2(archive, pruu_dir / archive.name)
    print(f"Copied release archive {archive.name} to {pruu_dir}")

