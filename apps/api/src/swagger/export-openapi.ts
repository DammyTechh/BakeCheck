#!/usr/bin/env ts-node
/**
 * Writes the OpenAPI specification to a file without starting an HTTP server.
 *
 * Useful for generating a client, diffing the contract in review, or
 * publishing the spec from CI. The document is produced from the real Nest
 * application, so it is identical to what `/api/docs-json` serves.
 *
 * The application is created but never listens, and it is closed afterwards —
 * no port is bound and no connection is left open.
 *
 * Usage:
 *   npm run openapi:export              # writes openapi.json
 *   npm run openapi:export -- --out spec.json --format yaml
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppConfig, CONFIG_TOKEN } from '../config/configuration';
import { buildOpenApiDocument } from './setup';

interface Options {
  outPath: string;
  format: 'json' | 'yaml';
}

function parseArgs(argv: string[]): Options {
  const options: Options = { outPath: 'openapi.json', format: 'json' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out' || arg === '-o') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a file path');
      options.outPath = value;
      index += 1;
    } else if (arg === '--format' || arg === '-f') {
      const value = argv[index + 1];
      if (value !== 'json' && value !== 'yaml') {
        throw new Error('--format must be json or yaml');
      }
      options.format = value;
      index += 1;
    }
  }

  // Keep the extension consistent with the chosen format unless the caller
  // explicitly named a file.
  if (options.format === 'yaml' && options.outPath === 'openapi.json') {
    options.outPath = 'openapi.yaml';
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Quiet: the export writes one line of output, and Nest's startup banner
  // would otherwise drown it when piped.
  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    const config = app.get<AppConfig>(CONFIG_TOKEN);
    // `init()` without `listen()` resolves the routes the document is built
    // from, without binding a port.
    await app.init();

    const document = buildOpenApiDocument(app, config);

    let contents: string;
    if (options.format === 'yaml') {
      // js-yaml ships with @nestjs/swagger, so this needs no extra dependency.
      const { dump } = await import('js-yaml');
      contents = dump(document, { noRefs: true, lineWidth: 100 });
    } else {
      contents = `${JSON.stringify(document, null, 2)}\n`;
    }

    const absolute = resolve(process.cwd(), options.outPath);
    writeFileSync(absolute, contents, 'utf8');

    const pathCount = Object.keys(document.paths ?? {}).length;
    const schemaCount = Object.keys(document.components?.schemas ?? {}).length;

    // eslint-disable-next-line no-console
    console.log(
      `Wrote ${absolute}\n  ${pathCount} paths, ${schemaCount} schemas, ` +
        `OpenAPI ${document.openapi}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: Error) => {
  // eslint-disable-next-line no-console
  console.error(`\nFailed to export the OpenAPI document:\n${error.message}\n`);
  process.exit(1);
});
