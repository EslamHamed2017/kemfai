import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { OpenAPIObject } from '@nestjs/swagger';
import { loadCommittedOpenApiContract } from '../../src/openapi/openapi-contract';

type JsonSchema = Record<string, unknown>;

const CONTRACT_SCHEMA_KEY = 'contract';

/**
 * `$ref: "#/components/schemas/X"` is only resolvable relative to the document it was
 * extracted from. Once we pull a single operation's request/response schema out of the
 * full contract and hand it to Ajv on its own, that local pointer is dangling unless it
 * is rewritten to point back into the whole document, which is registered once under
 * the `contract` key (see OpenApiContractValidator's constructor).
 */
function rewriteLocalRefs<T>(node: T): T {
  const clone = JSON.parse(JSON.stringify(node)) as T;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
        obj.$ref = `${CONTRACT_SCHEMA_KEY}${obj.$ref}`;
      }
      Object.values(obj).forEach(visit);
    }
  };
  visit(clone);
  return clone;
}

/**
 * Generic, schema-driven validation against the committed contract
 * (specs/001-saas-onboarding-shell/contracts/openapi.yaml) — T027. Deliberately reads
 * the contract itself rather than hard-coding per-endpoint expectations, so it stays
 * correct as the contract evolves: a status code this suite exercises must be one the
 * contract documents, and a response/request body is checked against whatever schema
 * (if any) the contract declares for it. Where the contract declares no body schema for
 * a given response, there is nothing to check beyond the status code itself — that is
 * not a gap in this validator, it is an accurate reflection of the committed contract.
 */
export class OpenApiContractValidator {
  private readonly ajv: Ajv;
  readonly document: OpenAPIObject;

  constructor(document: OpenAPIObject = loadCommittedOpenApiContract()) {
    this.document = document;
    this.ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema(document as unknown as JsonSchema, CONTRACT_SCHEMA_KEY);
  }

  private operation(path: string, method: string): Record<string, unknown> {
    const paths = this.document.paths as unknown as Record<string, Record<string, unknown>>;
    const pathItem = paths[path];
    if (!pathItem) {
      throw new Error(`Contract has no path "${path}"`);
    }
    const operation = pathItem[method.toLowerCase()] as Record<string, unknown> | undefined;
    if (!operation) {
      throw new Error(`Contract has no ${method.toUpperCase()} operation for "${path}"`);
    }
    return operation;
  }

  documentedStatuses(path: string, method: string): Set<number> {
    const responses = (this.operation(path, method).responses ?? {}) as Record<string, unknown>;
    return new Set(
      Object.keys(responses)
        .filter((code) => /^\d+$/.test(code))
        .map((code) => Number(code)),
    );
  }

  private mediaSchema(
    container: Record<string, unknown> | undefined,
    contentType: string,
  ): JsonSchema | undefined {
    const content = container?.content as Record<string, unknown> | undefined;
    const media = content?.[contentType] as Record<string, unknown> | undefined;
    return media?.schema as JsonSchema | undefined;
  }

  requestBodySchema(
    path: string,
    method: string,
    contentType = 'application/json',
  ): JsonSchema | undefined {
    const requestBody = this.operation(path, method).requestBody as
      Record<string, unknown> | undefined;
    return this.mediaSchema(requestBody, contentType);
  }

  responseSchema(
    path: string,
    method: string,
    status: number,
    contentType = 'application/json',
  ): JsonSchema | undefined {
    const responses = (this.operation(path, method).responses ?? {}) as Record<string, unknown>;
    const response = responses[String(status)] as Record<string, unknown> | undefined;
    return this.mediaSchema(response, contentType);
  }

  assertDocumentedStatus(path: string, method: string, status: number): void {
    const statuses = this.documentedStatuses(path, method);
    if (!statuses.has(status)) {
      throw new Error(
        `${method.toUpperCase()} ${path} returned undocumented status ${status}; contract ` +
          `declares [${[...statuses].sort().join(', ')}]`,
      );
    }
  }

  private compile(schema: JsonSchema): ValidateFunction {
    return this.ajv.compile(rewriteLocalRefs(schema));
  }

  private validateAgainst(schema: JsonSchema, value: unknown, label: string): void {
    const validate = this.compile(schema);
    if (!validate(value)) {
      throw new Error(
        `${label} does not match its declared schema:\n${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
  }

  validateRequestBody(
    path: string,
    method: string,
    body: unknown,
    contentType = 'application/json',
  ): void {
    const schema = this.requestBodySchema(path, method, contentType);
    if (!schema) return; // contract declares no request-body schema — nothing to check
    this.validateAgainst(schema, body, `${method.toUpperCase()} ${path} request body`);
  }

  validateResponseBody(path: string, method: string, status: number, body: unknown): void {
    const schema = this.responseSchema(path, method, status);
    if (!schema) return; // contract declares no response-body schema for this status
    this.validateAgainst(schema, body, `${method.toUpperCase()} ${path} ${status} response body`);
  }

  /** Validate a reusable component directly when an operation documents only its status. */
  validateComponentSchema(name: string, value: unknown): void {
    const schemas = this.document.components?.schemas as Record<string, JsonSchema> | undefined;
    const schema = schemas?.[name];
    if (!schema) {
      throw new Error(`Contract has no component schema "${name}"`);
    }
    this.validateAgainst(schema, value, `components.schemas.${name}`);
  }

  /** The one call sites should make per exercised response: status + body, both checked. */
  assertResponse(path: string, method: string, status: number, body: unknown): void {
    this.assertDocumentedStatus(path, method, status);
    this.validateResponseBody(path, method, status, body);
  }
}

/**
 * Tracks, per operation, which of the contract's documented status codes this suite has
 * actually exercised — so "every documented response code is exercised at least once"
 * (T027's acceptance criterion) is an assertion this suite runs, not just an outcome we
 * hope construction achieves.
 */
export class ContractCoverage {
  private readonly exercised = new Map<string, Set<number>>();

  constructor(private readonly validator: OpenApiContractValidator) {}

  private key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  record(path: string, method: string, status: number, body: unknown): void {
    this.validator.assertResponse(path, method, status, body);
    const key = this.key(method, path);
    if (!this.exercised.has(key)) {
      this.exercised.set(key, new Set());
    }
    this.exercised.get(key)!.add(status);
  }

  assertFullCoverage(path: string, method: string): void {
    const documented = this.validator.documentedStatuses(path, method);
    const seen = this.exercised.get(this.key(method, path)) ?? new Set();
    const missing = [...documented].filter((status) => !seen.has(status)).sort();
    if (missing.length > 0) {
      throw new Error(
        `${method.toUpperCase()} ${path}: documented status(es) [${missing.join(', ')}] were ` +
          'never exercised by this suite',
      );
    }
  }
}
