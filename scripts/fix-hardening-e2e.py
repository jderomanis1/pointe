from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'apps/worker/src/testRoutes.ts'
content = TARGET.read_text()

old_import = "import { lookupSlug } from './slug';"
new_import = "import { isRoomSlug, lookupSlug } from './slug';"
if old_import not in content:
    raise RuntimeError('testRoutes slug import not found')
content = content.replace(old_import, new_import, 1)

for route in ('close', 'ai-ready', 'fire-vacancy', 'drop-voter-sockets'):
    old = f"const {'closeMatch' if route == 'close' else 'aiReadyMatch' if route == 'ai-ready' else 'fireVacancyMatch' if route == 'fire-vacancy' else 'dropMatch'} = url.pathname.match(/^\\/api\\/__test\\/{route}\\/([a-z-]+-\\d+)$/);"
    variable = 'closeMatch' if route == 'close' else 'aiReadyMatch' if route == 'ai-ready' else 'fireVacancyMatch' if route == 'fire-vacancy' else 'dropMatch'
    new = f"const {variable} = url.pathname.match(/^\\/api\\/__test\\/{route}\\/([^/]+)$/);"
    if old not in content:
        raise RuntimeError(f'{route} route matcher not found')
    content = content.replace(old, new, 1)
    old_guard = f"if ({variable} && request.method === 'POST') {{\n    const slug = {variable}[1];"
    new_guard = f"if ({variable} && request.method === 'POST' && isRoomSlug({variable}[1])) {{\n    const slug = {variable}[1];"
    if old_guard not in content:
        raise RuntimeError(f'{route} route guard not found')
    content = content.replace(old_guard, new_guard, 1)

TARGET.write_text(content)
print('Secure slug support added to dev-only E2E routes.')
