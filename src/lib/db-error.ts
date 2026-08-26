/**
 * Turns a Postgres constraint violation into a caller-actionable 400.
 *
 * A write that violates NOT NULL / CHECK is a statement about the REQUEST, not an
 * internal failure: the caller left a required field out, or sent a value the
 * column refuses. Reporting it as `500 {"error":"Internal server error"}` puts the
 * only useful part — which column — in our logs and nowhere the caller can read it,
 * so a missing tag is indistinguishable from a malformed DAG.
 *
 * Nothing is swallowed: an error this does not recognise returns null and the
 * caller keeps its existing 500 path.
 */

/** Postgres error codes we can restate in terms of the request. */
const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";

export interface DbConstraintFailure {
  /** Request-body field name (camelCase), when the column maps to one. */
  field: string | null;
  /** The offending column as Postgres names it. */
  column: string | null;
  message: string;
  code: string;
}

/** `audience_type` -> `audienceType`. Request fields are the camelCase form of the column. */
function columnToField(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function describeDbConstraintFailure(err: unknown): DbConstraintFailure | null {
  if (!err || typeof err !== "object") return null;
  const source = err as Record<string, unknown>;
  const code = readString(source, "code");
  if (code !== NOT_NULL_VIOLATION && code !== CHECK_VIOLATION) return null;

  // postgres.js surfaces these as `column_name` / `constraint_name`; node-postgres as `column`.
  const column = readString(source, "column_name") ?? readString(source, "column");
  const constraint = readString(source, "constraint_name") ?? readString(source, "constraint");

  if (code === NOT_NULL_VIOLATION) {
    const field = column ? columnToField(column) : null;
    return {
      field,
      column,
      code,
      message: field
        ? `Missing required field "${field}" — the workflows table stores it NOT NULL.`
        : "A required column was not supplied.",
    };
  }

  return {
    field: column ? columnToField(column) : null,
    column,
    code,
    message: constraint
      ? `Value rejected by database constraint "${constraint}".`
      : "Value rejected by a database constraint.",
  };
}

/** The 400 body to answer with, or null when the error is not a constraint violation. */
export function constraintErrorResponse(
  err: unknown,
): { error: string; details: DbConstraintFailure } | null {
  const failure = describeDbConstraintFailure(err);
  if (!failure) return null;
  return { error: failure.message, details: failure };
}
