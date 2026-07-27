#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v npm >/dev/null 2>&1; then
  npm run compile
else
  NODE_CLI="${NODE_CLI:-$(command -v node || true)}"
  if [ -z "$NODE_CLI" ]; then
    echo "Neither npm nor node in PATH; cannot compile." >&2
    exit 1
  fi
  "$NODE_CLI" "$ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/"
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/extension"
cp package.json "$STAGE/extension/"
cp -r out themes media "$STAGE/extension/"

VER=$(node -p "require('./package.json').version")
PUB=$(node -p "require('./package.json').publisher")
NAME=$(node -p "require('./package.json').name")
DISP=$(node -p "require('./package.json').displayName")
DESC=$(node -p "require('./package.json').description")

cat >"$STAGE/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VER}" Publisher="${PUB}"/>
    <DisplayName>${DISP}</DisplayName>
    <Description xml:space="preserve">${DESC}</Description>
    <Categories>SCM Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

cat >"$STAGE/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".png" ContentType="image/png" />
</Types>
EOF

OUT="${ROOT}/${NAME}-${VER}.vsix"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" extension extension.vsixmanifest '[Content_Types].xml')
echo "Wrote $OUT"
