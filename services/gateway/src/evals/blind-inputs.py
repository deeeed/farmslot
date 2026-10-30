"""Inspect worker-facing task files without returning their contents."""
import json
from pathlib import Path
import sys

request = json.loads(sys.argv[1])
root = Path(request['root'])
markers = [value.lower() for value in request['markers'] if value]
blocked = {'experiment-manifest.json', 'reference-pr.json', 'reference-context.json',
           'reference-diff.txt', 'reference.result-package.json', 'eval-source.json'}
count = 0
for path in root.rglob('*'):
    relative = str(path.relative_to(root))
    if path.is_symlink():
        raise RuntimeError('A worker input is a symbolic link: ' + relative)
    if not path.is_file():
        continue
    if path.name in blocked or any(marker in relative.lower() for marker in markers):
        raise RuntimeError('Reference material is named in worker inputs: ' + relative)
    if path.name == '.npmrc' or path.name == '.env' or path.name.startswith('.env.'):
        raise RuntimeError('Unexpected local environment file in worker inputs: ' + relative)
    if path.suffix.lower() in {'.md', '.json', '.txt', '.diff', '.patch', '.yaml', '.yml', '.sh', '.js', '.ts'} or path.name in {'mark', 'mark-cli'}:
        text = path.read_text().lower()
        if any(marker in text for marker in markers):
            raise RuntimeError('Reference material is present in worker inputs: ' + relative)
    count += 1
print(json.dumps({'clean': True, 'files': count}))
