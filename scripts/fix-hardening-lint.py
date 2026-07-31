from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if old not in content:
        raise RuntimeError(f'Expected text missing from {path}: {old!r}')
    target.write_text(content.replace(old, new, 1))


# Replace call sites before adding the helper, so the helper implementation is
# not accidentally rewritten into a recursive call.
patch(
    'apps/worker/src/security.ts',
    "new TextEncoder().encode(raw).byteLength",
    "utf8ByteLength(raw)",
)
patch(
    'apps/worker/src/security.ts',
    "    && new TextEncoder().encode(value).byteLength <= maxBytes",
    "    && utf8ByteLength(value) <= maxBytes",
)
patch(
    'apps/worker/src/security.ts',
    "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/;",
    "// Deliberately rejects ASCII control characters from user-facing labels.\n"
    "// eslint-disable-next-line no-control-regex\n"
    "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/;\n\n"
    "export function utf8ByteLength(value: string): number {\n"
    "  let bytes = 0;\n"
    "  for (let index = 0; index < value.length; index += 1) {\n"
    "    const code = value.charCodeAt(index);\n"
    "    if (code < 0x80) {\n"
    "      bytes += 1;\n"
    "    } else if (code < 0x800) {\n"
    "      bytes += 2;\n"
    "    } else if (code >= 0xd800 && code <= 0xdbff\n"
    "        && index + 1 < value.length) {\n"
    "      const next = value.charCodeAt(index + 1);\n"
    "      if (next >= 0xdc00 && next <= 0xdfff) {\n"
    "        bytes += 4;\n"
    "        index += 1;\n"
    "      } else {\n"
    "        bytes += 3;\n"
    "      }\n"
    "    } else {\n"
    "      bytes += 3;\n"
    "    }\n"
    "  }\n"
    "  return bytes;\n"
    "}",
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
