/**
 * SQL templates (DBeaver "templates" / SqlDbx "speed typing"). Type the
 * trigger word and accept the completion (Tab) to expand; Tab / Shift+Tab
 * then move between the placeholders.
 */
import type { SplitDialect } from "@/lib/sqlSplit";

export interface SqlSnippet {
  label: string;
  detail: string;
  template: string;
}

function limited(d: SplitDialect, select: string, from: string): string {
  switch (d) {
    case "sqlserver":
      return `SELECT TOP 100 ${select}\nFROM ${from}`;
    case "oracle":
      return `SELECT ${select}\nFROM ${from}\nFETCH FIRST 100 ROWS ONLY`;
    default:
      return `SELECT ${select}\nFROM ${from}\nLIMIT 100`;
  }
}

export function sqlSnippets(d: SplitDialect): SqlSnippet[] {
  const except = d === "oracle" ? "MINUS" : "EXCEPT";
  const list: SqlSnippet[] = [
    { label: "sel", detail: "SELECT * … (first 100 rows)", template: limited(d, "*", "${1:table}") + "${}" },
    { label: "selw", detail: "SELECT … WHERE …", template: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}${}" },
    { label: "sc", detail: "SELECT COUNT(*)", template: "SELECT COUNT(*)\nFROM ${1:table}${}" },
    {
      label: "grp",
      detail: "Count rows per value",
      template: "SELECT ${1:column}, COUNT(*) AS cnt\nFROM ${2:table}\nGROUP BY ${1:column}\nORDER BY cnt DESC${}",
    },
    {
      label: "dupes",
      detail: "Find duplicate keys",
      template:
        "SELECT ${1:key_columns}, COUNT(*) AS cnt\nFROM ${2:table}\nGROUP BY ${1:key_columns}\nHAVING COUNT(*) > 1\nORDER BY cnt DESC${}",
    },
    {
      label: "nulls",
      detail: "Null / distinct profile of a column",
      template:
        "SELECT COUNT(*) AS total_rows,\n       COUNT(${1:column}) AS non_null,\n       COUNT(*) - COUNT(${1:column}) AS nulls,\n       COUNT(DISTINCT ${1:column}) AS distinct_values\nFROM ${2:table}${}",
    },
    {
      label: "minus",
      detail: `Rows in A not in B (${except})`,
      template: `SELECT \${1:columns} FROM \${2:table_a}\n${except}\nSELECT \${1:columns} FROM \${3:table_b}\${}`,
    },
    { label: "ins", detail: "INSERT INTO … VALUES", template: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})${}" },
    { label: "upd", detail: "UPDATE … SET … WHERE", template: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}${}" },
    { label: "del", detail: "DELETE … WHERE", template: "DELETE FROM ${1:table}\nWHERE ${2:condition}${}" },
    {
      label: "cte",
      detail: "WITH … AS ( … ) SELECT",
      template: "WITH ${1:cte} AS (\n  SELECT ${2:*}\n  FROM ${3:table}\n)\nSELECT *\nFROM ${1:cte}${}",
    },
    {
      label: "join",
      detail: "INNER JOIN",
      template: "SELECT ${1:a.*}, ${2:b.*}\nFROM ${3:table_a} a\nJOIN ${4:table_b} b ON b.${5:id} = a.${6:id}${}",
    },
    {
      label: "ljoin",
      detail: "LEFT JOIN",
      template: "SELECT ${1:a.*}, ${2:b.*}\nFROM ${3:table_a} a\nLEFT JOIN ${4:table_b} b ON b.${5:id} = a.${6:id}${}",
    },
    { label: "case", detail: "CASE WHEN … END", template: "CASE\n  WHEN ${1:condition} THEN ${2:result}\n  ELSE ${3:other}\nEND${}" },
    {
      label: "rn",
      detail: "ROW_NUMBER() OVER (…)",
      template: "ROW_NUMBER() OVER (PARTITION BY ${1:column} ORDER BY ${2:column} DESC) AS rn${}",
    },
    {
      label: "exists",
      detail: "WHERE EXISTS ( … )",
      template: "WHERE EXISTS (\n  SELECT 1\n  FROM ${1:table} x\n  WHERE x.${2:id} = ${3:outer}.${4:id}\n)${}",
    },
    {
      label: "crt",
      detail: "CREATE TABLE",
      template: "CREATE TABLE ${1:table_name} (\n  ${2:id} ${3:INT} NOT NULL,\n  ${4:name} ${5:VARCHAR(100)},\n  PRIMARY KEY (${2:id})\n)${}",
    },
    {
      label: "ctas",
      detail: "CREATE TABLE … AS SELECT",
      template:
        d === "sqlserver"
          ? "SELECT ${1:*}\nINTO ${2:new_table}\nFROM ${3:source_table}${}"
          : "CREATE TABLE ${1:new_table} AS\nSELECT ${2:*}\nFROM ${3:source_table}${}",
    },
  ];
  if (d !== "mysql") {
    list.push({
      label: "merge",
      detail: "MERGE (upsert)",
      template:
        "MERGE INTO ${1:target} t\nUSING ${2:source} s\n  ON t.${3:id} = s.${3:id}\nWHEN MATCHED THEN\n  UPDATE SET ${4:col} = s.${4:col}\nWHEN NOT MATCHED THEN\n  INSERT (${3:id}, ${4:col}) VALUES (s.${3:id}, s.${4:col})${}",
    });
  }
  return list;
}
