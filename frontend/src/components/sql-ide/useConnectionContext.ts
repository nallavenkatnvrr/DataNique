/**
 * Database / schema / (Snowflake) role & warehouse lists for the active
 * script, plus the effective context used by the explorer and completion.
 * Cached by react-query so switching tabs never reconnects to the database.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type Connection } from "@/api/client";
import { contextFields } from "./ideRunner";
import type { IdeContext } from "./ideStore";

const LONG = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;

export function useConnectionContext(conn: Connection | undefined, ctx: IdeContext) {
  const fields = contextFields(conn?.db_type);
  const databases = useQuery({
    queryKey: ["sql-ide-databases", conn?.id ?? null],
    queryFn: () => api.listDatabases(conn!.id),
    enabled: !!conn && fields.database,
    ...LONG,
  });
  const database = ctx.database || conn?.database || databases.data?.default || null;
  const schemas = useQuery({
    queryKey: ["sql-ide-schemas", conn?.id ?? null, fields.database ? database : null],
    queryFn: () => api.listSchemas(conn!.id, (fields.database && database) || undefined),
    enabled: !!conn && fields.schema,
    ...LONG,
  });
  const sameDb = !ctx.database || ctx.database === (conn?.database || databases.data?.default || null);
  const schema = fields.schema
    ? ctx.schema_name || (sameDb ? conn?.schema_name : null) || schemas.data?.default || null
    : null;
  const snowflake = useQuery({
    queryKey: ["sql-ide-sf-context", conn?.id ?? null],
    queryFn: () => api.getSnowflakeContext(conn!.id),
    enabled: !!conn && fields.roleWarehouse,
    ...LONG,
  });
  return { fields, databases, schemas, snowflake, database, schema };
}

export type ConnectionContextInfo = ReturnType<typeof useConnectionContext>;
