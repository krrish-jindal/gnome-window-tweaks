#!/usr/bin/env bash
# Run every test. Needs: node (>= 18), python3, and libglib2.0-bin for the install test.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null 2>&1 || { echo "node is required to run the tests"; exit 1; }

echo "== syntax =="
node --check wintile@nowsci.com/extension.js && echo "  extension.js parses"
for f in focus-opacity/bin/* tools/wintile-never-tile; do
    python3 -I -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$f" && echo "  $f parses"
done
for f in install.sh uninstall.sh tests/install_test.sh tests/run.sh; do
    bash -n "$f" && echo "  $f parses"
done

echo; echo "== WinTile: orientation layout (landscape output must equal the pre-orientation version) =="
node tests/orientation_test.js tests/fixtures/extension.pre-orientation.js wintile@nowsci.com/extension.js

echo; echo "== WinTile: drag-to-swap =="
node tests/swap_test.js wintile@nowsci.com/extension.js

echo; echo "== install / uninstall (sandboxed HOME) =="
bash tests/install_test.sh
