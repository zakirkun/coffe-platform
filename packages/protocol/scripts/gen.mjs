// Generates src/generated.ts (types) and src/schema.ts (schema object for Ajv) from
// schema/protocol.schema.json, which is produced by `cargo run -p coffe-protocol --bin
// coffe-protocol-schema`. Run from the repo root with `pnpm protocol:gen`.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(join(root, 'schema/protocol.schema.json'), 'utf8'));
const version = schema['x-protocol-version'];
const header = schema['x-protocol-header'];
if (typeof version !== 'string' || typeof header !== 'string') {
  throw new Error('schema is missing x-protocol-version / x-protocol-header');
}

const banner =
  '/* Generated from crates/coffe-protocol by packages/protocol/scripts/gen.mjs. Do not edit; run `pnpm protocol:gen`. */';

const types = await compile(structuredClone(schema), 'CoffeProtocol', {
  bannerComment: banner,
  additionalProperties: false,
  unreachableDefinitions: true,
  strictIndexSignatures: true,
  style: { singleQuote: true, printWidth: 100 },
});

await writeFile(
  join(root, 'src/generated.ts'),
  `${types}\nexport const PROTOCOL_VERSION = ${JSON.stringify(version)};\nexport const PROTOCOL_HEADER = ${JSON.stringify(header)};\n`,
);
await writeFile(
  join(root, 'src/schema.ts'),
  `${banner}\nexport const protocolSchema: Record<string, unknown> = ${JSON.stringify(schema)};\n`,
);
console.log(`protocol ${version}: wrote src/generated.ts and src/schema.ts`);
