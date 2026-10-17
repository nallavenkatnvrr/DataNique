/** Browse folders on the machine running Datanique and pick a file or folder. */
import * as React from "react";
import ReactDOM from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, File, Folder, X } from "lucide-react";
import { errorText } from "@/api/client";
import { filesApi } from "@/api/engine";
import { Spinner, useLocalState } from "@/components/kit";
import { cn, formatBytes } from "@/lib/utils";

export function FileBrowser({ open, onClose, onPick, folders = false }: {
  open: boolean; onClose: () => void; onPick: (path: string) => void; folders?: boolean;
}) {
  const [path, setPath] = useLocalState("dv-browse-path", "");
  const q = useQuery({ queryKey: ["browse", path], queryFn: () => filesApi.browse(path), enabled: open, retry: false });
  const [draft, setDraft] = React.useState(path);
  React.useEffect(() => setDraft(q.data?.path ?? path), [q.data?.path, path]);
  React.useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[500] grid place-items-center bg-black/40 p-4 fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dv-panel flex h-[70vh] w-full max-w-2xl flex-col overflow-hidden scale-in">
        <div className="flex items-center gap-2 border-b p-3">
          <button type="button" disabled={!q.data?.parent && !path} onClick={() => setPath(q.data?.parent ?? "")}
            className="rounded p-1.5 hover:bg-accent disabled:opacity-40" title="Up"><ArrowUp className="h-4 w-4" /></button>
          <input className="dv-input font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setPath(draft)} placeholder="Type a folder path and press Enter" />
          <button type="button" onClick={onClose} className="rounded p-1.5 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 scrollbar-thin">
          {q.isLoading && <div className="grid h-32 place-items-center"><Spinner /></div>}
          {q.error && <div className="p-4 text-sm text-destructive">{errorText(q.error)}</div>}
          {q.data?.entries.map((e) => (
            <button key={e.path} type="button"
              onClick={() => (e.dir ? setPath(e.path) : !folders && onPick(e.path))}
              onDoubleClick={() => e.dir && folders && onPick(e.path)}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent", !e.dir && folders && "opacity-50")}>
              {e.dir ? <Folder className="h-4 w-4 text-primary" /> : <File className="h-4 w-4 text-muted-foreground" />}
              <span className="flex-1 truncate">{e.name}</span>
              {e.size_bytes != null && <span className="text-xs text-muted-foreground">{formatBytes(e.size_bytes)}</span>}
            </button>
          ))}
          {q.data && !q.data.entries.length && <div className="p-6 text-center text-sm text-muted-foreground">No readable files here</div>}
        </div>
        <div className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
          <span>Showing folders and supported data files</span>
          {q.data?.path && (
            <button type="button" onClick={() => onPick(q.data!.path)} className="rounded-lg border px-3 py-1.5 font-medium text-foreground hover:bg-accent">
              Use this folder
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
