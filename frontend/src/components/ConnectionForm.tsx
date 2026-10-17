import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PlugZap, Save } from "lucide-react";
import { api, type Connection, type ConnectionPayload, type DbType } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  initial?: Connection;
  onSaved?: (c: Connection) => void;
  onCancel?: () => void;
}

function makeEmptyPayload(): ConnectionPayload {
  return {
    name: "",
    db_type: "snowflake",
    host: "",
    port: null,
    username: "",
    password: "",
    database: "",
    schema_name: "",
    extra: {},
    is_active: true,
  };
}

function fromConnection(c: Connection): ConnectionPayload {
  return {
    name: c.name,
    db_type: c.db_type,
    host: c.host ?? "",
    port: c.port ?? null,
    username: c.username ?? "",
    password: "",
    database: c.database ?? "",
    schema_name: c.schema_name ?? "",
    extra: c.extra ?? {},
    is_active: c.is_active,
  };
}

function getField(p: ConnectionPayload, key: string): any {
  if (key.startsWith("extra.")) return (p.extra as any)?.[key.slice(6)];
  return (p as any)[key];
}

function setField(p: ConnectionPayload, key: string, value: any): ConnectionPayload {
  if (key.startsWith("extra.")) {
    return { ...p, extra: { ...(p.extra ?? {}), [key.slice(6)]: value } };
  }
  return { ...p, [key]: value };
}

export function ConnectionForm({ initial, onSaved, onCancel }: Props) {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ["db-types"], queryFn: api.dbTypes });
  const [payload, setPayload] = React.useState<ConnectionPayload>(
    initial ? fromConnection(initial) : makeEmptyPayload()
  );

  const meta = types.data?.find((t) => t.type === payload.db_type);
  const needsPasswordToTestEdits = !!initial?.has_password && payload.password === "";

  const test = useMutation({
    mutationFn: () => api.testUnsavedConnection(payload),
    onSuccess: (res) => {
      if (res.ok) toast.success("Connection successful", { description: res.ping ? `Ping: ${res.ping}` : "" });
      else toast.error("Connection failed", { description: res.error });
    },
    onError: (err: any) => toast.error("Test failed", { description: String(err.message ?? err) }),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (initial?.id) {
        return api.updateConnection(initial.id, payload);
      }
      return api.createConnection(payload);
    },
    onSuccess: (c) => {
      toast.success(initial ? "Connection updated" : "Connection created");
      qc.invalidateQueries({ queryKey: ["connections"] });
      onSaved?.(c);
    },
    onError: (err: any) => toast.error("Save failed", { description: String(err.message ?? err) }),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payload.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!meta) {
      toast.error("Connection fields are unavailable", { description: "Wait for the database type fields to load, then try again." });
      return;
    }
    const missing = meta.fields.filter((field: any) => {
      if (!field.required) return false;
      const value = getField(payload, field.key);
      if (field.secret && initial?.has_password && (value == null || value === "")) return false;
      if (typeof value === "boolean") return false;
      return value == null || (typeof value === "string" && !value.trim());
    });
    if (missing.length) {
      toast.error("Required connection fields are missing", {
        description: missing.map((field: any) => field.label).join(", "),
      });
      return;
    }
    save.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? "Edit connection" : "New connection"}</CardTitle>
        <CardDescription>Fill in the connection details below. Password is encrypted before being stored.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Connection name</Label>
              <Input
                id="name"
                value={payload.name}
                onChange={(e) => setPayload({ ...payload, name: e.target.value })}
                placeholder="my-snowflake-prod"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="db_type">Database type</Label>
              <Select
                id="db_type"
                value={payload.db_type}
                onChange={(e) => setPayload({
                  // keep what applies to every database; reset type-specific options
                  ...makeEmptyPayload(), name: payload.name, db_type: e.target.value as DbType,
                  host: payload.host, username: payload.username, password: payload.password,
                  database: payload.database, schema_name: payload.schema_name,
                })}
              >
                {(types.data ?? []).map((t) => (
                  <option key={t.type} value={t.type}>{t.label}</option>
                ))}
              </Select>
            </div>
          </div>

          {meta && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {meta.fields.map((f: any) => {
                const val = getField(payload, f.key);
                const isPassword = !!f.secret;
                const isBoolean = f.type === "boolean";
                const hasOptions = Array.isArray(f.options) && f.options.length > 0;
                const placeholder =
                  initial && isPassword ? "(unchanged - leave blank to keep)" : f.placeholder ?? (f.default != null ? String(f.default) : "");
                if (isBoolean) {
                  const checked = val === true || val === "true" || val === "yes" || val === 1 || val === "1";
                  return (
                    <div key={f.key} className="space-y-2">
                      <Label htmlFor={f.key}>&nbsp;</Label>
                      <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                        <input
                          id={f.key}
                          type="checkbox"
                          className="h-4 w-4 rounded border-input"
                          checked={checked}
                          onChange={(e) => setPayload((p) => setField(p, f.key, e.target.checked))}
                        />
                        {f.label}
                      </label>
                      {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
                    </div>
                  );
                }
                return (
                  <div key={f.key} className="space-y-2">
                    <Label htmlFor={f.key}>
                      {f.label} {f.required ? <span className="text-destructive">*</span> : null}
                    </Label>
                    {hasOptions ? (
                      <Select
                        id={f.key}
                        value={val || (f.default != null ? String(f.default) : "")}
                        onChange={(e) => setPayload((p) => setField(p, f.key, e.target.value))}
                      >
                        <option value="">(default)</option>
                        {f.options.map((opt: any) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        id={f.key}
                        type={isPassword ? "password" : f.type === "number" ? "number" : "text"}
                        value={val ?? ""}
                        placeholder={placeholder}
                        onChange={(e) => {
                          let v: any = e.target.value;
                          if (f.type === "number") v = v === "" ? null : Number(v);
                          setPayload((p) => setField(p, f.key, v));
                        }}
                      />
                    )}
                    {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button type="submit" loading={save.isPending}>
              <Save className="h-4 w-4" />
              {initial ? "Update" : "Create"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => test.mutate()}
              loading={test.isPending}
              disabled={needsPasswordToTestEdits}
              title={needsPasswordToTestEdits ? "Enter the password to test these edits. The saved password cannot be read back." : "Test the current unsaved connection settings"}
            >
              {!test.isPending && <PlugZap className="h-4 w-4" />}
              {needsPasswordToTestEdits ? "Test (password required)" : "Test edits"}
            </Button>
            {needsPasswordToTestEdits ? (
              <span className="text-xs text-muted-foreground">
                Enter the password to test these edits, or save first; testing the saved connection would use stale settings.
              </span>
            ) : null}
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            )}
            {types.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
