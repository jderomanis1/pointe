from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if old not in content:
        raise RuntimeError(f'Expected text missing from {path}: {old!r}')
    target.write_text(content.replace(old, new, 1))


patch(
    'apps/worker/src/security.ts',
    "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/;",
    "// Deliberately rejects ASCII control characters from user-facing labels.\n"
    "// eslint-disable-next-line no-control-regex\n"
    "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/;\n\n"
    "export function utf8ByteLength(value: string): number {\n"
    "  // TextEncoder is provided by both Workers and Node 22.\n"
    "  // eslint-disable-next-line no-undef\n"
    "  return new TextEncoder().encode(value).byteLength;\n"
    "}",
)
patch(
    'apps/worker/src/security.ts',
    "new TextEncoder().encode(raw).byteLength",
    "utf8ByteLength(raw)",
)
patch(
    'apps/worker/src/security.ts',
    "new TextEncoder().encode(value).byteLength",
    "utf8ByteLength(value)",
)
patch(
    'apps/worker/src/room.ts',
    "  MAX_WS_MESSAGE_BYTES, MAX_WS_MESSAGES_PER_MINUTE,\n} from './security';",
    "  MAX_WS_MESSAGE_BYTES, MAX_WS_MESSAGES_PER_MINUTE, utf8ByteLength,\n} from './security';",
)
patch(
    'apps/worker/src/room.ts',
    "new TextEncoder().encode(message).byteLength",
    "utf8ByteLength(message)",
)

print('Lint compatibility fixes applied.')
