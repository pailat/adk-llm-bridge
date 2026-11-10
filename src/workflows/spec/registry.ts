import { z } from "zod";

/**
 * Metadata a run spec schema carries: the JSON Schema `id` of a named schema,
 * and any JSON Schema keyword such as `title`, `description` or `maxLength`.
 *
 * @internal
 */
export type RunSpecSchemaMeta = z.core.JSONSchemaMeta;

/**
 * Registry of the ids and descriptions of the run spec schemas.
 *
 * @remarks
 * A registry of this module, not zod's global one, so importing the subpath
 * changes no shared state: two copies of the module, or a module that is
 * evaluated again, cannot clash on an id. `runSpecJsonSchema` is generated
 * with it as the metadata source.
 *
 * @internal
 */
export const runSpecRegistry = z.registry<RunSpecSchemaMeta>();
