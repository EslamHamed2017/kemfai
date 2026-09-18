import { readFileSync } from 'fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { load as loadYaml } from 'js-yaml';
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { committedOpenApiContractPath, setupOpenApi } from '../../src/openapi/openapi-contract';

/**
 * T022 acceptance test against the live BFF: the real AppModule (global guard chain and
 * all), booted exactly the way main.ts boots it, then wired with the same setupOpenApi()
 * helper — so what is asserted here is what production serves, not a parallel harness.
 *
 * Zero drift is asserted by deep-comparing GET /api-docs-json with the committed
 * contracts/openapi.yaml parsed to JSON. This is precisely the diff later contract-test
 * suites (T027+, T108 CI) are specified to run, proven green here for the first time.
 * Requires a reachable, already-migrated Postgres configured via CONTROL_DB_* env vars.
 */
describe('OpenAPI bootstrap (T022)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // The one wiring step main.ts performs after create() — nothing else, no test-only
    // shortcuts: if the live spec can drift from the contract, this suite must drift too.
    setupOpenApi(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  const committedContract = loadYaml(
    readFileSync(committedOpenApiContractPath(), 'utf8'),
  ) as Record<string, unknown>;

  describe('GET /api-docs-json — the live spec', () => {
    it('returns the committed contract with zero drift (deep equality)', async () => {
      const response = await request(app.getHttpServer()).get('/api-docs-json').expect(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual(committedContract);
    });

    it('serves every path from contracts/openapi.yaml', async () => {
      const response = await request(app.getHttpServer()).get('/api-docs-json').expect(200);
      const livePaths = Object.keys(response.body.paths as Record<string, unknown>);
      const committedPaths = Object.keys(committedContract.paths as Record<string, unknown>);
      expect(committedPaths.length).toBeGreaterThan(0);
      expect(livePaths.sort()).toEqual(committedPaths.sort());
    });

    it('serves every tag from contracts/openapi.yaml', async () => {
      const response = await request(app.getHttpServer()).get('/api-docs-json').expect(200);
      const liveTags = (response.body.tags as Array<{ name: string }>).map((tag) => tag.name);
      const committedTags = (committedContract.tags as Array<{ name: string }>).map(
        (tag) => tag.name,
      );
      expect(liveTags.sort()).toEqual(committedTags.sort());
    });

    it("serves the contract's bearerAuth scheme and global security unchanged", async () => {
      const response = await request(app.getHttpServer()).get('/api-docs-json').expect(200);
      const bearerAuth = (
        (response.body.components as Record<string, unknown>).securitySchemes as Record<
          string,
          unknown
        >
      ).bearerAuth as Record<string, unknown>;
      expect(bearerAuth.type).toBe('http');
      expect(bearerAuth.scheme).toBe('bearer');
      expect(bearerAuth.bearerFormat).toBe('JWT');
      expect(response.body.security).toEqual([{ bearerAuth: [] }]);
    });
  });

  describe('GET /api-docs — swagger-ui rendering the committed contract', () => {
    it('renders the UI over the live document', async () => {
      const response = await request(app.getHttpServer()).get('/api-docs').expect(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Swagger UI');
    });

    it('hands swagger-ui the committed contract itself as the document to render', async () => {
      // swagger-ui-init.js embeds the document it renders as the `swaggerDoc` member of a
      // `let options = {...}` statement. Extract that JSON blob and deep-compare it with
      // the committed contract — proving the UI cannot render anything but the exact
      // committed spec (no second, independently-drifting document source).
      const initJs = await request(app.getHttpServer())
        .get('/api-docs/swagger-ui-init.js')
        .expect(200);
      expect(initJs.headers['content-type']).toContain('javascript');
      const marker = 'let options = ';
      const braceStart = initJs.text.indexOf('{', initJs.text.indexOf(marker) + marker.length);
      expect(braceStart).toBeGreaterThan(0);
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = braceStart; i < initJs.text.length; i += 1) {
        const ch = initJs.text[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = !inString;
        if (inString) continue;
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(braceStart);
      const embeddedOptions = JSON.parse(initJs.text.slice(braceStart, end + 1)) as {
        swaggerDoc: unknown;
      };
      expect(embeddedOptions.swaggerDoc).toEqual(committedContract);
    });
  });
});
